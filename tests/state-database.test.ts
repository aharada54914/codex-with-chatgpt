import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { backupDatabase, openStateDatabase, verifyDatabase } from "../src/state/database.js";
import { DomainRepositories, SqliteRepository } from "../src/state/repository.js";
import { migrations } from "../src/state/migrations.js";
import type { Activity } from "../src/domain/types.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const directories: string[] = [];
afterEach(() => { while (directories.length) cleanup(directories.pop()!); });

function activity(id: string, projectId = "project-1"): Activity {
  const timestamp = "2026-09-05T00:00:00.000Z";
  return { id, projectId, revision: 0, createdAt: timestamp, updatedAt: timestamp, goal: "ship safely", status: "INTAKE" };
}

describe("durable state database", () => {
  it("applies versioned migrations, WAL, and owner-only file permissions", () => {
    const directory = makeTmpDir("c2c-state-db"); directories.push(directory);
    const directoryMode = fs.statSync(directory).mode & 0o777;
    const file = path.join(directory, "state.sqlite3");
    const database = openStateDatabase(file);
    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
    ]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    if (process.platform !== "win32") expect(fs.statSync(directory).mode & 0o777).toBe(directoryMode);
    verifyDatabase(database);
    database.close();
  });

  it("closes the native connection when initialization fails", () => {
    const directory = makeTmpDir("c2c-state-init-failure"); directories.push(directory);
    const file = path.join(directory, "state.sqlite3");
    const malformed = new Database(file);
    malformed.exec("CREATE TABLE schema_migrations (wrong_column TEXT)");
    malformed.close();
    expect(() => openStateDatabase(file)).toThrow();
    const moved = path.join(directory, "moved.sqlite3");
    fs.renameSync(file, moved);
    expect(fs.existsSync(moved)).toBe(true);
  });

  it("rejects legacy project rows that cannot be safely bound to a canonical root", () => {
    const directory = makeTmpDir("c2c-state-legacy-project"); directories.push(directory);
    const file = path.join(directory, "state.sqlite3");
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    migrations[0]!.apply(legacy);
    legacy.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(1, migrations[0]!.name, "2026-09-05T00:00:00.000Z");
    const oldProject = {
      id: "legacy", projectId: null, revision: 0, name: "legacy", rootFingerprint: "old",
      createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z",
    };
    legacy.prepare(`INSERT INTO projects
      (id, project_id, revision, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(oldProject.id, null, 0, JSON.stringify(oldProject), oldProject.createdAt, oldProject.updatedAt);
    legacy.close();

    expect(() => openStateDatabase(file)).toThrow(/cannot migrate legacy project/i);
  });

  it("does not change permissions on a caller-owned parent directory", () => {
    const directory = makeTmpDir("c2c-state-parent-mode"); directories.push(directory);
    if (process.platform === "win32") return;
    fs.chmodSync(directory, 0o755);
    const database = openStateDatabase(path.join(directory, "state.sqlite3"));
    expect(fs.statSync(directory).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(directory, "state.sqlite3")).mode & 0o777).toBe(0o600);
    database.close();
  });

  it("round-trips domain repositories and rolls back partial transactions", () => {
    const directory = makeTmpDir("c2c-state-repo"); directories.push(directory);
    const database = openStateDatabase(path.join(directory, "state.sqlite3"));
    const repositories = new DomainRepositories(database);
    repositories.activities.insert(activity("a1"));
    expect(repositories.activities.get("a1")).toEqual(activity("a1"));
    expect(repositories.activities.listByProject("project-1")).toHaveLength(1);

    expect(() => repositories.transaction(() => {
      repositories.activities.insert(activity("a2"));
      repositories.activities.insert(activity("a1"));
    })).toThrow();
    expect(repositories.activities.get("a2")).toBeNull();
    database.close();
  });

  it("creates and verifies a recoverable owner-only backup", async () => {
    const directory = makeTmpDir("c2c-state-backup"); directories.push(directory);
    const database = openStateDatabase(path.join(directory, "state.sqlite3"));
    new DomainRepositories(database).activities.insert(activity("a1"));
    const backup = path.join(directory, "backups", "state.sqlite3");
    await backupDatabase(database, backup);
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    const recovered = openStateDatabase(backup);
    expect(new DomainRepositories(recovered).activities.get("a1")?.goal).toBe("ship safely");
    recovered.close();
    database.close();
  });

  it("stores every required domain record outside project trees without secret columns", () => {
    const directory = makeTmpDir("c2c-state-schema"); directories.push(directory);
    const database = openStateDatabase(path.join(directory, "state.sqlite3"));
    const tables = ["projects", "activities", "agents", "jobs", "approvals", "evidence", "reviews", "operations", "audit_events"];
    for (const table of tables) {
      const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(["id", "project_id", "revision", "payload_json", "created_at", "updated_at"]);
      expect(columns.some((column) => /secret|token|password/i.test(column.name))).toBe(false);
    }
    database.close();
  });

  it("rejects runtime table-name injection and leaves no backup temporary files", async () => {
    const directory = makeTmpDir("c2c-state-hardening"); directories.push(directory);
    const database = openStateDatabase(path.join(directory, "state.sqlite3"));
    expect(() => new SqliteRepository(database, "activities WHERE 1=1" as "activities")).toThrow("invalid domain table");
    const destination = path.join(directory, "backup.sqlite3");
    await backupDatabase(database, destination);
    await backupDatabase(database, destination);
    expect(fs.readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
    const recovered = openStateDatabase(destination);
    verifyDatabase(recovered);
    recovered.close();
    database.close();
  });
});

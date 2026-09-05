import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Project } from "../src/domain/types.js";
import { V1StateMigrator } from "../src/migration/v1.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { openStateDatabase } from "../src/state/database.js";
import { DomainRepositories } from "../src/state/repository.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const directories: string[] = [];
afterEach(() => { while (directories.length) cleanup(directories.pop()!); });

function setup() {
  const root = makeTmpDir("c2c-v1-migration"); directories.push(root);
  const legacy = path.join(root, "legacy"); fs.mkdirSync(path.join(legacy, "executions"), { recursive: true });
  fs.mkdirSync(path.join(legacy, "sessions"), { recursive: true });
  const databaseFile = path.join(root, "v2", "state.sqlite3"); const database = openStateDatabase(databaseFile);
  const repositories = new DomainRepositories(database);
  const registered = new ProjectRegistry(repositories).registerLocal(root, { name: "migrate" });
  const project = repositories.projects.get(registered.projectId) as Project;
  const workspaceId = project.rootFingerprint;
  const record = { taskId: "task-1", iteration: 1, changedFiles: ["src/a.ts"], tests: "1 passed",
    exitStatus: "ok", timestamp: "2026-09-05T00:00:00.000Z" };
  fs.writeFileSync(path.join(legacy, "executions", `${workspaceId}.jsonl`), `${JSON.stringify(record)}\n`);
  fs.writeFileSync(path.join(legacy, "sessions", `${workspaceId}.json`), JSON.stringify({
    title: "Legacy session", savedAt: "2026-09-05T00:00:00.000Z", conversationMode: "project",
  }));
  fs.writeFileSync(path.join(legacy, "prefs.json"), JSON.stringify({
    developerModeEnabled: true, setupMode: "manual", updatedAt: "2026-09-05T00:00:00.000Z",
  }));
  return { root, legacy, databaseFile, database, repositories, project, workspaceId,
    backup: path.join(root, "backups", "before-v1.sqlite3") };
}

describe("V1 state migration", () => {
  it("validates, backs up, imports once, and rolls back only the imported batch", async () => {
    const fixture = setup(); const migrator = new V1StateMigrator(fixture.repositories);
    const first = await migrator.import({ projectId: fixture.project.id, workspaceId: fixture.workspaceId,
      stateRoot: fixture.legacy, backupPath: fixture.backup });
    expect(first).toMatchObject({ imported: 3, replayed: false }); expect(fs.existsSync(fixture.backup)).toBe(true);
    expect(fixture.repositories.database.prepare("SELECT kind FROM legacy_metadata ORDER BY kind").all())
      .toEqual([{ kind: "execution" }, { kind: "preferences" }, { kind: "session" }]);
    const replay = await migrator.import({ projectId: fixture.project.id, workspaceId: fixture.workspaceId,
      stateRoot: fixture.legacy, backupPath: path.join(fixture.root, "unused.sqlite3") });
    expect(replay).toMatchObject({ batchId: first.batchId, imported: 0, replayed: true });
    expect(fs.existsSync(path.join(fixture.root, "unused.sqlite3"))).toBe(false);
    expect(migrator.rollback(first.batchId)).toBe(3);
    expect(fixture.repositories.database.prepare("SELECT count(*) AS count FROM legacy_metadata").get()).toEqual({ count: 0 });
    expect(fixture.repositories.projects.get(fixture.project.id)).not.toBeNull(); fixture.database.close();
  });

  it("fails closed on malformed, symlinked, or changed sources without partial imports", async () => {
    const malformed = setup(); fs.writeFileSync(path.join(malformed.legacy, "executions", `${malformed.workspaceId}.jsonl`), "not-json\n");
    await expect(new V1StateMigrator(malformed.repositories).import({ projectId: malformed.project.id,
      workspaceId: malformed.workspaceId, stateRoot: malformed.legacy, backupPath: malformed.backup }))
      .rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(malformed.repositories.database.prepare("SELECT count(*) AS count FROM legacy_import_batches").get()).toEqual({ count: 0 });
    expect(fs.existsSync(malformed.backup)).toBe(false); malformed.database.close();

    if (process.platform !== "win32") {
      const linked = setup(); const session = path.join(linked.legacy, "sessions", `${linked.workspaceId}.json`);
      fs.unlinkSync(session); fs.symlinkSync(path.join(linked.legacy, "prefs.json"), session);
      await expect(new V1StateMigrator(linked.repositories).import({ projectId: linked.project.id,
        workspaceId: linked.workspaceId, stateRoot: linked.legacy, backupPath: linked.backup }))
        .rejects.toMatchObject({ code: "INVALID_SOURCE" }); linked.database.close();
    }

    const changed = setup(); const migrator = new V1StateMigrator(changed.repositories);
    await migrator.import({ projectId: changed.project.id, workspaceId: changed.workspaceId,
      stateRoot: changed.legacy, backupPath: changed.backup });
    fs.writeFileSync(path.join(changed.legacy, "executions", `${changed.workspaceId}.jsonl`), JSON.stringify({
      taskId: "task-changed", iteration: 2, changedFiles: 0, tests: null, exitStatus: "failed",
      timestamp: "2026-09-05T01:00:00.000Z",
    }));
    await expect(migrator.import({ projectId: changed.project.id, workspaceId: changed.workspaceId,
      stateRoot: changed.legacy, backupPath: changed.backup })).rejects.toMatchObject({ code: "IMPORT_CONFLICT" });
    expect(changed.repositories.database.prepare("SELECT count(*) AS count FROM legacy_metadata").get()).toEqual({ count: 3 });
    changed.database.close();
  });

  it("rejects cross-project attribution and unsupported output references", async () => {
    const fixture = setup(); const migrator = new V1StateMigrator(fixture.repositories);
    const secondRoot = path.join(fixture.root, "second-project"); fs.mkdirSync(secondRoot);
    const second = new ProjectRegistry(fixture.repositories).registerLocal(secondRoot);
    await expect(migrator.import({ projectId: second.projectId, workspaceId: fixture.workspaceId,
      stateRoot: fixture.legacy, backupPath: fixture.backup })).rejects.toMatchObject({ code: "PROJECT_MISMATCH" });

    const records = path.join(fixture.legacy, "executions", `${fixture.workspaceId}.jsonl`);
    const record = JSON.parse(fs.readFileSync(records, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(records, `${JSON.stringify({ ...record, outputId: 1, outputAvailable: true })}\n`);
    await expect(migrator.import({ projectId: fixture.project.id, workspaceId: fixture.workspaceId,
      stateRoot: fixture.legacy, backupPath: fixture.backup })).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
    fixture.database.close();
  });

  it("rejects removed sources and collapses concurrent identical imports", async () => {
    const fixture = setup(); const migrator = new V1StateMigrator(fixture.repositories);
    const inputs = ["concurrent-a.sqlite3", "concurrent-b.sqlite3"].map((name) => ({
      projectId: fixture.project.id, workspaceId: fixture.workspaceId, stateRoot: fixture.legacy,
      backupPath: path.join(fixture.root, "backups", name),
    }));
    const results = await Promise.all(inputs.map((input) => migrator.import(input)));
    expect(results.map((result) => result.imported).sort()).toEqual([0, 3]);
    expect(fixture.repositories.database.prepare("SELECT count(*) AS count FROM legacy_import_batches").get())
      .toEqual({ count: 1 });

    fs.unlinkSync(path.join(fixture.legacy, "sessions", `${fixture.workspaceId}.json`));
    await expect(migrator.import({ ...inputs[0], backupPath: path.join(fixture.root, "removed.sqlite3") }))
      .rejects.toMatchObject({ code: "IMPORT_CONFLICT" });
    expect(fs.existsSync(path.join(fixture.root, "removed.sqlite3"))).toBe(false);
    fixture.database.close();
  });

  it("rejects backups that could overwrite the live database or V1 sources", async () => {
    const fixture = setup(); const migrator = new V1StateMigrator(fixture.repositories);
    for (const backupPath of [fixture.databaseFile, path.join(fixture.legacy, "prefs.json")]) {
      await expect(migrator.import({ projectId: fixture.project.id, workspaceId: fixture.workspaceId,
        stateRoot: fixture.legacy, backupPath })).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    }
    expect(JSON.parse(fs.readFileSync(path.join(fixture.legacy, "prefs.json"), "utf8")))
      .toMatchObject({ developerModeEnabled: true });
    expect(fixture.repositories.database.prepare("SELECT count(*) AS count FROM legacy_import_batches").get())
      .toEqual({ count: 0 });
    fixture.database.close();
  });

  it("persists the canonical backup path across replay through a symlinked parent", async () => {
    if (process.platform === "win32") return;
    const fixture = setup(); const migrator = new V1StateMigrator(fixture.repositories);
    const realParent = path.join(fixture.root, "real-backups"); fs.mkdirSync(realParent);
    const linkedParent = path.join(fixture.root, "linked-backups"); fs.symlinkSync(realParent, linkedParent);
    const lexicalBackup = path.join(linkedParent, "before.sqlite3");
    const canonicalBackup = path.join(realParent, "before.sqlite3");
    const first = await migrator.import({ projectId: fixture.project.id, workspaceId: fixture.workspaceId,
      stateRoot: fixture.legacy, backupPath: lexicalBackup });
    const replay = await migrator.import({ projectId: fixture.project.id, workspaceId: fixture.workspaceId,
      stateRoot: fixture.legacy, backupPath: path.join(fixture.root, "unused.sqlite3") });
    expect(first.backupPath).toBe(canonicalBackup); expect(replay.backupPath).toBe(canonicalBackup);
    expect(fixture.repositories.database.prepare("SELECT backup_path FROM legacy_import_batches").get())
      .toEqual({ backup_path: canonicalBackup });
    fixture.database.close();
  });
});

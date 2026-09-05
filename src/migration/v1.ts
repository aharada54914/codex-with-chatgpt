import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { backupDatabase } from "../state/database.js";
import type { DomainRepositories } from "../state/repository.js";
import { ProjectRegistry } from "../projects/registry.js";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const workspaceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const recordSchema = z.object({
  taskId: z.string(), iteration: z.number().int().nonnegative(),
  changedFiles: z.union([z.array(z.string()), z.number().int().nonnegative()]),
  tests: z.string().nullable(), exitStatus: z.string(), timestamp: z.string(), notes: z.string().optional(),
  outputId: z.number().int().positive().optional(), outputAvailable: z.boolean().optional(),
}).strict();
const sessionSchema = z.object({
  url: z.string().optional(), title: z.string().optional(), taskId: z.string().optional(),
  iteration: z.number().int().nonnegative().optional(), lastState: z.string().optional(), savedAt: z.string(),
  conversationMode: z.enum(["long-chat", "project"]).optional(), projectUrl: z.string().optional(),
  connectorName: z.string().optional(), checkpoint: z.record(z.unknown()).optional(),
}).strict();
const prefsSchema = z.object({
  developerModeEnabled: z.boolean().optional(), setupMode: z.enum(["auto", "manual"]).optional(), updatedAt: z.string(),
}).strict();

type LegacyItem = { sourceKey: string; kind: "execution" | "session" | "preferences"; payload: unknown; fingerprint: string };
export interface V1ImportResult { batchId: string; backupPath: string; imported: number; replayed: boolean }

export class V1MigrationError extends Error {
  constructor(public readonly code: "INVALID_SOURCE" | "UNKNOWN_PROJECT" | "PROJECT_MISMATCH" | "IMPORT_CONFLICT" | "UNSUPPORTED_SOURCE" | "UNKNOWN_BATCH", message: string) {
    super(message); this.name = "V1MigrationError";
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalizeForCreation(file: string): string {
  const suffix: string[] = []; let current = path.resolve(file);
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...suffix); } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(file);
      suffix.unshift(path.basename(current)); current = parent;
    }
  }
}

function validateBackupDestination(stateRoot: string, databaseFile: string, backupPath: string): string {
  const sourceRoot = fs.realpathSync.native(path.resolve(stateRoot));
  const destination = canonicalizeForCreation(backupPath);
  const liveDatabase = fs.realpathSync.native(path.resolve(databaseFile));
  if (destination === liveDatabase || destination === sourceRoot || destination.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new V1MigrationError("INVALID_SOURCE", "Backup destination must be outside V1 state and must not replace the live database");
  }
  return destination;
}

function readRegularFile(file: string): string | null {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_BYTES) {
    throw new V1MigrationError("INVALID_SOURCE", `Legacy source must be a bounded regular file: ${file}`);
  }
  return fs.readFileSync(file, "utf8");
}

function parseJson(file: string, schema: z.ZodTypeAny): unknown | null {
  const content = readRegularFile(file); if (content === null) return null;
  try { return schema.parse(JSON.parse(content)); } catch {
    throw new V1MigrationError("INVALID_SOURCE", `Legacy JSON is invalid: ${file}`);
  }
}

function loadItems(stateRoot: string, workspaceId: string): LegacyItem[] {
  const items: LegacyItem[] = [];
  const recordsFile = path.join(stateRoot, "executions", `${workspaceId}.jsonl`);
  const records = readRegularFile(recordsFile);
  if (records !== null) {
    for (const [index, line] of records.split("\n").entries()) {
      if (!line.trim()) continue;
      let payload: unknown;
      try { payload = recordSchema.parse(JSON.parse(line)); } catch {
        throw new V1MigrationError("INVALID_SOURCE", `Legacy execution record is invalid: ${recordsFile}:${index + 1}`);
      }
      const record = payload as z.infer<typeof recordSchema>;
      if (record.outputAvailable === true || record.outputId !== undefined) {
        throw new V1MigrationError(
          "UNSUPPORTED_SOURCE",
          `Legacy execution output references are not supported by this metadata-only importer: ${recordsFile}:${index + 1}`,
        );
      }
      items.push({ sourceKey: `execution:${workspaceId}:${index + 1}`, kind: "execution", payload, fingerprint: fingerprint(payload) });
    }
  }
  const session = parseJson(path.join(stateRoot, "sessions", `${workspaceId}.json`), sessionSchema);
  if (session !== null) items.push({ sourceKey: `session:${workspaceId}`, kind: "session", payload: session, fingerprint: fingerprint(session) });
  const prefs = parseJson(path.join(stateRoot, "prefs.json"), prefsSchema);
  if (prefs !== null) items.push({ sourceKey: "preferences:machine", kind: "preferences", payload: prefs, fingerprint: fingerprint(prefs) });
  return items;
}

export class V1StateMigrator {
  constructor(private readonly repositories: DomainRepositories) {}

  async import(input: { projectId: string; workspaceId: string; stateRoot: string; backupPath: string }): Promise<V1ImportResult> {
    const workspaceId = workspaceIdSchema.safeParse(input.workspaceId);
    if (!workspaceId.success) throw new V1MigrationError("INVALID_SOURCE", "Invalid legacy workspace id");
    if (!this.repositories.projects.get(input.projectId)) throw new V1MigrationError("UNKNOWN_PROJECT", "Register the project before importing V1 metadata");
    let resolvedWorkspaceId: string;
    try { resolvedWorkspaceId = new ProjectRegistry(this.repositories).resolveWorkspace(input.projectId).id; } catch {
      throw new V1MigrationError("PROJECT_MISMATCH", "The registered project root is unavailable or its identity changed");
    }
    if (resolvedWorkspaceId !== workspaceId.data) {
      throw new V1MigrationError("PROJECT_MISMATCH", "Legacy workspace id does not match the registered project root");
    }
    const stateRoot = path.resolve(input.stateRoot);
    const backupPath = validateBackupDestination(stateRoot, this.repositories.database.name, input.backupPath);
    const items = loadItems(stateRoot, workspaceId.data);
    const sourceFingerprint = fingerprint(items.map(({ sourceKey, fingerprint: itemFingerprint }) => [sourceKey, itemFingerprint]));
    const findExisting = () => this.repositories.database.prepare(`SELECT id, backup_path FROM legacy_import_batches
      WHERE project_id = ? AND workspace_id = ? AND source_fingerprint = ?`).get(
      input.projectId, workspaceId.data, sourceFingerprint,
    ) as { id: string; backup_path: string } | undefined;
    const assertNoDrift = () => {
      const prior = this.repositories.database.prepare(`SELECT source_key, source_fingerprint FROM legacy_metadata
        WHERE project_id = ? AND workspace_id = ? ORDER BY source_key`).all(input.projectId, workspaceId.data) as
        Array<{ source_key: string; source_fingerprint: string }>;
      const current = new Map(items.map((item) => [item.sourceKey, item.fingerprint]));
      for (const row of prior) {
        if (current.get(row.source_key) !== row.source_fingerprint) {
          throw new V1MigrationError("IMPORT_CONFLICT", `Legacy source changed or was removed after import: ${row.source_key}`);
        }
      }
    };
    const existing = findExisting();
    if (existing) return { batchId: existing.id, backupPath: existing.backup_path, imported: 0, replayed: true };
    assertNoDrift();
    await backupDatabase(this.repositories.database, backupPath);
    const batchId = `v1_${randomBytes(16).toString("hex")}`; const importedAt = new Date().toISOString();
    const outcome = this.repositories.transaction(() => {
      const concurrent = findExisting();
      if (concurrent) return { batchId: concurrent.id, backupPath: concurrent.backup_path, imported: 0, replayed: true };
      assertNoDrift();
      this.repositories.database.prepare(`INSERT INTO legacy_import_batches
        (id, project_id, workspace_id, source_fingerprint, backup_path, imported_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(batchId, input.projectId, workspaceId.data, sourceFingerprint, backupPath, importedAt);
      let count = 0;
      for (const item of items) {
        const result = this.repositories.database.prepare(`INSERT OR IGNORE INTO legacy_metadata
          (source_key, batch_id, project_id, workspace_id, kind, source_fingerprint, payload_json, imported_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(item.sourceKey, batchId, input.projectId, workspaceId.data, item.kind,
          item.fingerprint, JSON.stringify(item.payload), importedAt);
        count += result.changes;
      }
      return { batchId, backupPath, imported: count, replayed: false };
    });
    return outcome;
  }

  rollback(batchId: string): number {
    return this.repositories.transaction(() => {
      const batch = this.repositories.database.prepare("SELECT id FROM legacy_import_batches WHERE id = ?").get(batchId);
      if (!batch) throw new V1MigrationError("UNKNOWN_BATCH", "Unknown V1 import batch");
      const deleted = this.repositories.database.prepare("DELETE FROM legacy_metadata WHERE batch_id = ?").run(batchId).changes;
      this.repositories.database.prepare("DELETE FROM legacy_import_batches WHERE id = ?").run(batchId);
      return deleted;
    });
  }
}

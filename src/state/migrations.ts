import type Database from "better-sqlite3";

export type Migration = { version: number; name: string; apply(database: Database.Database): void };

const recordTables = [
  "projects", "activities", "agents", "jobs", "approvals", "evidence", "reviews", "operations", "audit_events",
] as const;

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "durable-domain-records",
    apply(database) {
      for (const table of recordTables) {
        database.exec(`
          CREATE TABLE ${table} (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            revision INTEGER NOT NULL CHECK (revision >= 0),
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX ${table}_project_idx ON ${table}(project_id);
        `);
      }
      database.exec("CREATE UNIQUE INDEX operations_idempotency_idx ON operations(json_extract(payload_json, '$.idempotencyKey'));");
    },
  },
  {
    version: 2,
    name: "unique-project-roots",
    apply(database) {
      const legacy = database.prepare(`SELECT id FROM projects
        WHERE json_type(payload_json, '$.canonicalRoot') IS NOT 'text'
           OR json_type(payload_json, '$.filesystemIdentity') IS NOT 'text'
        LIMIT 1`).get() as { id: string } | undefined;
      if (legacy) {
        throw new Error(
          `Cannot migrate legacy project '${legacy.id}': re-register its workspace with the V2 Project Registry`,
        );
      }
      database.exec(`CREATE UNIQUE INDEX projects_root_fingerprint_unique
        ON projects(json_extract(payload_json, '$.rootFingerprint'))`);
    },
  },
  {
    version: 3,
    name: "projection-revision-triggers",
    apply(database) {
      for (const table of ["approvals", "evidence", "reviews"] as const) {
        database.exec(`
          CREATE TRIGGER ${table}_projection_insert AFTER INSERT ON ${table}
          BEGIN
            UPDATE activities SET revision = revision + 1, updated_at = NEW.updated_at
              WHERE id = json_extract(NEW.payload_json, '$.activityId');
            UPDATE ${table} SET payload_json = json_set(
              payload_json, '$.activityRevision',
              (SELECT revision FROM activities WHERE id = json_extract(NEW.payload_json, '$.activityId'))
            ) WHERE id = NEW.id;
          END;
          CREATE TRIGGER ${table}_projection_update AFTER UPDATE OF payload_json ON ${table}
          WHEN json_extract(NEW.payload_json, '$.activityRevision') IS json_extract(OLD.payload_json, '$.activityRevision')
          BEGIN
            UPDATE activities SET revision = revision + 1, updated_at = NEW.updated_at
              WHERE id = json_extract(NEW.payload_json, '$.activityId');
            UPDATE ${table} SET payload_json = json_set(
              payload_json, '$.activityRevision',
              (SELECT revision FROM activities WHERE id = json_extract(NEW.payload_json, '$.activityId'))
            ) WHERE id = NEW.id;
          END;
          CREATE TRIGGER ${table}_projection_delete AFTER DELETE ON ${table}
          BEGIN
            UPDATE activities SET revision = revision + 1, updated_at = OLD.updated_at
              WHERE id = json_extract(OLD.payload_json, '$.activityId');
          END;
        `);
      }
    },
  },
  {
    version: 4,
    name: "unique-review-attempts",
    apply(database) {
      database.exec(`CREATE UNIQUE INDEX agents_reviewer_attempt_unique
        ON agents(
          json_extract(payload_json, '$.activityId'),
          json_extract(payload_json, '$.attempt')
        )
        WHERE json_extract(payload_json, '$.role') = 'reviewer'
          AND json_type(payload_json, '$.attempt') = 'integer'`);
    },
  },
  {
    version: 5,
    name: "approval-idempotency",
    apply(database) {
      database.exec(`
        CREATE UNIQUE INDEX approvals_request_idempotency_unique
          ON approvals(json_extract(payload_json, '$.requestIdempotencyKey'))
          WHERE json_type(payload_json, '$.requestIdempotencyKey') = 'text';
        CREATE UNIQUE INDEX approvals_response_idempotency_unique
          ON approvals(json_extract(payload_json, '$.responseIdempotencyKey'))
          WHERE json_type(payload_json, '$.responseIdempotencyKey') = 'text';
      `);
    },
  },
];

export function migrate(database: Database.Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
  const versions = new Set(applied.map((row) => row.version));
  for (const migration of migrations) {
    if (versions.has(migration.version)) continue;
    database.transaction(() => {
      migration.apply(database);
      database.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, new Date().toISOString());
    })();
  }
}

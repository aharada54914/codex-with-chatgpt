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

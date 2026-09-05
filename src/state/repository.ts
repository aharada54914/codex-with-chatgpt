import type { StateDatabase } from "./database.js";
import type { DomainKind, DomainRecord, DomainRecordByKind } from "../domain/types.js";

type StoredRow = {
  id: string;
  project_id: string | null;
  revision: number;
  payload_json: string;
  created_at: string;
  updated_at: string;
};

export interface Repository<T extends DomainRecord> {
  insert(record: T): void;
  get(id: string): T | null;
  listByProject(projectId: string | null): T[];
  update(record: T): boolean;
  updateExpected(record: T, expectedRevision: number): boolean;
  delete(id: string): boolean;
}

const DOMAIN_TABLES = new Set<DomainKind>([
  "projects", "activities", "agents", "jobs", "approvals", "evidence", "reviews", "operations", "audit_events",
]);

function hydrate<T extends DomainRecord>(row: StoredRow): T {
  return {
    ...JSON.parse(row.payload_json) as object,
    id: row.id,
    projectId: row.project_id,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as T;
}

export class SqliteRepository<K extends DomainKind> implements Repository<DomainRecordByKind[K]> {
  constructor(private readonly database: StateDatabase, private readonly table: K) {
    if (!DOMAIN_TABLES.has(table)) throw new Error(`invalid domain table: ${String(table)}`);
  }

  insert(record: DomainRecordByKind[K]): void {
    this.database.prepare(`INSERT INTO ${this.table}
      (id, project_id, revision, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.projectId, record.revision, JSON.stringify(record), record.createdAt, record.updatedAt);
  }

  get(id: string): DomainRecordByKind[K] | null {
    const row = this.database.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).get(id) as StoredRow | undefined;
    return row ? hydrate<DomainRecordByKind[K]>(row) : null;
  }

  listByProject(projectId: string | null): DomainRecordByKind[K][] {
    const rows = projectId === null
      ? this.database.prepare(`SELECT * FROM ${this.table} WHERE project_id IS NULL ORDER BY created_at, id`).all()
      : this.database.prepare(`SELECT * FROM ${this.table} WHERE project_id = ? ORDER BY created_at, id`).all(projectId);
    return (rows as StoredRow[]).map(hydrate<DomainRecordByKind[K]>);
  }

  update(record: DomainRecordByKind[K]): boolean {
    const result = this.database.prepare(`UPDATE ${this.table} SET project_id = ?, revision = ?, payload_json = ?, updated_at = ? WHERE id = ?`)
      .run(record.projectId, record.revision, JSON.stringify(record), record.updatedAt, record.id);
    return result.changes === 1;
  }

  updateExpected(record: DomainRecordByKind[K], expectedRevision: number): boolean {
    const result = this.database.prepare(`UPDATE ${this.table}
      SET project_id = ?, revision = ?, payload_json = ?, updated_at = ?
      WHERE id = ? AND revision = ?`)
      .run(record.projectId, record.revision, JSON.stringify(record), record.updatedAt, record.id, expectedRevision);
    return result.changes === 1;
  }

  delete(id: string): boolean {
    return this.database.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id).changes === 1;
  }
}

export class DomainRepositories {
  readonly projects: SqliteRepository<"projects">;
  readonly activities: SqliteRepository<"activities">;
  readonly agents: SqliteRepository<"agents">;
  readonly jobs: SqliteRepository<"jobs">;
  readonly approvals: SqliteRepository<"approvals">;
  readonly evidence: SqliteRepository<"evidence">;
  readonly reviews: SqliteRepository<"reviews">;
  readonly operations: SqliteRepository<"operations">;
  readonly auditEvents: SqliteRepository<"audit_events">;

  constructor(readonly database: StateDatabase) {
    this.projects = new SqliteRepository(database, "projects");
    this.activities = new SqliteRepository(database, "activities");
    this.agents = new SqliteRepository(database, "agents");
    this.jobs = new SqliteRepository(database, "jobs");
    this.approvals = new SqliteRepository(database, "approvals");
    this.evidence = new SqliteRepository(database, "evidence");
    this.reviews = new SqliteRepository(database, "reviews");
    this.operations = new SqliteRepository(database, "operations");
    this.auditEvents = new SqliteRepository(database, "audit_events");
  }

  transaction<T>(operation: () => T): T {
    // Acquire the write reservation before any revision read. This prevents a
    // deferred WAL snapshot from failing later with SQLITE_BUSY_SNAPSHOT.
    return this.database.transaction(operation).immediate();
  }

  findOperationByIdempotencyKey(idempotencyKey: string): DomainRecordByKind["operations"] | null {
    const row = this.database.prepare(`SELECT * FROM operations
      WHERE json_extract(payload_json, '$.idempotencyKey') = ?`).get(idempotencyKey) as StoredRow | undefined;
    return row ? hydrate<DomainRecordByKind["operations"]>(row) : null;
  }
}

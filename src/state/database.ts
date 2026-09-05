import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import { ensureDir, stateSubdir } from "../config/paths.js";
import { migrate } from "./migrations.js";

export type StateDatabase = Database.Database;

function prepareSecureFile(file: string): void {
  const parent = path.dirname(file);
  const parentExisted = fs.existsSync(parent);
  const directory = ensureDir(parent);
  if (!parentExisted && process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const existing = (() => { try { return fs.lstatSync(file); } catch { return null; } })();
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(`state database path must be a regular file: ${file}`);
  }
  const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
  const descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | noFollow, 0o600);
  fs.closeSync(descriptor);
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

export function defaultDatabasePath(): string {
  return path.join(stateSubdir("v2"), "state.sqlite3");
}

export function openStateDatabase(file = defaultDatabasePath()): StateDatabase {
  prepareSecureFile(file);
  const database = new Database(file);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    migrate(database);
    return database;
  } catch (error) {
    try { database.close(); } catch (closeError) {
      throw new AggregateError([error, closeError], "SQLite initialization and cleanup failed");
    }
    throw error;
  }
}

export function verifyDatabase(database: StateDatabase): void {
  const rows = database.pragma("integrity_check") as Array<{ integrity_check: string }>;
  if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
    throw new Error(`SQLite integrity check failed: ${JSON.stringify(rows)}`);
  }
}

export async function backupDatabase(database: StateDatabase, destination: string): Promise<void> {
  ensureDir(path.dirname(destination));
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    prepareSecureFile(temporary);
    await database.backup(temporary);
    const backup = new Database(temporary, { readonly: true });
    try { verifyDatabase(backup); } finally { backup.close(); }
    fs.renameSync(temporary, destination);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

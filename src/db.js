import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Apply the SQLite schema as soon as the database is opened. This makes every
// entry point (API server, migration command, scripts) safe against an empty DB.
const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));
const schema = fs.readFileSync(schemaPath, 'utf8');
db.transaction(() => db.exec(schema))();

export async function exec(sql) {
  db.exec(sql);
}

export async function query(sql, params = []) {
  const statement = db.prepare(sql);
  const bindings = params.map((value) => value === undefined ? null : value);
  if (statement.reader) return statement.all(...bindings);
  const result = statement.run(...bindings);
  return { insertId: Number(result.lastInsertRowid), affectedRows: result.changes };
}

export async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

export async function close() {
  db.close();
}

// Pluggable storage adapter for @agentpro/scroll-continuity.
// Default implementation uses Node.js built-in `node:sqlite` (zero external dependencies).
// Future multi-node deployments can supply a Postgres/RLS adapter matching the same interface.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function createSqliteStorageAdapter({
  dbPath = ':memory:',
  synchronous = 'NORMAL',
  busyTimeoutMs = 5000,
  walMode = true,
} = {}) {
  const isMemory = !dbPath || dbPath === ':memory:';
  if (!isMemory) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(isMemory ? ':memory:' : dbPath);
  if (!isMemory && walMode) {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  const syncMode = ['OFF', 'NORMAL', 'FULL', 'EXTRA'].includes(String(synchronous).toUpperCase())
    ? String(synchronous).toUpperCase()
    : 'NORMAL';
  db.exec(`PRAGMA synchronous = ${syncMode};`);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`PRAGMA busy_timeout = ${Math.max(500, Number(busyTimeoutMs) || 5000)};`);

  let closed = false;

  function ensureOpen() {
    if (closed) throw new Error('Continuity storage adapter is closed');
  }

  function exec(sql) {
    ensureOpen();
    return db.exec(sql);
  }

  function prepare(sql) {
    ensureOpen();
    return db.prepare(sql);
  }

  function transaction(fn) {
    ensureOpen();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const res = fn();
      db.exec('COMMIT;');
      return res;
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch { /* ignore rollback error */ }
      throw err;
    }
  }

  function checkpoint() {
    ensureOpen();
    if (isMemory) return { ok: true, memory: true };
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch { /* ignore if not WAL */ }
    return { ok: true };
  }

  function verifyIntegrity() {
    ensureOpen();
    const row = db.prepare('PRAGMA quick_check;').get();
    const val = row ? Object.values(row)[0] : null;
    return { ok: val === 'ok', detail: String(val || 'unknown') };
  }

  function backupTo(destPath) {
    ensureOpen();
    if (!destPath) throw new Error('backupTo requires destPath');
    fs.mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 });
    if (isMemory) {
      throw new Error('Cannot file-backup an in-memory SQLite database');
    }
    checkpoint();
    const escaped = String(destPath).replace(/'/g, "''");
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    db.exec(`VACUUM INTO '${escaped}';`);
    fs.chmodSync(destPath, 0o600);
    const verifyDb = new DatabaseSync(destPath, { open: true, readOnly: true });
    try {
      const chk = verifyDb.prepare('PRAGMA quick_check;').get();
      const val = chk ? Object.values(chk)[0] : null;
      return { ok: val === 'ok', destPath, sizeBytes: fs.statSync(destPath).size };
    } finally {
      verifyDb.close();
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    try { db.close(); } catch { /* ignore */ }
  }

  return {
    kind: 'sqlite',
    dbPath: isMemory ? ':memory:' : dbPath,
    isMemory,
    raw: db,
    exec,
    prepare,
    transaction,
    checkpoint,
    verifyIntegrity,
    backupTo,
    close,
  };
}

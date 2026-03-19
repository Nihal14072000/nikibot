/**
 * tools/db.js
 * Cross-platform SQLite wrapper.
 *
 * On Linux/macOS → uses better-sqlite3 (fast, native, production-ready)
 * On Windows     → uses @sqlite.org/sqlite-wasm (pure JS, no build tools needed)
 *
 * Same API surface used in index.js either way.
 */

import os from "os";

const IS_WINDOWS = os.platform() === "win32";

let _db = null;
let _impl = null; // "native" | "wasm"

// ─── Initialise ────────────────────────────────────────────────────────────

export async function initDb(dbPath = "history.db") {
  if (IS_WINDOWS) {
    // Pure JS SQLite — works on Windows without any build tools
    const { default: initSqlJs } = await import("sql.js");
    const fs = await import("fs");
    const SQL = await initSqlJs();

    // Load existing DB file if present
    let dbBuffer;
    try {
      dbBuffer = fs.readFileSync(dbPath);
    } catch {
      dbBuffer = null;
    }

    _db   = dbBuffer ? new SQL.Database(dbBuffer) : new SQL.Database();
    _impl = "wasm";

    // Persist to disk after every write
    _db._save = () => {
      const data = _db.export();
      fs.writeFileSync(dbPath, Buffer.from(data));
    };

    console.log("💾  Database: sql.js (Windows mode)");
  } else {
    // Native better-sqlite3 — Linux/macOS production path
    const { default: Database } = await import("better-sqlite3");
    _db   = new Database(dbPath);
    _impl = "native";
    console.log("💾  Database: better-sqlite3 (native)");
  }

  // Create tables
  exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    TEXT    NOT NULL,
      role       TEXT    NOT NULL,
      content    TEXT    NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat ON messages(chat_id, id);
  `);

  return _db;
}

// ─── Unified API ───────────────────────────────────────────────────────────

export function exec(sql) {
  if (_impl === "wasm") {
    _db.run(sql);
  } else {
    _db.exec(sql);
  }
}

export function prepare(sql) {
  if (_impl === "wasm") {
    // Wrap sql.js statement in a better-sqlite3-compatible interface
    return {
      run(...params) {
        _db.run(sql, params);
        _db._save();
      },
      all(...params) {
        const stmt = _db.prepare(sql);
        const rows = [];
        stmt.bind(params);
        while (stmt.step()) {
          const row = stmt.getAsObject();
          rows.push(row);
        }
        stmt.free();
        return rows;
      },
    };
  } else {
    return _db.prepare(sql);
  }
}

export function close() {
  if (_db) {
    if (_impl === "wasm") _db._save?.();
    else _db.close();
  }
}

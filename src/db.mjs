import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { guidOf, itemIdentity } from './identity.mjs';
import { contentHashes } from './revision.mjs';

/**
 * Schema version. 1 was the original (feed_id, guid)+INSERT OR IGNORE store
 * with no versioning and no delivery state; 2 is the state machine.
 */
export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS feeds (
  id                   TEXT PRIMARY KEY,
  url                  TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL,
  last_fetch_at        TEXT,
  last_nonempty_at     TEXT,
  applied_snapshot_at  TEXT,
  applied_run_id       INTEGER,
  consecutive_empty    INTEGER NOT NULL DEFAULT 0,
  total_runs           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id          TEXT NOT NULL,
  trigger          TEXT NOT NULL DEFAULT 'manual',
  snapshot_at      TEXT NOT NULL,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  status           TEXT NOT NULL DEFAULT 'running',
  raw_hash         TEXT,
  item_count       INTEGER NOT NULL DEFAULT 0,
  new_count        INTEGER NOT NULL DEFAULT 0,
  revision_count   INTEGER NOT NULL DEFAULT 0,
  metadata_count   INTEGER NOT NULL DEFAULT 0,
  unchanged_count  INTEGER NOT NULL DEFAULT 0,
  adopted_count    INTEGER NOT NULL DEFAULT 0,
  absent_count     INTEGER NOT NULL DEFAULT 0,
  delivery_intents INTEGER NOT NULL DEFAULT 0,
  empty            INTEGER NOT NULL DEFAULT 0,
  error            TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id         TEXT NOT NULL,
  identity        TEXT NOT NULL,
  identity_kind   TEXT NOT NULL DEFAULT 'guid',
  weak_identity   INTEGER NOT NULL DEFAULT 0,
  guid            TEXT,
  link_key        TEXT NOT NULL DEFAULT '',
  version         INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  link            TEXT NOT NULL DEFAULT '',
  published       TEXT NOT NULL DEFAULT '',
  summary         TEXT NOT NULL DEFAULT '',
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  last_run_id     INTEGER,
  UNIQUE(feed_id, identity)
);
CREATE UNIQUE INDEX IF NOT EXISTS items_guid_unique
  ON items(feed_id, guid) WHERE guid IS NOT NULL AND guid <> '';
CREATE INDEX IF NOT EXISTS items_link_key ON items(feed_id, link_key);

CREATE TABLE IF NOT EXISTS item_versions (
  item_id       INTEGER NOT NULL,
  feed_id       TEXT NOT NULL,
  identity      TEXT NOT NULL,
  identity_kind TEXT NOT NULL DEFAULT 'guid',
  version       INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  link          TEXT NOT NULL DEFAULT '',
  published     TEXT NOT NULL DEFAULT '',
  summary       TEXT NOT NULL DEFAULT '',
  material      INTEGER NOT NULL DEFAULT 0,
  run_id        INTEGER,
  created_at    TEXT NOT NULL,
  PRIMARY KEY(item_id, version),
  FOREIGN KEY(item_id) REFERENCES items(id)
);

CREATE TABLE IF NOT EXISTS item_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id     TEXT NOT NULL,
  item_id     INTEGER NOT NULL,
  identity    TEXT NOT NULL,
  version     INTEGER NOT NULL,
  event_type  TEXT NOT NULL,
  material    INTEGER NOT NULL DEFAULT 0,
  run_id      INTEGER,
  created_at  TEXT NOT NULL,
  UNIQUE(feed_id, identity, version),
  FOREIGN KEY(item_id) REFERENCES items(id)
);
CREATE INDEX IF NOT EXISTS item_events_feed ON item_events(feed_id, id);

CREATE TABLE IF NOT EXISTS subscriptions (
  feed_id     TEXT NOT NULL,
  subscriber  TEXT NOT NULL,
  notify      TEXT NOT NULL DEFAULT 'new+updates',
  backfill    INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY(feed_id, subscriber)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id          TEXT NOT NULL,
  item_id          INTEGER NOT NULL,
  identity         TEXT NOT NULL,
  version          INTEGER NOT NULL,
  subscriber       TEXT NOT NULL,
  event_id         INTEGER,
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  idempotency_key  TEXT NOT NULL,
  lease_until      TEXT,
  next_attempt_at  TEXT,
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  delivered_at     TEXT,
  external_id      TEXT,
  UNIQUE(feed_id, identity, version, subscriber),
  FOREIGN KEY(item_id) REFERENCES items(id),
  FOREIGN KEY(event_id) REFERENCES item_events(id)
);
CREATE INDEX IF NOT EXISTS deliveries_due
  ON deliveries(status, next_attempt_at, lease_until);
CREATE INDEX IF NOT EXISTS deliveries_feed ON deliveries(feed_id, status);
`;

const LEGACY_TABLES = ['feeds', 'items', 'deliveries'];

function tableExists(db, name) {
  return Boolean(
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function hasLegacySchema(db) {
  return tableExists(db, 'items') && !columnNames(db, 'items').has('version');
}

/**
 * Carry the 0.1 schema forward without pretending history did not exist.
 *
 * Old rows become version 1. Old delivery rows were written before (and
 * independently of) the external send, so they cannot be treated as confirmed;
 * they are imported as `delivered` only because the old code had no other
 * state to distinguish, and a warning counter is returned for the caller.
 */
function migrateLegacy(db, now) {
  const imported = { feeds: 0, items: 0, deliveries: 0 };
  for (const table of LEGACY_TABLES) {
    if (tableExists(db, table)) db.exec(`ALTER TABLE ${table} RENAME TO legacy_${table};`);
  }
  db.exec(SCHEMA);

  if (tableExists(db, 'legacy_feeds')) {
    const rows = db.prepare('SELECT * FROM legacy_feeds').all();
    const insert = db.prepare(
      `INSERT INTO feeds(id, url, created_at, last_fetch_at, last_nonempty_at, total_runs)
       VALUES(?, ?, ?, ?, ?, 0)`,
    );
    for (const row of rows) {
      insert.run(String(row.id), String(row.url ?? ''), now, row.last_seen ?? null, row.last_seen ?? null);
      imported.feeds += 1;
    }
  }

  const itemIdByKey = new Map();
  if (tableExists(db, 'legacy_items')) {
    const rows = db.prepare('SELECT * FROM legacy_items ORDER BY rowid').all();
    const insertItem = db.prepare(
      `INSERT INTO items(feed_id, identity, identity_kind, weak_identity, guid, link_key,
                         version, content_hash, payload_hash, title, link, published, summary,
                         first_seen_at, last_seen_at)
       VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertVersion = db.prepare(
      `INSERT INTO item_versions(item_id, feed_id, identity, identity_kind, version, content_hash,
                                 payload_hash, title, link, published, summary, material, run_id, created_at)
       VALUES(?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, NULL, ?)`,
    );
    const insertEvent = db.prepare(
      `INSERT INTO item_events(feed_id, item_id, identity, version, event_type, material, run_id, created_at)
       VALUES(?, ?, ?, 1, 'new', 1, NULL, ?)`,
    );
    for (const row of rows) {
      const normalized = {
        guid: String(row.guid ?? ''),
        title: String(row.title ?? ''),
        link: String(row.link ?? ''),
        published: String(row.published ?? ''),
        summary: String(row.summary ?? ''),
      };
      const identity = itemIdentity(normalized);
      const hashes = contentHashes(normalized);
      const info = insertItem.run(
        String(row.feed_id), identity.key, identity.kind, identity.weaklyIdentified ? 1 : 0,
        guidOf(normalized), identity.linkKey,
        hashes.contentHash, hashes.payloadHash,
        normalized.title, normalized.link, normalized.published, normalized.summary, now, now,
      );
      const itemId = Number(info.lastInsertRowid);
      itemIdByKey.set(`${row.feed_id}\u0000${row.guid}`, itemId);
      insertVersion.run(
        itemId, String(row.feed_id), identity.key, identity.kind,
        hashes.contentHash, hashes.payloadHash,
        normalized.title, normalized.link, normalized.published, normalized.summary, now,
      );
      insertEvent.run(String(row.feed_id), itemId, identity.key, now);
      imported.items += 1;
    }
  }

  if (tableExists(db, 'legacy_deliveries')) {
    const rows = db.prepare('SELECT * FROM legacy_deliveries ORDER BY rowid').all();
    const insertDelivery = db.prepare(
      `INSERT INTO deliveries(feed_id, item_id, identity, version, subscriber, event_id, reason,
                              status, attempts, idempotency_key, created_at, updated_at, delivered_at)
       VALUES(?, ?, ?, 1, ?, NULL, 'legacy', 'delivered', 1, ?, ?, ?, ?)`,
    );
    const seen = new Set();
    for (const row of rows) {
      const itemId = itemIdByKey.get(`${row.feed_id}\u0000${row.guid}`);
      if (!itemId) continue;
      const item = db.prepare('SELECT identity FROM items WHERE id = ?').get(itemId);
      const key = `${row.feed_id}\u0000${item.identity}\u0000${row.subscriber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      insertDelivery.run(
        String(row.feed_id), itemId, item.identity, String(row.subscriber),
        deliveryKey(row.feed_id, item.identity, 1, row.subscriber),
        row.delivered_at ?? now, row.delivered_at ?? now, row.delivered_at ?? now,
      );
      imported.deliveries += 1;
    }
  }

  for (const table of LEGACY_TABLES) {
    if (tableExists(db, `legacy_${table}`)) db.exec(`DROP TABLE legacy_${table};`);
  }
  return imported;
}

export function deliveryKey(feedId, identity, version, subscriber) {
  return createHash('sha256')
    .update(`${feedId}\u0000${identity}\u0000${version}\u0000${subscriber}`)
    .digest('hex');
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}

function isBusy(error) {
  const text = String(error?.message ?? '');
  return text.includes('SQLITE_BUSY') || text.toLowerCase().includes('database is locked');
}

/**
 * Retry a synchronous operation that can fail with SQLITE_BUSY.
 *
 * `busy_timeout` covers lock acquisition inside ordinary statements, but a
 * few operations (notably changing the journal mode) surface SQLITE_BUSY
 * immediately, so the open sequence needs its own bounded retry.
 */
function withBusyRetry(fn, { attempts = 20, baseDelayMs = 10 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      if (!isBusy(error)) throw error;
      lastError = error;
      sleepSync(baseDelayMs * (attempt + 1) + Math.floor(Math.random() * baseDelayMs));
    }
  }
  throw lastError;
}

export function openDb(dbPath, { now = new Date().toISOString() } = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
  db.exec('PRAGMA busy_timeout = 20000;');

  if (dbPath !== ':memory:') {
    // WAL is what lets readers proceed while an ingest holds the write lock.
    // Changing the journal mode needs an exclusive lock, so two processes
    // opening a fresh database simultaneously can race here; the loser simply
    // retries, and if it cannot win it keeps the existing mode.
    try {
      withBusyRetry(() => db.exec('PRAGMA journal_mode = WAL;'));
    } catch (error) {
      if (!isBusy(error)) throw error;
    }
    db.exec('PRAGMA synchronous = NORMAL;');
  }

  let migration = null;
  // The schema check and the migration must share one write transaction:
  // otherwise two concurrent opens of a 0.1 database can both decide it is
  // legacy and migrate it twice.
  withBusyRetry(() =>
    transaction(db, () => {
      if (hasLegacySchema(db)) migration = migrateLegacy(db, now);
      else db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    }),
  );
  if (migration) db.migration = migration;
  return db;
}

// Nested transactions: DatabaseSync already exposes a read-only
// `isTransaction`, so track whether *we* opened the transaction in a WeakMap.
const transactionDepth = new WeakMap();

export function transaction(db, fn, mode = 'IMMEDIATE') {
  const depth = transactionDepth.get(db) ?? 0;
  if (depth > 0) {
    transactionDepth.set(db, depth + 1);
    try {
      return fn();
    } finally {
      transactionDepth.set(db, depth);
    }
  }
  db.exec(`BEGIN ${mode}`);
  transactionDepth.set(db, 1);
  let result;
  try {
    result = fn();
  } catch (error) {
    transactionDepth.delete(db);
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may already have been rolled back by SQLite.
    }
    throw error;
  }
  // Transactions in the store are synchronous by design; an async callback
  // would commit before its promise settles, so reject it explicitly.
  if (result && typeof result.then === 'function') {
    transactionDepth.delete(db);
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw new Error('transaction callback must be synchronous');
  }
  transactionDepth.delete(db);
  db.exec('COMMIT');
  return result;
}

export function withDb(target, fn) {
  if (typeof target !== 'string') return fn(target, false);
  const db = openDb(target);
  try {
    return fn(db, true);
  } finally {
    db.close();
  }
}

export { guidOf, itemIdentity };

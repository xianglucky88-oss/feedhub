import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createMemoryStore } from './memory-store.mjs';

const quote = (value) => `'${String(value ?? '').replaceAll("'", "''")}'`;

// 探测一次 sqlite3 CLI；缺失时整个进程透明切换到接口一致的内存后端，
// 采集与去重语义（INSERT OR IGNORE、UNIQUE(feed_id,id)）保持等价。
const sqliteAvailable = (() => {
  const probe = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' });
  return probe.status === 0;
})();
const memory = sqliteAvailable ? null : createMemoryStore();

export function execSql(dbPath, sql, json = false) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const args = json ? ['-json', dbPath, sql] : [dbPath, sql];
  const result = spawnSync('sqlite3', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'sqlite3 failed');
  return result.stdout.trim();
}

function tableColumns(dbPath, table) {
  const raw = execSql(dbPath, `PRAGMA table_info(${table});`, true);
  return raw ? JSON.parse(raw).map((row) => row.name) : [];
}

export function initStore(dbPath) {
  if (!sqliteAvailable) return; // 内存后端无需建表
  execSql(dbPath, `
    CREATE TABLE IF NOT EXISTS feeds (id TEXT PRIMARY KEY, url TEXT NOT NULL, last_seen TEXT);
    CREATE TABLE IF NOT EXISTS items (
      feed_id TEXT NOT NULL,
      id TEXT NOT NULL,
      id_kind TEXT,
      guid TEXT,
      title TEXT,
      link TEXT,
      published TEXT,
      updated TEXT,
      summary TEXT,
      source_format TEXT,
      UNIQUE(feed_id, id)
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      feed_id TEXT NOT NULL, id TEXT NOT NULL, subscriber TEXT NOT NULL,
      delivered_at TEXT NOT NULL
    );
  `);

  // 旧库（items 以 guid 为主键列）平滑迁移到 canonical id 模型。
  const columns = tableColumns(dbPath, 'items');
  if (columns.includes('guid') && !columns.includes('id_kind')) {
    execSql(dbPath, `
      ALTER TABLE items RENAME TO items_legacy;
      CREATE TABLE items (
        feed_id TEXT NOT NULL,
        id TEXT NOT NULL,
        id_kind TEXT,
        guid TEXT,
        title TEXT,
        link TEXT,
        published TEXT,
        updated TEXT,
        summary TEXT,
        source_format TEXT,
        UNIQUE(feed_id, id)
      );
      INSERT OR IGNORE INTO items(feed_id, id, guid, title, link, published, summary)
        SELECT feed_id, guid, guid, title, link, published, summary FROM items_legacy;
      DROP TABLE items_legacy;
    `);
  }
}

export function saveFeed(dbPath, feed) {
  if (!sqliteAvailable) return memory.saveFeed(dbPath, feed);
  execSql(dbPath, `INSERT INTO feeds(id, url, last_seen) VALUES(${quote(feed.id)}, ${quote(feed.url)}, ${quote(feed.lastSeen || '')})
    ON CONFLICT(id) DO UPDATE SET url=excluded.url, last_seen=excluded.last_seen;`);
}

export function existingIds(dbPath, feedId) {
  if (!sqliteAvailable) return memory.existingIds(dbPath, feedId);
  const raw = execSql(dbPath, `SELECT id FROM items WHERE feed_id=${quote(feedId)};`, true);
  return new Set((raw ? JSON.parse(raw) : []).map((row) => row.id));
}

// 兼容旧调用名。
export const existingGuids = existingIds;

export function saveItems(dbPath, feedId, entries) {
  if (!sqliteAvailable) {
    entries.forEach((entry) => memory.saveItem(dbPath, feedId, entry));
    return;
  }
  for (const entry of entries) {
    execSql(dbPath, `INSERT OR IGNORE INTO items(feed_id, id, id_kind, guid, title, link, published, updated, summary, source_format)
      VALUES(${quote(feedId)}, ${quote(entry.id)}, ${quote(entry.idKind)}, ${quote(entry.guid)},
      ${quote(entry.title)}, ${quote(entry.link)}, ${quote(entry.published)}, ${quote(entry.updated)},
      ${quote(entry.summary)}, ${quote(entry.sourceFormat)});`);
  }
}

export function recordDeliveries(dbPath, feedId, entries, subscribers) {
  if (!sqliteAvailable) {
    for (const entry of entries) {
      for (const subscriber of subscribers) {
        memory.recordDelivery(dbPath, feedId, entry.id, subscriber, new Date().toISOString());
      }
    }
    return;
  }
  for (const entry of entries) {
    for (const subscriber of subscribers) {
      execSql(dbPath, `INSERT INTO deliveries(feed_id, id, subscriber, delivered_at)
        VALUES(${quote(feedId)}, ${quote(entry.id)}, ${quote(subscriber)}, datetime('now'));`);
    }
  }
}

export function counts(dbPath) {
  if (!sqliteAvailable) return memory.counts(dbPath);
  const raw = execSql(dbPath, `SELECT
    (SELECT count(*) FROM feeds) AS feeds,
    (SELECT count(*) FROM items) AS items,
    (SELECT count(*) FROM deliveries) AS deliveries;`, true);
  return JSON.parse(raw || '[{}]')[0] || { feeds: 0, items: 0, deliveries: 0 };
}

export const storageBackend = sqliteAvailable ? 'sqlite3' : 'memory';

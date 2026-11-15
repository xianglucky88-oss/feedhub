import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

export function execSql(dbPath, sql, json = false) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const args = json ? ['-json', dbPath, sql] : [dbPath, sql];
  const result = spawnSync('sqlite3', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'sqlite3 failed');
  return result.stdout.trim();
}

export function initStore(dbPath) {
  execSql(dbPath, `
    CREATE TABLE IF NOT EXISTS feeds (id TEXT PRIMARY KEY, url TEXT NOT NULL, last_seen TEXT);
    CREATE TABLE IF NOT EXISTS items (
      feed_id TEXT NOT NULL, guid TEXT NOT NULL, title TEXT, link TEXT,
      published TEXT, summary TEXT, UNIQUE(feed_id, guid)
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      feed_id TEXT NOT NULL, guid TEXT NOT NULL, subscriber TEXT NOT NULL,
      delivered_at TEXT NOT NULL
    );
  `);
}

export function saveFeed(dbPath, feed) {
  execSql(dbPath, `INSERT INTO feeds(id, url, last_seen) VALUES(${quote(feed.id)}, ${quote(feed.url)}, ${quote(feed.lastSeen || '')})
    ON CONFLICT(id) DO UPDATE SET url=excluded.url, last_seen=excluded.last_seen;`);
}

export function existingGuids(dbPath, feedId) {
  const raw = execSql(dbPath, `SELECT guid FROM items WHERE feed_id=${quote(feedId)};`, true);
  return new Set((raw ? JSON.parse(raw) : []).map((row) => row.guid));
}

export function saveItems(dbPath, feedId, items) {
  for (const item of items) {
    execSql(dbPath, `INSERT OR IGNORE INTO items(feed_id, guid, title, link, published, summary)
      VALUES(${quote(feedId)}, ${quote(item.guid)}, ${quote(item.title)}, ${quote(item.link)},
      ${quote(item.published)}, ${quote(item.summary)});`);
  }
}

export function recordDeliveries(dbPath, feedId, items, subscribers) {
  for (const item of items) {
    for (const subscriber of subscribers) {
      execSql(dbPath, `INSERT INTO deliveries(feed_id, guid, subscriber, delivered_at)
        VALUES(${quote(feedId)}, ${quote(item.guid)}, ${quote(subscriber)}, datetime('now'));`);
    }
  }
}

export function counts(dbPath) {
  const raw = execSql(dbPath, `SELECT
    (SELECT count(*) FROM feeds) AS feeds,
    (SELECT count(*) FROM items) AS items,
    (SELECT count(*) FROM deliveries) AS deliveries;`, true);
  return JSON.parse(raw || '[{}]')[0] || { feeds: 0, items: 0, deliveries: 0 };
}

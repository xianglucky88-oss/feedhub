import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { toIso } from './clock.mjs';

// 与 health.mjs 的问题状态保持一致；单独定义以避免循环依赖。
const PROBLEM_STATUSES = ['stale', 'invalid-time', 'future-time', 'clock-anomaly'];

// 数据库访问层。
//
// 优先使用 Node 内置的 node:sqlite（Node >= 22.5），在没有该模块时回退到
// sqlite3 命令行。两条路径读写同一份标准 SQLite 文件，因此旧数据库可直接复用。
// 健康状态存放在独立的 feed_health 表中；对既有 feeds 表只追加 observe_seq 列，
// 不改动已有数据，保证旧库兼容。

let native = null;
try {
  native = await import('node:sqlite');
} catch {
  native = null;
}

export const driver = native?.DatabaseSync ? 'node:sqlite' : 'sqlite3-cli';

const quote = (value) => `'${String(value ?? '').replaceAll("'", "''")}'`;
// 可选字段：缺失写 NULL，便于 SQL 侧区分“没有值”和“空字符串”。
const quoteMaybe = (value) =>
  value === null || value === undefined ? 'NULL' : quote(value);

function openNative(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  return new native.DatabaseSync(dbPath);
}

export function execSql(dbPath, sql, json = false) {
  mkdirSync(dirname(dbPath), { recursive: true });
  if (native?.DatabaseSync) {
    const db = openNative(dbPath);
    try {
      if (json) {
        const rows = db.prepare(sql).all().map((row) => ({ ...row }));
        return rows.length ? JSON.stringify(rows) : '';
      }
      db.exec(sql);
      return '';
    } finally {
      db.close();
    }
  }

  const args = json ? ['-json', dbPath, sql] : [dbPath, sql];
  const result = spawnSync('sqlite3', args, { encoding: 'utf8' });
  if (result.error) throw new Error(`sqlite3 unavailable: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr || 'sqlite3 failed');
  return result.stdout.trim();
}

export function query(dbPath, sql) {
  const raw = execSql(dbPath, sql, true);
  return raw ? JSON.parse(raw) : [];
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
    CREATE TABLE IF NOT EXISTS feed_health (
      feed_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      reason TEXT,
      observed_at TEXT,
      observed_raw TEXT,
      evaluated_at TEXT,
      previous_status TEXT,
      last_ok_at TEXT,
      recovered_at TEXT,
      last_problem_status TEXT,
      last_problem_at TEXT,
      clock_regressed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS health_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_id TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      observed_at TEXT,
      previous_status TEXT
    );
  `);
  migrate(dbPath);
}

// 旧库升级：只追加列，不改动既有数据，保证兼容已经存在的 feeds 表。
function migrate(dbPath) {
  const feedColumns = new Set(
    query(dbPath, 'PRAGMA table_info(feeds);').map((row) => row.name),
  );
  if (!feedColumns.has('observe_seq')) {
    execSql(dbPath, 'ALTER TABLE feeds ADD COLUMN observe_seq INTEGER NOT NULL DEFAULT 0;');
  }

  const healthColumns = new Set(
    query(dbPath, 'PRAGMA table_info(feed_health);').map((row) => row.name),
  );
  if (!healthColumns.has('observe_seq')) {
    execSql(dbPath, 'ALTER TABLE feed_health ADD COLUMN observe_seq INTEGER;');
  }
  if (!healthColumns.has('clock_high_water')) {
    execSql(dbPath, 'ALTER TABLE feed_health ADD COLUMN clock_high_water TEXT;');
  }
}

export function readFeed(dbPath, feedId) {
  return query(dbPath, `SELECT id, url, last_seen, observe_seq FROM feeds WHERE id=${quote(feedId)} LIMIT 1;`)[0] || null;
}

export function listFeeds(dbPath) {
  return query(dbPath, `SELECT id, url, last_seen, observe_seq FROM feeds ORDER BY id;`);
}

export function saveFeed(dbPath, feed) {
  // 写入前统一时间语义：能解析的转成 UTC ISO，不能解析的保留原值供诊断，
  // 空值保持空字符串（表示“从未观测”）。
  // observe_seq 每次成功采集自增，作为“是否发生了新的成功采集”的可靠信号。
  const normalized = normalizeStoredTime(feed.lastSeen);
  execSql(dbPath, `INSERT INTO feeds(id, url, last_seen, observe_seq)
    VALUES(${quote(feed.id)}, ${quote(feed.url)}, ${quote(normalized)}, 1)
    ON CONFLICT(id) DO UPDATE SET url=excluded.url, last_seen=excluded.last_seen,
      observe_seq=COALESCE(feeds.observe_seq, 0) + 1;`);
  return readFeed(dbPath, feed.id);
}

function normalizeStoredTime(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' && value.trim() === '') return '';
  return toIso(value) ?? String(value).trim();
}

export function readHealth(dbPath, feedId) {
  return query(dbPath, `SELECT * FROM feed_health WHERE feed_id=${quote(feedId)} LIMIT 1;`)[0] || null;
}

export function saveHealth(dbPath, feedId, health) {
  const previous = readHealth(dbPath, feedId);
  const healthy = health.status === 'fresh' || health.status === 'recovered';
  const problem = PROBLEM_STATUSES.includes(health.status);
  const lastOkAt = healthy ? health.now : previous?.last_ok_at ?? null;
  const recoveredAt =
    health.status === 'recovered' && previous?.status !== 'recovered'
      ? health.now
      : previous?.recovered_at ?? null;
  const lastProblemStatus = problem ? health.status : previous?.last_problem_status ?? null;
  const lastProblemAt = problem ? health.now : previous?.last_problem_at ?? null;
  // evaluated_at 记录“本次评估时间”；clock_high_water 记录历史见过的最大评估时间，
  // 作为时钟回拨检测的高水位。即使进程重启或本机时钟后退，也不会忘掉历史高位。
  // 旧库/迁移前记录没有 clock_high_water 时，用 evaluated_at 兜底。
  const evaluatedAt = health.now;
  const clockHighWater = health.clockHighWaterReset
    ? health.now
    : highWater(previous?.clock_high_water ?? previous?.evaluated_at, health.now);
  // 采集序号只应前进，不应被一次旧值评估回退。
  const observeSeq = maxNumber(previous?.observe_seq, health.observeSeq);
  // 判定层明确要求重置高水位（历史值异常偏大）时，以本次 now 重新起算，
  // 否则保留历史最大值。这样时钟曾向前跳错不会让状态永久卡死。
  const observedRaw = rawForStorage(health.observedRaw);

  execSql(dbPath, `INSERT INTO feed_health(
      feed_id, status, reason, observed_at, observed_raw, evaluated_at,
      previous_status, last_ok_at, recovered_at, last_problem_status, last_problem_at,
      clock_regressed, observe_seq, clock_high_water)
    VALUES(
      ${quote(feedId)}, ${quote(health.status)}, ${quote(health.reason)},
      ${quoteMaybe(health.observedAt)}, ${quote(observedRaw)}, ${quote(evaluatedAt)},
      ${quoteMaybe(health.previousStatus)}, ${quoteMaybe(lastOkAt)}, ${quoteMaybe(recoveredAt)},
      ${quoteMaybe(lastProblemStatus)}, ${quoteMaybe(lastProblemAt)}, ${health.clockRegressed ? 1 : 0},
      ${quoteNumber(observeSeq)}, ${quoteMaybe(clockHighWater)})
    ON CONFLICT(feed_id) DO UPDATE SET
      status=excluded.status,
      reason=excluded.reason,
      observed_at=excluded.observed_at,
      observed_raw=excluded.observed_raw,
      evaluated_at=excluded.evaluated_at,
      previous_status=excluded.previous_status,
      last_ok_at=excluded.last_ok_at,
      recovered_at=excluded.recovered_at,
      last_problem_status=excluded.last_problem_status,
      last_problem_at=excluded.last_problem_at,
      clock_regressed=excluded.clock_regressed,
      observe_seq=excluded.observe_seq,
      clock_high_water=excluded.clock_high_water;`);

  execSql(dbPath, `INSERT INTO health_events(feed_id, evaluated_at, status, reason, observed_at, previous_status)
    VALUES(${quote(feedId)}, ${quote(health.now)}, ${quote(health.status)}, ${quote(health.reason)},
      ${quote(health.observedAt)}, ${quote(health.previousStatus)});`);
}

function quoteNumber(value) {
  return value === null || value === undefined || Number.isNaN(Number(value))
    ? 'NULL'
    : String(Number(value));
}

function maxNumber(a, b) {
  const left = toNumberOrNull(a);
  const right = toNumberOrNull(b);
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function toNumberOrNull(value) {
  return value === null || value === undefined || value === '' ? null : Number(value);
}

function highWater(a, b) {
  const left = toIso(a);
  const right = toIso(b);
  if (left === null) return right;
  if (right === null) return left;
  return left >= right ? left : right;
}

function rawForStorage(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function healthEvents(dbPath, feedId, limit = 20) {
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 20));
  return query(dbPath, `SELECT evaluated_at, status, reason, observed_at, previous_status
    FROM health_events WHERE feed_id=${quote(feedId)}
    ORDER BY id DESC LIMIT ${safeLimit};`);
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

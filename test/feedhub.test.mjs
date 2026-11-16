import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { fixture } from '../src/mockfeed.mjs';
import { parseFeed } from '../src/parse.mjs';
import { normalizeItem } from '../src/normalize.mjs';
import { signature, verifySignature } from '../src/websub.mjs';
import { parseInstant, toIso } from '../src/clock.mjs';
import {
  evaluateHealth,
  checkHealth,
  diagnoseAll,
  describeHealth,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_FUTURE_TOLERANCE_MS,
} from '../src/health.mjs';
import { ingestFeed } from '../src/poll.mjs';
import { initStore, execSql, readFeed, readHealth, saveFeed, healthEvents } from '../src/store.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BASE = '2026-11-16T10:00:00.000Z';
const at = (offsetMs) => new Date(Date.parse(BASE) + offsetMs).toISOString();

let databaseCounter = 0;
function tempDb(name = 'test') {
  databaseCounter += 1;
  const path = `/tmp/feedhub-test/${process.pid}-${databaseCounter}-${name}.db`;
  rmSync(path, { force: true });
  return path;
}

/** 把 evaluateHealth 的结果浓缩成可持久化的 previous 行。 */
function asPrevious(health) {
  return {
    status: health.status,
    observed_at: health.observedAt,
    evaluated_at: health.now,
    last_ok_at: health.lastOkAt,
    recovered_at: health.recoveredAt,
    observe_seq: health.observeSeq,
    clock_high_water: health.clockHighWater,
  };
}

function evaluate(lastSeen, now, previous = null, options = {}) {
  return evaluateHealth({ lastSeen, now, previous, ...options });
}

test('parses the local RSS fixture', () => {
  const parsed = parseFeed(fixture);
  assert.equal(parsed.format, 'rss');
  assert.equal(parsed.items.length, 2);
  assert.equal(normalizeItem(parsed.items[0]).summary, 'hello world');
});

test('rejects formats that are intentionally not implemented', () => {
  assert.throws(() => parseFeed('{"version":"https://jsonfeed.org/version/1"}'), /not implemented/);
});

test('verifies WebSub HMAC signatures', () => {
  const body = 'payload';
  const signed = signature(body, 'secret');
  assert.equal(verifySignature(body, signed, 'secret'), true);
  assert.equal(verifySignature(body, signed, 'wrong'), false);
});

// ---------------------------------------------------------------------------
// 时间解析：时区、秒/毫秒、非法日期、空值
// ---------------------------------------------------------------------------

test('parses timezone offsets, epoch seconds and milliseconds to the same instant', () => {
  const expected = Date.parse('2026-11-16T02:00:00.000Z');
  assert.equal(parseInstant('2026-11-16T10:00:00+08:00').ms, expected);
  assert.equal(parseInstant('2026-11-16T10:00:00+0800').ms, expected);
  assert.equal(parseInstant('Wed, 16 Nov 2026 10:00:00 +0800').ms, expected);
  assert.equal(parseInstant(1794794400).ms, expected); // epoch 秒
  assert.equal(parseInstant(1794794400000).ms, expected); // epoch 毫秒
  assert.equal(parseInstant('1794794400').ms, expected);
  assert.equal(parseInstant('1794794400000').ms, expected);
  // 无时区 ISO 一律按 UTC，不随机器时区漂移。
  assert.equal(parseInstant('2026-11-16T02:00:00').ms, expected);
  assert.equal(parseInstant('2026-11-16 02:00:00').ms, expected);
  // 其他无时区格式（RFC 822、美式日期时间）同样按 UTC，而非机器本地时区。
  assert.equal(parseInstant('Fri, 14 Nov 2026 10:00:00').ms, Date.parse('2026-11-14T10:00:00Z'));
  assert.equal(parseInstant('11/16/2026 02:00:00').ms, expected);
});

test('distinguishes empty, null, garbage and impossible calendar dates', () => {
  for (const empty of [null, undefined, '', '   ']) {
    assert.equal(parseInstant(empty).ms, null);
  }
  for (const bad of ['garbage', 'NaN', 'not-a-time', '1794602', '2026-02-30', '2026-02-30T00:00:00Z', '2026-11-16T25:00:00Z']) {
    assert.equal(parseInstant(bad).ms, null, `${bad} should be invalid`);
  }
  assert.equal(toIso('Fri, 14 Nov 2026 10:00:00 GMT'), '2026-11-14T10:00:00.000Z');
});

// ---------------------------------------------------------------------------
// 状态判定：从未观测 / 无效 / 未来 / 新鲜 / 过期
// ---------------------------------------------------------------------------

test('reports never-observed for missing and empty timestamps', () => {
  const missing = evaluate(null, BASE);
  assert.equal(missing.status, 'never-observed');
  assert.equal(missing.reason, 'never-observed');
  assert.equal(missing.healthy, false);

  const empty = evaluate('   ', BASE);
  assert.equal(empty.status, 'never-observed');
  assert.equal(empty.reason, 'empty-timestamp');
  assert.equal(empty.healthy, false);
});

test('reports invalid-time without treating it as epoch or fresh', () => {
  const health = evaluate('broken-timestamp', BASE);
  assert.equal(health.status, 'invalid-time');
  assert.equal(health.healthy, false);
  assert.equal(health.observedAt, null);
  // 原因与观测时间都必须能在结果中找到。
  assert.ok(health.reason);
  assert.equal(health.now, BASE);
});

test('treats exactly maxAge as stale and one millisecond earlier as fresh', () => {
  const exact = evaluate(BASE, at(DEFAULT_MAX_AGE_MS));
  assert.equal(exact.status, 'stale');
  assert.equal(exact.reason, 'age-at-threshold');
  assert.equal(exact.ageMs, DEFAULT_MAX_AGE_MS);
  assert.equal(exact.healthy, false);

  const justInside = evaluate(BASE, at(DEFAULT_MAX_AGE_MS - 1));
  assert.equal(justInside.status, 'fresh');
  assert.equal(justInside.ageMs, DEFAULT_MAX_AGE_MS - 1);
});

test('reports future timestamps beyond the tolerance instead of calling them fresh', () => {
  const beyond = evaluate(at(DEFAULT_FUTURE_TOLERANCE_MS + 1), BASE);
  assert.equal(beyond.status, 'future-time');
  assert.equal(beyond.healthy, false);
  assert.ok(beyond.ageMs < 0);

  const within = evaluate(at(DEFAULT_FUTURE_TOLERANCE_MS), BASE, {
    status: 'fresh',
    observed_at: at(-HOUR),
    evaluated_at: at(-HOUR),
    last_ok_at: at(-HOUR),
  });
  assert.equal(within.status, 'fresh');
  assert.equal(within.reason, 'within-future-tolerance');
});

test('healthy results expose the observation time and reason used', () => {
  const health = evaluate(BASE, at(1000));
  assert.equal(health.healthy, true);
  assert.equal(health.observedAt, BASE);
  assert.equal(health.now, at(1000));
  assert.equal(health.ageMs, 1000);
  assert.ok(health.detail.length > 0);
  assert.match(describeHealth(health), /observed_at=2026-11-16T10:00:00.000Z/);
});

// ---------------------------------------------------------------------------
// 恢复语义：新观测、重复采集、时钟回拨/恢复
// ---------------------------------------------------------------------------

test('requires a new observation to claim recovery from stale', () => {
  const stale = evaluate(BASE, at(DEFAULT_MAX_AGE_MS), null, {});
  const previous = asPrevious(stale);
  previous.observe_seq = 1;
  previous.last_ok_at = BASE;

  // 时间戳没变：不能称为恢复。
  const repeated = evaluate(BASE, at(DEFAULT_MAX_AGE_MS + HOUR), previous);
  assert.equal(repeated.status, 'stale');

  // 有新的成功采集：恢复。
  const recovered = evaluate(
    at(DEFAULT_MAX_AGE_MS + HOUR),
    at(DEFAULT_MAX_AGE_MS + HOUR),
    previous,
    { observeSeq: 2 },
  );
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.reason, 'recovered-from-stale');
  assert.equal(recovered.healthy, true);
});

test('does not turn a future timestamp into recovery when the clock merely catches up', () => {
  const future = evaluate(at(2 * HOUR), BASE);
  assert.equal(future.status, 'future-time');
  const previous = {
    ...asPrevious(future),
    last_ok_at: BASE,
    observe_seq: 1,
  };

  // 当前时间追上未来观测，但没有新采集：保持异常，不能伪装成恢复。
  const caughtUp = evaluate(at(2 * HOUR), at(2 * HOUR), previous);
  assert.equal(caughtUp.status, 'future-time');
  assert.equal(caughtUp.reason, 'clock-caught-up-awaiting-observation');
  assert.equal(caughtUp.healthy, false);

  // 真正的新采集（序号变大）才恢复。
  const healthy = evaluate(at(2 * HOUR), at(2 * HOUR), previous, { observeSeq: 2 });
  assert.equal(healthy.status, 'recovered');
  assert.equal(healthy.reason, 'recovered-from-future-time');
});

test('detects clock rollback and keeps it until a newer observation arrives', () => {
  const lastOk = at(-HOUR);
  const previous = {
    status: 'fresh',
    observed_at: lastOk,
    evaluated_at: at(-HOUR),
    clock_high_water: at(-HOUR),
    last_ok_at: lastOk,
    observe_seq: 1,
  };

  const rolledBack = evaluate(lastOk, at(-2 * HOUR), previous);
  assert.equal(rolledBack.status, 'clock-anomaly');
  assert.equal(rolledBack.reason, 'clock-regressed');
  assert.equal(rolledBack.clockRegressed, true);
  assert.equal(rolledBack.healthy, false);

  // 时钟回到原位但未重新采集：依旧异常。
  const restored = evaluate(lastOk, at(-HOUR), { ...previous, status: 'clock-anomaly' });
  assert.equal(restored.status, 'clock-anomaly');
  assert.equal(restored.reason, 'clock-restored-awaiting-observation');

  // 时钟恢复且有新的成功采集：恢复。
  const recovered = evaluate(
    at(-HOUR),
    at(-HOUR),
    { ...previous, status: 'clock-anomaly' },
    { observeSeq: 2 },
  );
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.reason, 'recovered-from-clock-anomaly');
});

test('recovers from invalid-time only after the field is repaired', () => {
  const invalid = evaluate('corrupt', BASE);
  assert.equal(invalid.status, 'invalid-time');

  // 沿用损坏记录时仍然无效。
  const stillBad = evaluate('corrupt', at(HOUR), { ...asPrevious(invalid), status: 'invalid-time' });
  assert.equal(stillBad.status, 'invalid-time');

  const repaired = evaluate(BASE, at(HOUR), {
    ...asPrevious(invalid),
    status: 'invalid-time',
    last_ok_at: null,
  });
  assert.equal(repaired.status, 'recovered');
  assert.equal(repaired.reason, 'recovered-from-invalid-time');
});

test('first ever valid observation is fresh, not recovered', () => {
  const first = evaluate(BASE, BASE, {
    status: 'never-observed',
    observed_at: '',
    evaluated_at: BASE,
    last_ok_at: null,
  });
  assert.equal(first.status, 'fresh');
  assert.equal(first.reason, 'first-observation');
});

// ---------------------------------------------------------------------------
// 采集 / 查询 / 诊断共用同一套时间语义
// ---------------------------------------------------------------------------

test('ingest persists normalized UTC timestamps and health uses the same value', () => {
  const dbPath = tempDb('ingest');
  const result = ingestFeed({
    id: 'local',
    url: 'file://fixture',
    raw: fixture,
    dbPath,
    subscribers: ['a'],
    now: '2026-11-16T18:00:00+08:00',
  });

  const stored = readFeed(dbPath, 'local');
  assert.equal(stored.last_seen, '2026-11-16T10:00:00.000Z');
  assert.equal(result.observedAt, stored.last_seen);
  assert.equal(result.health.observedAt, stored.last_seen);
  assert.equal(result.health.now, stored.last_seen);

  const queried = checkHealth(dbPath, 'local', { now: at(HOUR) });
  assert.equal(queried.observedAt, stored.last_seen);
  assert.equal(queried.status, 'fresh');
});

test('duplicate ingests advance observe_seq but keep the same observation time', () => {
  const dbPath = tempDb('duplicate');
  const first = ingestFeed({ id: 'local', url: 'file://fixture', raw: fixture, dbPath, now: BASE });
  const second = ingestFeed({ id: 'local', url: 'file://fixture', raw: fixture, dbPath, now: BASE });

  assert.equal(first.observeSeq, 1);
  assert.equal(second.observeSeq, 2);
  assert.equal(second.fresh, 0);
  assert.equal(second.health.status, 'fresh');
  assert.equal(second.health.reason, 'within-max-age');
});

test('service restart still detects staleness and clock rollback from persisted state', () => {
  const dbPath = tempDb('restart');
  ingestFeed({ id: 'local', url: 'file://fixture', raw: fixture, dbPath, now: BASE });

  // 模拟重启：重新 init，读取持久化的 feed_health。
  initStore(dbPath);
  const stale = checkHealth(dbPath, 'local', { now: at(DEFAULT_MAX_AGE_MS) });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.reason, 'age-at-threshold');

  // 重启后时钟仍可能回拨：高水位已持久化。
  const rollbackDb = tempDb('restart-rollback');
  ingestFeed({ id: 'local', url: 'file://fixture', raw: fixture, dbPath: rollbackDb, now: at(10 * HOUR) });
  initStore(rollbackDb);
  const rollback = checkHealth(rollbackDb, 'local', { now: at(9 * HOUR) });
  assert.equal(rollback.status, 'clock-anomaly');
});

test('repeated state flapping is reported accurately', () => {
  const dbPath = tempDb('flapping');
  const maxAgeMs = HOUR;
  const options = { maxAgeMs, futureToleranceMs: 5 * 60 * 1000 };

  // fresh -> stale(恰好阈值) -> 时钟回拨 -> 时钟恢复待观测 -> 再次回拨 -> 恢复
  const steps = [
    { now: at(30 * 60 * 1000), expected: 'fresh' },
    { now: at(HOUR), expected: 'stale' },
    { now: at(30 * 60 * 1000), expected: 'clock-anomaly' },
    { now: at(50 * 60 * 1000), expected: 'clock-anomaly' },
    // 观测确实老化到阈值：如实报过期，而不是一直用时钟异常掩盖。
    { now: at(HOUR), expected: 'stale' },
    { now: at(90 * 60 * 1000), expected: 'stale' },
  ];

  ingestFeed({ id: 'local', url: 'file://fixture', raw: fixture, dbPath, now: BASE, healthOptions: options });
  for (const step of steps) {
    const health = checkHealth(dbPath, 'local', { ...options, now: step.now });
    assert.equal(health.status, step.expected, `at ${step.now}: ${health.reason}`);
    // 任何一步都不能在源未恢复时误报为健康。
    if (step.expected !== 'fresh') {
      assert.equal(health.healthy, false, `at ${step.now}: ${health.reason}`);
    }
  }

  // 恢复：又一次成功采集，且必须来自可恢复的异常状态。
  const recovered = ingestFeed({
    id: 'local',
    url: 'file://fixture',
    raw: fixture,
    dbPath,
    now: at(2 * HOUR),
    healthOptions: options,
  });
  assert.equal(recovered.health.status, 'recovered');
  assert.ok(recovered.health.reason.startsWith('recovered-from-'));
  assert.equal(recovered.health.healthy, true);
});

// ---------------------------------------------------------------------------
// 旧数据库兼容
// ---------------------------------------------------------------------------

test('reads legacy databases that predate the health tables and observe_seq', () => {
  const dbPath = tempDb('legacy');
  // 模拟旧版本 schema：feeds 无 observe_seq，且没有 feed_health 表。
  execSql(dbPath, `
    CREATE TABLE feeds (id TEXT PRIMARY KEY, url TEXT NOT NULL, last_seen TEXT);
    CREATE TABLE items (
      feed_id TEXT NOT NULL, guid TEXT NOT NULL, title TEXT, link TEXT,
      published TEXT, summary TEXT, UNIQUE(feed_id, guid)
    );
    CREATE TABLE deliveries (
      feed_id TEXT NOT NULL, guid TEXT NOT NULL, subscriber TEXT NOT NULL,
      delivered_at TEXT NOT NULL
    );
    INSERT INTO feeds(id, url, last_seen) VALUES('old', 'file://old', '2026-11-15T10:00:00Z');
  `);

  initStore(dbPath);
  const columns = execSql(dbPath, 'PRAGMA table_info(feeds);', true);
  assert.match(columns, /observe_seq/);

  // 旧记录的时间是秒级无毫秒 + Z，语义同一：应判为过期而非时间无效。
  const health = checkHealth(dbPath, 'old', { now: at(DAY) });
  assert.equal(health.status, 'stale');
  assert.equal(health.observedAt, '2026-11-15T10:00:00.000Z');
});

test('legacy empty last_seen is never-observed, not stale-by-accident', () => {
  const dbPath = tempDb('legacy-empty');
  execSql(dbPath, `
    CREATE TABLE feeds (id TEXT PRIMARY KEY, url TEXT NOT NULL, last_seen TEXT);
    INSERT INTO feeds(id, url, last_seen) VALUES('empty', 'file://empty', '');
    INSERT INTO feeds(id, url, last_seen) VALUES('null-ish', 'file://null', NULL);
  `);
  initStore(dbPath);
  const results = diagnoseAll(dbPath, { now: BASE });
  const byId = Object.fromEntries(results.map((entry) => [entry.feedId, entry.health]));
  assert.equal(byId['empty'].status, 'never-observed');
  assert.equal(byId['empty'].reason, 'empty-timestamp');
  assert.equal(byId['null-ish'].status, 'never-observed');
});

test('migrated old records can be updated by a new ingest', () => {
  const dbPath = tempDb('legacy-upgrade');
  execSql(dbPath, `
    CREATE TABLE feeds (id TEXT PRIMARY KEY, url TEXT NOT NULL, last_seen TEXT);
    INSERT INTO feeds(id, url, last_seen) VALUES('old', 'file://old', '2020-01-01T00:00:00Z');
  `);
  initStore(dbPath);
  const result = ingestFeed({ id: 'old', url: 'file://old', raw: fixture, dbPath, now: BASE });
  assert.equal(result.observeSeq, 1);
  assert.equal(result.health.status, 'recovered');
  assert.equal(result.health.reason, 'recovered-from-stale');
  assert.equal(readHealth(dbPath, 'old').status, 'recovered');
});

test('health events record each evaluation for diagnosis', () => {
  const dbPath = tempDb('events');
  ingestFeed({ id: 'local', url: 'file://fixture', raw: fixture, dbPath, now: BASE });
  checkHealth(dbPath, 'local', { now: at(DEFAULT_MAX_AGE_MS) });
  const events = healthEvents(dbPath, 'local', 10);
  assert.ok(events.length >= 2);
  assert.equal(events[0].status, 'stale');
  assert.ok(events[0].reason);
});

test('explicit now keeps ingest deterministic and rejects invalid now', () => {
  const dbPath = tempDb('now');
  assert.throws(
    () => ingestFeed({ id: 'x', url: 'u', raw: fixture, dbPath, now: 'not-a-time' }),
    /invalid now/,
  );
  const result = ingestFeed({ id: 'x', url: 'u', raw: fixture, dbPath, now: BASE });
  assert.equal(result.observedAt, BASE);
});

test('legacy row whose timestamp is ahead of the clock is a rollback, not a recovery', () => {
  const dbPath = tempDb('legacy-rollback');
  execSql(dbPath, `
    CREATE TABLE feeds (id TEXT PRIMARY KEY, url TEXT NOT NULL, last_seen TEXT);
    INSERT INTO feeds(id, url, last_seen) VALUES('old', 'file://old', '2026-11-20T10:00:00Z');
  `);
  initStore(dbPath);
  const result = ingestFeed({ id: 'old', url: 'file://old', raw: fixture, dbPath, now: BASE });
  assert.equal(result.health.status, 'clock-anomaly');
  assert.equal(result.health.reason, 'clock-regressed');
  assert.equal(result.health.healthy, false);
});

test('a future observation stays abnormal while the clock catches up, then recovers on a real ingest', () => {
  const dbPath = tempDb('future');
  // 时钟/发布方把观测写成未来时间（可用 observedAt 重放该场景）。
  const bogus = ingestFeed({
    id: 'local',
    url: 'file://fixture',
    raw: fixture,
    dbPath,
    now: BASE,
    observedAt: at(2 * HOUR),
  });
  assert.equal(bogus.health.status, 'future-time');
  assert.equal(bogus.health.healthy, false);

  const caughtUp = checkHealth(dbPath, 'local', { now: at(2 * HOUR) });
  assert.equal(caughtUp.status, 'future-time');
  assert.equal(caughtUp.reason, 'clock-caught-up-awaiting-observation');
  assert.equal(caughtUp.healthy, false);

  const later = checkHealth(dbPath, 'local', { now: at(3 * HOUR) });
  assert.equal(later.status, 'future-time');
  assert.equal(later.healthy, false);

  // 真正的修复：新的成功采集，即使时间戳比原来那个未来值更早。
  const fixed = ingestFeed({
    id: 'local',
    url: 'file://fixture',
    raw: fixture,
    dbPath,
    now: at(3 * HOUR),
  });
  assert.equal(fixed.health.status, 'recovered');
  assert.equal(fixed.health.reason, 'recovered-from-future-time');
  assert.equal(fixed.health.healthy, true);
});

test('ingest rejects an unparseable observedAt instead of storing garbage', () => {
  const dbPath = tempDb('bad-observed');
  assert.throws(
    () => ingestFeed({
      id: 'x', url: 'u', raw: fixture, dbPath, now: BASE, observedAt: '2026-02-30T00:00:00Z',
    }),
    /invalid observedAt/,
  );
});

test('a badly forward-jumped clock does not wedge the status forever', () => {
  const dbPath = tempDb('high-water');
  const options = { maxClockRollbackMs: 2 * DAY };

  // 时钟错误地向前跳了 30 天并完成一次采集。
  ingestFeed({
    id: 'x', url: 'u', raw: fixture, dbPath,
    now: '2026-12-16T10:00:00Z', healthOptions: options,
  });

  // 时钟被校正回来：首次评估保守报异常，同时重置陈旧高水位。
  const corrected = checkHealth(dbPath, 'x', { ...options, now: BASE });
  assert.equal(corrected.status, 'clock-anomaly');
  assert.equal(corrected.reason, 'clock-high-water-reset');
  assert.equal(corrected.clockHighWaterReset, true);
  assert.equal(corrected.healthy, false);
  assert.equal(readHealth(dbPath, 'x').clock_high_water, BASE);

  // 之后正常采集即可恢复，且状态不会永久卡死。
  const recovered = ingestFeed({
    id: 'x', url: 'u', raw: fixture, dbPath, now: '2026-11-16T10:05:00Z', healthOptions: options,
  });
  assert.equal(recovered.health.status, 'recovered');
  assert.equal(recovered.health.healthy, true);

  const later = checkHealth(dbPath, 'x', { ...options, now: '2026-11-16T10:10:00Z' });
  assert.equal(later.healthy, true);
});

test('a rollback within the allowed window is still reported as clock-anomaly, not reset', () => {
  const dbPath = tempDb('small-rollback');
  const options = { maxClockRollbackMs: 7 * DAY };
  ingestFeed({ id: 'x', url: 'u', raw: fixture, dbPath, now: BASE, healthOptions: options });
  const health = checkHealth(dbPath, 'x', { ...options, now: at(-HOUR) });
  assert.equal(health.status, 'clock-anomaly');
  assert.equal(health.reason, 'clock-regressed');
  assert.equal(health.clockHighWaterReset, false);
  assert.equal(readHealth(dbPath, 'x').clock_high_water, BASE);
});


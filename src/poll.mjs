import {
  existingGuids,
  initStore,
  saveFeed,
  saveItems,
  recordDeliveries,
  readHealth,
  readFeed,
  saveHealth as persistHealth,
} from './store.mjs';
import { parseFeed } from './parse.mjs';
import { normalizeItem } from './normalize.mjs';
import { newItems } from './update-detect.mjs';
import { parseInstant, toIso } from './clock.mjs';
import { evaluateHealth, PROBLEM_STATUSES } from './health.mjs';

/**
 * 为没有 feed_health 记录的旧库构造“上一次状态”。
 * 用旧 last_seen 与本次采集时间比较：已过期则视为 stale，否则视为已有观测，
 * 这样升级后的首次采集能够正确报告 recovered，而不是 first-observation。
 * 采集序号从 0 起算，本次采集会得到 1 > 0，因此被识别为新观测。
 *
 * 时钟高水位取“旧观测时间”和“本次 now”的较大者：若旧记录的时间晚于当前时钟，
 * 说明跨升级发生了时钟回拨，必须让调用方把它识别为 clock-anomaly 而非恢复。
 * 回拨幅度超过默认上限（疑似历史上时钟向前跳错）时，交由 evaluateHealth 重置高水位，
 * 避免升级后的状态被陈旧高水位永久卡死。
 */
function legacyPrevious(feed, now, options) {
  if (!feed) return null;
  const health = evaluateHealth({
    lastSeen: feed.last_seen,
    observeSeq: 0,
    now,
    previous: null,
    ...options,
  });
  const nowMs = parseInstant(now).ms;
  const observedMs = parseInstant(feed.last_seen).ms;
  const highWater = Math.max(nowMs ?? 0, observedMs ?? 0);
  return {
    status: health.status,
    observed_at: health.observedAt,
    observed_raw: feed.last_seen,
    evaluated_at: health.now,
    last_ok_at: health.status === 'fresh' ? health.now : null,
    recovered_at: null,
    observe_seq: 0,
    clock_high_water: toIso(highWater),
  };
}

/**
 * 采集一个源。
 *
 * 写入的最后观测时间与健康查询使用同一套时间语义（src/clock.mjs）：
 * - 默认以当前时钟的 UTC ISO（毫秒）作为 last_seen；
 * - 调用方可传入 now 以构造确定性场景（时钟回拨/恢复测试）；
 * - 也可用 observedAt 显式指定写入的最后观测时间（例如重放时钟跳变记录），
 *   此时时间戳同样经 src/clock.mjs 规范化后再落库；
 * - 每次成功采集自增 observe_seq，健康判定据此识别“新的成功采集”，
 *   不依赖时间戳大小（未来时间戳修复后可能比旧值更小）；
 * - 采集完成后立即用同一 now 评估健康，避免采集与查询之间出现语义漂移。
 */
export function ingestFeed({
  id,
  url,
  raw,
  dbPath,
  subscribers = [],
  now = Date.now(),
  observedAt: observedOverride,
  healthOptions = {},
}) {
  initStore(dbPath);
  const nowIso = toIso(now);
  if (nowIso === null) throw new TypeError(`invalid now value: ${String(now)}`);
  const observedAt = observedOverride === undefined ? nowIso : toIso(observedOverride);
  if (observedAt === null) {
    throw new TypeError(`invalid observedAt value: ${String(observedOverride)}`);
  }

  // 兼容旧数据库：可能只有 feeds.last_seen，没有 feed_health 记录。
  // 在覆盖旧值之前先用同一套时间语义评估一次，作为“上一次状态”的替身，
  // 否则旧库中早已过期的源会被误判成 first-observation。
  const priorFeed = readFeed(dbPath, id);
  const priorHealth = readHealth(dbPath, id);
  const previous = priorHealth ?? legacyPrevious(priorFeed, nowIso, healthOptions);
  const baseSeq = priorFeed?.observe_seq ?? 0;
  // 旧库没有采集序号时，把上一次状态视为序号 0；本次采集得到的序号必然更大，
  // 因此能正确识别为“新的成功采集”。
  if (previous && previous.observe_seq === null) previous.observe_seq = baseSeq;

  const parsed = parseFeed(raw);
  const items = parsed.items.map(normalizeItem);
  const fresh = newItems(items, existingGuids(dbPath, id));
  saveItems(dbPath, id, fresh);
  const savedFeed = saveFeed(dbPath, { id, url, lastSeen: observedAt });
  recordDeliveries(dbPath, id, fresh, subscribers);

  // 先铺开可调阈值，再固定本次采集的时间 / 序号 / 上一次状态，
  // 避免 healthOptions 意外覆盖这些语义字段。
  const health = evaluateHealth({
    ...healthOptions,
    lastSeen: observedAt,
    observeSeq: savedFeed?.observe_seq ?? null,
    now: nowIso,
    previous,
  });
  persistHealth(dbPath, id, health);

  return {
    format: parsed.format,
    parsed: items.length,
    fresh: fresh.length,
    delivered: fresh.length * subscribers.length,
    observedAt,
    observeSeq: savedFeed?.observe_seq ?? null,
    health: {
      status: health.status,
      healthy: health.healthy,
      reason: health.reason,
      observedAt: health.observedAt,
      now: health.now,
      observeSeq: health.observeSeq,
      clockRegressed: health.clockRegressed,
      clockHighWaterReset: health.clockHighWaterReset,
    },
    hasProblem: PROBLEM_STATUSES.includes(health.status),
  };
}

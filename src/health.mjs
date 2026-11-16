// 源健康判定。
//
// 判定只依赖三样东西：本次健康检查看到的“最后观测时间”（lastSeen）、
// 本次采集序号（observeSeq）、本次检查的“当前时间”（now），
// 以及上一次持久化的健康记录（previous）。
//
// 采集写入、健康查询和命令行都调用同一套 evaluateHealth，
// 确保三处使用完全一致的时间语义（解析规则见 src/clock.mjs）。
//
// 状态：
//   never-observed  从未观测（无记录，或最后观测时间为空字符串）
//   invalid-time    时间字段损坏 / 无法解析
//   future-time     观测时间明显晚于当前时间（超出容忍窗口）
//   clock-anomaly   本机时钟回拨，或时钟已恢复但尚无新的成功采集
//   stale           观测时间已达到/超过 maxAge
//   fresh           正常新鲜
//   recovered       从异常状态恢复，且确实发生了新的成功采集
//
// 边界约定（显式且可测试）：
//   - age === maxAgeMs 视为过期（“恰好达到过期阈值”）。
//   - 观测时间最多领先 now 的 futureToleranceMs 时仍算新鲜（容忍时钟抖动）。
//   - now 早于上次评估时间超过 clockToleranceMs 时视为时钟回拨。
//   - “新观测”由采集序号判断，而不是时间戳大小：这样即使旧观测是未来时间，
//     修复后的正确时间也不会因为“比未来小”而被误认为没有重新采集。
//   - recovered 必须来自异常状态 + 新的成功采集；时钟自然追上未来时间戳、
//     重复采集、或时钟恢复却未重新采集，都不会被判成 recovered。
//   - 时钟高水位超过 maxClockRollbackMs 落后于 now 时，视为历史高水位可疑：
//     本次保守报 clock-anomaly 并重置高水位，避免一次错误的向前跳变永久卡住状态。

import { parseInstant, toIso } from './clock.mjs';
import {
  initStore,
  readFeed,
  readHealth,
  saveHealth as persistHealth,
  listFeeds,
  healthEvents,
} from './store.mjs';

export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
export const DEFAULT_CLOCK_TOLERANCE_MS = 5 * 60 * 1000;
// 超过这个幅度的“当前时间落后于历史高水位”，更可能是之前时钟向前跳错后又被校正，
// 而不是一次真实回拨。继续以陈旧高水位判定会让健康状态永久卡住，因此超过此界限时
// 不再断言时钟异常，改按观测时间分类，并把高水位重置到当前时间（有界自愈）。
export const DEFAULT_MAX_CLOCK_ROLLBACK_MS = 7 * 24 * 60 * 60 * 1000;

export const PROBLEM_STATUSES = Object.freeze([
  'stale',
  'invalid-time',
  'future-time',
  'clock-anomaly',
]);
const RECOVERABLE = new Set(PROBLEM_STATUSES);
const HEALTHY = new Set(['fresh', 'recovered']);

export const STATUS_LABELS = Object.freeze({
  'never-observed': '从未观测',
  'invalid-time': '时间无效',
  'future-time': '未来时间',
  'clock-anomaly': '时钟异常',
  stale: '已过期',
  fresh: '正常新鲜',
  recovered: '已恢复',
});

const REASON_LABELS = Object.freeze({
  'never-observed': '数据库中没有该源的最后观测时间',
  'empty-timestamp': '最后观测时间为空字符串',
  'unparseable-timestamp': '最后观测时间无法解析',
  'clock-regressed': '本机时钟早于上次评估时间，时间不可信',
  'clock-high-water-reset': '历史时钟高水位异常偏大（疑似时钟曾向前跳错），已重置后按观测时间判定',
  'clock-restored-awaiting-observation': '时钟已恢复，但尚无时钟异常之后的新采集',
  'timestamp-after-now': '最后观测时间明显晚于当前时间',
  'clock-caught-up-awaiting-observation': '此前位于未来的观测时间已追上当前时间，但尚无新的成功采集',
  'age-at-threshold': '距最后观测恰好达到过期阈值',
  'age-over-threshold': '距最后观测已超过过期阈值',
  'within-max-age': '最后观测仍在有效期内',
  'first-observation': '首次成功观测',
  'recovered-sustained': '处于恢复后的观察期内，尚无新的采集',
  'recovered-from-stale': '源从过期状态恢复，且有新的成功采集',
  'recovered-from-invalid-time': '时间字段修复后恢复，且有新的成功采集',
  'recovered-from-future-time': '未来时间问题修复后恢复，且有新的成功采集',
  'recovered-from-clock-anomaly': '时钟恢复并有新的成功采集后恢复',
});

function nonNegativeOption(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return number;
}

function normalizeOptions(options = {}) {
  return {
    maxAgeMs: nonNegativeOption(options.maxAgeMs, DEFAULT_MAX_AGE_MS, 'maxAgeMs'),
    futureToleranceMs: nonNegativeOption(
      options.futureToleranceMs,
      DEFAULT_FUTURE_TOLERANCE_MS,
      'futureToleranceMs',
    ),
    clockToleranceMs: nonNegativeOption(
      options.clockToleranceMs,
      DEFAULT_CLOCK_TOLERANCE_MS,
      'clockToleranceMs',
    ),
    maxClockRollbackMs: nonNegativeOption(
      options.maxClockRollbackMs,
      DEFAULT_MAX_CLOCK_ROLLBACK_MS,
      'maxClockRollbackMs',
    ),
  };
}

function toCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function previousSnapshot(previous) {
  if (!previous) {
    return {
      status: null,
      observedMs: null,
      evaluatedMs: null,
      observeSeq: null,
      lastOkAt: null,
      recoveredAt: null,
      clockHighWaterMs: null,
    };
  }
  return {
    status: previous.status ?? null,
    observedMs: parseInstant(previous.observed_at ?? previous.observedAt).ms,
    evaluatedMs: parseInstant(previous.evaluated_at ?? previous.evaluatedAt).ms,
    observeSeq: toCount(previous.observe_seq ?? previous.observeSeq),
    lastOkAt: toIso(previous.last_ok_at ?? previous.lastOkAt),
    recoveredAt: toIso(previous.recovered_at ?? previous.recoveredAt),
    clockHighWaterMs: parseInstant(
      previous.clock_high_water ?? previous.clockHighWater,
    ).ms,
  };
}

/**
 * 纯函数式健康判定。
 *
 * @param {object} input
 * @param {*} input.lastSeen      最后观测时间（任意受支持格式；空值表示从未观测）
 * @param {number} [input.observeSeq] 当前采集序号；用于判断是否发生了新的成功采集
 * @param {*} input.now           本次判定使用的当前时间，默认 Date.now()
 * @param {object|null} input.previous 上一次持久化的健康记录
 * @returns {object} 判定结果，包含 status / healthy / reason / observedAt / now 等
 */
export function evaluateHealth(input = {}) {
  const options = normalizeOptions(input);
  const nowInfo = parseInstant(input.now ?? Date.now());
  if (nowInfo.ms === null) throw new TypeError(`invalid now value: ${String(input.now)}`);
  const nowMs = nowInfo.ms;
  const now = toIso(nowMs);
  const previous = previousSnapshot(input.previous);
  const observedInfo = parseInstant(input.lastSeen);
  const observedMs = observedInfo.ms;
  const observedAt = observedMs === null ? null : toIso(observedMs);
  const observeSeq = toCount(input.observeSeq);
  // 时钟回拨以“历史见过的最大评估时间”为基准。若旧库没有该列，回退到 evaluated_at。
  const storedHighWaterMs = previous.clockHighWaterMs ?? previous.evaluatedMs;
  const rollbackMs =
    storedHighWaterMs === null ? 0 : storedHighWaterMs - nowMs;
  // 回拨幅度过大时，更可能是历史上时钟曾向前跳错、如今被校正；继续信任陈旧高水位
  // 会让状态永久卡在 clock-anomaly。此时忽略并重置高水位，改按观测时间判定。
  const clockHighWaterReset =
    storedHighWaterMs !== null && rollbackMs > options.maxClockRollbackMs;
  const clockHighWaterMs = clockHighWaterReset ? null : storedHighWaterMs;
  const clockRegressed =
    clockHighWaterMs !== null && nowMs < clockHighWaterMs - options.clockToleranceMs;

  // 新采集的判定：
  //   1) 有采集序号时，以序号增长为准（与时间戳大小无关）；
  //   2) 旧数据库没有序号时，回退到时间戳严格变新；
  //   3) 完全没有观测时间时，不可能是一次成功采集。
  let newObservation;
  if (observedMs === null) {
    newObservation = false;
  } else if (previous.status === null) {
    newObservation = true;
  } else if (observeSeq !== null && previous.observeSeq !== null) {
    newObservation = observeSeq > previous.observeSeq;
  } else if (previous.observedMs !== null) {
    newObservation = observedMs > previous.observedMs;
  } else {
    newObservation = true;
  }

  const futureObservation =
    observedMs !== null && observedMs > nowMs + options.futureToleranceMs;
  const ageMs = observedMs === null ? null : nowMs - observedMs;

  const result = {
    status: 'fresh',
    healthy: true,
    reason: 'within-max-age',
    detail: REASON_LABELS['within-max-age'],
    observedAt,
    observedRaw: input.lastSeen ?? null,
    observedPrecision: observedInfo.precision,
    observeSeq,
    now,
    ageMs,
    newObservation,
    maxAgeMs: options.maxAgeMs,
    futureToleranceMs: options.futureToleranceMs,
    clockToleranceMs: options.clockToleranceMs,
    previousStatus: previous.status,
    clockRegressed,
    clockHighWater: clockHighWaterMs === null ? null : toIso(clockHighWaterMs),
    clockHighWaterReset,
    lastOkAt: previous.lastOkAt,
    recoveredAt: previous.recoveredAt,
  };

  const finish = (status, reason, extra = {}) => {
    const healthy = HEALTHY.has(status);
    const merged = {
      ...result,
      ...extra,
      status,
      healthy,
      reason,
      detail: REASON_LABELS[reason] || reason,
    };
    if (healthy) merged.lastOkAt = now;
    if (status === 'recovered') merged.recoveredAt = now;
    return merged;
  };

  // 1. 从未观测：缺失与空字符串区分开。
  if (input.lastSeen === null || input.lastSeen === undefined) {
    return finish('never-observed', 'never-observed');
  }
  if (typeof input.lastSeen === 'string' && input.lastSeen.trim() === '') {
    return finish('never-observed', 'empty-timestamp');
  }

  // 2. 时间字段损坏。
  if (observedMs === null) {
    return finish('invalid-time', 'unparseable-timestamp');
  }

  // 3. 时钟回拨优先级最高：此时任何“新鲜”都不可信，新的采集也不能证明恢复。
  if (clockRegressed) {
    return finish('clock-anomaly', 'clock-regressed', { ageMs });
  }

  // 3b. 历史高水位异常偏大（回拨幅度超过 maxClockRollbackMs）：更可能是时钟曾向前跳错。
  //     本次仍保守地报告时钟异常，但会重置高水位（见 store），下一次评估即可正常判定，
  //     避免永久卡在 clock-anomaly。之所以不直接判为新鲜，是为了避免误报正常。
  if (clockHighWaterReset) {
    return finish('clock-anomaly', 'clock-high-water-reset', { ageMs });
  }

  // 4. 上一次是时钟异常。此时时钟已回到可信区间（仍回拨的情况第 3 步已处理）：
  //    - 观测仍在未来：如实报未来时间（新的采集也不能证明时钟正常）；
  //    - 有新的成功采集且观测在有效期内：恢复；
  //    - 没有新采集但观测确实已老化：如实报过期，说明源长期未更新；
  //    - 其余情况：继续报时钟异常，等待新的成功采集来证明恢复。
  if (previous.status === 'clock-anomaly') {
    if (futureObservation) {
      return finish('future-time', 'timestamp-after-now', { ageMs });
    }
    if (newObservation && ageMs < options.maxAgeMs) {
      return finish('recovered', 'recovered-from-clock-anomaly', { ageMs });
    }
    if (ageMs >= options.maxAgeMs) {
      return finish('stale', 'age-over-threshold', { ageMs });
    }
    return finish('clock-anomaly', 'clock-restored-awaiting-observation', { ageMs });
  }

  // 5. 明显未来时间。
  if (futureObservation) {
    return finish('future-time', 'timestamp-after-now', { ageMs });
  }

  // 6. 此前位于未来的观测：时间虽已追上，但若无新的成功采集，不能宣告恢复。
  //    若观测确实已老化，则如实报过期；否则继续报未来时间。
  if (previous.status === 'future-time' && !newObservation) {
    if (ageMs >= options.maxAgeMs) {
      return finish('stale', 'age-over-threshold', { ageMs });
    }
    return finish('future-time', 'clock-caught-up-awaiting-observation', { ageMs });
  }

  // 7. 过期判定；恰好达到阈值即过期。
  if (ageMs >= options.maxAgeMs) {
    return finish('stale', ageMs === options.maxAgeMs ? 'age-at-threshold' : 'age-over-threshold', {
      ageMs,
    });
  }

  // 8. 正常 / 恢复。恢复必须来自可恢复的异常状态，且确有新的成功采集。
  //    “此前有过可解析观测”或“此前时间字段损坏后被修复”才算恢复；
  //    从未观测过时，首次得到合法观测只能算 first-observation。
  const hasObservationHistory = previous.observedMs !== null;
  const recoveredEligible =
    RECOVERABLE.has(previous.status) &&
    newObservation &&
    (hasObservationHistory || previous.status === 'invalid-time');
  if (recoveredEligible) {
    return finish('recovered', `recovered-from-${previous.status}`, { ageMs });
  }
  if (previous.status === null || previous.status === 'never-observed' || !hasObservationHistory) {
    return finish('fresh', 'first-observation', { ageMs });
  }
  if (previous.status === 'recovered' && !newObservation) {
    return finish('recovered', 'recovered-sustained', { ageMs });
  }
  // 观测时间略微领先当前时间但仍在容忍窗口内：保持健康，但原因如实说明，
  // 方便诊断区分“正常新鲜”和“时钟抖动”。
  if (observedMs > nowMs) {
    return finish('fresh', 'within-future-tolerance', { ageMs });
  }
  return finish('fresh', 'within-max-age', { ageMs });
}

/** 人类可读的一行诊断。 */
export function describeHealth(health) {
  const label = STATUS_LABELS[health.status] || health.status;
  const observed = health.observedAt ?? String(health.observedRaw ?? '—');
  const age = health.ageMs === null ? '—' : `${health.ageMs}ms`;
  const flags = [
    health.clockRegressed ? 'clock_regressed' : null,
    health.clockHighWaterReset ? 'clock_high_water_reset' : null,
  ].filter(Boolean).join(',') || 'none';
  return `${label} (${health.reason}): observed_at=${observed}, now=${health.now}, age=${age}, ` +
    `seq=${health.observeSeq ?? '—'}, previous=${health.previousStatus ?? '—'}, ` +
    `new_observation=${health.newObservation}, flags=${flags}`;
}

function healthOptions(options) {
  return {
    now: options.now,
    maxAgeMs: options.maxAgeMs,
    futureToleranceMs: options.futureToleranceMs,
    clockToleranceMs: options.clockToleranceMs,
    maxClockRollbackMs: options.maxClockRollbackMs,
  };
}

/**
 * 查询并记录某个源的当前健康状态。
 * 使用与采集相同的时间语义；previous 从 feed_health 读取，评估结果写回。
 */
export function checkHealth(dbPath, feedId, options = {}) {
  initStore(dbPath);
  const feed = readFeed(dbPath, feedId);
  const previous = readHealth(dbPath, feedId);
  const health = evaluateHealth({
    ...healthOptions(options),
    lastSeen: feed ? feed.last_seen : null,
    observeSeq: feed ? feed.observe_seq : null,
    previous,
  });
  // 只有已登记的源才写入健康记录；查询一个不存在的源不应凭空造出数据。
  if (feed) persistHealth(dbPath, feedId, health);
  return health;
}

/** 诊断所有已知源；同样使用统一时间语义。 */
export function diagnoseAll(dbPath, options = {}) {
  initStore(dbPath);
  return listFeeds(dbPath).map((feed) => ({
    feedId: feed.id,
    url: feed.url,
    lastSeenStored: feed.last_seen,
    health: checkHealth(dbPath, feed.id, options),
  }));
}

export { healthEvents };

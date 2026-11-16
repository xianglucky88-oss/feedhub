// 统一的时间语义层。
//
// 采集写入、健康查询和命令行诊断都必须通过这里，避免三处各写一套
// Date 解析 / 时区 / 单位规则。核心约束：
//   1. 显式区分“无法解析”和“合法时间”，绝不把非法时间混成 0 或 now。
//   2. 支持 epoch 秒 / 毫秒、带时区偏移、RFC 3339、RFC 822 等常见输入。
//   3. 拒绝日历上不存在的日期（JS 的 Date 会把 2026-02-30 滚到 3 月）。
//   4. 输出统一为 UTC ISO 字符串（毫秒精度），便于 SQLite 文本比较与兼容旧记录。

const SECONDS_PATTERN = /^-?\d{10}$/;
const MILLIS_PATTERN = /^-?\d{13}$/;

// 允许的前缀/后缀：仅接受明确的数值时间戳，其余交给 Date.parse。
// Date.parse 对纯数字字符串（如 "1700000000"）在某些实现里会按年份处理，
// 因此数值必须先经过我们的判定。
const NUMERIC_PATTERN = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * 把任意“时间输入”解析成毫秒时间戳或 null（无法解析）。
 *
 * 接受：
 *   - Date 实例
 *   - 数字：|v| 在 [1e9, 1e11) 区间视为 epoch 秒，否则视为毫秒。
 *     （1e9 秒 = 2001 年，1e11 毫秒 = 1973 年，区间足以区分单位且不误伤 0。）
 *   - 字符串：
 *       '' / 空白            -> null
 *       'null' / 'undefined' -> null
 *       纯数字                -> epoch 秒（10 位）或毫秒（13 位），其余拒绝
 *       ISO 8601 / RFC 3339  -> 支持 Z、±HH:MM、±HHMM、±HH
 *       RFC 822/2822         -> 支持 GMT/UTC 及数字偏移
 *       纯日期               -> 仅接受 YYYY-MM-DD 或 YYYY/MM/DD，按 UTC 解释
 *
 * 返回 { ms, source, precision }：precision 为 'seconds' / 'milliseconds' / 'days'，
 * 说明原始输入的单位，供诊断使用。无法解析返回 { ms: null, ... }。
 */
export function parseInstant(value) {
  const invalid = { ms: null, source: describeSource(value), precision: null, raw: value };
  if (value === null || value === undefined) return invalid;

  if (value instanceof Date) {
    const ms = value.valueOf();
    return Number.isFinite(ms)
      ? { ms, source: 'date', precision: 'milliseconds', raw: value }
      : invalid;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalid;
    // 数字按毫秒解释，除非它明显是 epoch 秒（|v| < 1e11 且落在合理秒级区间）。
    // 阈值 1e11 约等于 1973 年的毫秒值、5138 年的秒值，足以区分两种单位，
    // 同时不会把 0 / 负数毫秒误判成秒。
    if (Math.abs(value) >= 1e9 && Math.abs(value) < 1e11) {
      const ms = value * 1000;
      return validMs(ms) ? { ms, source: 'number', precision: 'seconds', raw: value } : invalid;
    }
    return validMs(value)
      ? { ms: value, source: 'number', precision: 'milliseconds', raw: value }
      : invalid;
  }

  if (typeof value !== 'string') return invalid;
  const text = value.trim();
  if (text === '' || /^(null|undefined|nan)$/i.test(text)) return invalid;

  // 纯数字：10 位按 epoch 秒、13 位按 epoch 毫秒；带小数点的按秒。
  // 其他位数既不是秒也不是毫秒，直接拒绝，避免 Date.parse 把它们当成年份。
  if (NUMERIC_PATTERN.test(text)) {
    if (SECONDS_PATTERN.test(text)) {
      const ms = Number(text) * 1000;
      return validMs(ms) ? { ms, source: 'string', precision: 'seconds', raw: value } : invalid;
    }
    if (MILLIS_PATTERN.test(text)) {
      const ms = Number(text);
      return validMs(ms) ? { ms, source: 'string', precision: 'milliseconds', raw: value } : invalid;
    }
    if (/^\d+\.\d+$/.test(text)) {
      const ms = Number(text) * 1000;
      return validMs(ms) ? { ms, source: 'string', precision: 'seconds', raw: value } : invalid;
    }
    return invalid;
  }

  // 纯日期：Date.parse 对 'YYYY-MM-DD' 按 UTC，对带斜杠/空格的格式按本地时区，
  // 语义不一致。这里统一为 UTC 并严格校验日历合法性。
  const dateOnly = parseDateOnly(text);
  if (dateOnly !== undefined) {
    return dateOnly === null
      ? invalid
      : { ms: dateOnly, source: 'string', precision: 'days', raw: value };
  }

  // 其余交给 Date.parse；它已能处理 ISO 偏移与 RFC 822。
  // 但 Date.parse 会把 2026-02-30 这类不存在的 ISO 日期滚到 3 月，
  // 因此含年月日的 ISO 输入先做日历校验。
  const calendar = checkIsoCalendarDate(text);
  if (calendar === false) return invalid;

  const normalized = normalizeAmbiguousZone(text);
  const ms = Date.parse(normalized);
  return validMs(ms)
    ? { ms, source: 'string', precision: inferPrecision(text), raw: value }
    : invalid;
}

function inferPrecision(text) {
  if (/\.\d+/.test(text)) return 'milliseconds';
  return text.includes(':') ? 'seconds' : 'days';
}

function validMs(ms) {
  if (!Number.isFinite(ms)) return false;
  const date = new Date(ms);
  return Number.isFinite(date.valueOf());
}

function describeSource(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return typeof value;
}

// 返回 undefined 表示“不是纯日期格式”，null 表示“是纯日期但非法”。
function parseDateOnly(text) {
  const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) return undefined;
  const [, y, m, d] = match.map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const date = new Date(ms);
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return ms;
}

// 对形如 2026-02-30T... 的 ISO 输入做日历校验；返回 false 表示非法。
// 非 ISO 格式返回 true（交给 Date.parse）。
function checkIsoCalendarDate(text) {
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/);
  if (!match) return true;
  const [, y, m, d] = match.map(Number);
  // 时区偏移与时间部分交给 Date.parse，这里只确认年月日存在。
  const ms = Date.UTC(y, m - 1, d);
  const date = new Date(ms);
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

// 无时区的时间在 JS 中会按“机器本地时区”解释，导致同一数据在不同机器上得到
// 不同结果。这里统一按 UTC：
//   - 无时区 ISO 日期时间：直接补 Z；
//   - 其他含时分但无时区的格式（RFC 822、美式日期时间）：追加 GMT 后再解析。
function normalizeAmbiguousZone(text) {
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2}|[+-]\d{2})$/.test(text);
  if (hasZone) {
    // 形如 2026-11-16T10:00:00+08 的两位偏移，补成 +08:00 再交给 Date.parse。
    return /[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?[+-]\d{2}$/.test(text)
      ? text.replace(/([+-]\d{2})$/, '$1:00')
      : text;
  }
  const isoNoZone = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
  if (isoNoZone.test(text)) return `${text.replace(' ', 'T')}Z`;
  // 只有日期没有时间的情况已由 parseDateOnly 处理；这里处理带时分的其他格式。
  if (/\d{1,2}:\d{2}/.test(text)) return `${text} GMT`;
  return text;
}

/** 规范化输出：UTC ISO 字符串（毫秒精度）。无法解析时返回 null。 */
export function toIso(value) {
  const { ms } = parseInstant(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/** 解析成毫秒；无法解析时返回 null。 */
export function toMillis(value) {
  return parseInstant(value).ms;
}

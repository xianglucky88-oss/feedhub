// 统一归一化层：解析层只负责忠实提取，所有“怎么算同一条内容”的策略都集中在这里。
//
// 统一条目模型（UnifiedEntry）：
//   id            canonical id，判定新旧的唯一主键，保留下来的条目一定非空
//   idKind        id 来源：explicit(显式标识) | link(规范化链接) | title-hash(标题/摘要指纹)
//   guid          各格式原始声明的标识（rss guid / atom id / json id），仅用于诊断
//   title         纯文本标题；源数据完全没有标题时回退到摘要前缀，仍没有则为 ''
//   link          规范化后的绝对 http(s) URL；无法规范化则为 ''
//   published     合法日期统一转 ISO 字符串，非法/缺失为 ''
//   updated       同上
//   dateRaw       原始日期字符串，非法日期可追溯
//   summary       纯文本摘要（HTML 标签与实体已处理）
//   authors       作者名数组
//   sourceFormat  rss | atom | json，诊断用
//
// canonical id 优先级（高 → 低）：
//   1. 显式稳定标识：RSS guid（含 isPermaLink=false 的不透明值）、Atom id、JSON id
//      —— 但 isPermaLink="true" 的 URL 形 guid 与普通链接走同一套 URL 规范化，
//         保证 “RSS 用 URL 当 guid” 与 “Atom/JSON 用 url 字段” 得到同一个 id；
//   2. 规范化后的条目链接（URL 形字段也在此合并）；
//   3. 标题回退：纯文本标题（缺失时回退摘要）的小写形式做 SHA-1 指纹。
// 三种来源产出同一个字符串空间：URL 一律先规范化，指纹带 h: 前缀避免与真实标识撞车。

import { createHash } from 'node:crypto';
import { decodeEntities } from './xml-parser.mjs';

export function stripHtml(value = '') {
  // 先解码实体（&amp; &lt; &#8217; …），再移除标签，最后压空白。
  // 嵌套标签（<b><i>x</i></b>）天然按顺序剥离，不需要逐格式正则。
  const decoded = decodeEntities(String(value));
  return decoded
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TRACKING_PARAMS = /^(utm_|ref$|ref_|source$|campaign$|fbclid$|gclid$|mc_)/i;

export function canonicalizeUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) {
    // URN、mailto、相对路径等无法可靠规范化的形式原样保留，避免制造伪主键。
    return value;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  // 主机名小写、去掉默认端口、丢弃 fragment 与纯跟踪用途的查询参数：
  // 剩余查询参数按名字排序，使同一资源的乱序参数 URL 收敛到同一 canonical 形式。
  const defaultPort = (url.protocol === 'http:' && url.port === '80')
    || (url.protocol === 'https:' && url.port === '443');
  const params = [...url.searchParams]
    .filter(([key]) => !TRACKING_PARAMS.test(key))
    .sort(([a], [b]) => a.localeCompare(b));
  const search = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  const host = url.hostname.toLowerCase() + (defaultPort ? '' : (url.port ? `:${url.port}` : ''));
  return `${url.protocol}//${host}${url.pathname.replace(/\/+$/, '') || '/'}${search}`;
}

function toIsoDate(raw) {
  const value = String(raw || '').trim();
  if (!value) return { iso: '', valid: false };
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return { iso: '', valid: false };
  return { iso: parsed.toISOString(), valid: true };
}

function fingerprint(text) {
  return `h:${createHash('sha1').update(text, 'utf8').digest('hex')}`;
}

function titleFallback(summaryText) {
  // 展示用回退：取摘要前 80 个纯文本字符，保证跨格式确定性一致。
  return summaryText.slice(0, 80);
}

export function normalizeItem(rawItem) {
  const item = { ...blankItem(), ...rawItem };
  const titleText = stripHtml(item.title);
  const summaryText = stripHtml(item.summary || item.content);
  const link = canonicalizeUrl(
    item.link
    || (item.links || []).map((candidate) => candidate.href).find(Boolean)
    || '',
  );

  // ---- canonical id 计算 -------------------------------------------------
  let id = '';
  let idKind = '';
  const explicit = String(item.id || '').trim();
  if (explicit) {
    if (item.idPermanent === false) {
      // 显式声明“不是永久链接”：不透明标识，原样使用（如 RSS guid isPermaLink=false）。
      id = explicit;
    } else if (/^https?:\/\//i.test(explicit)) {
      // URL 形标识与链接字段共用规范化逻辑，跨格式才能收敛。
      id = canonicalizeUrl(explicit);
    } else {
      id = explicit; // tag: URI、urn:uuid、自定义 slug 等。
    }
    idKind = 'explicit';
  } else if (link) {
    id = link;
    idKind = 'link';
  } else {
    // 标题回退：有标题用标题，没有标题用摘要；全部缺失则条目为空，交由上层剔除。
    const key = (titleText || summaryText).toLowerCase();
    if (key) {
      id = fingerprint(key);
      idKind = 'title-hash';
    }
  }

  const published = toIsoDate(item.published);
  const updated = toIsoDate(item.updated);

  return {
    id,
    idKind,
    guid: explicit,
    title: titleText || titleFallback(summaryText),
    link,
    published: published.iso,
    updated: updated.iso,
    dateRaw: { published: String(item.published || ''), updated: String(item.updated || '') },
    dateInvalid: [!published.valid && !!item.published, !updated.valid && !!item.updated],
    summary: summaryText,
    authors: Array.isArray(item.authors) ? item.authors : [],
    sourceFormat: item.sourceFormat || '',
  };
}

function blankItem() {
  return {
    id: '', idPermanent: true, title: '', link: '', published: '', updated: '',
    summary: '', content: '', authors: [], links: [], sourceFormat: '',
  };
}

function isEmptyRaw(item) {
  return !item.id && !item.link && !(item.links || []).some((candidate) => candidate.href)
    && !stripHtml(item.title) && !stripHtml(item.summary) && !stripHtml(item.content);
}

// 归一化整份 feed：剔除空条目、检测批内重复 canonical id（保留首个，其余显式上报，
// 绝不静默覆盖）。返回结构同时包含可直接入库的 entries 和诊断信息。
export function normalizeFeed(parsed) {
  const skippedEmpty = [];
  const duplicates = [];
  const entries = [];
  const seen = new Map(); // canonical id -> 首次出现的下标

  (parsed.items || []).forEach((rawItem, index) => {
    if (isEmptyRaw(rawItem)) {
      skippedEmpty.push({ index, reason: 'empty entry: no id, link, title or content' });
      return;
    }
    const entry = normalizeItem(rawItem);
    if (!entry.id) {
      skippedEmpty.push({ index, reason: 'no stable identity could be derived' });
      return;
    }
    if (seen.has(entry.id)) {
      duplicates.push({ index, id: entry.id, firstIndex: seen.get(entry.id), sourceFormat: entry.sourceFormat });
      return;
    }
    seen.set(entry.id, entries.length);
    entries.push(entry);
  });

  return {
    format: parsed.format,
    meta: parsed.meta || { title: '', link: '' },
    entries,
    skippedEmpty,
    duplicates,
  };
}

// 供更新判定使用的条目指纹：同一条内容在 RSS/Atom/JSON 间字段顺序不同、
// 标签嵌套不同也应得到相同结果（全部基于归一化后的纯文本字段）。
export function entryFingerprint(entry) {
  const payload = JSON.stringify({
    id: entry.id,
    link: entry.link,
    title: entry.title,
    published: entry.published,
    summary: entry.summary,
  });
  return createHash('sha1').update(payload, 'utf8').digest('hex');
}

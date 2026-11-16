import { rmSync } from 'node:fs';
import {
  rssFixture, atomFixture, jsonFixture, rssEdgeFixture, atomEdgeFixture, shared,
} from './mockfeed.mjs';
import { parseFeed } from './parse.mjs';
import { normalizeFeed } from './normalize.mjs';
import { newItems, sameEntry } from './update-detect.mjs';
import { ingestFeed } from './poll.mjs';
import { signature, verifySignature } from './websub.mjs';

const command = process.argv[2];
if (command !== 'demo') {
  console.error('usage: node src/cli.mjs demo');
  process.exit(2);
}

const subscribers = ['warehouse', 'search'];

// ---- 链路一：无存储依赖的跨格式一致性证明 --------------------------------
// 同一份内容依次以 RSS → Atom → JSON 三种格式送达，逐轮按 canonical id 去重，
// 并比较归一化后的条目值，证明既不会拆成两篇也不会静默覆盖。
const formats = [
  { name: 'rss', raw: rssFixture },
  { name: 'atom', raw: atomFixture },
  { name: 'json', raw: jsonFixture },
];
const known = new Set();
const rounds = [];
let referenceEntries = null;
for (const { name, raw } of formats) {
  const normalized = normalizeFeed(parseFeed(raw));
  const fresh = newItems(normalized.entries, known);
  if (referenceEntries) {
    const byId = new Map(referenceEntries.map((entry) => [entry.id, entry]));
    for (const entry of normalized.entries) {
      if (!byId.has(entry.id)) throw new Error(`格式切换后出现新 id：${entry.id}`);
      if (!sameEntry(entry, byId.get(entry.id))) {
        throw new Error(`id=${entry.id} 在 ${name} 中归一化值与 RSS 不一致`);
      }
    }
  } else {
    referenceEntries = normalized.entries;
  }
  normalized.entries.forEach((entry) => known.add(entry.id));
  rounds.push({
    format: name,
    parsed: parseFeed(raw).items.length,
    normalized: normalized.entries.length,
    fresh: fresh.length,
    ids: normalized.entries.map((entry) => entry.id),
  });
}

// ---- 链路二：边界 fixture 的重复 / 空条目 / 非法日期 / 回退处理 -----------
const edgeRss = normalizeFeed(parseFeed(rssEdgeFixture));
const edgeAtom = normalizeFeed(parseFeed(atomEdgeFixture));

// ---- 链路三：持久化端到端（有 sqlite3 走 SQLite，否则自动用内存后端） ----
const dbPath = '/tmp/feedhub/feedhub.db';
rmSync('/tmp/feedhub', { recursive: true, force: true });
const first = ingestFeed({ id: 'local', url: 'file://rss', raw: rssFixture, dbPath, subscribers });
const switched = ingestFeed({ id: 'local', url: 'file://atom', raw: atomFixture, dbPath, subscribers });
const third = ingestFeed({ id: 'local', url: 'file://json', raw: jsonFixture, dbPath, subscribers });
const { counts, storageBackend } = await import('./store.mjs');
const persistence = { backend: storageBackend, dbPath, first, switched, third, counts: counts(dbPath) };

const body = '<hub.challenge>ok</hub.challenge>';
console.log(JSON.stringify({
  expectedIds: [shared.post1.id, shared.post2.id],
  crossFormatRounds: rounds,
  edgeRss: {
    normalized: edgeRss.entries.length,
    duplicates: edgeRss.duplicates,
    skippedEmpty: edgeRss.skippedEmpty,
    idKinds: Object.fromEntries(edgeRss.entries.map((entry) => [entry.id, entry.idKind])),
    invalidDates: edgeRss.entries
      .filter((entry) => entry.dateInvalid[0])
      .map((entry) => ({ id: entry.id, raw: entry.dateRaw.published })),
  },
  edgeAtomCrossFormatId: edgeAtom.entries[0]?.id,
  persistence,
  signatureValid: verifySignature(body, signature(body, 'secret'), 'secret'),
}, null, 2));

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rssFixture, atomFixture, jsonFixture, rssEdgeFixture, atomEdgeFixture, shared,
} from '../src/mockfeed.mjs';
import { parseXml, documentElement, childElements, textOf, innerHtml, decodeEntities } from '../src/xml-parser.mjs';
import { parseFeed, detectFormat } from '../src/parse.mjs';
import {
  normalizeItem, normalizeFeed, stripHtml, canonicalizeUrl, entryFingerprint,
} from '../src/normalize.mjs';
import { newItems, sameEntry } from '../src/update-detect.mjs';
import { ingestFeed } from '../src/poll.mjs';
import { existingIds, counts, storageBackend } from '../src/store.mjs';

// ---------------------------------------------------------------------------
// 1. 通用 XML 解析器：CDATA、实体、命名空间、嵌套元素、注释、容错
// ---------------------------------------------------------------------------
test('xml parser: CDATA 与转义文本都能还原，且嵌套标签可序列化为 HTML', () => {
  const xml = `<?xml version="1.0"?>
    <root xmlns:x="urn:x"><!-- a comment -->
      <a><![CDATA[hello <b>world</b>]]></a>
      <b>Tom &amp; Jerry &#8212; &mdash;</b>
      <x:item x:attr="v">nested <i>text</i> tail</x:item>
    </root>`;
  const root = documentElement(xml);
  assert.equal(root.local, 'root');
  const children = (local) => childElements(root, local);
  assert.equal(textOf(children('a')[0]), 'hello <b>world</b>');
  assert.equal(textOf(children('b')[0]), 'Tom & Jerry — —');
  const item = children('item')[0];
  assert.equal(item.attrs['x:attr'], 'v'); // 命名空间前缀保留，本地名可查
  assert.equal(textOf(item), 'nested text tail');
  assert.equal(innerHtml(item), 'nested <i>text</i> tail');
});

test('xml parser: 未知实体保持原样，数字引用支持十进制与十六进制', () => {
  assert.equal(decodeEntities('a&madeup;b'), 'a&madeup;b');
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
});

test('xml parser: 标签不闭合或闭合不匹配时显式报错，而不是静默截断', () => {
  assert.throws(() => parseXml('<root><a>x</root>'), /unexpected closing tag/);
  assert.throws(() => parseXml('<root><a>x'), /unclosed element/);
  assert.throws(() => parseXml('plain text only'), /no root element/);
});

test('xml parser: DOCTYPE 与处理指令被跳过，带引号的 > 不会截断文档', () => {
  const xml = `<?xml version="1.0"?><!DOCTYPE rss PUBLIC "x" "y"><rss><channel>
    <item><title>a &gt; b</title></item></channel></rss>`;
  const doc = parseFeed(xml);
  assert.equal(doc.format, 'rss');
  assert.equal(doc.items[0].title, 'a > b');
});

// ---------------------------------------------------------------------------
// 2. 格式探测与三种格式解析
// ---------------------------------------------------------------------------
test('detectFormat 识别 rss / atom / rdf / json', () => {
  assert.equal(detectFormat(rssFixture), 'rss');
  assert.equal(detectFormat(atomFixture), 'atom');
  assert.equal(detectFormat(jsonFixture), 'json');
  assert.equal(detectFormat('<rdf:RDF xmlns:rdf="x"><item/></rdf:RDF>'), 'rss');
  assert.throws(() => detectFormat('<html><body>nope</body></html>'), /unsupported feed format/);
});

test('JSON Feed 解析失败给出明确错误', () => {
  assert.throws(() => parseFeed('{oops'), /invalid JSON Feed/);
  assert.throws(() => parseFeed('{"hello":"world"}'), /missing JSON Feed version/);
});

test('三种格式都解析出同样数量的条目，且保留各自原始字段', () => {
  for (const raw of [rssFixture, atomFixture, jsonFixture]) {
    const parsed = parseFeed(raw);
    assert.equal(parsed.items.length, 2);
    assert.ok(parsed.items.every((item) => item.sourceFormat === parsed.format));
  }
  assert.equal(parseFeed(atomFixture).items[0].links.length, 1); // entry 只有 alternate
  const atomFeedLinks = parseFeed(atomFixture).meta;
  assert.ok(atomFeedLinks.link.startsWith('https://example.test/'));
  assert.equal(parseFeed(jsonFixture).items[0].authors[0], 'Ada');
});

// ---------------------------------------------------------------------------
// 3. 统一条目模型：跨格式同内容得到同一 canonical id 与一致的纯文本值
// ---------------------------------------------------------------------------
test('跨格式：同一篇内容收敛到相同 canonical id，不会拆成两篇', () => {
  const normalized = formats => formats.map((raw) => normalizeFeed(parseFeed(raw)));
  const [rss, atom, json] = normalized([rssFixture, atomFixture, jsonFixture]);

  const expected = [shared.post1.id, shared.post2.id];
  for (const result of [rss, atom, json]) {
    assert.deepEqual(result.entries.map((entry) => entry.id), expected);
    assert.equal(result.duplicates.length, 0);
    assert.equal(result.skippedEmpty.length, 0);
  }
});

test('跨格式：HTML 剥离、日期 ISO 化、字段顺序差异都得到一致结果', () => {
  const byId = (result) => new Map(result.entries.map((entry) => [entry.id, entry]));
  const rss = byId(normalizeFeed(parseFeed(rssFixture)));
  const atom = byId(normalizeFeed(parseFeed(atomFixture)));
  const json = byId(normalizeFeed(parseFeed(jsonFixture)));

  for (const id of [shared.post1.id, shared.post2.id]) {
    for (const [field, value] of Object.entries({
      title: rss.get(id).title,
      summary: rss.get(id).summary,
      published: rss.get(id).published,
    })) {
      assert.equal(atom.get(id)[field], value, `atom ${field} of ${id}`);
      assert.equal(json.get(id)[field], value, `json ${field} of ${id}`);
    }
    assert.equal(entryFingerprint(rss.get(id)), entryFingerprint(atom.get(id)));
    assert.equal(entryFingerprint(rss.get(id)), entryFingerprint(json.get(id)));
  }

  // 摘要里的 CDATA + 嵌套 <b> 被剥离成纯文本。
  assert.equal(rss.get(shared.post1.id).summary, 'hello world');
  assert.equal(atom.get(shared.post1.id).summary, 'hello world');
  // 非法/缺失日期不会污染 published，合法日期统一为 ISO。
  assert.equal(rss.get(shared.post1.id).published, '2026-11-14T10:00:00.000Z');
});

test('格式切换后按 canonical id 去重：二三轮 fresh 均为 0', () => {
  const known = new Set();
  const freshCounts = [];
  for (const raw of [rssFixture, atomFixture, jsonFixture]) {
    const { entries } = normalizeFeed(parseFeed(raw));
    freshCounts.push(newItems(entries, known).length);
    entries.forEach((entry) => known.add(entry.id));
  }
  assert.deepEqual(freshCounts, [2, 0, 0]);
});

test('sameEntry 区分“同 id 内容变化”与“同 id 完全一致”', () => {
  const a = normalizeFeed(parseFeed(rssFixture)).entries[0];
  const b = normalizeFeed(parseFeed(atomFixture)).entries[0];
  assert.equal(sameEntry(a, b), true);
  const changed = { ...b, summary: 'totally rewritten summary' };
  assert.equal(sameEntry(a, changed), false);
  assert.equal(sameEntry(a, null), false);
});

// ---------------------------------------------------------------------------
// 4. canonical id 优先级与回退
// ---------------------------------------------------------------------------
test('guid 优先级：显式 guid（含 isPermaLink=false）高于链接', () => {
  const result = normalizeFeed(parseFeed(rssEdgeFixture));
  const kinds = Object.fromEntries(result.entries.map((entry) => [entry.id, entry.idKind]));
  assert.equal(kinds['dup-1'], 'explicit');
  assert.equal(kinds['tag:example.test,2026:post-2'] ?? true, true); // 主 fixture 的不透明 id
  const opaque = result.entries.find((entry) => entry.guid === 'tag:edge.test,2026:g');
  assert.equal(opaque.id, 'tag:edge.test,2026:g');
  assert.equal(opaque.idKind, 'explicit');
});

test('URL 形 guid 与链接字段共用规范化，跨格式得到同一 id', () => {
  const rss = normalizeFeed(parseFeed(rssEdgeFixture)).entries.find((entry) => entry.idKind === 'explicit' && entry.id.startsWith('https://edge.test/b'));
  const atom = normalizeFeed(parseFeed(atomEdgeFixture)).entries[0];
  // RSS: guid isPermaLink=true https://edge.test/b；Atom: id 带尾斜杠。
  assert.equal(rss.id, atom.id);
  assert.equal(rss.id, 'https://edge.test/b');
});

test('无 guid 时回退到规范化链接，再无链接时回退到标题指纹', () => {
  const result = normalizeFeed(parseFeed(rssEdgeFixture));
  const byTitle = Object.fromEntries(result.entries.map((entry) => [entry.title, entry]));
  assert.equal(byTitle['No guid at all'].id, 'https://edge.test/c');
  assert.equal(byTitle['No guid at all'].idKind, 'link');
  assert.ok(byTitle['Title only item'].id.startsWith('h:'));
  assert.equal(byTitle['Title only item'].idKind, 'title-hash');
});

test('canonicalizeUrl: 主机名小写、去默认端口、去 fragment、查询参数排序、去尾斜杠', () => {
  const base = 'https://edge.test/path';
  assert.equal(canonicalizeUrl('HTTPS://EDGE.TEST:443/path/?a=1&b=2#frag'), 'https://edge.test/path?a=1&b=2');
  assert.equal(canonicalizeUrl('https://edge.test/path?b=2&a=1'), `${base}?a=1&b=2`);
  assert.equal(canonicalizeUrl('https://edge.test/path/'), base);
  assert.equal(canonicalizeUrl('urn:uuid:1234'), 'urn:uuid:1234'); // 非 http(s) 原样保留
  assert.equal(canonicalizeUrl('not a url at all'), 'not a url at all');
});

test('标题回退：标题缺失时用摘要前缀，两种格式仍可比', () => {
  const onlySummaryRss = parseFeed('<rss><channel><item><description>Some long summary text here</description><link>https://x.test/p</link></item></channel></rss>');
  const entry = normalizeFeed(onlySummaryRss).entries[0];
  assert.equal(entry.title, 'Some long summary text here');
  assert.equal(entry.id, 'https://x.test/p'); // 有链接时链接优先，标题仅作展示回退
});

// ---------------------------------------------------------------------------
// 5. 重复 id、空条目、非法日期、命名空间
// ---------------------------------------------------------------------------
test('批内重复 canonical id 被显式上报并保留首个，不静默覆盖', () => {
  const result = normalizeFeed(parseFeed(rssEdgeFixture));
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].id, 'dup-1');
  assert.equal(result.duplicates[0].firstIndex, 0);
  assert.equal(result.entries.filter((entry) => entry.id === 'dup-1').length, 1);
  assert.equal(result.entries.find((entry) => entry.id === 'dup-1').title, 'First');
});

test('空条目被剔除并给出原因，不产生伪主键', () => {
  const result = normalizeFeed(parseFeed(rssEdgeFixture));
  assert.equal(result.skippedEmpty.length, 1);
  assert.match(result.skippedEmpty[0].reason, /empty entry/);
  // 7 个原始 item：1 个重复、1 个空 → 5 条归一化条目。
  assert.equal(result.normalized ?? result.entries.length, 5);
});

test('非法日期保留原始串并标记，合法日期转 ISO；缺失发布时间安全降级', () => {
  const result = normalizeFeed(parseFeed(rssEdgeFixture));
  const bad = result.entries.find((entry) => entry.dateRaw.published === 'not-a-real-date');
  assert.equal(bad.published, '');
  assert.deepEqual(bad.dateInvalid, [true, false]);

  const noDate = normalizeItem({ sourceFormat: 'rss', title: 'undated', link: 'https://x.test/u' });
  assert.equal(noDate.published, '');
  assert.equal(noDate.updated, '');
  assert.deepEqual(noDate.dateInvalid, [false, false]);
});

test('不同命名空间的元素按本地名识别（content:encoded、dc:creator、rdf:about）', () => {
  const result = normalizeFeed(parseFeed(rssEdgeFixture));
  const ns = result.entries.find((entry) => entry.title === 'Namespace author');
  assert.deepEqual(ns.authors, ['Someone & Co']);

  const rdf = `<?xml version="1.0"?>
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
           xmlns="http://purl.org/rss/1.0/">
    <item rdf:about="https://rdf.test/1"><title>RDF item</title><link>https://rdf.test/1</link>
      <description>rss 1.0 body</description></item>
  </rdf:RDF>`;
  const parsed = parseFeed(rdf);
  assert.equal(parsed.format, 'rss');
  const entry = normalizeFeed(parsed).entries[0];
  assert.equal(entry.id, 'https://rdf.test/1');
  assert.equal(entry.summary, 'rss 1.0 body');
});

test('Atom xhtml 内容与 RSS CDATA 嵌套 HTML 剥离结果一致', () => {
  const atom = normalizeFeed(parseFeed(atomEdgeFixture)).entries[0];
  const rss = normalizeFeed(parseFeed(rssEdgeFixture)).entries.find((entry) => entry.id === 'https://edge.test/b');
  assert.equal(atom.summary, rss.summary);
  assert.equal(atom.summary, 'nested html');
});

// ---------------------------------------------------------------------------
// 6. 回归：旧 fixture 行为与工具函数
// ---------------------------------------------------------------------------
test('回归：RSS fixture 摘要剥离 CDATA 与标签后为纯文本', () => {
  const parsed = parseFeed(rssFixture);
  assert.equal(parsed.format, 'rss');
  assert.equal(normalizeItem(parsed.items[0]).summary, 'hello world');
});

test('stripHtml 处理嵌套标签、实体与多余空白', () => {
  assert.equal(stripHtml('<p>a <b>b</b></p><div>c</div>'), 'a b c');
  assert.equal(stripHtml('Tom &amp; Jerry &mdash; yes'), 'Tom & Jerry — yes');
});

test('纯 JSON 空 items 数组安全归一化', () => {
  const result = normalizeFeed(parseFeed(JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1', items: [],
  })));
  assert.equal(result.format, 'json');
  assert.deepEqual(result.entries, []);
});

// ---------------------------------------------------------------------------
// 7. 端到端：原始 feed → 解析 → 归一化 → 更新判定 → 存储/投递（跨格式切换）
// ---------------------------------------------------------------------------
test('端到端：同一 feed 在 RSS→Atom→JSON 间切换不拆条、不重复入库', () => {
  const dbPath = join(tmpdir(), `feedhub-e2e-${process.pid}-${Date.now()}.db`);
  rmSync(dbPath, { force: true });
  const opts = { id: 'feed-e2e', url: 'file://fixture', dbPath, subscribers: ['warehouse', 'search'] };

  const first = ingestFeed({ ...opts, raw: rssFixture });
  const switchedToAtom = ingestFeed({ ...opts, raw: atomFixture });
  const switchedToJson = ingestFeed({ ...opts, raw: jsonFixture });

  assert.equal(first.format, 'rss');
  assert.equal(first.parsed, 2);
  assert.equal(first.fresh, 2);
  assert.equal(first.delivered, 4);
  // 格式切换后 canonical id 全部已知：零新增，证明不会拆成两篇。
  assert.equal(switchedToAtom.fresh, 0);
  assert.equal(switchedToJson.fresh, 0);
  assert.deepEqual([...existingIds(dbPath, 'feed-e2e')].sort(),
    [shared.post1.id, shared.post2.id].sort());

  const stored = counts(dbPath);
  assert.equal(stored.feeds, 1);
  assert.equal(stored.items, 2);
  assert.equal(stored.deliveries, 4); // 只有首轮的两条各投两个订阅方
  rmSync(dbPath, { force: true });
});

test('端到端：边界 feed 的重复 id 与空条目被计数上报，非法日期不中断链路', () => {
  const dbPath = join(tmpdir(), `feedhub-edge-${process.pid}-${Date.now()}.db`);
  const result = ingestFeed({ id: 'feed-edge', url: 'file://edge', raw: rssEdgeFixture, dbPath, subscribers: [] });
  assert.equal(result.parsed, 7);
  assert.equal(result.normalized, 5);
  assert.equal(result.duplicateIds, 1);
  assert.equal(result.skippedEmpty, 1);
  assert.equal(result.fresh, 5);
  assert.equal(counts(dbPath).items, 5);
  rmSync(dbPath, { force: true });
});

test(`存储后端可用性（当前环境：${storageBackend}）`, () => {
  assert.ok(['sqlite3', 'memory'].includes(storageBackend));
});

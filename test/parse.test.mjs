import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../src/mockfeed.mjs';
import { parseFeed } from '../src/parse.mjs';
import { normalizeItem } from '../src/normalize.mjs';
import { itemIdentity } from '../src/identity.mjs';
import { classify, materialProjection } from '../src/revision.mjs';
import { signature, verifySignature } from '../src/websub.mjs';

test('parses the local RSS fixture', () => {
  const parsed = parseFeed(fixture);
  assert.equal(parsed.format, 'rss');
  assert.equal(parsed.items.length, 2);
  assert.equal(normalizeItem(parsed.items[0]).summary, 'hello world');
});

test('rejects formats that are intentionally not implemented', () => {
  assert.throws(() => parseFeed('{"version":"https://jsonfeed.org/version/1"}'), /not implemented/);
  assert.throws(() => parseFeed('<feed><entry/></feed>'), /not implemented/);
  assert.throws(() => parseFeed('   '), /empty/);
});

test('keeps a raw empty guid instead of silently borrowing content', () => {
  const parsed = parseFeed('<rss><channel><item><title>only title</title></item></channel></rss>');
  assert.equal(parsed.items[0].guid, '');
});

test('decodes entities outside CDATA but not inside it', () => {
  const parsed = parseFeed(
    '<rss><channel><item><guid>g</guid><title>a &amp; b</title>' +
      '<description><![CDATA[x &amp; y]]></description></item></channel></rss>',
  );
  assert.equal(parsed.items[0].title, 'a & b');
  assert.equal(parsed.items[0].summary, 'x &amp; y');
});

test('verifies WebSub HMAC signatures', () => {
  const body = 'payload';
  const signed = signature(body, 'secret');
  assert.equal(verifySignature(body, signed, 'secret'), true);
  assert.equal(verifySignature(body, signed, 'wrong'), false);
});

test('identity prefers guid, then link, then title, then content', () => {
  const guid = itemIdentity({ guid: 'abc', title: 'T', link: 'https://e.test/1' });
  assert.equal(guid.kind, 'guid');
  assert.equal(guid.weaklyIdentified, false);

  const link = itemIdentity({ guid: '', title: 'T', link: 'https://e.test/1?utm_source=x#frag' });
  assert.equal(link.kind, 'link');
  assert.equal(link.linkKey, 'https://e.test/1');

  const title = itemIdentity({ guid: '', title: 'Only Title', link: '' });
  assert.equal(title.kind, 'title');
  assert.equal(title.weaklyIdentified, true);

  const hash = itemIdentity({ guid: '', title: '', link: '', summary: 'body' });
  assert.equal(hash.kind, 'hash');
  assert.equal(hash.weaklyIdentified, true);
});

test('identity is stable across cosmetic link differences', () => {
  const a = itemIdentity({ guid: '', title: 'Same', link: 'https://E.test/post/?utm_campaign=z' });
  const b = itemIdentity({ guid: '', title: 'Same', link: 'https://e.test/post' });
  assert.equal(a.key, b.key);
});

test('revision material projection ignores tracking params and dates', () => {
  const a = materialProjection({ title: 'T', link: 'https://e.test/p?utm_source=a', summary: 's' });
  const b = materialProjection({ title: 'T', link: 'https://e.test/p', summary: 's' });
  assert.deepEqual(a, b);
});

test('classify distinguishes new, revision, metadata, unchanged', () => {
  const identity = itemIdentity({ guid: 'g', title: 'T', link: 'https://e.test/1' });
  const base = { title: 'T', link: 'https://e.test/1', published: '', summary: 'body' };

  const created = classify(null, { ...base, guid: 'g' }, identity);
  assert.equal(created.kind, 'new');
  assert.equal(created.version, 1);

  const existing = {
    version: 1,
    content_hash: created.contentHash,
    payload_hash: created.payloadHash,
  };

  const same = classify(existing, { ...base, guid: 'g' }, identity);
  assert.equal(same.kind, 'unchanged');

  const metadata = classify(existing, { ...base, guid: 'g', published: '2026-01-01T00:00:00Z' }, identity);
  assert.equal(metadata.kind, 'metadata');
  assert.equal(metadata.version, 1);

  const revision = classify(existing, { ...base, guid: 'g', summary: 'body changed' }, identity);
  assert.equal(revision.kind, 'revision');
  assert.equal(revision.version, 2);
});

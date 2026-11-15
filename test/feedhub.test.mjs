import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../src/mockfeed.mjs';
import { parseFeed } from '../src/parse.mjs';
import { normalizeItem } from '../src/normalize.mjs';
import { signature, verifySignature } from '../src/websub.mjs';

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

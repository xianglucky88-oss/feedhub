import { rmSync } from 'node:fs';
import { fixture } from './mockfeed.mjs';
import { ingestFeed } from './poll.mjs';
import { counts } from './store.mjs';
import { signature, verifySignature } from './websub.mjs';

const command = process.argv[2];
if (command !== 'demo') {
  console.error('usage: node src/cli.mjs demo');
  process.exit(2);
}

const dbPath = '/tmp/feedhub/feedhub.db';
rmSync('/tmp/feedhub', { recursive: true, force: true });
const first = ingestFeed({ id: 'local', url: 'file://fixture', raw: fixture, dbPath, subscribers: ['warehouse', 'search'] });
const second = ingestFeed({ id: 'local', url: 'file://fixture', raw: fixture, dbPath, subscribers: ['warehouse', 'search'] });
const body = '<hub.challenge>ok</hub.challenge>';
console.log(JSON.stringify({ first, second, counts: counts(dbPath), signatureValid: verifySignature(body, signature(body, 'secret'), 'secret') }, null, 2));

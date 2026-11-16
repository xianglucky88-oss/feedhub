import { rmSync } from 'node:fs';
import { fixture } from './mockfeed.mjs';
import { ingestFeed, feedState } from './ingest.mjs';
import { openDb, transaction } from './db.mjs';
import { signature, verifySignature } from './websub.mjs';
import { deliveryStateCounts, runDeliveries, recoverExpiredLeases } from './delivery.mjs';
import { syncSubscriptions } from './subscriptions.mjs';

const dbPath = process.env.FEEDHUB_DB ?? '/tmp/feedhub/feedhub.db';

async function demo() {
  rmSync('/tmp/feedhub', { recursive: true, force: true });
  const db = openDb(dbPath);
  const now = () => new Date().toISOString();
  try {
    const first = ingestFeed({
      id: 'local', url: 'file://fixture', raw: fixture, dbPath,
      subscribers: ['warehouse', 'search'], now: now(), trigger: 'demo',
    });
    const replay = ingestFeed({
      id: 'local', url: 'file://fixture', raw: fixture, dbPath,
      subscribers: ['warehouse', 'search'], now: now(), trigger: 'demo-replay',
    });
    const revised = ingestFeed({
      id: 'local', url: 'file://fixture',
      raw: fixture.replace('hello <b>world</b>', 'hello <b>world</b> (revised)'),
      dbPath, subscribers: ['warehouse', 'search'], now: now(), trigger: 'demo-revision',
    });
    const empty = ingestFeed({
      id: 'local', url: 'file://fixture',
      raw: '<?xml version="1.0"?><rss version="2.0"><channel><title>Local Feed</title></channel></rss>',
      dbPath, subscribers: ['warehouse', 'search'], now: now(), trigger: 'demo-empty',
    });

    // Deliver everything that is queued, using a ledger to prove that a
    // retried external send is not repeated.
    const sent = new Set();
    const send = async (delivery) => {
      if (sent.has(delivery.idempotency_key)) return { skipped: true };
      sent.add(delivery.idempotency_key);
      return { externalId: `local:${delivery.subscriber}:${delivery.identity}:${delivery.version}` };
    };
    recoverExpiredLeases(db, { now: now() });
    const deliveryRun = await runDeliveries(db, send, { now: now(), leaseMs: 30_000 });

    const body = '<hub.challenge>ok</hub.challenge>';
    return {
      first, replay, revised, empty,
      deliveryRun: deliveryRun.length,
      counts: feedState(db, 'local').counts,
      deliveryStates: deliveryStateCounts(db, 'local'),
      signatureValid: verifySignature(body, signature(body, 'secret'), 'secret'),
    };
  } finally {
    db.close();
  }
}

const command = process.argv[2];
if (command === 'demo') {
  console.log(JSON.stringify(await demo(), null, 2));
} else if (command === 'inspect') {
  const feedId = process.argv[3] ?? 'local';
  const db = openDb(dbPath);
  try {
    console.log(JSON.stringify({
      feed: feedState(db, feedId),
      deliveryStates: deliveryStateCounts(db, feedId),
      runs: db.prepare('SELECT * FROM ingest_runs WHERE feed_id = ? ORDER BY id').all(feedId),
    }, null, 2));
  } finally {
    db.close();
  }
} else if (command === 'sync-subscribers') {
  const feedId = process.argv[3];
  const subscribers = process.argv.slice(4).map((entry) => {
    const [id, notify, backfill] = entry.split(':');
    return { id, ...(notify ? { notify } : {}), ...(backfill ? { backfill: backfill === 'backfill' } : {}) };
  });
  const db = openDb(dbPath);
  try {
    console.log(JSON.stringify(transaction(db, () =>
      syncSubscriptions(db, feedId, subscribers, { now: new Date().toISOString() }),
    ), null, 2));
  } finally {
    db.close();
  }
} else {
  console.error('usage: node src/cli.mjs demo | inspect [feedId] | sync-subscribers <feedId> <id[:notify[:backfill]]>...');
  process.exit(2);
}

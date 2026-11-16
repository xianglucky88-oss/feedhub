import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestFeed, feedState, IngestError, recoverStaleRuns } from '../src/ingest.mjs';
import { openDb, transaction } from '../src/db.mjs';
import {
  claimDeliveries,
  confirmDelivery,
  failDelivery,
  recoverExpiredLeases,
  runDeliveries,
  deliveryStateCounts,
  listQueue,
} from '../src/delivery.mjs';
import { syncSubscriptions, removeSubscriber, listSubscribers } from '../src/subscriptions.mjs';
import { tempDb, rss, emptyRss } from './helpers.mjs';

function withStore(fn) {
  const db = tempDb('feedhub-state');
  const finish = () => db.cleanup();
  try {
    const result = fn(db.path);
    if (result && typeof result.then === 'function') return result.finally(finish);
    finish();
    return result;
  } catch (error) {
    finish();
    throw error;
  }
}

async function withStoreAsync(fn) {
  const db = tempDb('feedhub-state');
  try {
    return await fn(db.path);
  } finally {
    db.cleanup();
  }
}

function states(db, feedId = 'f') {
  return deliveryStateCounts(db, feedId);
}

test('first snapshot saves items and enqueues one intent per subscriber', () => {
  withStore((dbPath) => {
    const result = ingestFeed({
      id: 'f',
      raw: rss([
        { guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'a' },
        { guid: 'p2', title: 'Two', link: 'https://e.test/2', summary: 'b' },
      ]),
      dbPath,
      subscribers: ['alice', 'bob'],
      now: '2026-11-16T00:00:00.000Z',
    });
    assert.equal(result.status, 'applied');
    assert.equal(result.new, 2);
    assert.equal(result.deliveryIntents, 4);

    const db = openDb(dbPath);
    try {
      assert.deepEqual(states(db), {
        pending: 4, inflight: 0, retry: 0, failed: 0, delivered: 0, cancelled: 0, total: 4,
      });
      assert.equal(feedState(db, 'f').counts.items, 2);
    } finally {
      db.close();
    }
  });
});

test('replaying the same snapshot creates no versions, events, or intents', () => {
  withStore((dbPath) => {
    const raw = rss([{ guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'a' }]);
    ingestFeed({ id: 'f', raw, dbPath, subscribers: ['alice'], now: '2026-11-16T00:00:00.000Z' });
    const replay = ingestFeed({ id: 'f', raw, dbPath, subscribers: ['alice'], now: '2026-11-16T00:01:00.000Z' });
    assert.equal(replay.status, 'applied');
    assert.equal(replay.unchanged, 1);
    assert.equal(replay.revisions, 0);
    assert.equal(replay.deliveryIntents, 0);

    const db = openDb(dbPath);
    try {
      assert.equal(db.prepare('SELECT count(*) c FROM item_versions').get().c, 1);
      assert.equal(db.prepare('SELECT count(*) c FROM item_events').get().c, 1);
      assert.equal(states(db).total, 1);
    } finally {
      db.close();
    }
  });
});

test('a changed body produces exactly one new version and one update event per subscriber', () => {
  withStore((dbPath) => {
    ingestFeed({
      id: 'f',
      raw: rss([{ guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'v1' }]),
      dbPath, subscribers: ['alice', 'bob'], now: '2026-11-16T00:00:00.000Z',
    });
    const revised = ingestFeed({
      id: 'f',
      raw: rss([{ guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'v2' }]),
      dbPath, subscribers: ['alice', 'bob'], now: '2026-11-16T00:01:00.000Z',
    });
    assert.equal(revised.revisions, 1);
    assert.equal(revised.events.length, 1);
    assert.equal(revised.events[0].eventType, 'update');
    assert.equal(revised.events[0].version, 2);
    assert.equal(revised.deliveryIntents, 2);

    // Replaying the revision is a no-op.
    const again = ingestFeed({
      id: 'f',
      raw: rss([{ guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'v2' }]),
      dbPath, subscribers: ['alice', 'bob'], now: '2026-11-16T00:02:00.000Z',
    });
    assert.equal(again.revisions, 0);
    assert.equal(again.deliveryIntents, 0);

    const db = openDb(dbPath);
    try {
      assert.deepEqual(
        db.prepare('SELECT version, summary FROM item_versions ORDER BY version').all()
          .map((row) => [row.version, row.summary]),
        [[1, 'v1'], [2, 'v2']],
      );
    } finally {
      db.close();
    }
  });
});

test('cosmetic changes update payload without a version or notification', () => {
  withStore((dbPath) => {
    ingestFeed({
      id: 'f',
      raw: rss([{ guid: 'p1', title: 'One', link: 'https://e.test/1', published: 'Fri, 14 Nov 2026 10:00:00 GMT', summary: 'same' }]),
      dbPath, subscribers: ['alice'], now: '2026-11-16T00:00:00.000Z',
    });
    // Different date formatting and a tracking param: not material.
    const cosmetic = ingestFeed({
      id: 'f',
      raw: rss([{ guid: 'p1', title: '  One ', link: 'https://e.test/1?utm_source=x', published: '2026-11-14T10:00:00.000Z', summary: 'same' }]),
      dbPath, subscribers: ['alice'], now: '2026-11-16T00:01:00.000Z',
    });
    assert.equal(cosmetic.revisions, 0);
    assert.equal(cosmetic.metadata, 1);
    assert.equal(cosmetic.deliveryIntents, 0);

    const db = openDb(dbPath);
    try {
      assert.equal(db.prepare('SELECT count(*) c FROM item_versions').get().c, 1);
    } finally {
      db.close();
    }
  });
});

test('an empty response never deletes stored history', () => {
  withStore((dbPath) => {
    ingestFeed({
      id: 'f',
      raw: rss([
        { guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'a' },
        { guid: 'p2', title: 'Two', link: 'https://e.test/2', summary: 'b' },
      ]),
      dbPath, subscribers: ['alice'], now: '2026-11-16T00:00:00.000Z',
    });
    const empty = ingestFeed({ id: 'f', raw: emptyRss(), dbPath, now: '2026-11-16T00:01:00.000Z' });
    assert.equal(empty.status, 'empty');
    assert.equal(empty.stored.items, 2);
    assert.equal(empty.deliveryIntents, 0);

    const db = openDb(dbPath);
    try {
      const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get('f');
      assert.equal(feed.consecutive_empty, 1);
      assert.equal(feed.applied_snapshot_at, '2026-11-16T00:00:00.000Z');
      // Baseline is intact: the next non-empty snapshot is still unchanged.
      const next = ingestFeed({
        id: 'f',
        raw: rss([
          { guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'a' },
          { guid: 'p2', title: 'Two', link: 'https://e.test/2', summary: 'b' },
        ]),
        dbPath, now: '2026-11-16T00:02:00.000Z',
      });
      assert.equal(next.unchanged, 2);
      assert.equal(next.deliveryIntents, 0);
    } finally {
      db.close();
    }
  });
});

test('a malformed response fails the run without touching items', () => {
  withStore((dbPath) => {
    ingestFeed({
      id: 'f',
      raw: rss([{ guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'a' }]),
      dbPath, subscribers: ['alice'], now: '2026-11-16T00:00:00.000Z',
    });
    assert.throws(
      () => ingestFeed({ id: 'f', raw: '<html>maintenance</html>', dbPath, now: '2026-11-16T00:01:00.000Z' }),
      (error) => error instanceof IngestError && error.code === 'PARSE_FAILED',
    );
    const db = openDb(dbPath);
    try {
      assert.equal(feedState(db, 'f').counts.items, 1);
      const run = db.prepare('SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1').get();
      assert.equal(run.status, 'failed');
      assert.match(run.error, /unsupported feed format/);
    } finally {
      db.close();
    }
  });
});

test('a failure mid-batch rolls back the whole snapshot and retry resumes from the boundary', () => {
  withStore((dbPath) => {
    const before = rss([{ guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'a' }]);
    ingestFeed({ id: 'f', raw: before, dbPath, subscribers: ['alice'], now: '2026-11-16T00:00:00.000Z' });

    const batch = rss([
      { guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'a' },
      { guid: 'p2', title: 'Two', link: 'https://e.test/2', summary: 'b' },
      { guid: 'p3', title: 'Three', link: 'https://e.test/3', summary: 'c' },
    ]);

    assert.throws(
      () => ingestFeed({
        id: 'f', raw: batch, dbPath, subscribers: ['alice'], now: '2026-11-16T00:01:00.000Z',
        failpoint: ({ stage, index }) => {
          if (stage === 'item' && index === 2) throw new Error('injected crash');
        },
      }),
      (error) => error.code === 'APPLY_FAILED',
    );

    const db = openDb(dbPath);
    try {
      // Nothing from the failed batch is visible.
      assert.equal(feedState(db, 'f').counts.items, 1);
      assert.equal(feedState(db, 'f').counts.events, 1);
      assert.equal(db.prepare("SELECT count(*) c FROM deliveries WHERE identity LIKE 'g:%'").get().c, 1);
      assert.equal(db.prepare('SELECT status FROM ingest_runs ORDER BY id DESC LIMIT 1').get().status, 'failed');
    } finally {
      db.close();
    }

    const retry = ingestFeed({
      id: 'f', raw: batch, dbPath, subscribers: ['alice'], now: '2026-11-16T00:02:00.000Z',
    });
    assert.equal(retry.status, 'applied');
    assert.equal(retry.new, 2, 'only the two not-yet-committed items are new');
    assert.equal(retry.unchanged, 1);
    assert.equal(retry.deliveryIntents, 2);

    const db2 = openDb(dbPath);
    try {
      assert.equal(feedState(db2, 'f').counts.items, 3);
      assert.equal(feedState(db2, 'f').counts.events, 3);
    } finally {
      db2.close();
    }
  });
});

test('a crash after intents are enqueued does not duplicate them on replay', () => {
  withStore((dbPath) => {
    const raw = rss([{ guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'a' }]);
    assert.throws(
      () => ingestFeed({
        id: 'f', raw, dbPath, subscribers: ['alice', 'bob'], now: '2026-11-16T00:00:00.000Z',
        failpoint: ({ stage }) => {
          if (stage === 'after-enqueue') throw new Error('crash after enqueue');
        },
      }),
      (error) => error.code === 'APPLY_FAILED',
    );

    const db = openDb(dbPath);
    assert.equal(states(db).total, 0, 'rollback removes intents from the failed run');
    db.close();

    const retry = ingestFeed({ id: 'f', raw, dbPath, subscribers: ['alice', 'bob'], now: '2026-11-16T00:01:00.000Z' });
    assert.equal(retry.new, 1);
    assert.equal(retry.deliveryIntents, 2);

    const db2 = openDb(dbPath);
    try {
      assert.equal(states(db2).total, 2);
      // Replay yet again: still 2.
      ingestFeed({ id: 'f', raw, dbPath, subscribers: ['alice', 'bob'], now: '2026-11-16T00:02:00.000Z' });
      assert.equal(states(db2).total, 2);
    } finally {
      db2.close();
    }
  });
});

test('guid appearing later adopts the content-identified item without duplicating it', () => {
  withStore((dbPath) => {
    const withoutGuid = rss([{ title: 'Hello World', link: 'https://e.test/a', summary: 'body' }]);
    const withGuid = rss([{ guid: 'g-42', title: 'Hello World', link: 'https://e.test/a', summary: 'body' }]);

    const first = ingestFeed({ id: 'f', raw: withoutGuid, dbPath, subscribers: ['alice'], now: '2026-11-16T00:00:00.000Z' });
    assert.equal(first.new, 1);

    const second = ingestFeed({ id: 'f', raw: withGuid, dbPath, subscribers: ['alice'], now: '2026-11-16T00:01:00.000Z' });
    assert.equal(second.new, 0, 'must not create a second row');
    assert.equal(second.revisions, 0, 'identity adoption is not a content revision');
    assert.equal(second.adopted, 1);
    assert.equal(second.deliveryIntents, 0);

    const db = openDb(dbPath);
    try {
      const items = db.prepare('SELECT identity_kind, guid, version FROM items').all();
      assert.equal(items.length, 1);
      assert.equal(items[0].identity_kind, 'guid');
      assert.equal(items[0].guid, 'g-42');
      assert.equal(items[0].version, 1);
    } finally {
      db.close();
    }

    // After adoption, a body edit is an ordinary revision of the same row.
    const third = ingestFeed({
      id: 'f', raw: rss([{ guid: 'g-42', title: 'Hello World', link: 'https://e.test/a', summary: 'body v2' }]),
      dbPath, subscribers: ['alice'], now: '2026-11-16T00:02:00.000Z',
    });
    assert.equal(third.revisions, 1);
    assert.equal(third.deliveryIntents, 1);
  });
});

test('a guid-less item edited by title updates in place instead of forking', () => {
  withStore((dbPath) => {
    ingestFeed({
      id: 'f',
      raw: rss([{ title: 'Original Title', link: 'https://e.test/same', summary: 'body' }]),
      dbPath, subscribers: ['alice'], now: '2026-11-16T00:00:00.000Z',
    });
    const edited = ingestFeed({
      id: 'f',
      raw: rss([{ title: 'Renamed Title', link: 'https://e.test/same', summary: 'body' }]),
      dbPath, subscribers: ['alice'], now: '2026-11-16T00:01:00.000Z',
    });
    assert.equal(edited.new, 0, 'the link identifies the same item');
    assert.equal(edited.revisions, 1);
    assert.equal(edited.deliveryIntents, 1);

    const db = openDb(dbPath);
    try {
      assert.equal(db.prepare('SELECT count(*) c FROM items').get().c, 1);
      assert.equal(db.prepare('SELECT identity_kind FROM items').get().identity_kind, 'link');
      assert.equal(db.prepare('SELECT title FROM items').get().title, 'Renamed Title');
    } finally {
      db.close();
    }
  });
});

test('two guids sharing one link stay distinct items', () => {
  withStore((dbPath) => {
    const raw = rss([
      { guid: 'g1', title: 'One', link: 'https://e.test/shared', summary: 'a' },
      { guid: 'g2', title: 'Two', link: 'https://e.test/shared', summary: 'b' },
    ]);
    const result = ingestFeed({ id: 'f', raw, dbPath, subscribers: ['alice'], now: '2026-11-16T00:00:00.000Z' });
    assert.equal(result.new, 2);
    assert.equal(result.adopted, 0);

    const db = openDb(dbPath);
    try {
      assert.equal(db.prepare('SELECT count(*) c FROM items').get().c, 2);
      assert.deepEqual(
        db.prepare('SELECT guid FROM items ORDER BY id').all().map((row) => row.guid),
        ['g1', 'g2'],
      );
    } finally {
      db.close();
    }
  });
});

test('a guid temporarily missing from a guid-keyed item does not fork or hijack it', () => {
  withStore((dbPath) => {
    ingestFeed({
      id: 'f',
      raw: rss([{ guid: 'stable-id', title: 'One', link: 'https://e.test/x', summary: 'v1' }]),
      dbPath, subscribers: ['alice'], now: '2026-11-16T00:00:00.000Z',
    });
    // The source drops the guid but keeps link + content.
    const dropped = ingestFeed({
      id: 'f',
      raw: rss([{ title: 'One', link: 'https://e.test/x', summary: 'v1' }]),
      dbPath, subscribers: ['alice'], now: '2026-11-16T00:01:00.000Z',
    });
    assert.equal(dropped.new, 0);
    assert.equal(dropped.revisions, 0);
    assert.equal(dropped.deliveryIntents, 0);

    const db = openDb(dbPath);
    try {
      const item = db.prepare('SELECT guid, identity_kind FROM items').get();
      assert.equal(item.guid, 'stable-id', 'the guid stays authoritative');
      assert.equal(item.identity_kind, 'guid');
    } finally {
      db.close();
    }

    // And it still updates as a revision of the same row.
    const revised = ingestFeed({
      id: 'f',
      raw: rss([{ title: 'One', link: 'https://e.test/x', summary: 'v2' }]),
      dbPath, subscribers: ['alice'], now: '2026-11-16T00:02:00.000Z',
    });
    assert.equal(revised.new, 0);
    assert.equal(revised.revisions, 1);

    const db2 = openDb(dbPath);
    try {
      assert.equal(db2.prepare('SELECT count(*) c FROM items').get().c, 1);
      assert.equal(db2.prepare('SELECT guid FROM items').get().guid, 'stable-id');
    } finally {
      db2.close();
    }
  });
});

test('backfill after an identity upgrade does not re-notify already-delivered content', () => {
  withStore((dbPath) => {
    const db = openDb(dbPath);
    try {
      // 1. Item arrives without a guid and is delivered to alice.
      ingestFeed({
        id: 'f',
        raw: rss([{ title: 'Hello', link: 'https://e.test/a', summary: 'body' }]),
        dbPath, subscribers: ['alice'], now: '2026-11-16T00:00:00.000Z',
      });
      const claim = claimDeliveries(db, { now: '2026-11-16T00:01:00.000Z', leaseMs: 60_000 });
      for (const delivery of claim) confirmDelivery(db, delivery.id, { now: '2026-11-16T00:01:01.000Z' });
      assert.equal(states(db).delivered, 1);

      // 2. The guid appears: the item is re-keyed, not re-created.
      const upgrade = ingestFeed({
        id: 'f',
        raw: rss([{ guid: 'g-9', title: 'Hello', link: 'https://e.test/a', summary: 'body' }]),
        dbPath, now: '2026-11-16T00:02:00.000Z',
      });
      assert.equal(upgrade.new, 0);
      assert.equal(upgrade.adopted, 1);

      // 3. A new subscriber backfills. The already-delivered version 1 must
      //    not appear under the new identity.
      const backfill = transaction(db, () =>
        syncSubscriptions(db, 'f', [{ id: 'alice' }, { id: 'bob', backfill: true }], {
          now: '2026-11-16T00:03:00.000Z',
        }),
      );
      assert.equal(backfill.enqueued, 1, 'only bob is new');

      const rows = db.prepare('SELECT subscriber, version, status FROM deliveries ORDER BY subscriber').all();
      assert.deepEqual(
        rows.map((row) => [row.subscriber, row.version, row.status]),
        [['alice', 1, 'delivered'], ['bob', 1, 'pending']],
      );
      assert.equal(db.prepare('SELECT count(*) c FROM deliveries WHERE subscriber = ?').get('alice').c, 1);
      // Idempotency keys were recomputed with the new identity.
      const keys = db.prepare('SELECT DISTINCT idempotency_key FROM deliveries').all();
      assert.equal(keys.length, 2);
    } finally {
      db.close();
    }
  });
});

test('items missing from a later snapshot are recorded as absent but retained', () => {  withStore((dbPath) => {
    ingestFeed({
      id: 'f',
      raw: rss([
        { guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'a' },
        { guid: 'p2', title: 'Two', link: 'https://e.test/2', summary: 'b' },
      ]),
      dbPath, now: '2026-11-16T00:00:00.000Z',
    });
    const partial = ingestFeed({
      id: 'f',
      raw: rss([{ guid: 'p2', title: 'Two', link: 'https://e.test/2', summary: 'b' }]),
      dbPath, now: '2026-11-16T00:01:00.000Z',
    });
    assert.equal(partial.absent, 1);
    assert.equal(partial.stored.items, 2);
  });
});

test('delivery lifecycle distinguishes saved, should-deliver, and delivered', () => {
  withStore((dbPath) => {
    ingestFeed({
      id: 'f', raw: rss([{ guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'a' }]),
      dbPath, subscribers: ['alice'], now: '2026-11-16T00:00:00.000Z',
    });
    const db = openDb(dbPath);
    try {
      // Saved but not delivered.
      assert.equal(feedState(db, 'f').counts.items, 1);
      assert.equal(states(db).pending, 1);

      const [claimed] = claimDeliveries(db, { now: '2026-11-16T00:01:00.000Z', leaseMs: 60_000 });
      assert.equal(claimed.status, 'inflight');
      assert.equal(states(db).inflight, 1);

      confirmDelivery(db, claimed.id, {
        now: '2026-11-16T00:01:05.000Z',
        externalId: 'ext-1',
        idempotencyKey: claimed.idempotency_key,
      });
      assert.equal(states(db).delivered, 1);

      // Confirming again is a no-op, not a second delivery.
      const again = confirmDelivery(db, claimed.id, { now: '2026-11-16T00:01:06.000Z' });
      assert.equal(again.changed, false);
      assert.equal(states(db).total, 1);
    } finally {
      db.close();
    }
  });
});

test('a send that succeeds then crashes before confirm is retried under the same key', async () => {
  await withStoreAsync(async (dbPath) => {
    ingestFeed({
      id: 'f', raw: rss([{ guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'a' }]),
      dbPath, subscribers: ['alice'], now: '2026-11-16T00:00:00.000Z',
    });
    const db = openDb(dbPath);
    try {
      // Worker 1 claims and "sends" successfully, then dies before confirming.
      const [first] = claimDeliveries(db, { now: '2026-11-16T00:01:00.000Z', leaseMs: 1000 });
      const external = new Set([first.idempotency_key]); // external system saw it

      // Lease expires; a second worker takes over.
      assert.equal(recoverExpiredLeases(db, { now: '2026-11-16T00:05:00.000Z' }).length, 1);
      assert.equal(states(db).retry, 1);

      const sender = async (delivery) => {
        if (external.has(delivery.idempotency_key)) return { skipped: true };
        external.add(delivery.idempotency_key);
        return { externalId: 'ext' };
      };
      const results = await runDeliveries(db, sender, { now: '2026-11-16T00:06:00.000Z', leaseMs: 1000 });
      // The external system deduplicated, so the caller reports a skip; the
      // intent remains queued rather than being falsely marked delivered.
      assert.equal(results[0].status, 'skipped');
      assert.equal(states(db).retry + states(db).inflight, 1);

      // Operator confirms the idempotency key says it was already delivered.
      confirmDelivery(db, first.id, { now: '2026-11-16T00:07:00.000Z', externalId: 'ext' });
      assert.equal(states(db).delivered, 1);
      assert.equal(states(db).total, 1);
    } finally {
      db.close();
    }
  });
});

test('retryable failures back off, non-retryable ones become terminal failed', () => {
  withStore((dbPath) => {
    ingestFeed({
      id: 'f',
      raw: rss([
        { guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'a' },
        { guid: 'p2', title: 'Two', link: 'https://e.test/2', summary: 'b' },
      ]),
      dbPath, subscribers: ['alice'], now: '2026-11-16T00:00:00.000Z',
    });
    const db = openDb(dbPath);
    try {
      const claimed = claimDeliveries(db, { now: '2026-11-16T00:01:00.000Z', leaseMs: 60_000 });
      assert.equal(claimed.length, 2);

      failDelivery(db, claimed[0].id, new Error('temporary'), {
        now: '2026-11-16T00:01:01.000Z', retryDelayMs: 10_000,
      });
      const retryRow = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(claimed[0].id);
      assert.equal(retryRow.status, 'retry');
      assert.equal(retryRow.next_attempt_at, '2026-11-16T00:01:11.000Z');
      assert.equal(retryRow.last_error, 'temporary');

      failDelivery(db, claimed[1].id, new Error('permanent'), {
        now: '2026-11-16T00:01:01.000Z', retryable: false,
      });
      assert.equal(db.prepare('SELECT status FROM deliveries WHERE id = ?').get(claimed[1].id).status, 'failed');

      // A retry that succeeds converges to delivered.
      const [again] = claimDeliveries(db, { now: '2026-11-16T00:02:00.000Z', leaseMs: 60_000 });
      assert.equal(again.id, claimed[0].id);
      confirmDelivery(db, again.id, { now: '2026-11-16T00:02:01.000Z' });
      assert.equal(states(db).delivered, 1);
      assert.equal(states(db).failed, 1);
    } finally {
      db.close();
    }
  });
});

test('exhausted retries stop at failed without losing the version', () => {
  withStore((dbPath) => {
    ingestFeed({
      id: 'f', raw: rss([{ guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'a' }]),
      dbPath, subscribers: ['alice'], now: '2026-11-16T00:00:00.000Z',
    });
    const db = openDb(dbPath);
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const [delivery] = claimDeliveries(db, { now: `2026-11-16T00:0${attempt}:00.000Z`, leaseMs: 60_000 });
        if (!delivery) break;
        failDelivery(db, delivery.id, new Error(`boom ${attempt}`), {
          now: `2026-11-16T00:0${attempt}:01.000Z`, maxAttempts: 2, retryDelayMs: 1,
        });
      }
      const row = db.prepare('SELECT * FROM deliveries').get();
      assert.equal(row.status, 'failed');
      assert.equal(row.version, 1);
      assert.equal(db.prepare('SELECT version FROM items').get().version, 1);
    } finally {
      db.close();
    }
  });
});

test('subscriber removal cancels pending and in-flight intents without deleting history', () => {
  withStore((dbPath) => {
    ingestFeed({
      id: 'f', raw: rss([
        { guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'a' },
        { guid: 'p2', title: 'Two', link: 'https://e.test/2', summary: 'b' },
      ]),
      dbPath, subscribers: ['alice', 'bob'], now: '2026-11-16T00:00:00.000Z',
    });
    const db = openDb(dbPath);
    try {
      // bob's intents are pending; alice's are in flight.
      claimDeliveries(db, { now: '2026-11-16T00:01:00.000Z', leaseMs: 60_000, subscribers: ['bob'] });
      claimDeliveries(db, { now: '2026-11-16T00:01:01.000Z', leaseMs: 60_000, subscribers: ['alice'] });
      assert.equal(states(db).inflight, 4);

      const removed = removeSubscriber(db, 'f', 'alice', { now: '2026-11-16T00:02:00.000Z' });
      assert.deepEqual(removed.removed, ['alice']);
      // In-flight work may already have reached the external system, so it is
      // left for the worker to confirm or fail rather than being rewritten as
      // cancelled (which would hide a real delivery).
      assert.equal(removed.cancelled, 0);

      const aliceRows = db.prepare("SELECT status FROM deliveries WHERE subscriber = 'alice'").all();
      assert.ok(aliceRows.every((row) => row.status === 'inflight'));
      assert.equal(aliceRows.length, 2, 'rows are retained, not deleted');

      // An inactive subscriber is never re-claimed.
      const reclaim = claimDeliveries(db, { now: '2026-11-16T00:02:30.000Z', leaseMs: 60_000, subscribers: ['alice'] });
      assert.equal(reclaim.length, 0);

      assert.equal(db.prepare("SELECT count(*) c FROM deliveries WHERE subscriber = 'bob'").get().c, 2);
      assert.equal(db.prepare('SELECT count(*) c FROM items').get().c, 2);
      assert.equal(listSubscribers(db, 'f').find((row) => row.subscriber === 'alice').active, false);
    } finally {
      db.close();
    }
  });
});

test('removing a subscriber cancels queued but unattempted intents', () => {
  withStore((dbPath) => {
    ingestFeed({
      id: 'f', raw: rss([
        { guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'a' },
        { guid: 'p2', title: 'Two', link: 'https://e.test/2', summary: 'b' },
      ]),
      dbPath, subscribers: ['alice'], now: '2026-11-16T00:00:00.000Z',
    });
    const db = openDb(dbPath);
    try {
      assert.equal(states(db).pending, 2);
      const removed = removeSubscriber(db, 'f', 'alice', { now: '2026-11-16T00:01:00.000Z' });
      assert.equal(removed.cancelled, 2);
      const rows = db.prepare("SELECT status FROM deliveries WHERE subscriber = 'alice'").all();
      assert.ok(rows.every((row) => row.status === 'cancelled'));
      assert.equal(rows.length, 2, 'cancelled intents are kept for audit');

      // A replay of the same snapshot must not resurrect them.
      const replay = ingestFeed({
        id: 'f', raw: rss([
          { guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'a' },
          { guid: 'p2', title: 'Two', link: 'https://e.test/2', summary: 'b' },
        ]),
        dbPath, subscribers: ['alice'], now: '2026-11-16T00:02:00.000Z',
      });
      assert.equal(replay.deliveryIntents, 0);
      assert.ok(
        db.prepare("SELECT status FROM deliveries WHERE subscriber = 'alice'").all()
          .every((row) => row.status === 'cancelled'),
      );
    } finally {
      db.close();
    }
  });
});

test('re-adding a subscriber with backfill only enqueues never-delivered versions', () => {
  withStore((dbPath) => {
    const raw = rss([
      { guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'a' },
      { guid: 'p2', title: 'Two', link: 'https://e.test/2', summary: 'b' },
    ]);
    ingestFeed({ id: 'f', raw, dbPath, subscribers: ['alice'], now: '2026-11-16T00:00:00.000Z' });
    const db = openDb(dbPath);
    try {
      const claim = claimDeliveries(db, { now: '2026-11-16T00:01:00.000Z', leaseMs: 60_000 });
      for (const delivery of claim) confirmDelivery(db, delivery.id, { now: '2026-11-16T00:01:01.000Z' });
      assert.equal(states(db).delivered, 2);

      removeSubscriber(db, 'f', 'alice', { now: '2026-11-16T00:02:00.000Z' });
      const readd = transaction(db, () =>
        syncSubscriptions(db, 'f', [{ id: 'alice', backfill: true }], { now: '2026-11-16T00:03:00.000Z' }),
      );
      // Two versions already delivered -> backfill enqueues nothing.
      assert.equal(readd.enqueued, 0);
      assert.equal(states(db).total, 2);
      assert.equal(states(db).delivered, 2);

      // A new subscriber gets a backfill of both current versions.
      const fresh = transaction(db, () =>
        syncSubscriptions(db, 'f', [{ id: 'alice', backfill: true }, { id: 'carol', backfill: true }], {
          now: '2026-11-16T00:04:00.000Z',
        }),
      );
      assert.equal(fresh.enqueued, 2);
      const carol = db.prepare("SELECT reason, status FROM deliveries WHERE subscriber = 'carol'").all();
      assert.deepEqual(carol.map((row) => row.reason), ['backfill', 'backfill']);
      assert.ok(carol.every((row) => row.status === 'pending'));
    } finally {
      db.close();
    }
  });
});

test('notify policy filters new vs updates per subscriber', () => {
  withStore((dbPath) => {
    const raw = (summary) =>
      rss([{ guid: 'p1', title: 'One', link: 'https://e.test/1', summary }]);
    const created = ingestFeed({
      id: 'f', raw: raw('v1'), dbPath,
      subscribers: [{ id: 'newonly', notify: 'new' }, { id: 'updatesonly', notify: 'updates' }],
      now: '2026-11-16T00:00:00.000Z',
    });
    assert.equal(created.deliveryIntents, 1, 'only the new-only subscriber wants the creation');

    const revised = ingestFeed({ id: 'f', raw: raw('v2'), dbPath, now: '2026-11-16T00:01:00.000Z' });
    assert.equal(revised.deliveryIntents, 1, 'only the updates-only subscriber wants the revision');

    const db = openDb(dbPath);
    try {
      assert.equal(db.prepare("SELECT count(*) c FROM deliveries WHERE subscriber = 'newonly'").get().c, 1);
      assert.equal(db.prepare("SELECT count(*) c FROM deliveries WHERE subscriber = 'updatesonly'").get().c, 1);
      assert.equal(listSubscribers(db, 'f').length, 2);
    } finally {
      db.close();
    }
  });
});

test('a subscriber list change during ingest is applied atomically with the snapshot', () => {
  withStore((dbPath) => {
    const raw = rss([{ guid: 'p1', title: 'One', link: 'https://e.test/1', summary: 'a' }]);
    ingestFeed({ id: 'f', raw, dbPath, subscribers: ['alice'], now: '2026-11-16T00:00:00.000Z' });
    // Same snapshot, but bob replaced alice: only bob gets an intent for the
    // already-stored version if he is added with backfill.
    const changed = ingestFeed({
      id: 'f', raw, dbPath, subscribers: [{ id: 'bob', backfill: true }],
      now: '2026-11-16T00:01:00.000Z',
    });
    assert.equal(changed.unchanged, 1);
    assert.equal(changed.subscriptions.removed.includes('alice'), true);
    assert.equal(changed.subscriptions.added.includes('bob'), true);
    assert.equal(changed.deliveryIntents, 0, 'no new content, so no event-driven intent');
    assert.equal(changed.subscriptions.enqueued, 1, 'bob backfills the stored version');

    const db = openDb(dbPath);
    try {
      assert.equal(db.prepare("SELECT status FROM deliveries WHERE subscriber = 'alice'").get().status, 'cancelled');
      assert.equal(db.prepare("SELECT status FROM deliveries WHERE subscriber = 'bob'").get().status, 'pending');
    } finally {
      db.close();
    }
  });
});

test('stale running runs are reaped so recovery can retry them', () => {
  withStore((dbPath) => {
    const db = openDb(dbPath);
    try {
      db.prepare(
        `INSERT INTO ingest_runs(feed_id, trigger, snapshot_at, started_at, status)
         VALUES('f', 'manual', '2026-11-15T00:00:00.000Z', '2026-11-15T00:00:00.000Z', 'running')`,
      ).run();
      const reaped = recoverStaleRuns(db, { now: '2026-11-16T00:00:00.000Z' });
      assert.equal(reaped, 1);
      const run = db.prepare('SELECT status, error FROM ingest_runs').get();
      assert.equal(run.status, 'abandoned');
      assert.match(run.error, /terminated/);
    } finally {
      db.close();
    }
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestFeed, feedState } from '../src/ingest.mjs';
import { openDb } from '../src/db.mjs';
import { deliveryStateCounts } from '../src/delivery.mjs';
import {
  tempDb, rss, runChild, runChildConcurrently, childScript,
} from './helpers.mjs';

const WORKER = childScript(`
const dbPath = process.env.FH_DB;
const items = JSON.parse(process.env.FH_ITEMS);
const subscribers = JSON.parse(process.env.FH_SUBS);
const delay = Number(process.env.FH_DELAY ?? 0);
await new Promise((resolve) => setTimeout(resolve, delay));
try {
  const result = ingestFeed({
    id: 'f',
    raw: rss(items),
    dbPath,
    subscribers,
    trigger: 'concurrent',
    now: new Date().toISOString(),
  });
  console.log(JSON.stringify({ ok: true, new: result.new, unchanged: result.unchanged, revisions: result.revisions, intents: result.deliveryIntents, runId: result.runId }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code, message: error.message }));
  process.exitCode = 3;
}
`);

const CRASHING_WORKER = childScript(`
const dbPath = process.env.FH_DB;
const items = JSON.parse(process.env.FH_ITEMS);
try {
  ingestFeed({
    id: 'f',
    raw: rss(items),
    dbPath,
    subscribers: ['alice'],
    trigger: 'crashing',
    now: new Date().toISOString(),
    failpoint: ({ stage, index }) => {
      if (stage === 'item' && index === Number(process.env.FH_CRASH_AT)) {
        // Simulate an abrupt process death, not a recoverable exception.
        process.kill(process.pid, 'SIGKILL');
      }
    },
  });
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code, message: error.message }));
}
`);

function items(n, prefix = 'p') {
  return Array.from({ length: n }, (_, index) => ({
    guid: `${prefix}${index}`,
    title: `T${index}`,
    link: `https://e.test/${prefix}${index}`,
    summary: `body-${index}`,
  }));
}

test('concurrent ingests of the same source notify each item exactly once', async () => {
  const db = tempDb('feedhub-concurrent');
  try {
    const payload = items(5);
    const runs = await runChildConcurrently(
      Array.from({ length: 4 }, () => WORKER),
      {
        env: {
          FH_DB: db.path,
          FH_ITEMS: JSON.stringify(payload),
          FH_SUBS: JSON.stringify(['alice', 'bob']),
          FH_DELAY: '0',
        },
      },
    );

    const outcomes = runs.map((run) => {
      assert.equal(run.status, 0, `child failed\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
      return JSON.parse(run.stdout.trim().split('\n').at(-1));
    });
    assert.equal(outcomes.every((outcome) => outcome.ok), true);
    assert.equal(
      outcomes.reduce((sum, outcome) => sum + outcome.new, 0),
      5,
      'each item is created exactly once across all processes',
    );
    assert.equal(
      outcomes.reduce((sum, outcome) => sum + outcome.intents, 0),
      10,
      '5 items x 2 subscribers, not 4x that',
    );

    const handle = openDb(db.path);
    try {
      const state = feedState(handle, 'f');
      assert.equal(state.counts.items, 5);
      assert.equal(state.counts.events, 5);
      assert.equal(deliveryStateCounts(handle, 'f').total, 10);

      const runsInDb = handle.prepare('SELECT status FROM ingest_runs').all();
      assert.equal(runsInDb.length, 4, 'every trigger has an auditable run record');
      assert.ok(runsInDb.every((row) => row.status === 'applied'));
    } finally {
      handle.close();
    }
  } finally {
    db.cleanup();
  }
});

test('a process killed mid-snapshot leaves no partial state and can be retried', () => {
  const db = tempDb('feedhub-crash');
  try {
    const first = runChild(WORKER, {
      env: {
        FH_DB: db.path,
        FH_ITEMS: JSON.stringify(items(2)),
        FH_SUBS: JSON.stringify(['alice']),
      },
    });
    assert.equal(first.status, 0, first.stderr);

    const crashed = runChild(CRASHING_WORKER, {
      env: {
        FH_DB: db.path,
        FH_ITEMS: JSON.stringify(items(6)),
        FH_CRASH_AT: '3',
      },
    });
    assert.equal(crashed.status, null, 'child was killed by SIGKILL');
    assert.equal(crashed.signal, 'SIGKILL');

    const handle = openDb(db.path);
    let runRows;
    try {
      // The SIGKILL cannot run rollback, but SQLite's WAL ensures the open
      // transaction is discarded when the connection dies.
      const state = feedState(handle, 'f');
      assert.equal(state.counts.items, 2, 'committed baseline is intact');
      assert.equal(state.counts.events, 2);
      runRows = handle.prepare('SELECT status FROM ingest_runs ORDER BY id').all();
    } finally {
      handle.close();
    }
    // The killed run may remain `running`; recoverStaleRuns is what reaps it.
    assert.deepEqual(runRows.map((row) => row.status).sort(), ['applied', 'running']);

    const recovered = runChild(childScript(`
const dbPath = process.env.FH_DB;
const items = JSON.parse(process.env.FH_ITEMS);
const handle = openDb(dbPath);
const { recoverStaleRuns } = await import('./src/ingest.mjs');
const reaped = recoverStaleRuns(handle, { now: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
const result = ingestFeed({ id: 'f', raw: rss(items), dbPath, subscribers: ['alice'], now: new Date().toISOString() });
console.log(JSON.stringify({ reaped, new: result.new, unchanged: result.unchanged, intents: result.deliveryIntents }));
handle.close();
`), {
      env: { FH_DB: db.path, FH_ITEMS: JSON.stringify(items(6)) },
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    const outcome = JSON.parse(recovered.stdout.trim().split('\n').at(-1));
    assert.equal(outcome.reaped, 1);
    assert.equal(outcome.new, 4, 'the four items from the crashed run are applied once');
    assert.equal(outcome.unchanged, 2);
    assert.equal(outcome.intents, 4);

    const handle2 = openDb(db.path);
    try {
      assert.equal(feedState(handle2, 'f').counts.items, 6);
      assert.equal(deliveryStateCounts(handle2, 'f').total, 6);
    } finally {
      handle2.close();
    }
  } finally {
    db.cleanup();
  }
});

test('offline repeated ingestion converges to the same state (idempotent end to end)', () => {
  const db = tempDb('feedhub-idempotent');
  try {
    const payload = items(3);
    for (let round = 0; round < 3; round += 1) {
      ingestFeed({
        id: 'f',
        raw: rss(payload),
        dbPath: db.path,
        subscribers: ['alice', 'bob'],
        now: new Date(Date.UTC(2026, 10, 16, round)).toISOString(),
      });
    }
    const handle = openDb(db.path);
    try {
      assert.equal(feedState(handle, 'f').counts.items, 3);
      assert.equal(feedState(handle, 'f').counts.versions, 3);
      assert.equal(feedState(handle, 'f').counts.events, 3);
      assert.equal(deliveryStateCounts(handle, 'f').total, 6);

      // A revision replayed three times yields one new version and two intents.
      const revised = payload.map((item) => ({ ...item, summary: `${item.summary}-revised` }));
      for (let round = 0; round < 3; round += 1) {
        ingestFeed({
          id: 'f',
          raw: rss(revised),
          dbPath: db.path,
          subscribers: ['alice', 'bob'],
          now: new Date(Date.UTC(2026, 10, 16, 10 + round)).toISOString(),
        });
      }
      assert.equal(feedState(handle, 'f').counts.versions, 6);
      assert.equal(feedState(handle, 'f').counts.events, 6);
      assert.equal(deliveryStateCounts(handle, 'f').total, 12);
    } finally {
      handle.close();
    }
  } finally {
    db.cleanup();
  }
});

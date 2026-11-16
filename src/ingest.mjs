import { parseFeed } from './parse.mjs';
import { normalizeItem } from './normalize.mjs';
import { classify } from './revision.mjs';
import { sha256 } from './identity.mjs';
import { deliveryKey, openDb, transaction, withDb } from './db.mjs';
import { syncSubscriptions, listSubscribers } from './subscriptions.mjs';
import { enqueueForEvent } from './delivery.mjs';

export const RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  APPLIED: 'applied', // non-empty snapshot committed as the new baseline
  EMPTY: 'empty', // source returned nothing; history and baseline untouched
  FAILED: 'failed', // parse/transport/apply failure; no item changes committed
  ABANDONED: 'abandoned', // a prior process died before finishing this run
});

export class IngestError extends Error {
  constructor(message, { code = 'INGEST_FAILED', runId = null, cause } = {}) {
    super(message, { cause });
    this.name = 'IngestError';
    this.code = code;
    this.runId = runId;
  }
}

const DEFAULT_STALE_RUN_MS = 15 * 60 * 1000;

function ensureFeed(db, feedId, url, now) {
  db.prepare(
    `INSERT INTO feeds(id, url, created_at) VALUES(?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET url = CASE WHEN excluded.url <> '' THEN excluded.url ELSE feeds.url END`,
  ).run(feedId, url ?? '', now);
  return db.prepare('SELECT * FROM feeds WHERE id = ?').get(feedId);
}

function startRun(db, feedId, trigger, snapshotAt, now) {
  const info = db
    .prepare(
      `INSERT INTO ingest_runs(feed_id, trigger, snapshot_at, started_at, status)
       VALUES(?, ?, ?, ?, 'running')`,
    )
    .run(feedId, trigger, snapshotAt, now);
  return Number(info.lastInsertRowid);
}

function finishRun(db, runId, status, counts, now, error = null) {
  db.prepare(
    `UPDATE ingest_runs SET status = ?, finished_at = ?, raw_hash = ?, item_count = ?,
            new_count = ?, revision_count = ?, metadata_count = ?, unchanged_count = ?,
            adopted_count = ?, absent_count = ?, delivery_intents = ?, empty = ?, error = ?
      WHERE id = ?`,
  ).run(
    status,
    now,
    counts.rawHash ?? null,
    counts.parsed ?? 0,
    counts.new ?? 0,
    counts.revisions ?? 0,
    counts.metadata ?? 0,
    counts.unchanged ?? 0,
    counts.adopted ?? 0,
    counts.absent ?? 0,
    counts.deliveryIntents ?? 0,
    counts.empty ? 1 : 0,
    error ? String(error.message ?? error).slice(0, 1000) : null,
    runId,
  );
}

/**
 * Mark runs whose owning process died. A run that was `running` before the
 * start of this process cannot still be alive; it committed no item state
 * (apply is one transaction), so its snapshot can safely be retried.
 */
export function recoverStaleRuns(db, { now, staleAfterMs = DEFAULT_STALE_RUN_MS } = {}) {
  const cutoff = new Date(new Date(now).valueOf() - staleAfterMs).toISOString();
  const result = db
    .prepare(
      `UPDATE ingest_runs SET status = 'abandoned', finished_at = ?, error = 'process terminated'
        WHERE status = 'running' AND started_at <= ?`,
    )
    .run(now, cutoff);
  return Number(result.changes);
}

/**
 * Locate an existing row this item should reconcile onto when its derived
 * identity does not match a row directly.
 *
 * Adoption is deliberately conservative, because a wrong match silently
 * merges two items and rewrites history:
 *
 * Incoming has a guid:
 * - Same guid row: adopt (identity re-key if the stored key differs).
 * - Otherwise, adopt the single guid-less row that shares the link — this is
 *   the "guid appeared later" upgrade.
 * - Never adopt a row with a different guid, even on the same link.
 *
 * Incoming has no guid:
 * - If a guid-keyed row shares the link, attach to it without re-keying: the
 *   feed's own identity stays authoritative and a temporarily missing guid
 *   cannot fork or hijack the row.
 * - Otherwise attach to the single guid-less row sharing the link, keeping its
 *   stored identity so a title edit updates content instead of forking.
 * - Ambiguity (several weak rows on one link) adopts nothing.
 *
 * Returns `{ row, rekey, identity }`; `rekey=false` means "same item, keep the
 * stored identity".
 */
function reconcile(db, feedId, identity) {
  if (identity.guid) {
    const byGuid = db
      .prepare('SELECT * FROM items WHERE feed_id = ? AND guid = ?')
      .get(feedId, identity.guid);
    if (byGuid) {
      return {
        row: byGuid,
        rekey: byGuid.identity !== identity.key,
        identity: byGuid.identity !== identity.key
          ? identity
          : { key: byGuid.identity, kind: byGuid.identity_kind },
      };
    }
  }

  if (!identity.linkKey) return { row: null, rekey: false, identity };

  const candidates = db
    .prepare('SELECT * FROM items WHERE feed_id = ? AND link_key = ? ORDER BY id ASC')
    .all(feedId, identity.linkKey);
  if (candidates.length === 0) return { row: null, rekey: false, identity };

  const keep = (row) => ({ row, rekey: false, identity: { key: row.identity, kind: row.identity_kind } });

  if (identity.guid) {
    const weak = candidates.filter((row) => !row.guid);
    if (weak.length === 1) return { row: weak[0], rekey: true, identity };
    return { row: null, rekey: false, identity };
  }

  const guidRows = candidates.filter((row) => row.guid);
  if (guidRows.length === 1) return keep(guidRows[0]);
  if (guidRows.length > 1) return { row: null, rekey: false, identity };

  if (candidates.length === 1) return keep(candidates[0]);
  return { row: null, rekey: false, identity };
}

function insertItem(db, feedId, identity, item, decision, runId, now) {
  const info = db
    .prepare(
      `INSERT INTO items(feed_id, identity, identity_kind, weak_identity, guid, link_key,
                         version, content_hash, payload_hash, title, link, published, summary,
                         first_seen_at, last_seen_at, last_run_id)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      feedId,
      identity.key,
      identity.kind,
      identity.weaklyIdentified ? 1 : 0,
      identity.guid,
      identity.linkKey,
      decision.version,
      decision.contentHash,
      decision.payloadHash,
      item.title,
      item.link,
      item.published,
      item.summary,
      now,
      now,
      runId,
    );
  return Number(info.lastInsertRowid);
}

function updateItem(db, itemId, identity, item, decision, runId, now) {
  db.prepare(
    `UPDATE items SET identity = ?, identity_kind = ?, weak_identity = ?, guid = ?, link_key = ?,
            version = ?, content_hash = ?, payload_hash = ?, title = ?, link = ?, published = ?,
            summary = ?, last_seen_at = ?, last_run_id = ?
      WHERE id = ?`,
  ).run(
    identity.key,
    identity.kind,
    identity.weaklyIdentified ? 1 : 0,
    identity.guid,
    identity.linkKey,
    decision.version,
    decision.contentHash,
    decision.payloadHash,
    item.title,
    item.link,
    item.published,
    item.summary,
    now,
    runId,
    itemId,
  );
}

function updateContent(db, itemId, item, decision, runId, now) {
  db.prepare(
    `UPDATE items SET version = ?, content_hash = ?, payload_hash = ?, title = ?, link = ?,
            published = ?, summary = ?, last_seen_at = ?, last_run_id = ?
      WHERE id = ?`,
  ).run(
    decision.version,
    decision.contentHash,
    decision.payloadHash,
    item.title,
    item.link,
    item.published,
    item.summary,
    now,
    runId,
    itemId,
  );
}

function touchItem(db, itemId, identity, existing, decision, runId, now) {
  db.prepare(
    `UPDATE items SET identity = ?, identity_kind = ?, weak_identity = ?, guid = ?, link_key = ?,
            content_hash = ?, payload_hash = ?, title = ?, link = ?, published = ?, summary = ?,
            last_seen_at = ?, last_run_id = ?
      WHERE id = ?`,
  ).run(
    identity.key,
    identity.kind,
    identity.weaklyIdentified ? 1 : 0,
    identity.guid ?? existing.guid,
    identity.linkKey,
    decision.contentHash,
    decision.payloadHash,
    decision.payload.title,
    decision.payload.link,
    decision.payload.published,
    decision.payload.summary,
    now,
    runId,
    itemId,
  );
}

function storeVersion(db, context, { itemId, identity, item, decision, material }) {
  // A version is immutable. If a row with this number already exists, the only
  // acceptable reason is an exact replay; anything else is an invariant
  // violation that would silently rewrite history, so fail loudly.
  const existing = db
    .prepare(
      `SELECT content_hash, payload_hash FROM item_versions
        WHERE item_id = ? AND version = ?`,
    )
    .get(itemId, decision.version);
  if (existing) {
    if (existing.content_hash !== decision.contentHash) {
      throw new Error(
        `version invariant violated: item ${itemId} version ${decision.version} ` +
          `already stores ${existing.content_hash.slice(0, 12)}, attempted ${decision.contentHash.slice(0, 12)}`,
      );
    }
    return;
  }
  db.prepare(
    `INSERT INTO item_versions(item_id, feed_id, identity, identity_kind, version, content_hash,
                               payload_hash, title, link, published, summary, material, run_id, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    itemId,
    context.feedId,
    identity.key,
    identity.kind,
    decision.version,
    decision.contentHash,
    decision.payloadHash,
    item.title,
    item.link,
    item.published,
    item.summary,
    material ? 1 : 0,
    context.runId,
    context.now,
  );
}

/**
 * One version, one event. The unique key (feed, identity, version) makes
 * replaying the same snapshot produce the same event id rather than a second
 * notification.
 */
function storeEvent(db, context, { itemId, identity, version, eventType }) {
  const inserted = db
    .prepare(
      `INSERT INTO item_events(feed_id, item_id, identity, version, event_type, material, run_id, created_at)
       VALUES(?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(feed_id, identity, version) DO NOTHING`,
    )
    .run(context.feedId, itemId, identity.key, version, eventType, context.runId, context.now);
  const id =
    Number(inserted.changes) === 1
      ? Number(inserted.lastInsertRowid)
      : db
          .prepare('SELECT id FROM item_events WHERE feed_id = ? AND identity = ? AND version = ?')
          .get(context.feedId, identity.key, version).id;
  return {
    id: Number(id),
    feedId: context.feedId,
    itemId,
    identity: identity.key,
    version,
    eventType,
    created: Number(inserted.changes) === 1,
  };
}

/**
 * Move an item from a weaker identity to a stronger one.
 *
 * Every reference must move with it, or the delivery uniqueness invariant
 * breaks: a version delivered under the old key would look undelivered under
 * the new key, and a later backfill would notify subscribers twice for content
 * they already received. Idempotency keys embed the identity, so they are
 * recomputed too.
 */
function rekeyReferences(db, feedId, itemId, oldIdentity, newIdentity, now) {
  if (!oldIdentity || oldIdentity === newIdentity.key) return;
  db.prepare('UPDATE item_versions SET identity = ?, identity_kind = ? WHERE item_id = ?')
    .run(newIdentity.key, newIdentity.kind, itemId);
  db.prepare('UPDATE item_events SET identity = ? WHERE item_id = ?')
    .run(newIdentity.key, itemId);

  const deliveries = db
    .prepare('SELECT id, version, subscriber FROM deliveries WHERE item_id = ?')
    .all(itemId);
  const update = db.prepare(
    'UPDATE deliveries SET identity = ?, idempotency_key = ?, updated_at = ? WHERE id = ?',
  );
  for (const row of deliveries) {
    update.run(
      newIdentity.key,
      deliveryKey(feedId, newIdentity.key, row.version, row.subscriber),
      now,
      row.id,
    );
  }
}

function applyItem(db, context, item, seen, index) {
  const { feedId, runId, now } = context;
  const incoming = item.identity;
  let existing = db
    .prepare('SELECT * FROM items WHERE feed_id = ? AND identity = ?')
    .get(feedId, incoming.key);

  let matched = null;
  if (!existing) matched = reconcile(db, feedId, incoming);
  if (matched?.row) existing = matched.row;

  const rekey = Boolean(matched?.rekey);
  // The identity used for the stored row and its events. When we deliberately
  // keep an existing row's key, events/versions must use that key too, or the
  // unique (feed, identity, version) event constraint stops matching.
  const identity = existing && !rekey
    ? { key: existing.identity, kind: existing.identity_kind }
    : (matched?.identity ?? incoming);

  if (rekey && existing && existing.identity !== identity.key) {
    rekeyReferences(db, feedId, existing.id, existing.identity, identity, now);
  }

  const decision = classify(existing, item, identity);
  let itemId;
  let event = null;

  if (!existing) {
    itemId = insertItem(db, feedId, identity, item, decision, runId, now);
    storeVersion(db, context, { itemId, identity, item, decision, material: true });
    event = storeEvent(db, context, { itemId, identity, version: decision.version, eventType: 'new' });
    context.counts.new += 1;
  } else if (decision.kind === 'revision') {
    itemId = existing.id;
    if (rekey) updateItem(db, itemId, identity, item, decision, runId, now);
    else updateContent(db, itemId, item, decision, runId, now);
    storeVersion(db, context, { itemId, identity, item, decision, material: true });
    event = storeEvent(db, context, { itemId, identity, version: decision.version, eventType: 'update' });
    context.counts.revisions += 1;
  } else if (decision.kind === 'metadata') {
    itemId = existing.id;
    if (rekey) touchItem(db, itemId, identity, existing, decision, runId, now);
    else updateContent(db, itemId, item, decision, runId, now);
    context.counts.metadata += 1;
  } else {
    itemId = existing.id;
    if (rekey) touchItem(db, itemId, identity, existing, decision, runId, now);
    else db.prepare('UPDATE items SET last_seen_at = ?, last_run_id = ? WHERE id = ?').run(now, runId, itemId);
    context.counts.unchanged += 1;
  }

  if (rekey && existing) context.counts.adopted += 1;
  seen.add(itemId);

  if (typeof context.failpoint === 'function') {
    context.failpoint({ stage: 'item', index, itemId, feedId, runId, version: decision.version });
  }
  return event;
}

function applySnapshot(db, context) {
  const { items } = context;
  const seen = new Set();
  const seenIdentity = new Set();
  const events = [];

  for (const [index, item] of items.entries()) {
    if (seenIdentity.has(item.identity.key)) {
      context.counts.duplicates += 1;
      continue;
    }
    seenIdentity.add(item.identity.key);
    const event = applyItem(db, context, item, seen, index);
    if (event) events.push(event);
  }

  const stored = db.prepare('SELECT id FROM items WHERE feed_id = ?').all(context.feedId);
  context.counts.absent = stored.filter((row) => !seen.has(row.id)).length;

  db.prepare(
    `UPDATE feeds SET last_fetch_at = ?, last_nonempty_at = ?, applied_snapshot_at = ?,
            applied_run_id = ?, consecutive_empty = 0, total_runs = total_runs + 1
      WHERE id = ?`,
  ).run(context.now, context.now, context.snapshotAt, context.runId, context.feedId);

  for (const event of events) {
    const result = enqueueForEvent(db, event, { now: context.now });
    context.counts.deliveryIntents += result.created;
  }

  if (typeof context.failpoint === 'function') {
    context.failpoint({ stage: 'after-enqueue', feedId: context.feedId, runId: context.runId });
  }
  return events;
}

function newCounts() {
  return {
    parsed: 0,
    new: 0,
    revisions: 0,
    metadata: 0,
    unchanged: 0,
    adopted: 0,
    duplicates: 0,
    absent: 0,
    deliveryIntents: 0,
  };
}

/**
 * Ingest one snapshot of a feed.
 *
 * Phases:
 *   1. Record `running` run (own transaction) so a crash is observable.
 *   2. Parse. A parse failure records `failed` and changes no item state.
 *   3. One IMMEDIATE transaction applies every item, version, event, delivery
 *      intent and the feed baseline, then marks the run `applied`.
 *
 * Empty snapshots stop after phase 2: the feed baseline is not advanced and no
 * stored item is removed, so an upstream blip cannot erase history. Items that
 * legitimately disappear are simply not re-observed; `absent_count` records it.
 *
 * Concurrent triggers serialize on the IMMEDIATE transaction. The second one
 * blocks, then observes the first one's committed state and classifies every
 * item as unchanged, enqueueing nothing.
 */
export function ingestFeed(options) {
  const {
    id,
    url = '',
    raw,
    dbPath,
    db: providedDb,
    subscribers,
    trigger = 'manual',
    now = new Date().toISOString(),
    snapshotAt = now,
    failpoint = null,
    parseOptions = {},
  } = options;

  if (!id) throw new IngestError('feed id is required', { code: 'INVALID_INPUT' });

  return withDb(providedDb ?? dbPath, (db) =>
    ingestWithDb(db, {
      id,
      url,
      raw,
      subscribers,
      trigger,
      now,
      snapshotAt,
      failpoint,
      parseOptions,
    }),
  );
}

function ingestWithDb(db, ctx) {
  const { id: feedId, url, raw, subscribers, trigger, now, snapshotAt, failpoint, parseOptions } = ctx;

  // Phase 1: durable run record. If the process dies after this, a later
  // ingest reaps it as `abandoned`; no partial item state exists.
  const runId = transaction(db, () => {
    ensureFeed(db, feedId, url, now);
    return startRun(db, feedId, trigger, snapshotAt, now);
  });

  const counts = newCounts();
  counts.rawHash = typeof raw === 'string' ? sha256(raw) : null;

  // Phase 2a: parse. A malformed/empty response must never open an apply
  // transaction, and must never delete anything.
  let parsed;
  try {
    if (typeof raw !== 'string' || raw.trim() === '') throw new Error('feed response is empty');
    parsed = parseFeed(raw, parseOptions);
  } catch (error) {
    transaction(db, () => {
      finishRun(db, runId, RUN_STATUS.FAILED, counts, now, error);
      db.prepare('UPDATE feeds SET last_fetch_at = ?, total_runs = total_runs + 1 WHERE id = ?').run(now, feedId);
    });
    throw new IngestError(`failed to parse feed ${feedId}: ${error.message}`, {
      code: 'PARSE_FAILED',
      runId,
      cause: error,
    });
  }

  const items = parsed.items.map(normalizeItem);
  counts.parsed = items.length;

  // Phase 2b: empty snapshot. History is untouched; consecutive_empty rises so
  // operators can distinguish "quiet feed" from "broken upstream".
  if (items.length === 0) {
    const subChanges = transaction(db, () => {
      const changes = subscribers === undefined
        ? null
        : syncSubscriptions(db, feedId, subscribers, { now });
      db.prepare(
        `UPDATE feeds SET last_fetch_at = ?, consecutive_empty = consecutive_empty + 1,
                total_runs = total_runs + 1 WHERE id = ?`,
      ).run(now, feedId);
      finishRun(db, runId, RUN_STATUS.EMPTY, { ...counts, empty: true }, now, 'empty snapshot');
      return changes;
    });
    return {
      feedId,
      runId,
      status: RUN_STATUS.EMPTY,
      format: parsed.format,
      items: 0,
      ...summarize(counts),
      subscriptions: subChanges,
      stored: storedTotals(db, feedId),
    };
  }

  // Phase 3: one atomic apply. Anything thrown here rolls the whole snapshot
  // back; the retry re-parses and re-applies from the same boundary.
  let events;
  let subChanges;
  try {
    ({ events, subChanges } = transaction(db, () => {
      const changes = subscribers === undefined
        ? null
        : syncSubscriptions(db, feedId, subscribers, { now });
      const context = { feedId, runId, now, snapshotAt, items, counts, failpoint };
      const applied = applySnapshot(db, context);
      finishRun(db, runId, RUN_STATUS.APPLIED, counts, now);
      return { events: applied, subChanges: changes };
    }));
  } catch (error) {
    // The apply transaction rolled back. Record the failure in a fresh
    // transaction so the run is not left dangling as `running`.
    try {
      transaction(db, () => {
        finishRun(db, runId, RUN_STATUS.FAILED, counts, now, error);
        db.prepare('UPDATE feeds SET last_fetch_at = ?, total_runs = total_runs + 1 WHERE id = ?').run(now, feedId);
      });
    } catch {
      // Best effort; the stale-run reaper will catch it.
    }
    throw new IngestError(`failed to apply feed ${feedId}: ${error.message}`, {
      code: 'APPLY_FAILED',
      runId,
      cause: error,
    });
  }

  return {
    feedId,
    runId,
    status: RUN_STATUS.APPLIED,
    format: parsed.format,
    items: items.length,
    ...summarize(counts),
    events: events.map((event) => ({
      id: event.id,
      itemId: event.itemId,
      identity: event.identity,
      version: event.version,
      eventType: event.eventType,
      created: event.created,
    })),
    subscriptions: subChanges,
    stored: storedTotals(db, feedId),
  };
}

function summarize(counts) {
  return {
    parsed: counts.parsed,
    new: counts.new,
    revisions: counts.revisions,
    metadata: counts.metadata,
    unchanged: counts.unchanged,
    adopted: counts.adopted,
    duplicates: counts.duplicates,
    absent: counts.absent,
    deliveryIntents: counts.deliveryIntents,
  };
}

export function storedTotals(db, feedId) {
  const row = db
    .prepare(
      `SELECT
         (SELECT count(*) FROM items WHERE feed_id = ?) AS items,
         (SELECT count(*) FROM item_versions WHERE feed_id = ?) AS versions,
         (SELECT count(*) FROM item_events WHERE feed_id = ?) AS events,
         (SELECT count(*) FROM deliveries WHERE feed_id = ? AND status = 'pending') AS pending,
         (SELECT count(*) FROM deliveries WHERE feed_id = ? AND status = 'delivered') AS delivered`,
    )
    .get(feedId, feedId, feedId, feedId, feedId);
  return { ...row };
}

export function feedState(db, feedId) {
  const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get(feedId);
  if (!feed) return null;
  return {
    ...feed,
    subscribers: listSubscribers(db, feedId),
    counts: storedTotals(db, feedId),
  };
}

export { openDb, transaction };

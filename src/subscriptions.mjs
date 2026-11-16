import { transaction } from './db.mjs';
import { DEFAULT_NOTIFY, normalizeNotify } from './notify.mjs';
import { enqueueDelivery } from './delivery.mjs';

export const SUBSCRIBER_ID_PATTERN = /^[A-Za-z0-9._:@/+-]{1,200}$/;

function normalizeSubscriber(entry, defaults) {
  if (typeof entry === 'string') {
    return {
      id: entry,
      notify: normalizeNotify(defaults.notify),
      backfill: Boolean(defaults.backfill),
    };
  }
  if (!entry || typeof entry !== 'object' || !entry.id) {
    throw new Error('subscriber entries must be an id string or { id, notify?, backfill? }');
  }
  return {
    id: String(entry.id),
    notify: normalizeNotify(entry.notify ?? defaults.notify),
    backfill: entry.backfill === undefined ? Boolean(defaults.backfill) : Boolean(entry.backfill),
  };
}

function validateSubscriberId(id) {
  if (!SUBSCRIBER_ID_PATTERN.test(id)) throw new Error(`invalid subscriber id: ${id}`);
  return id;
}

export function listSubscribers(db, feedId, { activeOnly = false } = {}) {
  return db
    .prepare(
      `SELECT subscriber, notify, backfill, active, created_at, updated_at
         FROM subscriptions WHERE feed_id = ? ${activeOnly ? 'AND active = 1' : ''}
        ORDER BY subscriber`,
    )
    .all(feedId)
    .map((row) => ({ ...row, active: Boolean(row.active), backfill: Boolean(row.backfill) }));
}

/**
 * Reconcile the desired active subscriber set for a feed.
 *
 * - Subscribers absent from `subscribers` are deactivated, and their
 *   not-yet-delivered intents become `cancelled`. Nothing is deleted, so the
 *   history of what was already delivered stays auditable and replay cannot
 *   resurrect a cancelled notification.
 * - `backfill` applies only to a subscriber that becomes active during this
 *   call. It enqueues the current version of every stored item. The unique
 *   delivery key means re-adding a subscriber never duplicates a notification
 *   that was already delivered.
 *
 * Caller owns the transaction so this can be composed into ingest atomically.
 */
export function syncSubscriptions(db, feedId, subscribers, options = {}) {
  const now = options.now;
  const defaults = { notify: options.notify ?? DEFAULT_NOTIFY, backfill: options.backfill ?? false };
  const wanted = new Map();
  for (const entry of subscribers ?? []) {
    const subscriber = normalizeSubscriber(entry, defaults);
    validateSubscriberId(subscriber.id);
    wanted.set(subscriber.id, subscriber);
  }

  const existing = new Map(
    db.prepare('SELECT * FROM subscriptions WHERE feed_id = ?').all(feedId).map((row) => [row.subscriber, row]),
  );
  const changes = { added: [], reactivated: [], updated: [], removed: [], cancelled: 0, enqueued: 0 };
  const toBackfill = [];

  const insert = db.prepare(
    `INSERT INTO subscriptions(feed_id, subscriber, notify, backfill, active, created_at, updated_at)
     VALUES(?, ?, ?, ?, 1, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE subscriptions SET notify = ?, backfill = ?, active = 1, updated_at = ?
      WHERE feed_id = ? AND subscriber = ?`,
  );
  const deactivate = db.prepare(
    `UPDATE subscriptions SET active = 0, updated_at = ? WHERE feed_id = ? AND subscriber = ?`,
  );
  // Only intents that have not been attempted are cancelled here. An
  // `inflight` row may already have reached the external system, so it is left
  // for the worker to confirm or fail; `claimDeliveries` refuses to re-claim
  // it for an inactive subscriber.
  const cancel = db.prepare(
    `UPDATE deliveries SET status = 'cancelled', lease_until = NULL, next_attempt_at = NULL,
            updated_at = ?, last_error = 'subscriber inactive'
      WHERE feed_id = ? AND subscriber = ? AND status IN ('pending', 'retry')`,
  );

  for (const subscriber of wanted.values()) {
    const row = existing.get(subscriber.id);
    if (!row) {
      insert.run(feedId, subscriber.id, subscriber.notify, subscriber.backfill ? 1 : 0, now, now);
      changes.added.push(subscriber.id);
      if (subscriber.backfill) toBackfill.push(subscriber);
      continue;
    }
    const wasActive = Boolean(row.active);
    update.run(subscriber.notify, subscriber.backfill ? 1 : 0, now, feedId, subscriber.id);
    if (!wasActive) {
      changes.reactivated.push(subscriber.id);
      if (subscriber.backfill) toBackfill.push(subscriber);
    } else if (row.notify !== subscriber.notify || Boolean(row.backfill) !== subscriber.backfill) {
      changes.updated.push(subscriber.id);
    }
  }

  for (const [id, row] of existing) {
    if (wanted.has(id) || !row.active) continue;
    deactivate.run(now, feedId, id);
    changes.removed.push(id);
    changes.cancelled += Number(cancel.run(now, feedId, id).changes);
  }

  for (const subscriber of toBackfill) {
    const items = db
      .prepare('SELECT id, identity, version FROM items WHERE feed_id = ? ORDER BY id')
      .all(feedId);
    for (const item of items) {
      const result = enqueueDelivery(db, {
        feedId,
        itemId: item.id,
        identity: item.identity,
        version: item.version,
        subscriber: subscriber.id,
        reason: 'backfill',
        eventId: null,
      }, { now });
      if (result.created) changes.enqueued += 1;
    }
  }

  return changes;
}

export function removeSubscriber(db, feedId, subscriberId, options = {}) {
  return transaction(db, () => {
    const active = listSubscribers(db, feedId, { activeOnly: true })
      .filter((row) => row.subscriber !== subscriberId)
      .map((row) => ({ id: row.subscriber, notify: row.notify, backfill: row.backfill }));
    const changes = syncSubscriptions(db, feedId, active, { now: options.now });
    return { removed: changes.removed, cancelled: changes.cancelled };
  });
}

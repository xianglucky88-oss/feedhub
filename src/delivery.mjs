import { deliveryKey, transaction } from './db.mjs';
import { shouldNotify } from './notify.mjs';

export const DELIVERY_STATUSES = Object.freeze([
  'pending', // intent recorded, not yet attempted
  'inflight', // lease taken by a worker; external outcome unknown
  'retry', // attempt failed with a retryable error
  'failed', // attempts exhausted (terminal until manually retried)
  'delivered', // external delivery confirmed
  'cancelled', // subscriber left or policy changed before delivery
]);

const RETRYABLE = new Set(['retry', 'pending']);

/**
 * Insert one delivery intent.
 *
 * The unique constraint on (feed_id, identity, version, subscriber) is the
 * idempotency boundary: replaying the same ingest or the same fanout can never
 * create a second intent for the same version. A cancelled or delivered row is
 * *not* resurrected by a plain re-enqueue, which is what makes replay safe.
 */
export function enqueueDelivery(db, intent, { now, allowRevive = false } = {}) {
  const key = deliveryKey(intent.feedId, intent.identity, intent.version, intent.subscriber);
  const existing = db
    .prepare(
      `SELECT id, status FROM deliveries
        WHERE feed_id = ? AND identity = ? AND version = ? AND subscriber = ?`,
    )
    .get(intent.feedId, intent.identity, intent.version, intent.subscriber);

  if (existing) {
    if (allowRevive && (existing.status === 'failed' || existing.status === 'cancelled')) {
      db.prepare(
        `UPDATE deliveries SET status = 'pending', next_attempt_at = NULL, last_error = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(now, existing.id);
      return { id: existing.id, created: false, revived: true };
    }
    return { id: existing.id, created: false, revived: false, status: existing.status };
  }

  const info = db
    .prepare(
      `INSERT INTO deliveries(feed_id, item_id, identity, version, subscriber, event_id, reason,
                              status, attempts, idempotency_key, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    )
    .run(
      intent.feedId,
      intent.itemId,
      intent.identity,
      intent.version,
      intent.subscriber,
      intent.eventId ?? null,
      intent.reason,
      key,
      now,
      now,
    );
  return { id: Number(info.lastInsertRowid), created: true, revived: false };
}

export function enqueueForEvent(db, event, options) {
  const subscribers = db
    .prepare(
      `SELECT subscriber, notify, backfill, active FROM subscriptions
        WHERE feed_id = ? AND active = 1 ORDER BY subscriber`,
    )
    .all(event.feedId);
  let created = 0;
  let considered = 0;
  for (const row of subscribers) {
    if (!shouldNotify(row.notify, event.eventType)) continue;
    considered += 1;
    const result = enqueueDelivery(
      db,
      {
        feedId: event.feedId,
        itemId: event.itemId,
        identity: event.identity,
        version: event.version,
        subscriber: row.subscriber,
        eventId: event.id,
        reason: event.eventType,
      },
      options,
    );
    if (result.created) created += 1;
  }
  return { created, considered, subscribers: subscribers.length };
}

function isoAfter(now, ms) {
  return new Date(new Date(now).valueOf() + ms).toISOString();
}

/**
 * Claim due intents for one worker.
 *
 * A claim moves pending/retry -> inflight and stamps a lease. Because the
 * external send is not transactional, `inflight` is the durable record of
 * "we may have sent this but do not know". A crashed worker leaves a lease
 * behind; `recoverExpiredLeases` returns those to the queue.
 */
export function claimDeliveries(db, options) {
  const {
    now,
    limit = 100,
    leaseMs = 60_000,
    feedId = null,
    subscribers = null,
  } = options;

  return transaction(db, () => {
    const rows = db
      .prepare(
        `SELECT d.* FROM deliveries d
           LEFT JOIN subscriptions s
             ON s.feed_id = d.feed_id AND s.subscriber = d.subscriber
          WHERE d.status IN ('pending', 'retry')
            AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
            AND (${feedId ? 'd.feed_id = ?' : '1 = 1'})
            AND (s.active IS NULL OR s.active = 1)
          ORDER BY d.id ASC
          LIMIT ?`,
      )
      .all(...[now, ...(feedId ? [feedId] : []), limit]);

    const leaseUntil = isoAfter(now, leaseMs);
    const claim = db.prepare(
      `UPDATE deliveries SET status = 'inflight', lease_until = ?, updated_at = ?, attempts = attempts + 1
        WHERE id = ? AND status IN ('pending', 'retry')`,
    );
    const claimed = [];
    for (const row of rows) {
      if (subscribers && !subscribers.includes(row.subscriber)) continue;
      const result = claim.run(leaseUntil, now, row.id);
      if (Number(result.changes) === 1) {
        claimed.push({ ...row, status: 'inflight', lease_until: leaseUntil, attempts: row.attempts + 1 });
      }
    }
    return claimed;
  });
}

/**
 * Record the outcome of an external send.
 *
 * The caller supplies the idempotency key and the external (or local) id. A
 * repeated confirmation for an already-delivered row is a no-op, so at-least-
 * once retries converge to exactly-once observable notifications.
 */
export function confirmDelivery(db, deliveryId, { now, externalId = null, idempotencyKey } = {}) {
  const row = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId);
  if (!row) throw new Error(`unknown delivery ${deliveryId}`);
  if (row.status === 'delivered') {
    return { ...row, changed: false };
  }
  if (idempotencyKey && idempotencyKey !== row.idempotency_key) {
    throw new Error(`idempotency key mismatch for delivery ${deliveryId}`);
  }
  db.prepare(
    `UPDATE deliveries SET status = 'delivered', delivered_at = ?, updated_at = ?,
            external_id = COALESCE(?, external_id), lease_until = NULL, next_attempt_at = NULL,
            last_error = NULL
      WHERE id = ?`,
  ).run(now, now, externalId, deliveryId);
  return { ...db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId), changed: true };
}

/**
 * Record a failed external send. Retryable failures go back to `retry` with a
 * backoff; non-retryable ones become terminal `failed`. Either way the intent
 * and its version are preserved, so nothing is silently lost.
 */
export function failDelivery(db, deliveryId, error, options = {}) {
  const { now, maxAttempts = 5, retryDelayMs = 5_000, retryable = true } = options;
  const row = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId);
  if (!row) throw new Error(`unknown delivery ${deliveryId}`);
  if (row.status === 'delivered') return { ...row, changed: false };

  const exhausted = row.attempts >= maxAttempts;
  const nextStatus = retryable && !exhausted ? 'retry' : 'failed';
  const backoff = retryDelayMs * Math.max(1, 2 ** Math.max(0, row.attempts - 1));
  db.prepare(
    `UPDATE deliveries SET status = ?, lease_until = NULL, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    nextStatus,
    nextStatus === 'retry' ? isoAfter(now, backoff) : null,
    String(error?.message ?? error).slice(0, 500),
    now,
    deliveryId,
  );
  return { ...db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId), changed: true };
}

export function recoverExpiredLeases(db, options = {}) {
  const { now, limit = 1000 } = options;
  const rows = db
    .prepare(
      `SELECT * FROM deliveries
        WHERE status = 'inflight' AND lease_until IS NOT NULL AND lease_until <= ?
        ORDER BY id LIMIT ?`,
    )
    .all(now, limit);
  const update = db.prepare(
    `UPDATE deliveries SET status = 'retry', lease_until = NULL, next_attempt_at = NULL,
            last_error = 'lease expired', updated_at = ?
      WHERE id = ? AND status = 'inflight'`,
  );
  const recovered = [];
  for (const row of rows) {
    if (Number(update.run(now, row.id).changes) === 1) recovered.push(row);
  }
  return recovered;
}

export function cancelDelivery(db, deliveryId, options = {}) {
  const { now, reason = 'cancelled' } = options;
  const row = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId);
  if (!row) throw new Error(`unknown delivery ${deliveryId}`);
  if (row.status === 'delivered') return { ...row, changed: false };
  db.prepare(
    `UPDATE deliveries SET status = 'cancelled', lease_until = NULL, next_attempt_at = NULL,
            last_error = ?, updated_at = ?
      WHERE id = ?`,
  ).run(reason, now, deliveryId);
  return { ...db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId), changed: true };
}

export function listQueue(db, statuses = ['pending', 'inflight', 'retry', 'failed']) {
  const placeholders = statuses.map(() => '?').join(', ');
  return db
    .prepare(`SELECT * FROM deliveries WHERE status IN (${placeholders}) ORDER BY id`)
    .all(...statuses);
}

export function deliveryStateCounts(db, feedId = null) {
  const rows = db
    .prepare(
      `SELECT status, count(*) AS n FROM deliveries
        ${feedId ? 'WHERE feed_id = ?' : ''} GROUP BY status`,
    )
    .all(...(feedId ? [feedId] : []));
  const counts = Object.fromEntries(DELIVERY_STATUSES.map((status) => [status, 0]));
  for (const row of rows) counts[row.status] = row.n;
  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  return counts;
}

/**
 * Drive pending intents to a terminal state through an external sender.
 *
 * `send(delivery)` returns `{ externalId }` on success or throws on failure.
 * Success is recorded only after `send` returns, and the confirmation is
 * keyed by the delivery's idempotency key, so a retry after a crash between
 * send and confirm (the "delivered externally, unconfirmed locally" window)
 * reuses the same key rather than creating a new notification.
 */
export async function runDeliveries(db, send, options = {}) {
  const now = options.now;
  const claim = claimDeliveries(db, { ...options, now });
  const results = [];
  for (const delivery of claim) {
    try {
      const outcome = (await send(delivery)) ?? {};
      if (outcome.skipped) {
        results.push({ id: delivery.id, status: 'skipped' });
        continue;
      }
      const confirmed = confirmDelivery(db, delivery.id, {
        now: options.confirmNow ?? now,
        externalId: outcome.externalId ?? null,
        idempotencyKey: delivery.idempotency_key,
      });
      results.push({ id: delivery.id, status: confirmed.status, changed: confirmed.changed });
    } catch (error) {
      const failed = failDelivery(db, delivery.id, error, {
        now: options.confirmNow ?? now,
        maxAttempts: options.maxAttempts,
        retryDelayMs: options.retryDelayMs,
        retryable: error.retryable !== false,
      });
      results.push({ id: delivery.id, status: failed.status, error: String(error.message ?? error) });
    }
  }
  return results;
}

export function isRetryableStatus(status) {
  return RETRYABLE.has(status);
}

export const DEFAULT_NOTIFY = 'new+updates';

const NOTIFY_ALIASES = new Map([
  ['new', 'new'],
  ['updates', 'updates'],
  ['update', 'updates'],
  ['all', 'new+updates'],
  ['new+updates', 'new+updates'],
  ['new_and_updates', 'new+updates'],
  ['true', 'new+updates'],
  ['false', 'none'],
  ['none', 'none'],
  ['off', 'none'],
]);

export function normalizeNotify(notify) {
  const value = String(notify ?? DEFAULT_NOTIFY).trim().toLowerCase();
  const normalized = NOTIFY_ALIASES.get(value);
  if (!normalized) {
    throw new Error(`unknown notify policy: ${notify} (expected new, updates, new+updates, or none)`);
  }
  return normalized;
}

export function shouldNotify(notify, eventType) {
  const policy = normalizeNotify(notify);
  if (policy === 'none') return false;
  if (policy === 'new+updates') return true;
  if (eventType === 'new') return policy === 'new';
  return policy === 'updates';
}

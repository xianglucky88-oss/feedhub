import { existingGuids, initStore, saveFeed, saveItems, recordDeliveries } from './store.mjs';
import { parseFeed } from './parse.mjs';
import { normalizeItem } from './normalize.mjs';
import { newItems } from './update-detect.mjs';

export function ingestFeed({ id, url, raw, dbPath, subscribers = [] }) {
  initStore(dbPath);
  const parsed = parseFeed(raw);
  const items = parsed.items.map(normalizeItem);
  const fresh = newItems(items, existingGuids(dbPath, id));
  saveItems(dbPath, id, fresh);
  saveFeed(dbPath, { id, url, lastSeen: new Date().toISOString() });
  recordDeliveries(dbPath, id, fresh, subscribers);
  return { format: parsed.format, parsed: items.length, fresh: fresh.length, delivered: fresh.length * subscribers.length };
}

import { existingIds, initStore, saveFeed, saveItems, recordDeliveries } from './store.mjs';
import { parseFeed } from './parse.mjs';
import { normalizeFeed } from './normalize.mjs';
import { newItems } from './update-detect.mjs';

// 原始 feed 入口到更新判定的完整链路：
//   raw → parseFeed（多格式忠实提取）→ normalizeFeed（统一条目模型 + 去重/剔空）
//       → newItems（按 canonical id 判定新旧）→ SQLite 落库 + fanout 记录。
export function ingestFeed({ id, url, raw, dbPath, subscribers = [] }) {
  initStore(dbPath);
  const parsed = parseFeed(raw);
  const { format, entries, skippedEmpty, duplicates } = normalizeFeed(parsed);
  const fresh = newItems(entries, existingIds(dbPath, id));
  saveItems(dbPath, id, fresh);
  saveFeed(dbPath, { id, url, lastSeen: new Date().toISOString() });
  recordDeliveries(dbPath, id, fresh, subscribers);
  return {
    format,
    parsed: parsed.items.length,
    normalized: entries.length,
    fresh: fresh.length,
    delivered: fresh.length * subscribers.length,
    skippedEmpty: skippedEmpty.length,
    duplicateIds: duplicates.length,
    duplicates,
  };
}

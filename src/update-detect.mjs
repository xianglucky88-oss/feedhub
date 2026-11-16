// 更新判定：只认归一化后的 canonical id。
// 同一篇内容在 RSS / Atom / JSON 之间切换时，只要 canonical id 收敛一致，
// 就不会被错误拆成两篇；未知 id 才视为新条目。
//
// 另外提供 compareEntry 用于“同一 id 的内容是否发生变化”的判定，
// 字段顺序、HTML 嵌套差异已在归一化阶段抹平，这里按值比较即可。

import { entryFingerprint } from './normalize.mjs';

export function newItems(entries, knownIds) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
  return entries.filter((entry) => !known.has(entry.id));
}

export function isNewEntry(entry, knownIds) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
  return !known.has(entry.id);
}

// 比较两个归一化条目是否为同一篇且内容一致。
export function sameEntry(a, b) {
  if (!a || !b || a.id !== b.id) return false;
  return entryFingerprint(a) === entryFingerprint(b);
}

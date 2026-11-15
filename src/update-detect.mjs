export function newItems(items, knownGuids) {
  return items.filter((item) => !knownGuids.has(item.guid));
}

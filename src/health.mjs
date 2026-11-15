export function isStale(lastSeen, now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000) {
  if (!lastSeen) return true;
  const timestamp = new Date(lastSeen).valueOf();
  return Number.isNaN(timestamp) || now - timestamp > maxAgeMs;
}

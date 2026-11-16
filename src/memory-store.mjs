// 内存后备存储：接口与 store.mjs 中基于 sqlite3 CLI 的函数一一对应。
// 仅当运行环境没有 sqlite3 命令时启用，保证采集/去重/投递链路在无二进制
// 的环境里仍然端到端可验证；存在 sqlite3 时一律走真实 SQLite，行为不变。
//
// 按 dbPath 维护互相隔离的多个“库”，与每个 SQLite 文件一一对应，
// 同一进程里跑多组测试时计数不会串库。

function createDatabase() {
  return {
    feeds: new Map(), // id -> { id, url, lastSeen }
    items: new Map(), // `${feedId} ${id}` -> entry
    deliveries: [], // { feedId, id, subscriber, deliveredAt }
  };
}

export function createMemoryStore() {
  const databases = new Map();
  const db = (dbPath) => {
    if (!databases.has(dbPath)) databases.set(dbPath, createDatabase());
    return databases.get(dbPath);
  };

  return {
    saveFeed(dbPath, feed) {
      db(dbPath).feeds.set(feed.id, { id: feed.id, url: feed.url, lastSeen: feed.lastSeen || '' });
    },
    existingIds(dbPath, feedId) {
      const prefix = `${feedId} `;
      return new Set([...db(dbPath).items.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length)));
    },
    saveItem(dbPath, feedId, entry) {
      const key = `${feedId} ${entry.id}`;
      const database = db(dbPath);
      if (database.items.has(key)) return; // INSERT OR IGNORE 语义
      database.items.set(key, { feedId, ...entry });
    },
    recordDelivery(dbPath, feedId, id, subscriber, deliveredAt) {
      db(dbPath).deliveries.push({ feedId, id, subscriber, deliveredAt });
    },
    counts(dbPath) {
      const database = db(dbPath);
      return {
        feeds: database.feeds.size,
        items: database.items.size,
        deliveries: database.deliveries.length,
      };
    },
  };
}

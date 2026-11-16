# feedhub

离线可运行的订阅源采集与更新分发。当前实现 RSS 2.0、SQLite 幂等状态机、按明确规则判定内容修订、可恢复的投递队列（outbox）以及 WebSub HMAC 工具；Atom、JSON Feed、真正的回调服务器和续期流程仍是后续题目空间。

```bash
make test     # Node 单元测试，含并发与故障注入
make demo     # 本地 RSS 采集 → 修订 → 空响应 → 投递，输出状态快照
make verify    # 断言 SQLite 状态机
```

运行期只使用本地 fixture 和内置 `node:sqlite`，不访问公网，也不需要外部 `sqlite3` 命令。

## 状态机

摄取分三个阶段，任何阶段失败都不会留下半成品：

1. **run 记录**：写入 `ingest_runs(status='running')`，进程崩溃时可由后续摄取标记为 `abandoned`。
2. **解析**：格式错误或空响应直接记录 `failed` / `empty`，不打开写入事务。
3. **应用**：单个 `BEGIN IMMEDIATE` 事务内完成条目分类、版本、事件、投递意向和 feed 基线，最后把 run 标为 `applied`。

条目状态由两张表表达：

| 表 | 含义 |
| --- | --- |
| `items` | 当前已保存的最新版本（每条目一行） |
| `item_versions` | 每个版本的内容快照，`material=1` 表示会触发通知 |
| `item_events` | 每个版本一个事件，唯一键 `(feed_id, identity, version)` |

投递状态只在 `deliveries` 中流转，绝不删除：

`pending → inflight → delivered`，失败进入 `retry`（指数退避）或 `failed`（终态），订阅者退订则为 `cancelled`。

`inflight` 就是"外部已发送、本地未确认"的窗口：租约过期后由 `recoverExpiredLeases` 放回队列，重试使用同一 `idempotency_key`，因此重复投递不会产生第二次通知。

## 判定规则

- **身份**：优先 `guid`；无 guid 时用规范化 link（去掉 `utm_*` 等跟踪参数、fragment、末尾斜杠），再退化到 `title+published`，最后是正文哈希。弱身份在 `items.weak_identity` 中标记。
- **guid 出现/消失**：按 guid 或 link 回填到已有行，沿用原条目，不重复、不重新通知。
- **修订**：只有 `title` / 规范化 `link` / `summary` 的**实质投影**变化才产生新版本和 `update` 事件；空白、HTML 标记、日期重排只更新 payload，不产生版本。
- **空响应**：只记录 `empty` run 并累加 `consecutive_empty`，不推进基线、不删除任何条目。
- **订阅者变化**：退订会把未投递意向标为 `cancelled`；重新加入且 `backfill=true` 只会补齐从未投递过的 `(条目,版本)`。

## 与旧实现的关键差异

旧的 `(feed_id, guid)` + `INSERT OR IGNORE` 流程无法表达"已保存但未投递"、内容修订和崩溃恢复。现在：

- 条目身份与内容哈希分离，`items` 只保存最新版本，历史在 `item_versions`。
- 投递意向先落库再发送，发送结果单独确认；不存在"写成功即已投递"的假设。
- 所有写入（条目、版本、事件、意向、订阅、基线）在同一个 SQLite 事务内提交。
- 不允许用 `INSERT OR IGNORE` 吞掉状态：版本号冲突会抛错，而不是静默覆盖历史。

## 运行要求

Node.js >= 22.5（使用内置 `node:sqlite`）。

## 常用命令

```bash
node src/cli.mjs demo
node src/cli.mjs inspect local
node src/cli.mjs sync-subscribers local alice bob:new:backfill
```

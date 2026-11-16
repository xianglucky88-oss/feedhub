# feedhub

离线可运行的订阅源采集与更新分发半成品。当前实现 RSS 2.0、SQLite 状态、基于 guid 的重复抑制、本地 fanout、WebSub HMAC 工具，以及统一的源健康判定；Atom、JSON Feed、真正的回调服务器和续期流程仍是后续题目空间。

```bash
make test
make demo
make verify
```

运行期只使用本地 fixture 和 SQLite，不访问公网。数据库驱动优先使用 Node 内置的
`node:sqlite`（Node >= 22.5），不可用时回退到 `sqlite3` 命令行；两者读写同一份标准
SQLite 文件。

## 源健康判定

所有时间输入都经过 `src/clock.mjs` 统一解析：支持 epoch 秒 / 毫秒、ISO 8601 与
RFC 3339 的时区偏移（`Z`、`±HH:MM`、`±HHMM`、`±HH`）、无时区 ISO（按 UTC）、
RFC 822 日期，并拒绝日历上不存在的日期与空字符串。写入数据库的时间统一为 UTC ISO
（毫秒精度），因此采集写入、健康查询和命令行诊断使用同一套时间语义。

健康状态（`src/health.mjs` 的 `evaluateHealth`）：

| status | 含义 |
| --- | --- |
| `never-observed` | 无记录或最后观测时间为空（`reason` 区分缺失与空字符串） |
| `invalid-time` | 时间字段无法解析 |
| `future-time` | 观测时间超出未来容忍窗口；时间追上后若无新采集仍保持此状态 |
| `clock-anomaly` | 本机时钟回拨，或时钟恢复但尚无新的成功采集 |
| `stale` | 距最后观测已达到 / 超过 `maxAgeMs`（恰好等于阈值即过期） |
| `fresh` | 正常新鲜 |
| `recovered` | 从异常状态恢复，且确有新的成功采集 |

判定结果一定包含 `status`、`healthy`、`reason`、`detail`、`observedAt`、`now`、
`ageMs` 等字段，能说明“用什么观测时间、按什么原因”得出的结论。

关键约定：

- `observe_seq` 每次成功采集自增，恢复判定基于它而非时间戳大小，因此未来时间戳
  修复后即使时间变“早”也能正确识别为新的成功采集。
- `clock_high_water` 持久化历史见过的最大评估时间，服务重启后仍能检测时钟回拨。
- 重复采集不会把过期 / 异常状态伪装成恢复；只有新的成功采集才行。
- 旧数据库（`feeds` 无 `observe_seq`、无 `feed_health` 表）在首次采集时自动迁移，
  只追加列、不改既有数据。

边界可通过 `evaluateHealth` / `checkHealth` 的 `maxAgeMs`、`futureToleranceMs`、
`clockToleranceMs` 调整（默认 24h / 5min / 5min）。

```bash
# 诊断所有源；有异常时退出码为 1
node src/cli.mjs health --db /tmp/feedhub/feedhub.db
# 指定观察时刻与源，并查看历史事件
node src/cli.mjs health --db /tmp/feedhub/feedhub.db --feed local --now 2026-11-18T10:00:00Z --events 10
# 用显式时间窗口采集本地 fixture（便于重放时钟跳变场景）
node src/cli.mjs ingest --db /tmp/feedhub/feedhub.db --feed local --now 2026-11-16T10:00:00Z
```

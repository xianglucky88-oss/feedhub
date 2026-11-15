# feedhub

离线可运行的订阅源采集与更新分发半成品。当前实现 RSS 2.0、SQLite 状态、基于 guid 的重复抑制、本地 fanout 和 WebSub HMAC 工具；Atom、JSON Feed、真正的回调服务器和续期流程仍是后续题目空间。

```bash
make test
make demo
make verify
```

运行期只使用本地 fixture 和 `sqlite3` 命令，不访问公网。

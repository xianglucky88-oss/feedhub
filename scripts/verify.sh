#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export FEEDHUB_DB=/tmp/feedhub/feedhub.db
rm -rf /tmp/feedhub
output=$(node --no-warnings src/cli.mjs demo)
printf '%s\n' "$output" > /tmp/feedhub/demo.json
node -e '
const fs = require("node:fs");
const r = JSON.parse(fs.readFileSync("/tmp/feedhub/demo.json", "utf8"));
const checks = [
  ["首轮解析 RSS 并保存条目", r.first.status === "applied" && r.first.parsed === 2 && r.first.new === 2],
  ["首轮产生 4 条投递意向 (2 条 × 2 订阅者)", r.first.deliveryIntents === 4],
  ["重复轮询不产生新版本/新意向", r.replay.status === "applied" && r.replay.revisions === 0 && r.replay.deliveryIntents === 0],
  ["正文修订产生 1 个新版本", r.revised.revisions === 1 && r.revised.events.length === 1 && r.revised.events[0].eventType === "update"],
  ["修订只为 2 个订阅者各产生 1 条意向", r.revised.deliveryIntents === 2],
  ["空响应不删除历史", r.empty.status === "empty" && r.empty.stored.items === 2],
  ["状态区分已保存 / 应投递 / 已投递", r.counts.items === 2 && r.counts.events === 3 && r.deliveryStates.delivered === 6 && r.deliveryStates.pending === 0 && r.deliveryStates.inflight === 0],
  ["同一 (条目,版本,订阅者) 只投递一次", r.deliveryRun === 6 && r.deliveryStates.total === 6],
  ["签名校验", r.signatureValid === true],
];
let failed = 0;
console.log("== 断言 ==");
for (const [name, ok] of checks) { if (!ok) failed++; console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`); }
console.log(`\n结果: ${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);
' "$output"

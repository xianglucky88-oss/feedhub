#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
rm -rf /tmp/feedhub
output=$(node src/cli.mjs demo)
printf '%s\n' "$output"
node -e '
const r = JSON.parse(process.argv[1]);
const checks = [
  ["首轮解析 RSS", r.first.parsed === 2 && r.first.fresh === 2],
  ["重复轮询去重", r.second.fresh === 0],
  ["SQLite 状态", r.counts.items === 2 && r.counts.feeds === 1],
  ["fanout 投递", r.counts.deliveries === 4],
  ["签名校验", r.signatureValid === true],
];
let failed = 0;
console.log("== 断言 ==");
for (const [name, ok] of checks) { if (!ok) failed++; console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`); }
console.log(`\n结果: ${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);
' "$output"

#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
rm -rf /tmp/feedhub
output=$(node src/cli.mjs demo)
printf '%s\n' "$output"
node -e '
const r = JSON.parse(process.argv[1]);
const rounds = r.crossFormatRounds;
const ids = rounds.map(x => x.ids.join(","));
const checks = [
  ["三格式各自解析出 2 条", rounds.every(x => x.parsed === 2 && x.normalized === 2)],
  ["跨格式 canonical id 完全一致", new Set(ids).size === 1 && ids[0] === r.expectedIds.join(",")],
  ["格式切换不产生新条目", rounds[0].fresh === 2 && rounds[1].fresh === 0 && rounds[2].fresh === 0],
  ["重复 id 显式上报且保留首个", r.edgeRss.duplicates.length === 1 && r.edgeRss.duplicates[0].id === "dup-1"],
  ["空条目被剔除", r.edgeRss.skippedEmpty.length === 1 && r.edgeRss.normalized === 5],
  ["id 回退优先级齐全",
    r.edgeRss.idKinds["dup-1"] === "explicit" &&
    r.edgeRss.idKinds["https://edge.test/c"] === "link" &&
    Object.entries(r.edgeRss.idKinds).some(([id, kind]) => id.startsWith("h:") && kind === "title-hash")],
  ["非法日期被标记且保留原文", r.edgeRss.invalidDates.length === 1 && r.edgeRss.invalidDates[0].raw === "not-a-real-date"],
  ["URL 形 guid 跨 RSS/Atom 收敛", r.edgeAtomCrossFormatId === "https://edge.test/b"],
  ["端到端存储不拆条不重复",
    r.persistence.first.fresh === 2 && r.persistence.switched.fresh === 0 && r.persistence.third.fresh === 0 &&
    r.persistence.counts.items === 2 && r.persistence.counts.feeds === 1],
  ["fanout 仅首轮投递", r.persistence.counts.deliveries === 4],
  ["签名校验", r.signatureValid === true],
];
let failed = 0;
console.log("== 断言（存储后端: " + r.persistence.backend + "）==");
for (const [name, ok] of checks) { if (!ok) failed++; console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`); }
console.log(`\n结果: ${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);
' "$output"

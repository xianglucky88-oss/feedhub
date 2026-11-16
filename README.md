# feedhub

离线可运行的订阅源采集与更新分发工具。支持 **RSS 2.0、RSS 1.0(RDF)、Atom 1.0、JSON Feed 1.x** 四种输入格式，SQLite 状态存储、基于 canonical id 的重复抑制、本地 fanout 和 WebSub HMAC 工具；全部离线运行，不访问公网。

```bash
make test     # 27 个单元/端到端测试（node --test，零依赖）
make demo     # 同一内容在 RSS→Atom→JSON 间切换的完整采集演示
make verify   # 11 条跨格式/边界/存储断言
```

运行期只使用本地 fixture。持久化默认走 `sqlite3` CLI；环境缺少该二进制时自动切换到接口等价的内存后端（演示输出中会标明 `backend`），采集与去重语义不变。

## 架构：解析与归一化两层分离

| 文件 | 职责 |
| --- | --- |
| `src/xml-parser.mjs` | 通用 XML 分词器 + 树构建器（非逐格式正则）：CDATA、字符/命名实体、命名空间前缀、注释/PI/DOCTYPE、XHTML 嵌套元素、裸 `&` 容错 |
| `src/parse.mjs` | 格式探测与忠实提取：RSS/RDF/Atom/JSON → 统一中性中间结构，不含任何判定策略 |
| `src/normalize.mjs` | 全部归一化策略：canonical id、URL 规范化、日期校验、HTML 剥离、空条目剔除、批内重复检测、条目指纹 |
| `src/update-detect.mjs` | 按 canonical id 判定新旧、同 id 内容变化比较 |
| `src/poll.mjs` | 原始 feed → 解析 → 归一化 → 更新判定 → 落库/投递 的完整链路 |
| `src/store.mjs` / `src/memory-store.mjs` | SQLite 存储（含旧 guid schema 迁移）与无 sqlite3 时的内存后备 |

## 统一条目模型（UnifiedEntry）

每条内容归一化为同一形状，字段缺失安全降级为 `''`：

- `id`：canonical id，更新判定的唯一主键；`idKind` 标明来源（`explicit` / `link` / `title-hash`）
- `guid`：格式原始声明的标识，仅诊断用
- `title` / `summary`：纯文本（实体已解码、标签与多余空白已剥离）；标题缺失时回退摘要前缀
- `link`：规范化绝对 URL；`published` / `updated`：合法日期统一 ISO，非法日期留空且原文保存在 `dateRaw`
- `authors` / `sourceFormat` / `dateInvalid`

### canonical id 优先级

1. **显式稳定标识**：RSS `guid`（含 `isPermaLink="false"` 的不透明值，原样使用）、Atom `id`、JSON `id`；其中 URL 形标识先做 URL 规范化，以便与链接字段收敛；
2. **规范化链接**：无显式标识时使用条目链接；
3. **标题回退**：都没有时，用纯文本标题（再缺则摘要）的小写形式做 SHA-1 指纹（`h:` 前缀防撞）；
4. 三者全缺的条目视为空条目剔除并在 `skippedEmpty` 上报，绝不生成伪主键。

### URL 规范化

主机名小写、去除默认端口与 fragment、剥离 `utm_*` 等跟踪参数、其余查询参数排序、去除路径尾斜杠。因此 `RSS 干净链接`、`Atom 带 utm 参数链接`、`JSON 乱序参数链接` 收敛到同一个 canonical id。

### 重复与异常处理

- 批内重复 canonical id：保留首个，其余进入 `duplicates`（含下标与来源格式），不静默覆盖；
- 非法日期：`published`/`updated` 留空，原文进 `dateRaw`，`dateInvalid` 标记，不影响入库；
- 命名空间：所有元素按本地名匹配，`content:encoded`、`dc:creator`、`rdf:about` 等均可识别；
- 字段顺序：解析基于节点树而非正则位置，同一内容在两种格式中字段顺序不同仍得到相同归一化结果。

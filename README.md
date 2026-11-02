# respire-minimax-code

> 吸即存，呼即取——给 MiniMax Code 装上 respire 本地加密记忆。

本插件由 [respire-general](../respire-general) 生成：技能与 MCP 能力来自通用包，另加 MiniMax Code
0.4.0+ 的 hook 扩展。数据本地加密、端侧优先、云端 LWW 同步；引擎是
[respire（命令名 rsrs）](https://www.npmjs.com/package/@rsrsai/cli)。

## 插件由什么组成

| 路径 | 作用 |
| --- | --- |
| `.claude-plugin/plugin.json` | **mcode 0.4.0+ 权威清单**：inline `hooks` + `mcpServers` |
| `mcp/respire-mcp.mjs` | stdio 桥：解析引擎（含 Windows `.cmd` shim）后交给 `rsrs mcp` |
| `io.minimax.mcode/hooks/scripts/respire-hook.mjs` | 三类事件的单入口 hook（Node，无第三方依赖） |
| `skills/respire/SKILL.md` | 记忆操作法（何时查、怎么存、红线），由 `skills/` 自动发现 |

### 为什么没有根 `plugin.json`

mcode 本地读取器会**先尝试根 `plugin.json` 的便携 Agent Plugins 布局**，而该读取器固定返回
`hooks: []`；同时存在根清单与 `.claude-plugin` 时，hooks 会被静默忽略。0.4+ 专用布局因此只保留
`.claude-plugin/plugin.json`。该结论已在 **mcode 0.6.12** 上实测：删除根清单后 SessionStart /
UserPromptSubmit / Stop 全部执行。

代价：**不支持 mcode 0.3.x**（0.3 只读便携布局）。需要 0.3 时请用 `respire-general`（无自动 hooks）。

## 安装

### 引擎（缺失时 agent 可代装）

```bash
npm i -g @rsrsai/cli@latest
rsrs --version
```

无全局写权限时先试：

```bash
npm config set prefix ~/.npm-global
npm i -g @rsrsai/cli@latest
```

插件每轮实时探测引擎；装好**同会话内**即恢复召回与「记：」落库。

### 本地插件目录

```bash
mcode plugin marketplace list          # 找到当前 profile 的 local 目录
# 把整个 respire-minimax-code 目录作为该目录的直接子目录拷入（不要拷上级仓库）
mcode plugin list --available --marketplace local
mcode plugin list --json               # 应看到 skillCount=1、mcpServerCount=1、enabled=true
```

然后在 TUI 里打开 `/plugins` 刷新并启用。移除本地插件会删除安装目录，请保留源目录。

## 装上后发生什么

| 时机 | 行为 |
| --- | --- |
| `SessionStart` | 注入记忆层简则；一次 `rsrs status` 三态探测——未登录附注册引导、库空（<10 条）附首日存料引导、缺语义模型附**可选**装法；常态零打扰 |
| `UserPromptSubmit` | 自动 `rsrs recall --titles`：只注入分数＋8 位短 id＋标题；语义档超时/不可用则用 `rsrs diary --contains` 词面兜底（只取 important）；正文由 agent `memory_show` / `rsrs show` 按需取 |
| prompt 以「记：」「存：」「remember:」开头 | 直接 `rsrs remember … --importance important` 落库并回执；判为相似时不写入、转述候选由模型决断；回执要求模型抽事实句并 `rsrs retitle` |
| `Stop` | 存储检查：`{"decision":"block","reason":…}` 续跑一轮；`stop_hook_active=true` 时放行，防循环；节流与「近 10 分钟已落库」双重抑制 |
| `/nomem` 前缀 | 本轮跳过召回 |
| `$skill: 名称` 前缀 | 召回前剥除，防技能名词面污染 query |
| MCP 客户端 | 也可完全不依赖 hook：直接调用 `memory_recall` / `memory_remember` 等全套工具 |

## 为什么 hook 超时是 10 秒

mcode 的 hook 解析器只接受 **1–10 秒**的整数 timeout，超过会被判为无效并静默跳过。
因此本插件把内层子进程上限压到：语义召回 4.5s、词面兜底整体 9s、status 6s、store 9s，
给 Node 冷启动和进程回收留余量。冷启动第一次语义召回可能超时，会自动切词面兜底；fail-open 不拦会话。

## 调优（可选）

配置优先级：

1. `RESPITE_CONFIG` 环境变量
2. `$PLUGIN_DATA/respire.config.json`
3. `$CLAUDE_PLUGIN_ROOT/io.minimax.mcode/respire.config.json`

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `rsrs` | `""` | 引擎路径；空 = 自动探测（`RESPITE_BIN` → PATH 的 `rsrs`/`respire` → 常见安装目录） |
| `recall_threshold` | `0` | 召回下限；0=引擎直出，设正数才过滤 |
| `recall_limit` | `5` | 取前 N 条 |
| `min_prompt_chars` | `2` | 过短不检索 |
| `session_rules` | `true` | 是否注入 SessionStart 简则 |
| `budget_chars` | `1500` | 单轮注入总预算 |
| `enabled` | `true` | 总开关：false=全线静默 |
| `store_nudge_every` | `1` | Stop 节流：1=每轮、N=每 N 轮、0=关 |
| `store_force` | `false` | `记：` 落库加 `--force` 跳过判重；慢库上更可靠，但失去候选合并提示 |
| `semantic_timeout_ms` | `4500` | 语义召回单次预算；超时后走词面兜底 |
| `lexical_fallback` | `true` | 语义超时/失败时用 `rsrs diary --contains` 兜底（只取 important） |
| `log` | `true` | `$PLUGIN_DATA/hook.log` 留痕 |
| `skip_prefixes` | `[]` | 宿主内部提示白名单，不召回也不落库 |

其它环境变量：`RESPITE_BIN`、`RESPITE_RSRS`、`RESPITE_LOG`、`RESPITE_NUDGE_STATE`、`RESPITE_DATA`。

## 不装模型完全可用（降级是一等公民）

- 注册、登录、同步、召回全不依赖端侧模型——装完插件即可用，未装模型时引擎自动走词面档。
- BGE-M3（约 1.1GB）是**纯可选增强**：`rsrs model install && rsrs model activate m3`。
- 未装引擎时 SessionStart 会把安装命令交给 agent 代跑，不阻塞会话。

## 与 respire-qoder 的差异

| 项 | respire-qoder | respire-minimax-code |
| --- | --- | --- |
| 协议 | Qoder 私有清单 `.qoder-plugin/` | MiniMax Code 0.4+（Claude 兼容布局） |
| 清单 | `.qoder-plugin/plugin.json` | 仅 `.claude-plugin/plugin.json` |
| 根占位符 | `${QODER_PLUGIN_ROOT}` | `${CLAUDE_PLUGIN_ROOT}`（harness 注入） |
| 数据目录 | `QODER_PLUGIN_DATA` | `PLUGIN_DATA`（harness 注入） |
| Stop 阻塞 | `{"decision":"deny"}` | `{"decision":"block","reason":…}`（Claude 兼容） |
| hook 运行时 | Python | Node（mcode 本身是 Node，不额外要求 Python） |
| 额外能力 | 无 | `rsrs mcp` 全套 MCP 工具（不依赖 hook 也能用） |
| 0.3 支持 | 不适用 | **不支持**（0.3 只读便携布局） |

## 验证

```bash
node ../respire-general/scripts/validate.mjs .
node ../respire-general/tests/run.mjs --check
```

直接验 hook（不依赖 mcode 是否已加载插件）：

```bash
printf '%s' '{"hook_event_name":"UserPromptSubmit","prompt":"respire 记忆","session_id":"t","cwd":"."}' \
  | node io.minimax.mcode/hooks/scripts/respire-hook.mjs UserPromptSubmit
```

### 本地 mcode 冒烟测试（可选，但推荐）

用隔离的 `MINIMAX_DATA_DIR` 和临时 npm 前缀，不碰全局安装：

1. `npm install --prefix <temp> @minimax-ai/code@latest`
2. 把本目录拷到 `<data>/plugins/respire-minimax-code`
3. `MINIMAX_DATA_DIR=<data> node <temp>/node_modules/@minimax-ai/code/cli.js plugin list --json`
   应看到 `skillCount: 1`、`mcpServerCount: 1`、`enabled: true`
4. 用本地 mock OpenAI 兼容服务跑 `mcode exec`，检查 `<data>/v2/plugin-data/hooks/respire-minimax-code/hook.log`
   应依次出现 `session`、`recall`、`stop(nudge)`、`stop(active_skip)`

本包已在 **mcode 0.6.12** 上按上述方式实测：MCP 连接成功，三个 hook 事件均执行。

## 已知边界

- **不支持 mcode 0.3.x**：0.3 只读便携根清单，而根清单会让 0.4+ 忽略 hooks；二者不能同时满足。
- **社区 Registry 目前要求根 `plugin.json`**：该便携布局会丢掉 hooks。若目标是 MiniMax-Code-Plugins 社区目录，应提交 `respire-general`（技能 + MCP，无自动 hooks），或另做无 hooks 的便携变体。
- **官方 Marketplace 使用 `.minimax-plugin` V1**：本包未包含该布局；上官方目录需要另做 V1 清单（icon/category/hooks 文件）并走官方 issue/PR 审核。
- **召回质量是引擎上限**：用词鸿沟下 BGE-M3 可能漏召真条——简则已约束模型「命中不贴题换词补查」。
- **冷启动窗**：runtime 冷启＋模型加载可能让首次语义召回超过 4.5s，此时自动切词面兜底；整体仍在 9s 内。
- **MCP 需要 PATH 上的 `node`**：`mcpServers` 用 `node` 启动 stdio 桥，桥自己解析 `rsrs`（含 Windows `.cmd` shim）；`node` 缺失时 MCP 无法启动（rsrs 本身也是 Node CLI）。

## 数据与网络

- 记忆正文保存在本机 `~/.rsrs`（加密）；只有登录并同步时才访问 `api.rsrs.rs`。
- 插件不收集遥测，不访问第三方服务；hook 与 MCP 只调用本机 `rsrs`。
- 引擎安装/更新由 npm 完成，插件本身不下载二进制。

## License

MIT

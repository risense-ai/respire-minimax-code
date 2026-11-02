# respire-minimax-code

> 吸即存，呼即取——给 MiniMax Code 装上 respire 本地加密记忆。

本插件由 [respire-general](../respire-general) 生成，使用 **MiniMax Plugin V1 官方格式**
（`.minimax-plugin/`）。技能与 MCP 能力来自通用包，hooks 使用 MiniMax Code 0.4.0+ 的插件 hook。
数据本地加密、端侧优先、云端 LWW 同步；引擎是
[respire（命令名 rsrs）](https://www.npmjs.com/package/@rsrsai/cli)。

## 插件由什么组成

| 路径 | 作用 |
| --- | --- |
| `.minimax-plugin/plugin.json` | **官方 V1 清单**：icons/category/mcpServers/skills/hooks |
| `icon.png` | 512×512 包图标（V1 必填） |
| `respire.mcp.json` | V1 MCP 文件：`node ./mcp/respire-mcp.mjs` → `rsrs mcp` |
| `hooks/respire-hooks.json` | 官方 hook 文档：SessionStart / UserPromptSubmit / Stop |
| `hooks/scripts/respire-hook.mjs` | 三类事件的单入口 hook（Node，无第三方依赖） |
| `mcp/respire-mcp.mjs` | stdio 桥：解析引擎（含 Windows `.cmd` shim）后交给 `rsrs mcp` |
| `skills/respire/SKILL.md` | 记忆操作法（何时查、怎么存、红线） |

## 版本与 hooks 支持

- **mcode 0.4.0+**：支持 V1 插件与 hook；本包在 **0.6.12 / 0.7.4** 上实测通过。
- **mcode 0.3.x**：旧版本线，只读根 `plugin.json` 的便携 Agent Plugins 布局；hooks 是实验性文档，
  本包不支持。按“只兼容有 hooks 的版本”的标准，0.3 不在目标内。
- **当前版本**：npm `@minimax-ai/code` 最新为 0.7.4。
- hooks 不是 MiniMax Code 缺失的能力；缺的是**便携布局**对 hooks 的支持。便携读取器固定返回
  `hooks: []`，所以不能把根清单和 V1/Compat 清单混在一起。

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

### 官方 Marketplace

V1 格式就是官方 Marketplace 的包格式。上架还需要官方审核（icon、category、exampleQueries、
archive/digest、catalog 成员资格），不是本地加载的必要条件。

## Marketplace 与普通插件有什么不同

Marketplace 只是**分发/catalog 来源**（`official` 与 `local`），不是另一套运行时：

- 安装后的插件能力由**清单格式 + 运行时版本**决定，不由 marketplace 决定。
- 官方 `.minimax-plugin` V1 **支持 hooks**；本地 `.claude-plugin` 也支持 hooks；
  根 `plugin.json` 的便携布局不支持 hooks。
- `@official` 需要 V1 + 官方审核；`local` 直接放目录即可，两者都能有 hooks。

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
因此本插件把内层子进程上限压到：语义召回 3.5s、词面兜底整体 7.5s、status 5s、store 8s，
给 Node 冷启动和进程回收留余量。冷启动第一次语义召回可能超时，会自动切词面兜底；fail-open 不拦会话。

## 调优（可选）

配置优先级：

1. `RESPITE_CONFIG` 环境变量
2. `$PLUGIN_DATA/respire.config.json`
3. `$PLUGIN_ROOT/respire.config.json`

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
| `semantic_timeout_ms` | `3500` | 语义召回单次预算；超时后走词面兜底 |
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
| 协议 | Qoder 私有清单 `.qoder-plugin/` | MiniMax Plugin V1 官方格式 |
| 清单 | `.qoder-plugin/plugin.json` | `.minimax-plugin/plugin.json` |
| hooks | 独立 `hooks/hooks.json` | `hooks/respire-hooks.json`，manifest 引用 |
| 根占位符 | `${QODER_PLUGIN_ROOT}` | `$PLUGIN_ROOT` / `%PLUGIN_ROOT%`（shell 展开） |
| 数据目录 | `QODER_PLUGIN_DATA` | `PLUGIN_DATA`（harness 注入） |
| Stop 阻塞 | `{"decision":"deny"}` | `{"decision":"block","reason":…}`（Claude 兼容） |
| hook 运行时 | Python | Node（mcode 本身是 Node，不额外要求 Python） |
| 额外能力 | 无 | `rsrs mcp` 全套 MCP 工具（不依赖 hook 也能用） |
| 0.3 支持 | 不适用 | **不支持**（只兼容有 hooks 的 0.4+） |

## 验证

```bash
node ../respire-general/scripts/validate.mjs .
node ../respire-general/tests/run.mjs --check
```

直接验 hook（不依赖 mcode 是否已加载插件）：

```bash
printf '%s' '{"hook_event_name":"UserPromptSubmit","prompt":"respire 记忆","session_id":"t","cwd":"."}' \
  | node hooks/scripts/respire-hook.mjs UserPromptSubmit
```

### 本地 mcode 冒烟测试（已验证 0.6.12 / 0.7.4）

用隔离的 `MINIMAX_DATA_DIR` 和临时 npm 前缀，不碰全局安装：

1. `npm install --prefix <temp> @minimax-ai/code@latest`
2. 把本目录拷到 `<data>/plugins/respire-minimax-code`
3. `MINIMAX_DATA_DIR=<data> node <temp>/node_modules/@minimax-ai/code/cli.js plugin list --json`
   应看到 `skillCount: 1`、`mcpServerCount: 1`、`enabled: true`
4. 用本地 mock OpenAI 兼容服务跑 `mcode exec`，检查
   `<data>/v2/plugin-data/hooks/respire-minimax-code/hook.log`，应依次出现
   `session`、`recall`、`stop(nudge)`、`stop(active_skip)`

## 已知边界

- **只支持 0.4.0+**：0.3 只读便携根清单，且 hooks 是实验性的；按“必须有 hooks”的标准不兼容。
- **社区 Registry 的校验器要求根 `plugin.json`**：V1 包不会通过该注册表校验；官方 Marketplace
  才是 V1 的目标渠道。社区目录可投 `respire-general`（无自动 hooks）。
- **官方 Marketplace 上架仍需审核**：catalog 成员资格、archive/digest、icon 字节校验由官方
  Marketplace validator 执行；本地加载不需要这些。
- **召回质量是引擎上限**：用词鸿沟下 BGE-M3 可能漏召真条——简则已约束模型「命中不贴题换词补查」。
- **冷启动窗**：runtime 冷启＋模型加载可能让首次语义召回超过 3.5s，此时自动切词面兜底；整体仍在 7.5s 内。
- **MCP 需要 PATH 上的 `node`**：V1 MCP 用 `node` 启动 stdio 桥，桥自己解析 `rsrs`
  （含 Windows `.cmd` shim）；`node` 缺失时 MCP 无法启动（rsrs 本身也是 Node CLI）。

## 数据与网络

- 记忆正文保存在本机 `~/.rsrs`（加密）；只有登录并同步时才访问 `api.rsrs.rs`。
- 插件不收集遥测，不访问第三方服务；hook 与 MCP 只调用本机 `rsrs`。
- 引擎安装/更新由 npm 完成，插件本身不下载二进制。

## License

MIT

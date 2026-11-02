# respire-minimax-code

> 吸即存，呼即取——给 MiniMax Code 装上 respire 本地加密记忆。

本插件由 [respire-general](../respire-general) 生成：通用部分（Agent Plugins 1.0 的 skill + MCP）原样复用，
只增加 MiniMax Code 的 hook 扩展。数据本地加密、端侧优先、云端 LWW 同步；引擎是
[respire（命令名 rsrs）](https://www.npmjs.com/package/@rsrsai/cli)。

## 插件由什么组成

| 路径 | 面向 | 作用 |
| --- | --- | --- |
| `plugin.json` | Agent Plugins 1.0 客户端 / mcode 0.3.x | 便携清单；固定位置发现 `skills/` 与 `mcp.json` |
| `mcp.json` | 所有支持 MCP 的客户端 | `node mcp/respire-mcp.mjs` stdio 桥 → `rsrs mcp`，全套记忆工具 |
| `mcp/respire-mcp.mjs` | 本插件 | 解析引擎（含 Windows `.cmd` shim）并把 stdio 原样交给 `rsrs mcp` |
| `skills/respire/SKILL.md` | 所有支持 Agent Skills 的客户端 | 记忆操作法（何时查、怎么存、红线） |
| `.claude-plugin/plugin.json` | **mcode 0.4.0+** | 权威清单；inline `hooks` + `mcpServers`，Skill 由 `skills/` 自动发现 |
| `io.minimax.mcode/hooks/hooks.json` | mcode 0.3.x | 旧版 hook 文档（0.4.0+ 会忽略） |
| `io.minimax.mcode/hooks/scripts/respire-hook.mjs` | 本插件 | 三类事件的单入口 hook（Node，无第三方依赖） |

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

### 本地插件目录（推荐先这样试）

```bash
mcode plugin marketplace list          # 找到当前 profile 的 local 目录
# 把整个 respire-minimax-code 目录作为该目录的直接子目录拷入（不要拷上级仓库）
mcode plugin list --available --marketplace local
```

然后在 TUI 里打开 `/plugins` 刷新并启用。移除本地插件会删除安装目录，请保留源目录。

### 社区 Registry

本包符合 MiniMax-Code-Plugins 的便携布局（根 `plugin.json` + `.claude-plugin/plugin.json` 双清单）。
提交前请在注册表仓库跑一遍它的校验：

```bash
npm run check
```

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
3. `$PLUGIN_ROOT/io.minimax.mcode/respire.config.json`

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
| 协议 | Qoder 私有清单 `.qoder-plugin/` | Agent Plugins 1.0 + MiniMax 客户端扩展 |
| 清单 | `.qoder-plugin/plugin.json` | 根 `plugin.json` + `.claude-plugin/plugin.json` |
| 根占位符 | `${QODER_PLUGIN_ROOT}` | `${PLUGIN_ROOT}`（0.3）/ `${CLAUDE_PLUGIN_ROOT}`（0.4+）；harness 注入 |
| 数据目录 | `QODER_PLUGIN_DATA` | `PLUGIN_DATA`（harness 注入） |
| Stop 阻塞 | `{"decision":"deny"}` | `{"decision":"block","reason":…}`（Claude 兼容） |
| hook 运行时 | Python | Node（mcode 本身是 Node，不额外要求 Python） |
| 额外能力 | 无 | `rsrs mcp` 全套 MCP 工具（不依赖 hook 也能用） |

## 验证

在本包上一级运行通用校验器：

```bash
node ../respire-general/scripts/validate.mjs .
node ../respire-general/tests/run.mjs --check
```

直接验 hook（不依赖 mcode 是否已加载插件）：

```bash
printf '%s' '{"hook_event_name":"UserPromptSubmit","prompt":"respire 记忆","session_id":"t","cwd":"."}' \
  | node io.minimax.mcode/hooks/scripts/respire-hook.mjs UserPromptSubmit
```

## 已知边界

- **0.3.x 的 hook 文档是尽力兼容**：按注册表 v0.3 参考实现使用扁平条目与 `args`；当前 0.4+ parser 只读 `.claude-plugin/plugin.json`，以它为准。
- **召回质量是引擎上限**：用词鸿沟下 BGE-M3 可能漏召真条——简则已约束模型「命中不贴题换词补查」。
- **冷启动窗**：runtime 冷启＋模型加载可能让首次语义召回超过 4.5s，此时自动切词面兜底；整体仍在 9s 内。
- **MCP 需要 PATH 上的 `node`**：`mcp.json` 用 `node` 启动 stdio 桥，桥自己解析 `rsrs`（含 Windows `.cmd` shim）；`node` 缺失时 MCP 无法启动（rsrs 本身也是 Node CLI）。
- 本包未在真实 mcode 0.4.x 上做加载验证（本机未安装）；格式按官方文档与源码校验，客户端兼容性以 MiniMax 官方文档为准。

## 数据与网络

- 记忆正文保存在本机 `~/.rsrs`（加密）；只有登录并同步时才访问 `api.rsrs.rs`。
- 插件不收集遥测，不访问第三方服务；hook 与 MCP 只调用本机 `rsrs`。
- 引擎安装/更新由 npm 完成，插件本身不下载二进制。

## License

MIT

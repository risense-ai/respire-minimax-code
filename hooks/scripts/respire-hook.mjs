#!/usr/bin/env node
/**
 * respire · MiniMax Code hook adapter
 *
 * One synchronous hook process for three events:
 *   SessionStart      -> inject the memory rules + one-shot status probe
 *   UserPromptSubmit  -> one-prefix store, otherwise title-tier recall
 *   Stop              -> one storage nudge per turn (block + reason)
 *
 * Contract (MiniMax Code mcode 0.4.0+ / Claude-compatible inline hooks):
 *   - event name in argv[2] (stdin `hook_event_name` also accepted)
 *   - one UTF-8 JSON object on stdin, then EOF
 *   - handler timeout is capped at 10s by mcode, so every child call is < 10s
 *   - plain text on stdout for SessionStart / UserPromptSubmit becomes
 *     additionalContext; Stop uses {"decision":"block","reason":"..."}
 *
 * Iron rule: fail-open. Any exception -> empty stdout, exit 0, one log line.
 * Never exit non-zero: mcode maps exit 2 to a blocking decision.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// mcode caps one handler at 10s (parser.ts: 1..10). Leave room for node startup,
// engine startup and process teardown. A cold engine can spend several seconds
// loading BGE-M3, so recall/store get 9s and the probe gets 6s.
const PROBE_T = 6_000;
const STORE_T = 9_000;
const LOG_MAX = 256 * 1024;

const DEFAULTS = {
  rsrs: '',
  recall_threshold: 0,
  recall_limit: 5,
  min_prompt_chars: 2,
  session_rules: true,
  budget_chars: 1500,
  log: true,
  enabled: true,
  store_nudge_every: 1,
  store_force: false,
  semantic_timeout_ms: 4500,
  lexical_fallback: true,
  skip_prefixes: [],
};

const RECALL_TOTAL_T = 9_000;

const STORE_PREFIX = /^(?:记|存|记录|记住|remember)\s*[:：]\s*/i;
const SKIP_PREFIX = /^(?:\/nomem|#nomem)\b/;
const SKILL_PREFIX = /^\$\s*skill\s*:\s*\S+\s*/i;

const RULES = `【respire 记忆层 · 已挂接】本机 respire（rsrs）记忆库随本会话生效；数据本地加密、云端同步（账号注册与登录不归本层管，见 rsrs.rs）。
1. 答前先翻忆：优先 MCP 工具 memory_recall / memory_show，无 MCP 时用 rsrs recall "项目名+关键词"（--json 结构化、--titles 只要 id+标题）；报错、异常先按报错原文翻忆。
2. 收尾可存：memory_remember 或 rsrs remember "内容" --title "事实句" --importance important（判后即存：相似会给候选，先决断再发）。**title 是召回与判重的门面，须从内容抽取「主语＋动作＋结果」的完整事实句，禁主题分类名、禁硬截断**；prompt 以「记：」开头时由本层先落库保底——回执带暂拟标题与短 id，**你须抽取更准的事实句并 rsrs retitle <短id> --title 替换**。
3. 每轮自动召回已随 prompt 注入；**未见召回注入、命中不贴题、或话题涉及此前的项目、报错、约定、日期时，换词补查再答（同义词、上位词、英文对应词各试一路），可见地调用**；仅当已有注入确实相关方才勿重复。本轮加 /nomem 前缀可关闭自动召回。
4. 口令、证件号、手机号、卡号、私钥禁入记忆正文与查询词，只写存放位置——库虽加密，密钥泄露即全裸。
5. 同步 rsrs sync（autosync 常开）、rsrs status 查态、rsrs prompt 读完整工作流；深用法见 respire 技能。`;

const NO_RSRS = `【respire·引擎未装】插件已就绪，只差引擎。请立即代为执行安装，无需等用户：
  npm i -g @rsrsai/cli@latest
（无全局写权限时先试：npm config set prefix ~/.npm-global && npm i -g @rsrsai/cli@latest）
装完跑 rsrs --version 确认——本层每轮实时探测，装完同会话内即恢复召回与「记：」落库。
配置下一步（你顺手引导即可）：rsrs status 查登录态；未登录则请用户去 https://rsrs.rs 注册后本机跑 rsrs register --user <名>（登录密码本人设≥8位；**超级密码绝不自造、绝不传 --super**——系统自动生成 A3-… 恢复码并在输出中醒目列出，**务必抄下保存**，丢失则任何设备都解不开记忆）；日常 rsrs login；语义模型可选，想要更好召回再 rsrs model install && rsrs model activate m3。若已误填自定义超级密码，跑 rsrs super-reset 重发 A3 码。`;

const LOGIN_NUDGE = `注意：本机 respire 尚未登录——记忆只存本机、不同步、不跨设备。引导用户：去 rsrs.rs 注册后跑 rsrs register（登录密码本人设；**超级密码由系统自动生成 A3-… 恢复码，不要自造，务必保存**）；日常登录可由你代跑 rsrs login --oauth --no-open，把授权链接交给用户点击。`;

const EMPTY_NUDGE = `注意：本机 respire 记忆库还是空的——没有记忆可召回，自动召回无动静是正常而非故障。引导：用「记：〈事实〉」由本层落库，或让 agent 先把既有项目的约定、报错教训、关键结论存上几条；既有规则与记忆可一次成库——让 agent 读 ~/AGENTS.md、常用项目 AGENTS.md、本机 skills/*/SKILL.md 与 hooks 配置，分析抽条后分条存入（口令证件卡号排除）；有货之后每轮召回才有内容。`;

const NO_MODEL = `注意：respire 语义模型（BGE-M3）未装——现为词面档。**完全可用**：注册、登录、同步与召回都不依赖模型；想要更好效果再装：rsrs model install 下载模型（约 1.1GB），再 rsrs model activate m3 建索引激活召升降为语义档（可代跑，建索引可后台挂起）。`;

const PROBE_FAIL = `注意：respire 状态探测失败（rsrs status 未回）——若是全新机器尚未注册，先引导用户去 rsrs.rs 注册并跑 rsrs register（首设备）；否则可能 runtime 冷启动中，首轮召回空转稍候即通，持续无回跑 rsrs doctor 诊断并转告用户。`;

const STORE_NUDGE =
  '记忆检查（自动一次）：只做一件事——若你本轮产生了新的**事实、决定、约定、教训或踩坑**，' +
  '用 memory_remember 或 rsrs remember 分条存入（--importance important；标题按「主语＋动作＋结果」事实句；' +
  '判重给候选先决策挂靠或 --force）；若本轮只是问答闲聊而无新事实，直接结束、勿重复作答。存完或无需存即结束。';

const REDACT = [
  [/(password|passwd|pwd|密码|口令)\s*[:=：]\s*\S+/gi, '$1=[REDACTED]'],
  [/\b(sk|ghp|gho|github_pat|AKIA|xox)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]'],
  [/\b\d{11,19}\b/g, '[NUM]'],
];

function redact(value) {
  let s = String(value == null ? '' : value);
  for (const [pattern, replacement] of REDACT) s = s.replace(pattern, replacement);
  return s;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isExecutable(p) {
  if (!isFile(p)) return false;
  if (process.platform === 'win32') return true;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function dataDir() {
  for (const candidate of [
    process.env.RESPITE_DATA,
    process.env.MINIMAX_PLUGIN_DATA,
    process.env.PLUGIN_DATA,
    process.env.CLAUDE_PLUGIN_DATA,
  ]) {
    if (!candidate) continue;
    try {
      fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
      return candidate;
    } catch {
      /* try next */
    }
  }
  const fallback = path.join(os.homedir(), '.rsrs', 'plugin-data', 'respire-minimax-code');
  try {
    fs.mkdirSync(fallback, { recursive: true, mode: 0o700 });
  } catch {
    /* read-only home: fall back to tmp */
  }
  return fallback;
}

function logEvent(cfg, event, outcome, detail = '', ms) {
  if (!cfg || cfg.log === false) return;
  try {
    const file = process.env.RESPITE_LOG || path.join(dataDir(), 'hook.log');
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX) fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
    const record = {
      ts: new Date().toISOString().slice(0, 19),
      ev: event,
      out: outcome,
    };
    if (typeof ms === 'number') record.ms = Math.round(ms);
    if (detail) record.d = redact(detail).slice(0, 160);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    /* logging must never break the hook */
  }
}

function sameType(value, reference) {
  if (typeof reference === 'boolean') return typeof value === 'boolean';
  if (typeof reference === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (Array.isArray(reference)) return Array.isArray(value) && value.every((v) => typeof v === 'string');
  return typeof value === typeof reference;
}

function loadConfig() {
  const cfg = { ...DEFAULTS };
  const candidates = [
    process.env.RESPITE_CONFIG || '',
    path.join(dataDir(), 'respire.config.json'),
    path.join(process.env.PLUGIN_ROOT || process.cwd(), 'respire.config.json'),
  ];
  for (const file of candidates) {
    if (!file) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (isRecord(doc)) {
        for (const [key, reference] of Object.entries(DEFAULTS)) {
          if (key in doc && sameType(doc[key], reference)) cfg[key] = doc[key];
        }
      }
      break;
    } catch {
      /* missing or broken config -> defaults; never block */
    }
  }
  if (!Number.isFinite(cfg.recall_threshold) || cfg.recall_threshold < 0) cfg.recall_threshold = 0;
  if (!Number.isInteger(cfg.recall_limit) || cfg.recall_limit < 1) cfg.recall_limit = 5;
  if (!Number.isInteger(cfg.min_prompt_chars) || cfg.min_prompt_chars < 0) cfg.min_prompt_chars = 2;
  if (!Number.isInteger(cfg.budget_chars) || cfg.budget_chars < 200) cfg.budget_chars = 1500;
  if (!Number.isInteger(cfg.semantic_timeout_ms) || cfg.semantic_timeout_ms < 500) cfg.semantic_timeout_ms = 4500;
  if (cfg.semantic_timeout_ms > 8000) cfg.semantic_timeout_ms = 8000;
  return cfg;
}

function pathCandidates(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  const found = [];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) found.push(candidate);
    }
  }
  return found;
}

function findEngine(cfg) {
  const home = os.homedir();
  const candidates = [
    cfg.rsrs,
    process.env.RESPITE_RSRS,
    process.env.RESPIRE_BIN,
    ...pathCandidates('rsrs'),
    ...pathCandidates('respire'),
    path.join(home, '.local', 'bin', 'rsrs'),
    path.join(home, '.local', 'bin', 'respire'),
    path.join(home, '.rsrs', 'bin', 'rsrs'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'rsrs.cmd') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'rsrs') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'pnpm', 'rsrs.cmd') : '',
    '/usr/local/bin/rsrs',
    '/opt/homebrew/bin/rsrs',
    '/usr/bin/rsrs',
  ];
  for (const candidate of candidates) {
    if (candidate && isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * A Windows npm shim is a .cmd wrapper around the package's cli.js. Spawning it
 * directly fails (or needs cmd.exe argument re-parsing), so read the shim and
 * run cli.js with the current node binary instead. This keeps arbitrary prompt
 * text out of cmd.exe's parser entirely.
 */
function resolveNodeCliFromShim(shim) {
  try {
    const text = fs.readFileSync(shim, 'utf8').slice(0, 64 * 1024);
    const dir = path.dirname(shim);
    const pattern = /([^\s"'<>|]*cli\.js)/gi;
    let match;
    while ((match = pattern.exec(text))) {
      let target = match[1]
        .replace(/%~dp0\\?/gi, `${dir}${path.sep}`)
        .replace(/%dp0%/gi, `${dir}${path.sep}`);
      if (!path.isAbsolute(target)) target = path.resolve(dir, target);
      if (isFile(target)) return target;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function resolveSpawn(engine) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(engine)) {
    const cli = resolveNodeCliFromShim(engine);
    if (!cli) return null;
    return { command: process.execPath, prefix: [cli] };
  }
  return { command: engine, prefix: [] };
}

function runEngine(engine, args, timeoutMs) {
  return new Promise((resolve) => {
    const spawnSpec = resolveSpawn(engine);
    if (!spawnSpec) {
      resolve({ code: -1, stdout: '', stderr: 'unsupported shim', timedOut: false });
      return;
    }
    let child;
    try {
      child = spawn(spawnSpec.command, [...spawnSpec.prefix, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      // If the kill never produces a close event, resolve anyway so the hook
      // itself stays inside mcode's 10s handler budget.
      setTimeout(() => finish(-1), 300);
    }, timeoutMs);
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 256 * 1024) stderr += chunk;
    });
    child.on('error', (error) => {
      stderr += String(error);
      finish(-1);
    });
    child.on('close', (code) => finish(typeof code === 'number' ? code : -1));
  });
}

function extractTitle(content) {
  const s = String(content || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const sentence = s.match(/^(.{6,}?[。！？!?])/);
  if (sentence) return sentence[1].slice(0, 70).trim();
  const head = s.slice(0, 70);
  let cut = -1;
  for (const ch of '，；、,;') cut = Math.max(cut, head.lastIndexOf(ch));
  if (cut >= 20) {
    return head
      .slice(0, cut + 1)
      .replace(/[，,；;\s]+$/, '')
      .trim();
  }
  return head;
}

async function doStore(engine, content, cfg) {
  if (!content) {
    logEvent(cfg, 'store', 'empty_content');
    return '';
  }
  if (content.length > 20_000) {
    logEvent(cfg, 'store', 'too_long', `${content.length} chars`);
    return '【respire·落库】内容过长（>20000 字），请改用 memory_remember 或拆条 rsrs remember。';
  }
  const title = extractTitle(content) || 'respire 快存';
  const started = Date.now();
  const args = ['remember', content, '--title', title, '--importance', 'important'];
  if (cfg.store_force === true) args.push('--force');
  args.push('--json');
  const result = await runEngine(engine, args, STORE_T);
  const elapsed = Date.now() - started;
  let doc = {};
  try {
    doc = result.stdout ? JSON.parse(result.stdout) : {};
  } catch {
    doc = {};
  }
  if (!isRecord(doc)) doc = {};
  if (result.timedOut) {
    logEvent(cfg, 'store', 'timeout', title, elapsed);
    return '【respire·落库】respire 超时未回，请改手动 memory_remember 或 rsrs remember 核实/补存。';
  }
  const status = String(doc.status || '');
  if (status === 'ok') {
    const id = String((doc.summary && doc.summary.id) || '');
    logEvent(cfg, 'store', 'ok', id.slice(0, 8), elapsed);
    const tail = id ? `（${id.slice(0, 8)}）` : '';
    const forced = cfg.store_force === true ? '（store_force 直写，判重未做）' : '';
    return (
      `【respire·落库】已存入：${title}${tail}${forced}。标题系规则暂拟——` +
      '请从内容抽取「主语＋动作＋结果」的完整事实句，' +
      `rsrs retitle ${id.slice(0, 8)} --title 替换（title 是召回与判重的门面）。`
    );
  }
  if (status === 'pending') {
    const candidates = Array.isArray(doc.items) ? doc.items : [];
    logEvent(cfg, 'store', 'pending', `cand=${candidates.length}`, elapsed);
    const lines = ['【respire·落库待决】respire 判定本条与既有记忆相似，未写入。候选：'];
    for (const item of candidates.slice(0, 5)) {
      if (isRecord(item)) lines.push(`- [${item.name || '?'}] ${item.value || ''}`);
    }
    lines.push('请决断：挂靠则同文加 --parent <id>；确属独立则加 --force 直写。');
    return lines.join('\n');
  }
  const errors = Array.isArray(doc.errors) ? doc.errors : [];
  const message = errors.length
    ? JSON.stringify(errors).slice(0, 200)
    : `status=${status || result.code}`;
  logEvent(cfg, 'store', 'fail', message, elapsed);
  return `【respire·落库失败】respire 未收：${message}`;
}

const STOP_WORDS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '把', '被', '我', '你', '他', '她', '它', '我们', '你们',
  '这个', '那个', '一下', '可以', '需要', '现在', '然后', '以及', '还有', '怎么', '如何', '什么',
  '为什么', '帮我', '帮忙', '请问', '一个', '没有', '就是', '还是', '但是', '因为', '所以', '如果',
  '吗', '呢', '吧', '啊', '请', '想', '要', '有', '做', '用', '看', '说',
  'the', 'and', 'for', 'with', 'how', 'what', 'why', 'when', 'where', 'who', 'this', 'that',
  'can', 'could', 'should', 'would', 'does', 'did', 'is', 'are', 'was', 'were', 'you', 'your',
  'please', 'help', 'about', 'from', 'into', 'have', 'has', 'not',
]);

function normalizeTerm(raw) {
  let term = String(raw || '').toLowerCase().trim();
  term = term.replace(/^(?:请问|帮我|帮忙|我想|我要|麻烦)/u, '');
  term = term.replace(/(?:怎么做|怎么弄|怎么搞|如何做|怎么办|是什么|有什么|有哪些|有没有|能不能|可不可以)$/u, '');
  term = term.replace(/^[的了是在和与把被]+/u, '').replace(/[的了是在和与把被吗呢吧啊]+$/u, '');
  if (/[的了是在和与把被]/u.test(term)) {
    const parts = term.split(/[的了是在和与把被]/u).filter(Boolean).sort((a, b) => b.length - a.length);
    term = parts[0] || term;
  }
  return term.trim();
}

function extractTerms(prompt) {
  const tokens = String(prompt || '')
    .split(/[^\p{L}\p{N}_-]+/u)
    .map(normalizeTerm)
    .filter((term) => term.length >= 2 && term.length <= 24 && !STOP_WORDS.has(term));
  const unique = [...new Set(tokens)];
  // Prefer specific terms (longer than one CJK character, shorter than a whole sentence).
  unique.sort((a, b) => {
    const rank = (value) => (value.length >= 3 && value.length <= 12 ? 0 : value.length > 12 ? 1 : 2);
    return rank(a) - rank(b) || b.length - a.length;
  });
  return unique.slice(0, 3);
}

function renderRecallHits(hits, cfg, label) {
  const budget = cfg.budget_chars;
  const lines = [];
  let used = 90;
  for (const hit of hits) {
    const stale = hit.stale ? ' →已被取代' : '';
    const line = `- [${hit.badge}] ${hit.title}（${String(hit.id || '').slice(0, 8)}）${stale}`;
    if (lines.length && used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  const note = label.includes('词面')
    ? '词面命中只是关键词匹配，不是可信度'
    : '分数是相关度不是可信度';
  const head =
    `【respire·自动召回】命中 ${lines.length} 条（${label}，` +
    `正文用 memory_show 或 rsrs show <短id> 按需读；${note}）：`;
  return [head, ...lines].join('\n');
}

async function doLexicalRecall(engine, prompt, cfg, started) {
  const terms = extractTerms(prompt);
  if (!terms.length) {
    logEvent(cfg, 'recall', 'lexical_no_terms', prompt.slice(0, 40), Date.now() - started);
    return '';
  }
  const deadline = started + RECALL_TOTAL_T - 250;
  const merged = new Map();
  const used = [];
  for (const term of terms) {
    const left = deadline - Date.now();
    if (left < 600) break;
    const result = await runEngine(
      engine,
      ['diary', '--contains', term, '--limit', String(cfg.recall_limit * 3), '--json'],
      Math.min(2_500, left),
    );
    if (result.timedOut || result.code !== 0) continue;
    let doc;
    try {
      doc = JSON.parse(result.stdout);
    } catch {
      continue;
    }
    if (!isRecord(doc) || !Array.isArray(doc.details)) continue;
    used.push(term);
    for (const detail of doc.details) {
      if (!isRecord(detail) || !detail.id || !detail.title) continue;
      if (detail.importance && detail.importance !== 'important') continue;
      const haystack = `${detail.title}\n${detail.content || ''}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (!haystack.includes(t)) continue;
        let count = 0;
        let at = 0;
        while ((at = haystack.indexOf(t, at)) !== -1) {
          count += 1;
          at += t.length;
        }
        score += count * (String(detail.title).toLowerCase().includes(t) ? 3 : 1);
      }
      if (!score) continue;
      const previous = merged.get(detail.id);
      if (previous) previous.score += score;
      else merged.set(detail.id, { id: detail.id, title: detail.title, score, stale: false });
    }
  }
  if (!merged.size) {
    logEvent(cfg, 'recall', 'lexical_miss', `terms=${used.join('|')}`, Date.now() - started);
    return '';
  }
  const hits = [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.recall_limit)
    .map((hit) => ({ ...hit, badge: '词面' }));
  logEvent(cfg, 'recall', 'lexical_hit', `n=${hits.length} terms=${used.join('|')}`, Date.now() - started);
  return renderRecallHits(hits, cfg, '词面兜底：语义档超时或不可用');
}

async function doRecall(engine, prompt, cfg) {
  const started = Date.now();
  const semanticBudget = Math.max(
    500,
    Math.min(cfg.semantic_timeout_ms, RECALL_TOTAL_T - 1_500),
  );
  const result = await runEngine(
    engine,
    ['recall', prompt, '--limit', String(cfg.recall_limit), '--titles', '--json'],
    semanticBudget,
  );
  const elapsed = Date.now() - started;

  if (!result.timedOut && result.code === 0) {
    let doc;
    try {
      doc = JSON.parse(result.stdout);
    } catch {
      doc = null;
    }
    if (isRecord(doc) && (doc.status === 'ok' || doc.status === 'skip')) {
      const details = Array.isArray(doc.details) ? doc.details : [];
      const threshold = Number(cfg.recall_threshold) || 0;
      const keep = [];
      let maxScore = 0;
      for (const detail of details) {
        if (!isRecord(detail)) continue;
        const score = typeof detail.score === 'number' ? detail.score : null;
        if (score !== null) maxScore = Math.max(maxScore, score);
        if (score !== null && score >= threshold) {
          keep.push({
            id: detail.id,
            title: String(detail.title || '').trim() || '(无题)',
            badge: score.toFixed(2),
            stale: Boolean(detail.superseded_by),
          });
          if (keep.length >= cfg.recall_limit) break;
        }
      }
      if (keep.length) {
        const gate = threshold > 0 ? `阈值 ${threshold}，` : 'rsrs 直出，';
        logEvent(cfg, 'recall', 'hit', `n=${keep.length} max=${maxScore} q=${prompt.slice(0, 40)}`, elapsed);
        return renderRecallHits(keep, cfg, `${gate}标题档`);
      }
      logEvent(cfg, 'recall', doc.status === 'skip' ? 'skip' : 'below_thr', `max=${maxScore}`, elapsed);
      // A semantic answer of "nothing relevant" is meaningful: do not add lexical noise.
      return '';
    }
    logEvent(
      cfg,
      'recall',
      'status_fail',
      isRecord(doc) ? String(doc.status) : '?',
      elapsed,
    );
  } else if (result.timedOut) {
    logEvent(cfg, 'recall', 'timeout', prompt.slice(0, 40), elapsed);
  } else {
    logEvent(cfg, 'recall', 'rc_nonzero', `rc=${result.code} ${result.stderr.slice(0, 80)}`, elapsed);
  }

  if (cfg.lexical_fallback === false) return '';
  const remaining = RECALL_TOTAL_T - (Date.now() - started) - 300;
  if (remaining < 800) return '';
  return doLexicalRecall(engine, prompt, cfg, started);
}

async function probeStatus(engine, cfg) {
  if (process.env.RESPITE_FAKE_PROBE_FAIL === '1') {
    logEvent(cfg, 'probe', 'fake_fail');
    return { logged: null, total: null, ok: false };
  }
  const started = Date.now();
  const result = await runEngine(engine, ['status', '--json'], PROBE_T);
  const elapsed = Date.now() - started;
  if (result.timedOut) {
    logEvent(cfg, 'probe', 'timeout', '', elapsed);
    return { logged: null, total: null, ok: false };
  }
  let doc;
  try {
    doc = JSON.parse(result.stdout);
  } catch {
    logEvent(cfg, 'probe', 'parse_error', result.stdout.slice(0, 80), elapsed);
    return { logged: null, total: null, ok: false };
  }
  if (!isRecord(doc) || doc.status !== 'ok') {
    logEvent(cfg, 'probe', 'status_not_ok', isRecord(doc) ? String(doc.status) : '?', elapsed);
    return { logged: null, total: null, ok: false };
  }
  const summary = isRecord(doc.summary) ? doc.summary : {};
  const session = isRecord(summary.session) ? summary.session : {};
  let logged = Boolean(session.has_token) && Boolean(session.user);
  let total = Number.isInteger(summary.local_total) ? summary.local_total : null;
  if (process.env.RESPITE_FAKE_LOGGED_OUT === '1') logged = false;
  if (process.env.RESPITE_FAKE_EMPTY === '1') total = 0;
  logEvent(cfg, 'probe', 'ok', `logged=${logged} total=${total}`, elapsed);
  return { logged, total, ok: true };
}

function modelInstalled() {
  if (process.env.RESPITE_FAKE_NO_MODEL === '1') return false;
  try {
    return fs.statSync(path.join(os.homedir(), '.rsrs', 'models', 'bge-m3')).isDirectory();
  } catch {
    return null;
  }
}

async function onSessionStart(data, cfg, engine) {
  if (!cfg.session_rules) return '';
  if (!engine) {
    logEvent(cfg, 'session', 'engine_missing');
    return NO_RSRS;
  }
  let out = RULES;
  const segments = [];
  const probe = await probeStatus(engine, cfg);
  if (!probe.ok) {
    out += `\n${PROBE_FAIL}`;
    segments.push('probe_fail');
  } else {
    if (probe.logged === false) {
      out += `\n${LOGIN_NUDGE}`;
      segments.push('login');
    }
    if (probe.total !== null && probe.total < 10) {
      out += `\n${EMPTY_NUDGE}`;
      segments.push('empty');
    }
  }
  if (modelInstalled() === false) {
    out += `\n${NO_MODEL}`;
    segments.push('no_model');
  }
  logEvent(cfg, 'session', 'ok', `segs=${segments.join(',') || 'none'}`);
  return out;
}

async function onPrompt(data, cfg, engine) {
  const raw = data.prompt;
  if (typeof raw !== 'string') {
    logEvent(cfg, 'prompt', 'bad_prompt', '非字符串');
    return '';
  }
  const prompt = raw.trim();
  if (!prompt || SKIP_PREFIX.test(prompt)) {
    logEvent(cfg, 'prompt', 'nomem_or_empty', prompt.slice(0, 40));
    return '';
  }
  for (const prefix of Array.isArray(cfg.skip_prefixes) ? cfg.skip_prefixes : []) {
    if (typeof prefix !== 'string' || !prefix) continue;
    if (prompt.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()) {
      logEvent(cfg, 'prompt', 'internal_skip', prefix);
      return '';
    }
  }
  const storeMatch = prompt.match(STORE_PREFIX);
  if (storeMatch) {
    const content = prompt.slice(storeMatch[0].length).trim();
    if (!engine) {
      logEvent(cfg, 'store', 'engine_missing', prompt.slice(0, 40));
      return NO_RSRS;
    }
    return doStore(engine, content, cfg);
  }
  if (prompt.length < cfg.min_prompt_chars) {
    logEvent(cfg, 'prompt', 'too_short', prompt.slice(0, 40));
    return '';
  }
  if (!engine) {
    logEvent(cfg, 'recall', 'engine_missing', prompt.slice(0, 40));
    return '';
  }
  const query = (prompt.replace(SKILL_PREFIX, '').trim() || prompt).slice(0, 4_000);
  return doRecall(engine, query, cfg);
}

function onStop(data, cfg, engine) {
  if (data.stop_hook_active === true) {
    logEvent(cfg, 'stop', 'active_skip');
    return '';
  }
  if (!engine) return '';
  const every = Number.isInteger(cfg.store_nudge_every) ? cfg.store_nudge_every : 1;
  if (every <= 0) return '';
  try {
    const stateFile = process.env.RESPITE_NUDGE_STATE || path.join(dataDir(), '.nudge_counter');
    let count = 0;
    try {
      count = Number.parseInt(fs.readFileSync(stateFile, 'utf8').trim(), 10) || 0;
    } catch {
      count = 0;
    }
    count += 1;
    fs.writeFileSync(stateFile, String(count), 'utf8');
    if (count % every !== 0) {
      logEvent(cfg, 'stop', 'every_skip', `n=${count} every=${every}`);
      return '';
    }
  } catch {
    /* throttle failure must not block */
  }
  try {
    const logFile = process.env.RESPITE_LOG || path.join(dataDir(), 'hook.log');
    if (fs.existsSync(logFile)) {
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-50);
      const now = Date.now();
      for (const line of lines) {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.ev === 'store' && record.out === 'ok') {
          const ts = Date.parse(`${record.ts}Z`);
          if (Number.isFinite(ts) && now - ts < 600_000) {
            logEvent(cfg, 'stop', 'stored_recent_skip');
            return '';
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  logEvent(cfg, 'stop', 'nudge');
  // Claude-compatible Stop semantics in mcode: decision=block + reason -> one
  // more model turn (continuePrompt). stop_hook_active prevents loops.
  return JSON.stringify({ decision: 'block', reason: STORE_NUDGE });
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let event = process.argv[2] || '';
  let data = {};
  let cfg = { ...DEFAULTS };
  let out = '';
  try {
    const raw = await readStdin();
    if (raw.trim()) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = {};
      }
    }
    if (!isRecord(data)) data = {};
    if (!event) event = String(data.hook_event_name || '');
    cfg = loadConfig();
    if (cfg.enabled === false) {
      logEvent(cfg, event || 'unknown', 'disabled');
      process.exit(0);
    }
    const engine = findEngine(cfg);
    if (event === 'SessionStart') {
      out = await onSessionStart(data, cfg, engine);
    } else if (event === 'UserPromptSubmit') {
      out = await onPrompt(data, cfg, engine);
    } else if (event === 'Stop') {
      out = onStop(data, cfg, engine);
    }
  } catch (error) {
    out = '';
    try {
      logEvent(cfg, event || 'unknown', 'fatal', `${error && error.name}: ${error && error.message}`);
    } catch {
      /* ignore */
    }
  }
  if (out) process.stdout.write(out);
  // Let stdout flush naturally (a hard process.exit can truncate pipes on
  // Windows). The unref'd guard only fires if a stray handle keeps us alive.
  const guard = setTimeout(() => process.exit(0), 3_000);
  guard.unref();
  process.exitCode = 0;
}

main();

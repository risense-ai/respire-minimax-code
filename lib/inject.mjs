/**
 * First-run `rsrs inject` support for hosts that do not provide plugin hooks.
 *
 * `rsrs inject` distributes the respire rules into a host's instruction file
 * (CLAUDE.md, AGENTS.md, MEMORY.md, ...). It is a one-time/refreshable file
 * write, not a per-prompt hook. This module:
 *
 *   1. finds the host target from the process environment or config;
 *   2. asks `rsrs inject --targets --json` what state that target is in;
 *   3. runs `rsrs inject --id <target>` only when it is absent or stale;
 *   4. records the result under PLUGIN_DATA for diagnostics.
 *
 * It is safe to call on every start: a current target is skipped.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const NEED_INJECT = new Set([
  'absent',
  'stale',
  'missing',
  'not_injected',
  'outdated',
  'warn',
]);

export function readPluginConfig(env = process.env) {
  for (const file of [
    env.RESPITE_CONFIG || '',
    env.PLUGIN_DATA ? path.join(env.PLUGIN_DATA, 'respire.config.json') : '',
    env.PLUGIN_ROOT ? path.join(env.PLUGIN_ROOT, 'respire.config.json') : '',
  ]) {
    if (!file) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) return doc;
    } catch {
      /* try next */
    }
  }
  return {};
}

/**
 * Best-effort host detection from environment markers. Returns null when the
 * host is unknown or is mcode/MiniMax Code (which has no `rsrs inject` target).
 */
export function detectTarget(env = process.env, configured = 'auto') {
  const explicit = String(configured || '').trim();
  if (explicit && explicit !== 'auto') {
    return explicit === 'none' ? null : explicit;
  }
  if (env.RESPITE_INJECT_TARGET && env.RESPITE_INJECT_TARGET !== 'auto') {
    return env.RESPITE_INJECT_TARGET === 'none' ? null : env.RESPITE_INJECT_TARGET;
  }
  // mcode sets MINIMAX_* for hooks; its plugin-data path also identifies it.
  if (
    env.MINIMAX_PLUGIN_ROOT ||
    env.MINIMAX_PROJECT_DIR ||
    env.MCODE_PLUGIN_ROOT ||
    /[\\/]\.minimax[\\/]/i.test(env.PLUGIN_DATA || '') ||
    /[\\/]\.minimax[\\/]/i.test(env.PLUGIN_ROOT || '')
  ) {
    return null;
  }
  const markers = [
    ['CLAUDE', 'claude'],
    ['CODEX', 'codex'],
    ['OPENCODE', 'opencode'],
    ['QWEN', 'qwen'],
    ['WORKBUDDY', 'workbuddy'],
    ['DOUBAO', 'doubao'],
    ['KYLINBOT', 'kylinbot'],
    ['DSH', 'dsh'],
    ['ZCODE', 'zigcode'],
    ['GROK', 'grok'],
    ['PI_', 'pi'],
  ];
  for (const [marker, target] of markers) {
    if (Object.keys(env).some((key) => key.startsWith(marker))) return target;
  }
  return null;
}

export function runEngine(spec, args, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.command, [...spec.prefix, ...args], {
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
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      setTimeout(() => finish(-1), 250);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 2 * 1024 * 1024) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 128 * 1024) stderr += chunk;
    });
    child.on('error', (error) => {
      stderr += String(error);
      finish(-1);
    });
    child.on('close', (code) => finish(typeof code === 'number' ? code : -1));
  });
}

function readState(stdout) {
  try {
    const doc = JSON.parse(stdout);
    if (!doc || !Array.isArray(doc.details)) return null;
    return doc;
  } catch {
    return null;
  }
}

/**
 * @param {object} input
 * @param {{command:string,prefix:string[]}} input.spec resolved rsrs executable
 * @param {string|null} input.target inject target id (claude, codex, generic, ...)
 * @param {string} [input.dataDir] PLUGIN_DATA for the state record
 * @param {boolean} [input.force] inject even when current
 * @param {boolean} [input.checkOnly] report only, never write
 * @param {(msg:string)=>void} [input.log]
 */
export async function injectOnce(input) {
  const log = input.log || (() => {});
  const target = input.target || null;
  if (!target) return { status: 'skip', reason: 'no host inject target' };
  if (target === 'mcode' || target === 'minimax') {
    return { status: 'skip', reason: 'mcode has no rsrs inject target' };
  }

  const listed = await runEngine(input.spec, ['inject', '--targets', '--json'], 5_000);
  if (listed.timedOut) return { status: 'error', reason: 'inject --targets timed out' };
  const doc = readState(listed.stdout);
  if (!doc) return { status: 'error', reason: 'inject --targets returned invalid JSON' };
  const detail = doc.details.find((item) => item && item.id === target);
  if (!detail) return { status: 'error', reason: `target ${target} not found` };
  const state = String(detail.state || '').toLowerCase();
  const needed = input.force === true || NEED_INJECT.has(state);
  if (!needed) {
    return { status: 'skip', target, state, reason: 'already injected' };
  }
  if (input.checkOnly) return { status: 'needed', target, state };

  const result = await runEngine(input.spec, ['inject', '--id', target, '--json'], 8_000);
  if (result.timedOut) return { status: 'error', target, state, reason: 'inject --id timed out' };
  let status = '';
  try {
    status = String(JSON.parse(result.stdout).status || '');
  } catch {
    status = '';
  }
  const ok = status === 'ok' || status === 'warn';
  if (ok) {
    try {
      const file = path.join(input.dataDir || '.', 'inject-state.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        `${JSON.stringify({ target, state, at: new Date().toISOString(), status })}\n`,
        'utf8',
      );
    } catch {
      /* state record is diagnostic only */
    }
    log(`respire inject: ${target} (${state}) -> ${status || 'ok'}`);
    return { status: 'injected', target, state, result: status || 'ok' };
  }
  log(`respire inject: ${target} failed (${status || result.code})`);
  return { status: 'error', target, state, reason: status || `rc=${result.code}` };
}

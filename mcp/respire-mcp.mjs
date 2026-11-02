#!/usr/bin/env node
/**
 * respire MCP stdio bridge.
 *
 * Agent Plugins only guarantees a portable `mcp.json`; how a client resolves a
 * bare `command` is client-defined. On Windows the npm/pnpm `rsrs` entry is a
 * `.cmd` shim, which many Node-based launchers cannot spawn without a shell.
 *
 * This bridge resolves the real engine (including the shim's `cli.js`) and then
 * hands its own stdio directly to `rsrs mcp`. No JSON-RPC parsing or buffering
 * happens here: stdin/stdout/stderr are inherited, so the MCP protocol remains
 * byte-for-byte intact.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

function configuredEngine() {
  for (const file of [
    process.env.RESPITE_CONFIG || '',
    process.env.PLUGIN_DATA ? path.join(process.env.PLUGIN_DATA, 'respire.config.json') : '',
    process.env.PLUGIN_ROOT
      ? path.join(process.env.PLUGIN_ROOT, 'io.minimax.mcode', 'respire.config.json')
      : '',
  ]) {
    if (!file) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (doc && typeof doc.rsrs === 'string' && doc.rsrs.trim()) return doc.rsrs.trim();
    } catch {
      /* ignore and keep probing */
    }
  }
  return '';
}

function findEngine() {
  const home = os.homedir();
  const candidates = [
    process.env.RESPITE_BIN,
    process.env.RESPITE_RSRS,
    configuredEngine(),
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
 * Read a Windows npm shim and return the real cli.js it wraps. Spawning the
 * `.cmd` itself would require cmd.exe to re-parse arguments; running cli.js with
 * the current node binary avoids that entirely.
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

const engine = findEngine();
if (!engine) {
  console.error(
    'respire MCP: engine not found. Install it with `npm i -g @rsrsai/cli@latest`, ' +
      'or set RESPITE_BIN to the rsrs executable in the MCP server environment.',
  );
  process.exit(1);
}

const spec = resolveSpawn(engine);
if (!spec) {
  console.error(`respire MCP: unsupported Windows shim for ${engine}; set RESPITE_BIN to cli.js`);
  process.exit(1);
}

const child = spawn(spec.command, [...spec.prefix, 'mcp'], {
  // stdin must be piped (inheriting a parent pipe is unreliable on Windows);
  // stdout/stderr can be inherited so protocol bytes are never buffered here.
  stdio: ['pipe', 'inherit', 'inherit'],
  windowsHide: true,
});

process.stdin.pipe(child.stdin);
process.stdin.on('error', () => {});
child.stdin.on('error', () => {});

child.on('error', (error) => {
  console.error(`respire MCP: failed to start engine: ${error && error.message}`);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  });
}

child.on('exit', (code, signal) => {
  try {
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
  } catch {
    /* ignore */
  }
  if (signal) {
    try {
      process.kill(process.pid, signal);
      return;
    } catch {
      /* fall through to numeric exit */
    }
  }
  process.exit(typeof code === 'number' ? code : 1);
});

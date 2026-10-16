// Shared helpers. Zero dependencies, Node >= 20.
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export class DlmError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function toPosix(p) {
  return p.split(sep).join('/');
}

export function rel(root, p) {
  return toPosix(relative(root, p));
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

/** Write a temp file -> fsync -> rename. The implementation of AGENTS.md hard rule 5; all state files go through here. */
export function atomicWrite(path, data) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function readJson(path, fallback) {
  if (!existsSync(path)) {
    if (fallback !== undefined) return fallback;
    throw new DlmError(`找不到 ${path}`);
  }
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new DlmError(`${path} 不是合法 JSON:${e.message}`);
  }
}

export function stableJson(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

export function writeJson(path, obj) {
  atomicWrite(path, stableJson(obj));
}

/** Create a lock file with O_EXCL; if the holder's pid is dead, treat it as a stale lock and take over. */
export function withLock(lockPath, fn, { timeoutMs = 10000 } = {}) {
  ensureDir(dirname(lockPath));
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = NaN;
      try {
        holder = Number(readFileSync(lockPath, 'utf8'));
      } catch { /* unreadable: treat as a stale lock */ }
      if (!Number.isFinite(holder) || !pidAlive(holder)) {
        try { unlinkSync(lockPath); } catch { /* someone else cleaned it first */ }
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new DlmError(`拿不到鎖 ${lockPath}(持有者 pid ${holder})`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lockPath); } catch { /* already cleaned */ }
  }
}

export function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** glob -> RegExp. Supports `**`, `*`, `?`; paths are always posix. */
export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

const globCache = new Map();
export function matchGlob(path, glob) {
  let re = globCache.get(glob);
  if (!re) {
    re = globToRegex(glob);
    globCache.set(glob, re);
  }
  return re.test(path);
}

export function matchAny(path, globs) {
  return (globs ?? []).some((g) => matchGlob(path, g));
}

/** The fixed prefix of a glob (the directory before the first wildcard), used to decide whether one scope contains another. */
export function globPrefix(glob) {
  const idx = glob.search(/[*?]/);
  const head = idx < 0 ? glob : glob.slice(0, idx);
  return head.includes('/') ? head.slice(0, head.lastIndexOf('/') + 1) : head;
}

/**
 * Environment for child processes: drop the parent-process context variables that change the child's behavior.
 * Example: when dlm runs under `node --test`, NODE_TEST_CONTEXT makes the worker's `node --test` silently skip all tests and exit 0 (false green).
 */
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  // A value of empty string = clear this variable (on an account switch, clearing it overrides the key in the account directory; see accounts.mjs)
  for (const [k, v] of Object.entries(extra ?? {})) if (v === '') delete env[k];
  return env;
}

/** Run through a shell and return the exit code and output. Never throws; on timeout returns code=124. Only for dlm's own commands or commands the user has approved. */
export function run(cmd, opts = {}) {
  return runArgv('sh', ['-c', cmd], opts);
}

/**
 * Run argv directly without a shell. Strings from a worker may only go this way: newlines, quotes and `;` are just words inside an argument,
 * and are never treated as a second command. Never throws; on timeout returns code=124.
 */
export function runArgv(file, args, { cwd, env, timeoutMs = 10 * 60 * 1000, input, exactEnv = false } = {}) {
  const started = Date.now();
  const r = spawnSync(file, args, {
    cwd,
    // exactEnv: pass only the listed variables (for the srt sandbox), do not inherit the whole host environment
    env: exactEnv ? env : childEnv(env),
    encoding: 'utf8',
    timeout: timeoutMs,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
  return {
    code: timedOut ? 124 : (r.status ?? (r.error?.code === 'ENOENT' ? 127 : 1)),
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? (r.error ? String(r.error) : ''),
    ms: Date.now() - started,
    timedOut,
  };
}

/**
 * Non-waiting lock: if acquired, return the release function; if someone else (a live pid) holds it, return null. A dead holder is treated as a stale lock and taken over.
 * Acquiring it again in the same process also returns null: the lock guards against concurrency and is not reentrant.
 */
export function tryLock(lockPath) {
  ensureDir(dirname(lockPath));
  for (let i = 0; i < 3; i++) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(lockPath, 'utf8').trim() === String(process.pid)) unlinkSync(lockPath);
        } catch { /* already cleaned */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockHolder(lockPath)) return null;
      try { unlinkSync(lockPath); } catch { /* someone else cleaned it first */ }
    }
  }
  return null;
}

/** The pid in the lock file; null if the file is missing or the holder is dead. */
export function lockHolder(lockPath) {
  let pid = NaN;
  try {
    pid = Number(readFileSync(lockPath, 'utf8').trim());
  } catch {
    return null;
  }
  return Number.isFinite(pid) && pidAlive(pid) ? pid : null;
}

/**
 * Untrusted text (worker reports, model output, git output) must always be wrapped with this when shown to Front.
 * <untrusted / </untrusted inside the body are escaped, so a worker cannot close the fence early and pretend what follows was said by dlm.
 */
export function fenceUntrusted(source, text) {
  const esc = (s) => String(s ?? '').replace(/<(\/?)(untrusted)/gi, '&lt;$1$2');
  const src = esc(source).replace(/"/g, "'");
  return `<untrusted source="${src}">\n${esc(text)}\n</untrusted>`;
}

export function tail(text, maxChars = 2000) {
  if (!text) return '';
  return text.length <= maxChars ? text : `…(截斷 ${text.length - maxChars} 字)\n${text.slice(-maxChars)}`;
}

export function listFiles(root, { skip = ['.git', 'node_modules'] } = {}) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirWithTypes(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(rel(root, p));
    }
  };
  walk(root);
  return out.sort();
}

import { readdirSync } from 'node:fs';
function readdirWithTypes(dir) {
  return readdirSync(dir, { withFileTypes: true });
}

export function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function removePath(p) {
  rmSync(p, { recursive: true, force: true });
}

export function slug(id) {
  return id.replace(/[^A-Za-z0-9.-]+/g, '--');
}

export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

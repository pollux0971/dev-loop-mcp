// 共用工具。零依賴,Node >= 20。
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

/** 寫暫存檔 → fsync → rename。AGENTS.md 硬規則 5 的實作,所有狀態檔都走這裡。 */
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

/** 以 O_EXCL 建鎖檔;持有者 pid 已死就視為殘鎖並接手。 */
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
      } catch { /* 讀不到就當殘鎖 */ }
      if (!Number.isFinite(holder) || !pidAlive(holder)) {
        try { unlinkSync(lockPath); } catch { /* 別人先清了 */ }
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
    try { unlinkSync(lockPath); } catch { /* 已被清掉 */ }
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

/** glob → RegExp。支援 `**`、`*`、`?`;路徑一律 posix。 */
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

/** glob 的固定前綴(第一個萬用字元之前的目錄),用來判斷範圍包含關係。 */
export function globPrefix(glob) {
  const idx = glob.search(/[*?]/);
  const head = idx < 0 ? glob : glob.slice(0, idx);
  return head.includes('/') ? head.slice(0, head.lastIndexOf('/') + 1) : head;
}

/**
 * 子程序的環境:拿掉會改變子程序行為的父程序情境變數。
 * 例:dlm 在 `node --test` 底下跑時,NODE_TEST_CONTEXT 會讓 worker 的 `node --test` 默默跳過全部測試並 exit 0(假綠)。
 */
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  // 值是空字串 = 要清掉這個變數(帳號切換時清掉會蓋過帳號目錄的金鑰,見 accounts.mjs)
  for (const [k, v] of Object.entries(extra ?? {})) if (v === '') delete env[k];
  return env;
}

/** 以 shell 執行並回傳退出碼與輸出。永不丟例外;逾時回 code=124。只給 dlm 自己或使用者批准過的指令用。 */
export function run(cmd, opts = {}) {
  return runArgv('sh', ['-c', cmd], opts);
}

/**
 * 不經 shell 直接執行 argv。worker 給的字串只能走這條:換行、引號、`;` 都只是參數裡的字,
 * 永遠不會被當成第二條指令。永不丟例外;逾時回 code=124。
 */
export function runArgv(file, args, { cwd, env, timeoutMs = 10 * 60 * 1000, input, exactEnv = false } = {}) {
  const started = Date.now();
  const r = spawnSync(file, args, {
    cwd,
    // exactEnv:只給明列的變數(srt 沙箱用),不整包繼承主機環境
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
 * 不等待的鎖:拿到就回傳釋放函式,別人(活著的 pid)拿著就回 null。持有者已死視為殘鎖並接手。
 * 同一個程序重複拿也回 null:鎖是防並發,不是可重入的。
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
        } catch { /* 已被清掉 */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockHolder(lockPath)) return null;
      try { unlinkSync(lockPath); } catch { /* 別人先清了 */ }
    }
  }
  return null;
}

/** 鎖檔裡的 pid;檔不在或持有者已死回 null。 */
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
 * 不可信文字(worker 報告、模型輸出、git 輸出)要給 Front 看時一律用這個包起來。
 * 內文裡的 <untrusted / </untrusted 會被跳脫,worker 沒辦法提前關閉圍欄、假裝後面是 dlm 說的話。
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

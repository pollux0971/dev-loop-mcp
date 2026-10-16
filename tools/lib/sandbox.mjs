// dlm 在主機上執行「專案程式碼」(worker、驗收、證據重跑、合併 gate、Critic)的唯一入口。
//
// v4.1 只剩一種執行方式:在沒有 .git 的副本(或 merge-tree)裡以 `sh -c` 跑,程式以你的身分在主機上執行。
// v4.0 的容器沙箱(docker / podman / srt)實跑沒用到,已移除;要加回來時從這裡接(profile 參數保留著)。
//
//   profile  在哪裡跑
//   worker   沙箱副本(.dlm/sandboxes/<id>,沒有 .git)
//   verify   用完即丟的副本;原 worktree 不動
//   gates    merge-tree(用完即丟)
//   critic   交件分支的 worktree
import { spawn } from 'node:child_process';
import {
  closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { childEnv, ensureDir, runArgv, sha256, toPosix } from './util.mjs';

export const NO_SANDBOX_WARNING = 'worker 寫的程式(測試、步驟定義、gate)直接在你的主機上、以你的身分執行,讀得到你的家目錄(見 docs/dlm/SECURITY.md)';

/**
 * 組出實際要執行的 argv:`sh -c cmd`。
 * 沙箱副本與驗收副本放在專案的 .dlm/ 底下、沒有 .git;不設 GIT_CEILING_DIRECTORIES 的話,裡面跑的
 * `git rev-parse --show-toplevel`(gate 包的 _root.ts 就靠它)會往上找到外層主 repo,把 ROOT 解析錯,
 * 看不到 worker 新寫的步驟檔(實測:dry-run 誤報 undefined、測試棒每次都被退回)。
 */
export function sandboxCommand(config, profile, cmd, opts = {}) {
  const env = opts.cwd ? { GIT_CEILING_DIRECTORIES: dirname(resolve(opts.cwd)), ...opts.env } : opts.env;
  return { file: 'sh', args: ['-c', cmd], env: childEnv(env) };
}

/** 同步執行。永不丟例外;逾時回 code=124。 */
export function sandboxExec(config, profile, cmd, { cwd, env, timeoutMs, input } = {}) {
  const c = sandboxCommand(config, profile, cmd, { cwd, env });
  // c.env 已經是完整的環境(childEnv 過、清掉了要清的變數);再 childEnv 一次會把清掉的又從 process.env 補回來
  return runArgv(c.file, c.args, { cwd, env: c.env, timeoutMs, input, exactEnv: true });
}

/** 背景啟動(worker)。回傳 { pid }:lease 到期時要收掉。 */
export function sandboxSpawn(config, profile, cmd, { cwd, env, logPath }) {
  const c = sandboxCommand(config, profile, cmd, { cwd, env });
  const fd = openSync(logPath, 'a');
  try {
    const child = spawn(c.file, c.args, { cwd, detached: true, stdio: ['ignore', fd, fd], env: c.env });
    child.on('error', () => { /* 啟動失敗由 harvest 依「沒有 pid / log」判 infra */ });
    child.unref();
    return { pid: child.pid ?? null };
  } finally {
    closeSync(fd);
  }
}

export function killSandboxed({ pid }) {
  if (pid) for (const p of [-pid, pid]) { try { process.kill(p, 'SIGTERM'); } catch { /* 已結束 */ } }
}

// ------------------------------------------------------------------ 工作目錄副本與依賴

/** node_modules 用 symlink 指到根目錄的(收件時比對指紋,見 nodeModulesFingerprint)。 */
export function linkDeps(root, dir) {
  const src = join(root, 'node_modules');
  const dst = join(dir, 'node_modules');
  if (existsSync(src) && !existsSync(dst)) {
    try { symlinkSync(src, dst, 'dir'); } catch { /* 沒有權限就算了,gate 會自己報錯 */ }
  }
}

/**
 * node_modules 的指紋(路徑 + 大小 + mtime)。worker 透過 symlink 寫得到根目錄的 node_modules,
 * 例如把 vitest 改成永遠回報通過;派工前後比對,不一致就判 FAIL。
 */
export function nodeModulesFingerprint(root) {
  const base = join(root, 'node_modules');
  if (!existsSync(base)) return null;
  const parts = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      // 工具自己的快取(vitest 載入設定檔時會建 node_modules/.vite-temp,不跳過的話每個跑過 vitest 的 worker 都被判 sandbox-escape)
      if (['.cache', '.vite', '.vite-temp', '.vitest'].includes(e.name)) continue;
      let st;
      try { st = lstatSync(p); } catch { continue; }
      parts.push(`${toPosix(relative(base, p))}\0${st.size}\0${Math.floor(st.mtimeMs)}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(base);
  return sha256(parts.sort().join('\n'));
}

/** 把一棵樹(不含 .git、node_modules)複製到 dest。回傳 dest。 */
export function copyTree(src, dest, { skip = ['.git', 'node_modules'] } = {}) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    if (skip.includes(name)) continue;
    cpSync(join(src, name), join(dest, name), { recursive: true, verbatimSymlinks: true });
  }
  return dest;
}

/**
 * v4.5:測試框架跑一次就會在任何一層留下的快取(Python 的 __pycache__ 等)。不收、不算變動:
 * 既有 Python 專案的 worker 跑一次測試,每一棒都被判「寫到範圍外」(實測)。它們不同步回 worktree,所以藏東西也沒用。
 */
export const TOOL_CACHE_DIRS = ['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.hypothesis'];

/** 檔案清單 + 內容 sha(不追 symlink;symlink 記它指向哪裡)。 */
export function treeManifest(dir, { skip = ['node_modules'], skipPaths = [] } = {}) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const relPath = toPosix(relative(dir, p));
      if (d === dir && skip.includes(e.name)) {
        // 頂層 node_modules:只允許是我們建的 symlink
        const st = lstatSync(p);
        if (!st.isSymbolicLink() && !(st.isDirectory() && readdirSync(p).length === 0)) out[`${relPath}/`] = 'replaced';
        continue;
      }
      if (skipPaths.includes(relPath)) continue;
      if (TOOL_CACHE_DIRS.includes(e.name) && e.isDirectory()) continue;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[relPath] = `link:${readlinkSync(p)}`;
      else if (st.isDirectory()) walk(p);
      else if (st.isFile()) out[relPath] = sha256(readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

export function diffManifest(before, after) {
  const changed = [];
  for (const [p, sha] of Object.entries(after)) if (before[p] !== sha) changed.push(p);
  for (const p of Object.keys(before)) if (!(p in after)) changed.push(p);
  return [...new Set(changed)].sort();
}

/** 臨時副本(驗證用):每次 runVerify 一份,用完刪掉。 */
export function scratchCopy(root, src, label) {
  const dest = join(root, '.dlm', 'scratch', `${label}-${process.pid}-${Date.now()}`);
  copyTree(src, dest, { skip: ['.git', 'node_modules'] });
  return dest;
}

export function removeTree(p) {
  rmSync(p, { recursive: true, force: true });
}

export function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export function ensureSandboxDirs(root) {
  ensureDir(join(root, '.dlm', 'sandboxes'));
  ensureDir(join(root, '.dlm', 'manifests'));
}

// The only entry point where dlm runs "project code" (worker, acceptance, evidence rerun, merge gate, Critic) on the host.
//
// v4.1 has only one way to run: in a copy without .git (or a merge tree), using `sh -c`; the code runs on the host as you.
// The v4.0 container sandbox (docker / podman / srt) was never used in real runs and was removed; to add it back, hook in here (the profile parameter is kept).
//
//   profile  where it runs
//   worker   sandbox copy (.dlm/sandboxes/<id>, no .git)
//   verify   throwaway copy; the original worktree is untouched
//   gates    merge tree (throwaway)
//   critic   worktree of the handed-in branch
import { spawn } from 'node:child_process';
import {
  closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { childEnv, ensureDir, runArgv, sha256, toPosix } from './util.mjs';

export const NO_SANDBOX_WARNING = 'worker 寫的程式(測試、步驟定義、gate)直接在你的主機上、以你的身分執行,讀得到你的家目錄(見 docs/dlm/SECURITY.md)';

/**
 * Build the argv that actually runs: `sh -c cmd`.
 * Sandbox copies and acceptance copies live under the project's .dlm/ and have no .git. Without GIT_CEILING_DIRECTORIES, the
 * `git rev-parse --show-toplevel` run inside (which the gate's _root.ts relies on) would search upward to the outer main repo and resolve ROOT wrongly,
 * so it could not see the step files the worker just wrote (seen in a real run: dry-run falsely reported undefined, and the test leg was sent back every time).
 */
export function sandboxCommand(config, profile, cmd, opts = {}) {
  const env = opts.cwd ? { GIT_CEILING_DIRECTORIES: dirname(resolve(opts.cwd)), ...opts.env } : opts.env;
  return { file: 'sh', args: ['-c', cmd], env: childEnv(env) };
}

/** Run synchronously. Never throws; on timeout returns code=124. */
export function sandboxExec(config, profile, cmd, { cwd, env, timeoutMs, input } = {}) {
  const c = sandboxCommand(config, profile, cmd, { cwd, env });
  // c.env is already the full environment (passed through childEnv, with the variables to clear removed); running childEnv again would refill the cleared ones from process.env
  return runArgv(c.file, c.args, { cwd, env: c.env, timeoutMs, input, exactEnv: true });
}

/** Start in the background (worker). Returns { pid }: it must be cleaned up when the lease expires. */
export function sandboxSpawn(config, profile, cmd, { cwd, env, logPath }) {
  const c = sandboxCommand(config, profile, cmd, { cwd, env });
  const fd = openSync(logPath, 'a');
  try {
    const child = spawn(c.file, c.args, { cwd, detached: true, stdio: ['ignore', fd, fd], env: c.env });
    child.on('error', () => { /* on a failed start, harvest decides infra from "no pid / log" */ });
    child.unref();
    return { pid: child.pid ?? null };
  } finally {
    closeSync(fd);
  }
}

export function killSandboxed({ pid }) {
  if (pid) for (const p of [-pid, pid]) { try { process.kill(p, 'SIGTERM'); } catch { /* already exited */ } }
}

// ------------------------------------------------------------------ working directory copy and dependencies

/** node_modules is a symlink to the one in the root (compare fingerprints when collecting; see nodeModulesFingerprint). */
export function linkDeps(root, dir) {
  const src = join(root, 'node_modules');
  const dst = join(dir, 'node_modules');
  if (existsSync(src) && !existsSync(dst)) {
    try { symlinkSync(src, dst, 'dir'); } catch { /* no permission: give up, the gate will report the error itself */ }
  }
}

/**
 * Fingerprint of node_modules (path + size + mtime). The worker can write the root node_modules through the symlink,
 * for example changing vitest to always report pass; compare before and after dispatch, and a mismatch is judged FAIL.
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
      // The tool's own cache (when vitest loads its config it creates node_modules/.vite-temp; if not skipped, every worker that ran vitest would be judged sandbox-escape)
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

/** Copy a tree (without .git and node_modules) to dest. Returns dest. */
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
 * v4.5: caches that a test framework leaves at any level after one run (Python's __pycache__ etc.). Not collected and not counted as a change:
 * a worker on an existing Python project ran the tests once and every leg was judged "wrote outside scope" (seen in a real run). They are not synced back to the worktree, so hiding things there is useless.
 */
export const TOOL_CACHE_DIRS = ['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.hypothesis'];

/** File list + content sha (symlinks are not followed; for a symlink record where it points). */
export function treeManifest(dir, { skip = ['node_modules'], skipPaths = [] } = {}) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const relPath = toPosix(relative(dir, p));
      if (d === dir && skip.includes(e.name)) {
        // Top-level node_modules: only allowed if it is the symlink we made
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

/** Temporary copy (for verification): one per runVerify, deleted after use. */
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

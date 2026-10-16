import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DlmError, atomicWrite, ensureDir, removePath, run, sha256 } from './util.mjs';

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 *  * Every git command dlm runs has hooks disabled. A worktree shares .git/hooks with the root: a worker could put a post-merge there,
 *  * and the next time dlm merges in the root it would run it on the host. dlm's own commit / merge needs no hook at all.
 */
export const NO_HOOKS = '-c core.hooksPath=/dev/null';

export function git(cwd, args, { allowFail = false } = {}) {
  const r = run(`git ${NO_HOOKS} ${args}`, { cwd, timeoutMs: 5 * 60 * 1000 });
  if (r.code !== 0 && !allowFail) throw new DlmError(`git ${args} 失敗(${cwd}):\n${r.stderr || r.stdout}`);
  return r;
}

/**
 *  * Fingerprint of the shared git config (.git/config and config.worktree). Filters, diff drivers, core.fsmonitor and the like live here,
 *  * and a worker that changes it could make dlm's git commands run arbitrary programs; so each tick compares at the start, and on a mismatch it halts and waits for the user to look.
 */
export function gitConfigFingerprint(root) {
  const dirOut = git(root, 'rev-parse --git-common-dir').stdout.trim();
  const common = isAbsolute(dirOut) ? dirOut : join(root, dirOut);
  const parts = ['config', 'config.worktree'].map((f) => {
    const p = join(common, f);
    return `${f}\0${existsSync(p) ? readFileSync(p, 'utf8') : ''}`;
  });
  return sha256(parts.join('\0'));
}

const baselinePath = (root) => join(root, '.dlm', 'git-config.sha256');

export function readConfigBaseline(root) {
  const p = baselinePath(root);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}

/** The user has confirmed the current git config (the first tick, or the user says continue after a halt caused by a config change). */
export function writeConfigBaseline(root) {
  const fp = gitConfigFingerprint(root);
  atomicWrite(baselinePath(root), `${fp}\n`);
  return fp;
}

export const out = (cwd, args) => git(cwd, args).stdout.trim();

export function currentBranch(root) {
  return out(root, 'rev-parse --abbrev-ref HEAD');
}

export function headSha(cwd, ref = 'HEAD') {
  return out(cwd, `rev-parse ${q(ref)}`);
}

export function branchExists(root, branch) {
  return git(root, `rev-parse --verify --quiet ${q(`refs/heads/${branch}`)}`, { allowFail: true }).code === 0;
}

/** Whether tracked files have uncommitted changes (can exclude paths dlm manages itself). */
export function dirtyTracked(root, ignorePrefixes = []) {
  // Must not trim: the status column at the start of each porcelain line may be a space (" M path")
  const lines = git(root, 'status --porcelain --untracked-files=no').stdout.split('\n').filter((l) => l.trim());
  return lines
    .map((l) => l.slice(3))
    .filter((p) => !ignorePrefixes.some((pre) => p === pre || p.startsWith(pre)));
}

export function addWorktree(root, path, branch, base) {
  ensureDir(join(path, '..'));
  if (existsSync(path)) return 'exists';
  if (branchExists(root, branch)) git(root, `worktree add ${q(path)} ${q(branch)}`);
  else git(root, `worktree add -b ${q(branch)} ${q(path)} ${q(base)}`);
  return 'created';
}

export function removeWorktree(root, path) {
  if (existsSync(path)) git(root, `worktree remove --force ${q(path)}`, { allowFail: true });
  removePath(path);
  git(root, 'worktree prune', { allowFail: true });
}

export function diffNames(root, base, branch) {
  const r = git(root, `diff --name-only ${q(`${base}...${branch}`)}`);
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Which files changed between two commits (not merge-base). */
export function changedBetween(root, a, b) {
  const r = git(root, `diff --name-only ${q(a)} ${q(b)}`);
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

export function diffText(root, base, branch, maxChars = 20000) {
  const t = git(root, `diff ${q(`${base}...${branch}`)}`).stdout;
  return t.length > maxChars ? `${t.slice(0, maxChars)}\n…(diff 截斷)` : t;
}

export function behindCount(root, branch, base) {
  const r = git(root, `rev-list --count ${q(`${branch}..${base}`)}`, { allowFail: true });
  return r.code === 0 ? Number(r.stdout.trim()) : 0;
}

export function isAncestor(root, a, b) {
  return git(root, `merge-base --is-ancestor ${q(a)} ${q(b)}`, { allowFail: true }).code === 0;
}

export function commitAll(cwd, paths, message) {
  git(cwd, `add -A -- ${paths.map(q).join(' ')}`);
  const staged = git(cwd, 'diff --cached --quiet', { allowFail: true });
  if (staged.code === 0) return null;
  git(cwd, `-c user.name=dlm -c user.email=dlm@localhost commit --quiet -m ${q(message)}`);
  return headSha(cwd);
}

export function mergeNoFf(root, branch, message) {
  const r = git(root, `-c user.name=dlm -c user.email=dlm@localhost merge --no-ff --no-edit -m ${q(message)} ${q(branch)}`, { allowFail: true });
  if (r.code !== 0) {
    git(root, 'merge --abort', { allowFail: true });
    return { ok: false, output: r.stdout + r.stderr };
  }
  return { ok: true, sha: headSha(root) };
}

/**
 *  * Sync main inside the worktree: use merge, not rebase (keeps each leg's trail); always --no-ff,
 *  * otherwise when the branch is behind it would fast-forward, main's commits would mix into this leg's first-parent chain, and be counted as the worker's changes. On a conflict, give up and report.
 */
export function syncWithMain(worktree, main) {
  const r = git(worktree, `-c user.name=dlm -c user.email=dlm@localhost merge --no-ff --no-edit ${q(main)}`, { allowFail: true });
  if (r.code !== 0) {
    git(worktree, 'merge --abort', { allowFail: true });
    return { ok: false, output: r.stdout + r.stderr };
  }
  return { ok: true };
}

/** Temp merge tree: main + candidate branch; run the full gate on this tree (branch all green != all green after merge). */
export function withMergeTree(root, dir, main, branch, fn) {
  removeWorktree(root, dir);
  git(root, `worktree add --detach ${q(dir)} ${q(main)}`);
  try {
    const m = git(dir, `-c user.name=dlm -c user.email=dlm@localhost merge --no-ff --no-edit ${q(branch)}`, { allowFail: true });
    if (m.code !== 0) return fn({ ok: false, output: m.stdout + m.stderr, dir });
    return fn({ ok: true, dir, sha: headSha(dir) });
  } finally {
    removeWorktree(root, dir);
  }
}

export function tag(root, name, ref) {
  git(root, `tag -f ${q(name)} ${q(ref)}`, { allowFail: true });
}

export function deleteBranch(root, branch) {
  git(root, `branch -D ${q(branch)}`, { allowFail: true });
}

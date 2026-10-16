import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DpError, atomicWrite, ensureDir, removePath, run, sha256 } from './util.mjs';

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * dp 跑的每一條 git 都停用 hooks。worktree 跟根目錄共用 .git/hooks:worker 在那裡放一個 post-merge,
 * 下一次 dp 在根目錄 merge 就會在主機上執行它。dp 自己的 commit / merge 不需要任何 hook。
 */
export const NO_HOOKS = '-c core.hooksPath=/dev/null';

export function git(cwd, args, { allowFail = false } = {}) {
  const r = run(`git ${NO_HOOKS} ${args}`, { cwd, timeoutMs: 5 * 60 * 1000 });
  if (r.code !== 0 && !allowFail) throw new DpError(`git ${args} 失敗(${cwd}):\n${r.stderr || r.stdout}`);
  return r;
}

/**
 * 共用 git 設定的指紋(.git/config 與 config.worktree)。filter、diff driver、core.fsmonitor 之類都在這裡,
 * worker 改了它就能讓 dp 的 git 指令執行任意程式;所以每個 tick 開頭比對,不一致就停機等使用者看。
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

const baselinePath = (root) => join(root, '.dp', 'git-config.sha256');

export function readConfigBaseline(root) {
  const p = baselinePath(root);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}

/** 使用者確認過現在的 git 設定(第一次 tick、或因設定變更停機後使用者說繼續)。 */
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

/** 追蹤中的檔案有沒有未 commit 的變更(可排除 dp 自己管理的路徑)。 */
export function dirtyTracked(root, ignorePrefixes = []) {
  // 不能 trim:porcelain 每行開頭的狀態欄可能是空白(" M path")
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

/** 兩個 commit 之間(不是 merge-base)改了哪些檔。 */
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
  git(cwd, `-c user.name=dp -c user.email=dp@localhost commit --quiet -m ${q(message)}`);
  return headSha(cwd);
}

export function mergeNoFf(root, branch, message) {
  const r = git(root, `-c user.name=dp -c user.email=dp@localhost merge --no-ff --no-edit -m ${q(message)} ${q(branch)}`, { allowFail: true });
  if (r.code !== 0) {
    git(root, 'merge --abort', { allowFail: true });
    return { ok: false, output: r.stdout + r.stderr };
  }
  return { ok: true, sha: headSha(root) };
}

/**
 * 在 worktree 裡同步主線:用 merge,不 rebase(保留每一棒的軌跡);一律 --no-ff,
 * 否則分支落後時會快轉,主線的 commit 會混進這一棒的 first-parent 鏈,被當成 worker 改的。衝突就放棄並回報。
 */
export function syncWithMain(worktree, main) {
  const r = git(worktree, `-c user.name=dp -c user.email=dp@localhost merge --no-ff --no-edit ${q(main)}`, { allowFail: true });
  if (r.code !== 0) {
    git(worktree, 'merge --abort', { allowFail: true });
    return { ok: false, output: r.stdout + r.stderr };
  }
  return { ok: true };
}

/** 臨時合併樹:main + 候選分支,在這棵樹上跑全 gate(分支全綠 ≠ 合併後全綠)。 */
export function withMergeTree(root, dir, main, branch, fn) {
  removeWorktree(root, dir);
  git(root, `worktree add --detach ${q(dir)} ${q(main)}`);
  try {
    const m = git(dir, `-c user.name=dp -c user.email=dp@localhost merge --no-ff --no-edit ${q(branch)}`, { allowFail: true });
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

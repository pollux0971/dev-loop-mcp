// Install and upgrade go through one pipeline (replacing v1's two: npx init + sync-gates.sh).
// Ownership is decided by the sha in .dlm-install.json:
//   does not exist -> create; exists and sha equals the last install -> may overwrite; exists but was modified -> conflict.
// If there is even one conflict, no file in the batch is written. Seed-only files (the user's project content) are created only the first time and never overwritten after that.
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectProject } from './brownfield.mjs';
import { loadDag } from './dag.mjs';
import { LEGACY, finishMigration, lockForMigration, migrateProject, migrationBlocker, migrationPlan } from './legacy.mjs';
import { readEvents } from './ledger.mjs';
import { renderAll, writeRendered } from './render.mjs';
import { replay } from './state.mjs';
import { DlmError, atomicWrite, listFiles, matchAny, readJson, run, runArgv, sha256, writeJson } from './util.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = '.dlm-install.json';

function readVersion() {
  return readFileSync(join(REPO_ROOT, 'VERSION'), 'utf8').trim();
}

/**
 * v4.5: the template has only the files that a "from-scratch TypeScript / vitest / cucumber project" uses. They are not installed into an existing project that already has code:
 * a Python project would get an extra package.json, tsconfig and a pile of .ts gate scripts, which only make the gate run the wrong things; a Node project's package.json is its own
 * (seed does not overwrite), so the template's scripts/*.ts are not wired in and would only fight the project's own scripts/ for names.
 */
export const NODE_TEMPLATE = [
  'package.json', 'tsconfig.json', 'cucumber.js', 'vitest.config.ts', 'vitest.scripts.config.ts', 'stryker.config.json',
  'scripts/**', 'features/steps/*.ts',
];

/** Returns [{ dest, content(Buffer), seed }]. With profile = 'existing' it does not include NODE_TEMPLATE. */
export function plannedFiles(name, { profile = 'full' } = {}) {
  const payload = join(REPO_ROOT, 'payload');
  const seedGlobs = readFileSync(join(payload, '.dlm-seed-only'), 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  const out = [];
  for (const f of listFiles(payload)) {
    if (f === '.dlm-seed-only') continue;
    let content = readFileSync(join(payload, f));
    const seed = matchAny(f, seedGlobs);
    if (seed && name && /\.(md|json)$/.test(f)) content = Buffer.from(content.toString('utf8').replaceAll('{{PROJECT_NAME}}', name));
    if (profile === 'existing' && matchAny(f, NODE_TEMPLATE)) continue;
    out.push({ dest: f === 'gitignore' ? '.gitignore' : f, content, seed });
  }
  for (const f of listFiles(join(REPO_ROOT, 'tools'))) {
    // tools/dp.mjs only forwards to dlm.mjs for setups from before 4.8.0; a new project has nothing that calls it
    if (f === 'dp.mjs') continue;
    out.push({ dest: `tools/${f}`, content: readFileSync(join(REPO_ROOT, 'tools', f)), seed: false });
  }
  return out;
}

function plan(target, files, manifest) {
  const actions = [];
  const conflicts = [];
  for (const f of files) {
    const p = join(target, f.dest);
    const newSha = sha256(f.content);
    if (!existsSync(p)) { actions.push({ ...f, op: 'create', sha: newSha }); continue; }
    const cur = sha256(readFileSync(p));
    if (f.seed) { actions.push({ ...f, op: 'keep', sha: cur }); continue; }
    if (cur === newSha) { actions.push({ ...f, op: 'same', sha: newSha }); continue; }
    if (manifest?.files?.[f.dest] === cur) { actions.push({ ...f, op: 'update', sha: newSha }); continue; }
    conflicts.push(`${f.dest}(你改過,或不是 dlm 裝的)`);
  }
  const removals = [];
  if (manifest) {
    const planned = new Set(files.map((f) => f.dest));
    for (const [dest, sha] of Object.entries(manifest.files)) {
      if (planned.has(dest) || !existsSync(join(target, dest))) continue;
      if (sha256(readFileSync(join(target, dest))) === sha) removals.push(dest);
      else conflicts.push(`${dest}(新版已移除,但你改過)`);
    }
  }
  return { actions, conflicts, removals };
}

function write(target, actions, removals, profile = 'full') {
  for (const a of actions) if (a.op === 'create' || a.op === 'update') atomicWrite(join(target, a.dest), a.content);
  for (const r of removals) unlinkSync(join(target, r));
  const files = {};
  for (const a of actions) if (!a.seed) files[a.dest] = a.sha;
  writeJson(join(target, MANIFEST), { version: readVersion(), ...(profile !== 'full' ? { profile } : {}), files });
}

/** Lines dlm needs in .gitignore (an existing project's own .gitignore is not overwritten by the template; missing lines are appended at the end). */
const DLM_IGNORES = ['.dlm/', '*.tmp-*'];
function ensureIgnores(dir) {
  const p = join(dir, '.gitignore');
  const cur = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const have = new Set(cur.split('\n').map((l) => l.trim()));
  const missing = DLM_IGNORES.filter((l) => !have.has(l));
  if (!missing.length) return false;
  atomicWrite(p, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}# dlm(dev-loop-mcp)\n${missing.join('\n')}\n`);
  return true;
}

const RENDERED = ['STATUS.md', 'DECISIONS.md', 'standalone.json'];

/**
 * Commit dlm's files: the ones written this time, plus the ones dlm plans that are not yet in git (install manifest, generated files and .gitignore count too).
 * Commit only these paths (git commit -- <paths>), without touching anything else the user has staged. Skipped if this is not a git repo.
 * v4.7.3 real run: after installing dlm into an existing project (already in git), tools/, AGENTS.md and .claude/ were not in git; the full gate before merge, in a temp tree of main + branch,
 * ran node tools/dlm.mjs check and could not find dlm, so the dev leg was red every time and blocked after three.
 */
export function commitDlmFiles(dir, message, { touched = [], profile = 'full' } = {}) {
  if (!existsSync(join(dir, '.git'))) return null;
  const g = (args) => runArgv('git', args, { cwd: dir });
  const tracked = new Set(g(['ls-files', '-z']).stdout.split('\0').filter(Boolean));
  const planned = [...plannedFiles(null, { profile }).map((f) => f.dest), MANIFEST, ...RENDERED, '.gitignore'];
  const paths = [...new Set([...touched, ...planned.filter((f) => existsSync(join(dir, f)) && !tracked.has(f))])]
    .filter((f) => existsSync(join(dir, f)) || tracked.has(f));
  if (!paths.length) return null;
  g(['add', '-A', '--', ...paths]);
  if (g(['diff', '--cached', '--quiet', '--', ...paths]).code === 0) return null;
  const r = g(['-c', 'user.name=dlm', '-c', 'user.email=dlm@localhost', 'commit', '--quiet', '-m', message, '--', ...paths]);
  if (r.code !== 0) throw new DlmError(`commit dlm 的檔失敗:${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return g(['rev-parse', 'HEAD']).stdout.trim();
}

export function init(target, { name, existing = false, commit = true } = {}) {
  const dir = resolve(target);
  const entries = existsSync(dir) ? readdirSync(dir).filter((e) => e !== '.git') : [];
  if (entries.length && !existing) throw new DlmError(`${dir} 不是空目錄。既有專案請加 --existing(只補缺的檔,衝突就一個都不寫)`);
  if (existsSync(join(dir, MANIFEST))) throw new DlmError(`${dir} 已經裝過 dlm,請用 dlm upgrade`);
  if (existsSync(join(dir, LEGACY.manifest))) throw new DlmError(`${dir} 已經裝過舊版 dp(4.8.0 以前),請用 dlm upgrade(會順便改成 dlm 的檔名)`);
  // Existing project that already has code: do not install the template's TS toolchain (the gate runs the project's own tests instead; see Brownfield in dlm setup)
  const profile = existing && entries.length && detectProject(dir).code_files > 0 ? 'existing' : 'full';
  const { actions, conflicts } = plan(dir, plannedFiles(name ?? 'my-project', { profile }), null);
  if (conflicts.length) throw new DlmError(`有 ${conflicts.length} 個同名檔內容不同,一個都沒寫:\n  - ${conflicts.join('\n  - ')}`);
  write(dir, actions, [], profile);
  const dag = loadDag(dir);
  const events = readEvents(dir);
  writeRendered(dir, renderAll(dir, dag, replay(events, dag), events));
  let git = 'existing';
  let committed = null;
  if (!existsSync(join(dir, '.git'))) {
    run('git init --quiet -b main', { cwd: dir });
    run('git add -A && git -c user.name=dlm -c user.email=dlm@localhost commit --quiet -m "dlm init"', { cwd: dir });
    git = 'initialized';
  } else {
    // v4.7.3: a project already in git used to commit nothing (see commitDlmFiles). Add .dlm/ to .gitignore, otherwise dlm's whole working directory shows up in git status
    const ignores = ensureIgnores(dir);
    const created = actions.filter((a) => a.op === 'create').map((a) => a.dest);
    if (commit) committed = commitDlmFiles(dir, 'dlm init --existing', { touched: [...created, MANIFEST, ...RENDERED, ...(ignores ? ['.gitignore'] : [])], profile });
  }
  return {
    profile,
    created: actions.filter((a) => a.op === 'create').map((a) => a.dest),
    kept: actions.filter((a) => a.op === 'keep').map((a) => a.dest),
    git,
    committed,
  };
}

/**
 * Upgrade the files dlm manages. v4.7.3: after writing, commit dlm's files (commitDlmFiles). Before, they stayed in the working directory, and the tick refused to run when it saw uncommitted changes;
 * an AI upgrading through MCP has no git, so it could only ask the user to commit in a terminal (seen in a real run). commit=false skips the commit.
 */
export function upgrade(target, { dryRun = false, commit = true } = {}) {
  const dir = resolve(target);
  // 4.8.0 renamed dp to dlm: an old project only has .dp-install.json. It is upgraded and renamed in the same commit.
  const legacy = !existsSync(join(dir, MANIFEST)) && existsSync(join(dir, LEGACY.manifest));
  const manifest = readJson(join(dir, legacy ? LEGACY.manifest : MANIFEST), null);
  if (!manifest) throw new DlmError(`${dir} 沒有 ${MANIFEST};不是 dlm 裝的專案,請先 dlm init --existing`);
  const profile = manifest.profile ?? 'full';
  let { actions, conflicts, removals } = plan(dir, plannedFiles(null, { profile }), manifest);
  if (conflicts.length) throw new DlmError(`升級衝突 ${conflicts.length} 個,一個檔都沒寫:\n  - ${conflicts.join('\n  - ')}\n把你的改動移到別的檔(或還原),再重跑`);
  const blockerNow = () => migrationBlocker(dir, [...replay(readEvents(dir), loadDag(dir)).dispatches.values()]);
  const summarize = () => ({
    from: manifest.version, to: readVersion(),
    update: actions.filter((a) => a.op === 'update').map((a) => a.dest),
    create: actions.filter((a) => a.op === 'create').map((a) => a.dest),
    remove: removals,
  });
  if (dryRun) {
    if (!legacy) return summarize();
    // the old config is renamed into place, not created from the template
    const s = summarize();
    const blocked = blockerNow();
    return { ...s, create: s.create.filter((f) => f !== 'dlm.config.json'), migrate: migrationPlan(dir), ...(blocked ? { blocked } : {}) };
  }
  if (!legacy) return finishUpgrade(dir, { actions, removals, profile, commit, summary: summarize() });

  const refuse = (why) => new DlmError(`這是 4.8.0 以前(dp)的專案,升級時要把 .dp/ 搬成 .dlm/:${why}`);
  const early = blockerNow();
  if (early) throw refuse(early);
  // hold tick.lock from here on: a tick started now would write into .dp/ while it moves
  const release = lockForMigration(dir);
  if (!release) throw refuse('有一次 tick 正在跑,等它結束再升級');
  try {
    const late = blockerNow(); // a worker may have been launched between the first check and the lock
    if (late && !/tick 正在跑/.test(late)) throw refuse(late);
    // seed-only files (config, package.json, hooks) are the user's: rename and rewrite them in place, then plan again,
    // so the new layout counts as existing and nothing of theirs is replaced by the template
    const { touched, warnings } = migrateProject(dir);
    ({ actions, conflicts, removals } = plan(dir, plannedFiles(null, { profile }), manifest));
    if (conflicts.length) throw new DlmError(`改名之後出現衝突(不應該發生):\n  - ${conflicts.join('\n  - ')}`);
    return finishUpgrade(dir, { actions, removals, profile, commit, summary: summarize(), legacy: { touched, warnings } });
  } finally {
    release();
  }
}

function finishUpgrade(dir, { actions, removals, profile, commit, summary, legacy = null }) {
  write(dir, actions, removals, profile);
  // STATUS.md and the other generated files come from the old version's templates (dp's wording, for one);
  // `dlm check` compares them with what this version renders and would fail until the next tick
  if (existsSync(join(dir, 'dag.json'))) {
    const dag = loadDag(dir);
    const events = readEvents(dir);
    writeRendered(dir, renderAll(dir, dag, replay(events, dag), events));
  }
  const migrated = [];
  if (legacy) {
    migrated.push(...legacy.touched, ...finishMigration(dir));
    if (ensureIgnores(dir)) migrated.push('.gitignore');
    summary.migrated = [...new Set(migrated)];
    if (legacy.warnings.length) summary.warnings = legacy.warnings;
    summary.note = '已從 dp 改名成 dlm。重開 Claude Code 才會用新的 hooks(重開前的 session 還在呼叫 tools/dp.mjs,它現在只轉給 tools/dlm.mjs,重開後可以刪);'
      + '這台電腦的 MCP 也要從 dev-loop-mcp 重裝一次(dlm mcp install)';
  }
  // Also commit the dlm files that are not yet in git (for projects installed into an existing project before 4.7.3, tools/ etc. were never committed; dlm doctor points here)
  const message = legacy ? `dlm upgrade ${summary.from} → ${summary.to} (rename dp → dlm)` : `dlm upgrade ${summary.from} → ${summary.to}`;
  summary.commit = commit ? commitDlmFiles(dir, message, { touched: [...summary.update, ...summary.create, ...summary.remove, MANIFEST, ...RENDERED, ...migrated], profile }) : null;
  return summary;
}

// 安裝與升級只有一條管線(取代 v1 的 npx 初始化 + sync-gates.sh 兩條)。
// 所有權用 .dlm-install.json 的 sha 判斷:
//   不存在 → 建;存在且 sha 等於上次安裝的 → 可覆蓋;存在但被改過 → 衝突。
// 只要有一個衝突,整批一個檔都不寫。seed-only 的檔(使用者的專案內容)只在第一次建立,之後永不覆蓋。
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
 * v4.5:範本裡只有「從零開始的 TypeScript / vitest / cucumber 專案」用得到的檔。裝進已經有程式的既有專案時不裝:
 * Python 專案多出 package.json、tsconfig、一堆 .ts gate 腳本,只會讓 gate 跑錯東西;Node 專案的 package.json 是它自己的
 * (seed 不覆蓋),範本的 scripts/*.ts 根本沒接上,只會跟專案自己的 scripts/ 搶名字。
 */
export const NODE_TEMPLATE = [
  'package.json', 'tsconfig.json', 'cucumber.js', 'vitest.config.ts', 'vitest.scripts.config.ts', 'stryker.config.json',
  'scripts/**', 'features/steps/*.ts',
];

/** 回傳 [{ dest, content(Buffer), seed }]。profile = 'existing' 時不含 NODE_TEMPLATE。 */
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

/** dlm 在 .gitignore 裡需要的行(既有專案自己的 .gitignore 不會被範本覆蓋,缺的補在最後)。 */
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
 * 把 dlm 的檔 commit 起來:這次寫到的、加上 dlm 規劃的檔裡還沒進 git 的(安裝清單、產生檔、.gitignore 也算)。
 * 只 commit 這些路徑(git commit -- <路徑>),不碰使用者 staged 的其他東西。不是 git repo 就不做。
 * v4.7.3 實測:既有專案(已經有 git)裝 dlm 後,tools/、AGENTS.md、.claude/ 都沒進 git;合併前的全 gate 在 main + 分支 的臨時樹
 * 跑 node tools/dlm.mjs check,找不到 dlm,實作棒每次都紅,三次後封鎖。
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
  // 已經有程式的既有專案:範本的 TS 工具鏈不裝(gate 改跑專案自己的測試,見 dlm setup 的 Brownfield)
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
    // v4.7.3:已經有 git 的專案以前什麼都不 commit(見 commitDlmFiles)。.gitignore 補上 .dlm/,不然 dlm 的工作目錄整個出現在 git status
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
 * 升級 dlm 管理的檔。v4.7.3:寫完就把 dlm 的檔 commit(commitDlmFiles)。以前留在工作目錄,tick 看到有未 commit 的變更就拒絕執行;
 * 從 MCP 升級的 AI 沒有 git 可用,只能請使用者自己去終端機 commit(實測)。commit=false 可以不 commit。
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
  // 順便把 dlm 的檔裡還沒進 git 的也 commit(4.7.3 以前裝進既有專案的,tools/ 等都沒 commit;dlm doctor 會指到這裡)
  const message = legacy ? `dlm upgrade ${summary.from} → ${summary.to} (rename dp → dlm)` : `dlm upgrade ${summary.from} → ${summary.to}`;
  summary.commit = commit ? commitDlmFiles(dir, message, { touched: [...summary.update, ...summary.create, ...summary.remove, MANIFEST, ...RENDERED, ...migrated], profile }) : null;
  return summary;
}

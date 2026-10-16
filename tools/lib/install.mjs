// 安裝與升級只有一條管線(取代 v1 的 npx 初始化 + sync-gates.sh 兩條)。
// 所有權用 .dp-install.json 的 sha 判斷:
//   不存在 → 建;存在且 sha 等於上次安裝的 → 可覆蓋;存在但被改過 → 衝突。
// 只要有一個衝突,整批一個檔都不寫。seed-only 的檔(使用者的專案內容)只在第一次建立,之後永不覆蓋。
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectProject } from './brownfield.mjs';
import { loadDag } from './dag.mjs';
import { readEvents } from './ledger.mjs';
import { renderAll, writeRendered } from './render.mjs';
import { replay } from './state.mjs';
import { DpError, atomicWrite, listFiles, matchAny, readJson, run, sha256, writeJson } from './util.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = '.dp-install.json';

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
  const seedGlobs = readFileSync(join(payload, '.dp-seed-only'), 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  const out = [];
  for (const f of listFiles(payload)) {
    if (f === '.dp-seed-only') continue;
    let content = readFileSync(join(payload, f));
    const seed = matchAny(f, seedGlobs);
    if (seed && name && /\.(md|json)$/.test(f)) content = Buffer.from(content.toString('utf8').replaceAll('{{PROJECT_NAME}}', name));
    if (profile === 'existing' && matchAny(f, NODE_TEMPLATE)) continue;
    out.push({ dest: f === 'gitignore' ? '.gitignore' : f, content, seed });
  }
  for (const f of listFiles(join(REPO_ROOT, 'tools'))) out.push({ dest: `tools/${f}`, content: readFileSync(join(REPO_ROOT, 'tools', f)), seed: false });
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
    conflicts.push(`${f.dest}(你改過,或不是 dp 裝的)`);
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

export function init(target, { name, existing = false } = {}) {
  const dir = resolve(target);
  const entries = existsSync(dir) ? readdirSync(dir).filter((e) => e !== '.git') : [];
  if (entries.length && !existing) throw new DpError(`${dir} 不是空目錄。既有專案請加 --existing(只補缺的檔,衝突就一個都不寫)`);
  if (existsSync(join(dir, MANIFEST))) throw new DpError(`${dir} 已經裝過 dp,請用 dp upgrade`);
  // 已經有程式的既有專案:範本的 TS 工具鏈不裝(gate 改跑專案自己的測試,見 dp setup 的 Brownfield)
  const profile = existing && entries.length && detectProject(dir).code_files > 0 ? 'existing' : 'full';
  const { actions, conflicts } = plan(dir, plannedFiles(name ?? 'my-project', { profile }), null);
  if (conflicts.length) throw new DpError(`有 ${conflicts.length} 個同名檔內容不同,一個都沒寫:\n  - ${conflicts.join('\n  - ')}`);
  write(dir, actions, [], profile);
  const dag = loadDag(dir);
  const events = readEvents(dir);
  writeRendered(dir, renderAll(dir, dag, replay(events, dag), events));
  let git = 'existing';
  if (!existsSync(join(dir, '.git'))) {
    run('git init --quiet -b main', { cwd: dir });
    run('git add -A && git -c user.name=dp -c user.email=dp@localhost commit --quiet -m "dp init"', { cwd: dir });
    git = 'initialized';
  }
  return {
    profile,
    created: actions.filter((a) => a.op === 'create').map((a) => a.dest),
    kept: actions.filter((a) => a.op === 'keep').map((a) => a.dest),
    git,
  };
}

export function upgrade(target, { dryRun = false } = {}) {
  const dir = resolve(target);
  const manifest = readJson(join(dir, MANIFEST), null);
  if (!manifest) throw new DpError(`${dir} 沒有 ${MANIFEST};不是 dp 裝的專案,請先 dp init --existing`);
  const profile = manifest.profile ?? 'full';
  const { actions, conflicts, removals } = plan(dir, plannedFiles(null, { profile }), manifest);
  if (conflicts.length) throw new DpError(`升級衝突 ${conflicts.length} 個,一個檔都沒寫:\n  - ${conflicts.join('\n  - ')}\n把你的改動移到別的檔(或還原),再重跑`);
  const summary = {
    from: manifest.version, to: readVersion(),
    update: actions.filter((a) => a.op === 'update').map((a) => a.dest),
    create: actions.filter((a) => a.op === 'create').map((a) => a.dest),
    remove: removals,
  };
  if (!dryRun) write(dir, actions, removals, profile);
  return summary;
}

// 4.8.0 renamed dev-paradigm-mcp to dev-loop-mcp, and its short name dp to dlm.
// Everything that knows the old names lives here: recognising projects and machines set up by dp,
// running an old project through its own tools/dp.mjs until it is upgraded, and the one-time migration.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { DlmError, lockHolder, pidAlive, readJson, runArgv, writeJson } from './util.mjs';

/** The project layout before 4.8.0. */
export const LEGACY = {
  config: 'dp.config.json',
  manifest: '.dp-install.json',
  dir: '.dp',
  cli: 'tools/dp.mjs',
  docs: 'docs/dp',
  baseline: 'docs/dp-baseline.json',
};
export const CLI = 'tools/dlm.mjs';
export const CONFIG = 'dlm.config.json';

/** An old project: it still has dp's config or install manifest and nothing from dlm yet. */
export function isLegacyProject(root) {
  return (existsSync(join(root, LEGACY.config)) || existsSync(join(root, LEGACY.manifest)))
    && !existsSync(join(root, CONFIG)) && !existsSync(join(root, '.dlm-install.json'));
}

/** The project's own CLI: tools/dlm.mjs, or tools/dp.mjs for a project that hasn't been upgraded yet. */
export function projectCli(root) {
  if (existsSync(join(root, CLI))) return join(root, CLI);
  if (isLegacyProject(root) && existsSync(join(root, LEGACY.cli))) return join(root, LEGACY.cli);
  return null;
}

/** Paths a project uses for its config and state folder, old or new layout (the hub watches them for changes). */
export function projectPaths(root) {
  const legacy = isLegacyProject(root);
  return {
    legacy,
    config: join(root, legacy ? LEGACY.config : CONFIG),
    stateDir: join(root, legacy ? LEGACY.dir : '.dlm'),
    manifest: join(root, legacy ? LEGACY.manifest : '.dlm-install.json'),
  };
}

export function legacyMessage(root) {
  return `${root} 是 4.8.0 以前(dp)的專案,先升級:dlm_upgrade_project,或在專案裡跑 node <dev-loop-mcp>/tools/dlm.mjs upgrade`;
}

/** Throw when a command that needs the new layout runs in an old project. */
export function assertNotLegacy(root) {
  if (isLegacyProject(root)) throw new DlmError(legacyMessage(root));
}

/**
 * Dispatch events written before the upgrade hold absolute paths under <project>/.dp/ (worktree, sandbox).
 * The upgrade moved that folder to .dlm/, and only the new code reads them, so the old segment always maps to the new one.
 */
export function remapStatePath(p) {
  if (typeof p !== 'string') return p;
  return p.replace(/([\\/])\.dp(?=[\\/])/, '$1.dlm');
}

// ------------------------------------------------------------------ text rewriting

/** Env vars that dp set or read. Only these are renamed, so a project's own DP_* variables are left alone. */
const ENV_NAMES = 'PROMPT|REPORT|ROLE|DISPATCH|PROJECT|ACCOUNT|NOTIFY_TEXT|IN_SANDBOX|CONFIG_DIR|KEY_FILE|ACCOUNTS_FILE|PROJECTS_FILE';

/** Rules that only touch dp's own paths and names, safe for any file (config, scripts, hooks). */
const PATH_RULES = [
  [/dev-paradigm-mcp/g, 'dev-loop-mcp'],
  [/tools\/dp\.mjs/g, 'tools/dlm.mjs'],
  [/docs\/dp\//g, 'docs/dlm/'],
  [/docs\/dp-baseline\.json/g, 'docs/dlm-baseline.json'],
  [/(?<![\w.-])dp\.config\.json/g, 'dlm.config.json'],
  [/(?<![\w-])\.dp-install\.json/g, '.dlm-install.json'],
  [/(?<![\w.-])\.dp(?=[\\/'"`\s,)\]]|$)/gm, '.dlm'],
  [/check:dp(?![\w-])/g, 'check:dlm'],
  [new RegExp(`(?<![A-Za-z0-9])DP_(?=(?:${ENV_NAMES})(?![A-Z0-9_]))`, 'g'), 'DLM_'],
  [/mcp__dp__/g, 'mcp__dlm__'],
];

/** Extra rules for dp's own prose (AGENTS.md and the template READMEs): the tool name and dp_* MCP tools. */
const PROSE_RULES = [
  [/(?<![A-Za-z0-9])dp_(?=[a-z])/g, 'dlm_'],
  [/(?<![A-Za-z0-9_])dp(?![A-Za-z0-9_])/g, 'dlm'],
];

export function renameTokens(text, { prose = false } = {}) {
  let out = text;
  for (const [re, to] of PATH_RULES) out = out.replace(re, to);
  if (prose) for (const [re, to] of PROSE_RULES) out = out.replace(re, to);
  return out;
}

/** Apply renameTokens to every string in a JSON value. Strings under "$comment" are prose. */
function renameJson(value, key = null) {
  if (typeof value === 'string') return renameTokens(value, { prose: key === '$comment' });
  if (Array.isArray(value)) return value.map((v) => renameJson(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameJson(v, k)]));
  return value;
}

// ------------------------------------------------------------------ machine config folder

const OLD_MACHINE_DIR = () => join(homedir(), '.config', 'dp');
const NEW_MACHINE_DIR = () => join(homedir(), '.config', 'dlm');
let machineChecked = false;

/** ~/.config/dlm. The first call in a process moves ~/.config/dp there if only the old folder exists. */
export function machineDir() {
  const dir = NEW_MACHINE_DIR();
  if (!machineChecked) {
    machineChecked = true;
    try { migrateMachineDir(OLD_MACHINE_DIR(), dir); } catch { /* a failed move must not stop dlm; the old folder stays where it was */ }
  }
  return dir;
}

/**
 * Move dp's machine folder (accounts, project list, account log, hub token, signing key) to dlm's.
 * accounts.json stores absolute account folders, some of them inside the old folder, so those paths move too.
 * A symlink is left at the old place: dp processes still running from before the upgrade keep reading and writing
 * the same files instead of starting a second copy. It can be deleted once nothing old is running.
 */
export function migrateMachineDir(oldDir, newDir) {
  if (existsSync(newDir) || !existsSync(oldDir)) return null;
  if (lstatSync(oldDir).isSymbolicLink()) return null;
  mkdirSync(dirname(newDir), { recursive: true });
  try {
    renameSync(oldDir, newDir);
  } catch (e) {
    if (existsSync(newDir)) return null; // another dlm process moved it first
    throw e;
  }
  const accounts = join(newDir, 'accounts.json');
  if (existsSync(accounts)) {
    const fix = (v) => {
      if (typeof v === 'string') return v === oldDir || v.startsWith(oldDir + sep) ? newDir + v.slice(oldDir.length) : v;
      if (Array.isArray(v)) return v.map(fix);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
      return v;
    };
    const before = readJson(accounts, null);
    if (before) {
      const after = fix(before);
      if (JSON.stringify(after) !== JSON.stringify(before)) writeJson(accounts, after);
    }
  }
  try { symlinkSync(basename(newDir), oldDir); } catch { /* not fatal: only old processes would miss it */ }
  return { from: oldDir, to: newDir };
}

// ------------------------------------------------------------------ project migration

/** Template files dp put in the project that the user owns afterwards (seed-only): rewritten in place, never replaced. */
const PROSE_FILES = ['AGENTS.md', 'AUTONOMY.md', 'CLAUDE.md', 'features/README.md', 'features/steps/README.md', 'docs/integration/README.md', 'docs/adr/README.md', 'contracts/README.md'];
const CODE_FILES = ['.claude/settings.json', 'package.json', 'tsconfig.json', 'cucumber.js', 'vitest.config.ts', 'vitest.scripts.config.ts', 'stryker.config.json', 'scripts/gates.config.json', 'features/steps/_world.ts', 'features/steps/common.steps.ts'];

/**
 * Why an old project can't be migrated right now, or null. The background loop or a tick holds a lock, and a worker
 * still running writes into .dp/; moving the folder under them would lose their results.
 */
export function migrationBlocker(root, dispatches = []) {
  const dir = join(root, LEGACY.dir);
  if (lockHolder(join(dir, 'run.lock'))) return '背景迴圈還在跑,先停(dlm_stop_loop,或在專案裡跑 node tools/dp.mjs run --stop)再升級';
  if (lockHolder(join(dir, 'tick.lock'))) return '有一次 tick 正在跑,等它結束再升級';
  const live = dispatches.filter((d) => d.state === 'running' && pidAlive(d.pid));
  if (live.length) return `還有 ${live.length} 個 worker 在跑(${live.map((d) => d.dispatch_id).join('、')}),等它們交件或停機後再升級`;
  return null;
}

/** What migrateProject would do, without touching anything (for upgrade --dry-run). */
export function migrationPlan(root) {
  const steps = [];
  const has = (p) => existsSync(join(root, p));
  if (has(LEGACY.dir)) steps.push(`${LEGACY.dir}/ → .dlm/`);
  if (has(LEGACY.config)) steps.push(`${LEGACY.config} → ${CONFIG}`);
  if (has(LEGACY.baseline)) steps.push(`${LEGACY.baseline} → docs/dlm-baseline.json`);
  if (has(LEGACY.manifest)) steps.push(`${LEGACY.manifest} → .dlm-install.json`);
  for (const f of [...PROSE_FILES, ...CODE_FILES, '.gitignore', '.mcp.json']) {
    if (!has(f)) continue;
    const text = readFileSync(join(root, f), 'utf8');
    if (rewriteFile(f, text) !== text) steps.push(`改寫 ${f}`);
  }
  return steps;
}

function rewriteFile(rel, text) {
  if (rel === '.gitignore') {
    return text.replace(/^# dp\(dev-paradigm-mcp\)$/m, '# dlm(dev-loop-mcp)').replace(/^\.dp\/$/m, '.dlm/');
  }
  if (rel === '.mcp.json') {
    let j;
    try { j = JSON.parse(text); } catch { return text; }
    const old = j?.mcpServers?.dp;
    if (!old || !JSON.stringify(old).includes(LEGACY.cli)) return text;
    const { dp: _drop, ...rest } = j.mcpServers;
    j.mcpServers = { ...rest, dlm: rest.dlm ?? renameJson(old) };
    return `${JSON.stringify(j, null, 2)}\n`;
  }
  return renameTokens(text, { prose: PROSE_FILES.includes(rel) });
}

/** git worktrees whose folder is inside dir (absolute paths), from `git worktree list --porcelain`. */
function worktreesUnder(root, dir) {
  const r = runArgv('git', ['worktree', 'list', '--porcelain'], { cwd: root });
  if (r.code !== 0) return [];
  // git prints the real path; the project may have been opened through a symlink (/tmp on macOS, for one)
  const bases = [...new Set([resolve(dir), realpathSync(dir)])].map((b) => b + sep);
  const toProject = (p) => {
    const base = bases.find((b) => resolve(p).startsWith(b));
    return base ? join(dir, resolve(p).slice(base.length)) : null;
  };
  return r.stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => toProject(l.slice(9))).filter(Boolean);
}

/**
 * Move an old project's own files to the new names. The caller (install.upgrade) has already checked
 * migrationBlocker and that the managed files have no conflicts; it replaces tools/ and docs/dlm/ afterwards.
 * Returns the project-relative paths created, changed or deleted, for the upgrade commit.
 */
export function migrateProject(root) {
  const touched = [];
  const git = existsSync(join(root, '.git'));

  const oldDir = join(root, LEGACY.dir);
  const newDir = join(root, '.dlm');
  if (existsSync(oldDir) && !existsSync(newDir)) {
    const wts = git ? worktreesUnder(root, oldDir) : [];
    renameSync(oldDir, newDir);
    // git still points at the old folders; repair tells both sides where each worktree is now
    const moved = wts.map((p) => join(newDir, relative(oldDir, p))).filter((p) => existsSync(p));
    if (moved.length) {
      const r = runArgv('git', ['worktree', 'repair', ...moved], { cwd: root });
      if (r.code !== 0) throw new DlmError(`搬完 .dlm/ 之後 git worktree repair 失敗:${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    }
    // Worktrees and sandbox copies have their own .dp/ (envelope, prompt, the worker's report). A worker that finished
    // before the upgrade but wasn't collected yet left its report there; the new code looks in .dlm/.
    const sandboxes = join(newDir, 'sandboxes');
    const inner = [...moved, ...(existsSync(sandboxes) ? readdirSync(sandboxes).map((d) => join(sandboxes, d)) : [])];
    for (const d of inner) {
      if (existsSync(join(d, LEGACY.dir)) && !existsSync(join(d, '.dlm'))) renameSync(join(d, LEGACY.dir), join(d, '.dlm'));
    }
  }

  const oldConfig = join(root, LEGACY.config);
  if (existsSync(oldConfig)) {
    if (!existsSync(join(root, CONFIG))) writeJson(join(root, CONFIG), renameJson(readJson(oldConfig)));
    unlinkSync(oldConfig);
    touched.push(CONFIG, LEGACY.config);
  }

  const oldBaseline = join(root, LEGACY.baseline);
  if (existsSync(oldBaseline)) {
    renameSync(oldBaseline, join(root, 'docs', 'dlm-baseline.json'));
    touched.push('docs/dlm-baseline.json', LEGACY.baseline);
  }

  for (const f of [...PROSE_FILES, ...CODE_FILES, '.gitignore', '.mcp.json']) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    const next = rewriteFile(f, text);
    if (next !== text) { writeFileSync(p, next); touched.push(f); }
  }
  return touched;
}

/** After the new files are written: drop the old manifest and the old docs folder if the upgrade emptied it. */
export function finishMigration(root) {
  const touched = [];
  if (existsSync(join(root, LEGACY.manifest))) { unlinkSync(join(root, LEGACY.manifest)); touched.push(LEGACY.manifest); }
  const docs = join(root, LEGACY.docs);
  try { if (existsSync(docs) && !readdirSync(docs).length) rmdirSync(docs); } catch { /* leave a folder that still holds the user's own files */ }
  return touched;
}

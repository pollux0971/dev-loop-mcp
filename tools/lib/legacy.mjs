// 4.8.0 renamed dev-paradigm-mcp to dev-loop-mcp, and its short name dp to dlm.
// Everything that knows the old names lives here: recognising projects and machines set up by dp,
// running an old project through its own tools/dp.mjs until it is upgraded, and the one-time migration.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { DlmError, lockHolder, pidAlive, readJson, runArgv, tryLock, writeJson } from './util.mjs';

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

/**
 * Left at tools/dp.mjs, in this repo and in every upgraded project. Things set up before the rename still call it:
 * an MCP server registered as dp, and the hooks of a Claude Code session started before the upgrade
 * (Claude Code keeps the hooks it read at startup). It only hands over to tools/dlm.mjs.
 */
export const FORWARDER = `#!/usr/bin/env node
// Before 4.8.0 the CLI was tools/dp.mjs (the tool was called dp). This file only forwards to tools/dlm.mjs, so things
// set up before the rename keep working until they are updated: an MCP server still registered as dp
// (run \`node tools/dlm.mjs mcp install\` to replace it) and the hooks of a Claude Code session started before the upgrade
// (restart Claude Code). Safe to delete once both are done.
await import('./dlm.mjs');
`;

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
 * The upgrade moved that folder to .dlm/. The last .dp segment is the project's own folder: an ancestor folder may
 * also be called .dp. A path that still exists as written is left alone.
 */
export function remapStatePath(p) {
  if (typeof p !== 'string' || !/[\\/]\.dp[\\/]/.test(p) || existsSync(p)) return p;
  const m = p.match(/^(.*[\\/])\.dp([\\/].*)$/);
  return m ? `${m[1]}.dlm${m[2]}` : p;
}

// ------------------------------------------------------------------ text rewriting

/** Env vars that dp set or read. Only these are renamed, so a project's own DP_* variables are left alone. */
const ENV_NAMES = 'PROMPT|REPORT|ROLE|DISPATCH|PROJECT|ACCOUNT|NOTIFY_TEXT|IN_SANDBOX|CONFIG_DIR|KEY_FILE|ACCOUNTS_FILE|PROJECTS_FILE|HOOKS';
/** dp's MCP tools (4.7.3 and the older names still found in docs). */
const TOOLS = 'flow|health|overview|list_projects|add_project|init_project|upgrade_project|remove_project|get_project|setup_project|onboard|baseline|'
  + 'get_dashboard|list_events|list_nodes|get_inbox|mark_inbox_seen|show|list_proposals|propose_feature|propose_bundle|decide|confirm|resume|'
  + 'unblock|halt|get_loop|start_loop|stop_loop|tick|get_roles|set_role|set_settings|doctor|list_accounts|add_account|update_account|remove_account|'
  + 'status|inbox|dashboard|accounts|use_accounts|intake_feature|intake_bundle';
/** dp's CLI commands. */
const COMMANDS = 'init|setup|doctor|upgrade|tick|run|status|dashboard|inbox|show|decide|confirm|halt|resume|unblock|intake|onboard|baseline|'
  + 'check|gates|render|stats|hook|account|mcp|project|hub|op|api|settings|contract|help';

/** Where a project-relative .dp starts: at the start of a string, after a quote, space, bracket, comma or =, optionally after ./ */
const DOT_DP = /(?<=^|[\s'"`(\[,=]|(?:^|[\s'"`(\[,=])\.\/)\.dp(?=[\\/'"`\s,)\]]|$)/gm;

/** Rules that only touch dp's own paths and names, safe for any file (config, scripts, hooks). */
const PATH_RULES = [
  [/dev-paradigm-mcp/g, 'dev-loop-mcp'],
  [/tools\/dp\.mjs/g, 'tools/dlm.mjs'],
  [/docs\/dp\//g, 'docs/dlm/'],
  [/docs\/dp-baseline\.json/g, 'docs/dlm-baseline.json'],
  [/(?<![\w.-])dp\.config\.json/g, 'dlm.config.json'],
  [/(?<![\w-])\.dp-install\.json/g, '.dlm-install.json'],
  [DOT_DP, '.dlm'],
  [/check:dp(?![\w-])/g, 'check:dlm'],
  [new RegExp(`(?<![A-Za-z0-9])DP_(?=(?:${ENV_NAMES})(?![A-Z0-9_]))`, 'g'), 'DLM_'],
  [/mcp__dp__/g, 'mcp__dlm__'],
];

/**
 * Extra rules for prose (AGENTS.md and the template READMEs). Only the forms dp itself wrote are renamed:
 * `dp`, dp's commands (`dp status`), its MCP tools (dp_get_inbox) and "dev-loop-mcp(dp)". A user's own "dp"
 * (dp[i][j], dp_table, a dp/ folder) stays as it is.
 */
const PROSE_RULES = [
  [/`dp`/g, '`dlm`'],
  [/(dev-loop-mcp\s?[((])dp(?=[))])/g, '$1dlm'],
  [new RegExp(`(?<![A-Za-z0-9_.\\[/-])dp(?= (?:${COMMANDS})(?![\\w-]))`, 'g'), 'dlm'],
  [new RegExp(`(?<![A-Za-z0-9])dp_(?=(?:${TOOLS})(?![A-Za-z0-9_]))`, 'g'), 'dlm_'],
];

export function renameTokens(text, { prose = false } = {}) {
  let out = text;
  for (const [re, to] of PATH_RULES) out = out.replace(re, to);
  if (prose) for (const [re, to] of PROSE_RULES) out = out.replace(re, to);
  return out;
}

/**
 * Apply renameTokens to every string in a JSON value. Strings under "$comment" are prose.
 * warnings collects strings that still name a .dp folder somewhere else (a worktree_dir outside the project, say):
 * only <project>/.dp is moved, so those are left for the user to look at.
 */
function renameJson(value, warnings, key = null, path = '') {
  if (typeof value === 'string') {
    const out = renameTokens(value, { prose: key === '$comment' });
    if (key !== '$comment' && /(^|[\\/])\.dp([\\/]|$)/.test(out)) warnings.push(`${CONFIG} 的 ${path || key}「${out}」指到專案以外的 .dp,沒有改,請自己確認`);
    return out;
  }
  if (Array.isArray(value)) return value.map((v, i) => renameJson(v, warnings, key, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameJson(v, warnings, k, path ? `${path}.${k}` : k)]));
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
    // a failed move must not stop dlm; the old folder stays where it was and the next process tries again
    try { migrateMachineDir(OLD_MACHINE_DIR(), dir); } catch { /* see above */ }
    // also heals an earlier move that stopped before rewriting accounts.json
    try { fixAccountPaths(OLD_MACHINE_DIR(), dir); } catch { /* retried on the next start */ }
  }
  return dir;
}

/**
 * Move dp's machine folder (accounts, project list, account log, hub token, signing key) to dlm's.
 * The old folder may be a symlink (dotfiles): renameSync moves the link itself, so it keeps pointing at the same place.
 * A symlink is left at the old place right after the move: dp processes started before the upgrade keep reading and
 * writing the same files, and absolute paths that still name the old folder keep resolving. It can be deleted once
 * nothing old is running.
 */
export function migrateMachineDir(oldDir, newDir) {
  if (existsSync(newDir) || !existsSync(oldDir)) return null; // done before, or nothing to move (a dangling link counts as nothing)
  mkdirSync(dirname(newDir), { recursive: true });
  try {
    renameSync(oldDir, newDir);
  } catch (e) {
    if (existsSync(newDir)) return null; // another dlm process moved it first
    throw e;
  }
  try { symlinkSync(basename(newDir), oldDir); } catch { /* not fatal: only old processes would miss it */ }
  fixAccountPaths(oldDir, newDir);
  return { from: oldDir, to: newDir };
}

/** accounts.json stores absolute account folders, some of them inside the old machine folder. */
export function fixAccountPaths(oldDir, newDir) {
  const accounts = join(newDir, 'accounts.json');
  if (!existsSync(accounts)) return false;
  const fix = (v) => {
    if (typeof v === 'string') return v === oldDir || v.startsWith(oldDir + sep) ? newDir + v.slice(oldDir.length) : v;
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
    return v;
  };
  const before = readJson(accounts, null);
  if (!before) return false;
  const after = fix(before);
  if (JSON.stringify(after) === JSON.stringify(before)) return false;
  writeJson(accounts, after);
  return true;
}

// ------------------------------------------------------------------ project migration

/** Template files dp put in the project that the user owns afterwards (seed-only): rewritten in place, never replaced. */
const PROSE_FILES = ['AGENTS.md', 'AUTONOMY.md', 'CLAUDE.md', 'features/README.md', 'features/steps/README.md', 'docs/integration/README.md', 'docs/adr/README.md', 'contracts/README.md'];
const CODE_FILES = ['.claude/settings.json', 'package.json', 'tsconfig.json', 'cucumber.js', 'vitest.config.ts', 'vitest.scripts.config.ts', 'stryker.config.json', 'scripts/gates.config.json', 'features/steps/_world.ts', 'features/steps/common.steps.ts'];

/**
 * Why an old project can't be migrated right now, or null. The background loop holds run.lock, a tick holds tick.lock,
 * and a worker still running writes into .dp/; moving the folder under them would lose their results.
 * The upgrade then takes tick.lock itself (lockForMigration) so nothing new starts while it works.
 */
export function migrationBlocker(root, dispatches = []) {
  const dir = join(root, LEGACY.dir);
  if (lockHolder(join(dir, 'run.lock'))) return '背景迴圈還在跑,先停(dlm_stop_loop,或在專案裡跑 node tools/dp.mjs run --stop)再升級';
  if (lockHolder(join(dir, 'tick.lock'))) return '有一次 tick 正在跑,等它結束再升級';
  const live = dispatches.filter((d) => d.state === 'running' && pidAlive(d.pid));
  if (live.length) return `還有 ${live.length} 個 worker 在跑(${live.map((d) => d.dispatch_id).join('、')}),等它們交件或停機後再升級`;
  return null;
}

/**
 * Hold .dp/tick.lock while the project is migrated, so a tick or loop started by hand, cron or an old process can't
 * write into .dp/ halfway through. The lock file moves to .dlm/ with the folder; release removes it from either place.
 * Returns null when a tick already holds it.
 */
export function lockForMigration(root) {
  // an earlier run that stopped halfway already moved the folder: lock there instead of creating .dp/ again
  const dir = !existsSync(join(root, LEGACY.dir)) && existsSync(join(root, '.dlm')) ? '.dlm' : LEGACY.dir;
  const release = tryLock(join(root, dir, 'tick.lock'));
  if (!release) return null;
  return () => {
    release();
    const moved = join(root, '.dlm', 'tick.lock');
    try { if (readFileSync(moved, 'utf8').trim() === String(process.pid)) unlinkSync(moved); } catch { /* not moved, or already gone */ }
  };
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
  steps.push(`${LEGACY.cli} 換成轉給 ${CLI} 的小檔(重開 Claude Code 之前的 session 還會呼叫它)`);
  return steps;
}

function rewriteFile(rel, text) {
  if (rel === '.gitignore') {
    return text.replace(/^# dp\(dev-paradigm-mcp\)$/m, '# dlm(dev-loop-mcp)').replace(/^\/?\.dp\/?$/m, '.dlm/');
  }
  if (rel === '.mcp.json') {
    let j;
    try { j = JSON.parse(text); } catch { return text; }
    const old = j?.mcpServers?.dp;
    if (!old || !JSON.stringify(old).includes(LEGACY.cli)) return text;
    const { dp: _drop, ...rest } = j.mcpServers;
    j.mcpServers = { ...rest, dlm: rest.dlm ?? renameJson(old, []) };
    return `${JSON.stringify(j, null, 2)}\n`;
  }
  return renameTokens(text, { prose: PROSE_FILES.includes(rel) });
}

/** git worktrees whose folder is inside dir, as paths under dir (git prints real paths; the project may sit behind a symlink). */
function worktreesUnder(root, dir) {
  const r = runArgv('git', ['worktree', 'list', '--porcelain'], { cwd: root });
  if (r.code !== 0) return [];
  let real = dir;
  try { real = realpathSync(dir); } catch { /* the folder is gone (already moved): compare with the plain path */ }
  const bases = [...new Set([resolve(dir), real])].map((b) => b + sep);
  const toDir = (p) => {
    const base = bases.find((b) => resolve(p).startsWith(b));
    return base ? join(dir, resolve(p).slice(base.length)) : null;
  };
  return r.stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => toDir(l.slice(9))).filter(Boolean);
}

/**
 * Tell git where the worktrees registered under <root>/.dp are now. Safe to run again: it looks at what git still
 * has registered under .dp, so a repair that failed once is retried by the next upgrade.
 */
function repairMovedWorktrees(root) {
  const oldDir = join(root, LEGACY.dir);
  const newDir = join(root, '.dlm');
  const moved = worktreesUnder(root, oldDir).filter((p) => !existsSync(p))
    .map((p) => join(newDir, relative(oldDir, p))).filter((p) => existsSync(p));
  if (!moved.length) return [];
  const r = runArgv('git', ['worktree', 'repair', ...moved], { cwd: root });
  if (r.code !== 0) throw new DlmError(`git worktree repair 失敗:${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return moved;
}

/**
 * Move an old project's own files to the new names. The caller (install.upgrade) holds lockForMigration, has checked
 * migrationBlocker and that the managed files have no conflicts; it replaces tools/ and docs/dlm/ afterwards.
 * Returns { touched, warnings }: project-relative paths created, changed or deleted (for the upgrade commit), and
 * things the user should look at.
 */
export function migrateProject(root) {
  const touched = [];
  const warnings = [];
  const git = existsSync(join(root, '.git'));

  const oldDir = join(root, LEGACY.dir);
  const newDir = join(root, '.dlm');
  if (existsSync(oldDir) && !existsSync(newDir)) {
    renameSync(oldDir, newDir);
    try {
      if (git) repairMovedWorktrees(root);
    } catch (e) {
      // put the folder back so the project is exactly as before, and the upgrade can simply be run again
      try { renameSync(newDir, oldDir); } catch { /* leave it; the repair above is retried on the next run */ }
      throw new DlmError(`搬 .dp/ → .dlm/ 時${e.message};已經搬回去,專案沒有改動`);
    }
  } else if (git && existsSync(newDir)) {
    repairMovedWorktrees(root); // an earlier run moved the folder but stopped before git knew
  }
  // Worktrees and sandbox copies have their own .dp/ (envelope, prompt, the worker's report). A worker that finished
  // before the upgrade but wasn't collected yet left its report there; the new code looks in .dlm/.
  const inner = [];
  for (const sub of ['worktrees', 'sandboxes']) {
    const d = join(newDir, sub);
    if (existsSync(d)) for (const e of readdirSync(d)) inner.push(join(d, e));
  }
  for (const d of inner) {
    if (existsSync(join(d, LEGACY.dir)) && !existsSync(join(d, '.dlm'))) renameSync(join(d, LEGACY.dir), join(d, '.dlm'));
  }

  const oldConfig = join(root, LEGACY.config);
  if (existsSync(oldConfig)) {
    if (!existsSync(join(root, CONFIG))) writeJson(join(root, CONFIG), renameJson(readJson(oldConfig), warnings));
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
  return { touched, warnings };
}

/**
 * After the new files are written: drop the old manifest and the old docs folder if the upgrade emptied it,
 * and leave the forwarder at tools/dp.mjs (the old CLI itself was removed with the other managed files).
 */
export function finishMigration(root) {
  const touched = [];
  if (existsSync(join(root, LEGACY.manifest))) { unlinkSync(join(root, LEGACY.manifest)); touched.push(LEGACY.manifest); }
  const docs = join(root, LEGACY.docs);
  try { if (existsSync(docs) && !readdirSync(docs).length) rmdirSync(docs); } catch { /* leave a folder that still holds the user's own files */ }
  const cli = join(root, LEGACY.cli);
  if (!existsSync(cli) && existsSync(join(root, CLI))) { writeFileSync(cli, FORWARDER, { mode: 0o755 }); touched.push(LEGACY.cli); }
  return touched;
}

/** DP_* variables a user set by hand: dlm reads only DLM_*, so these are ignored now. */
export function legacyEnvVars(env = process.env) {
  return ['CONFIG_DIR', 'ACCOUNTS_FILE', 'PROJECTS_FILE', 'KEY_FILE', 'HOOKS', 'PROJECT']
    .filter((n) => env[`DP_${n}`] && !env[`DLM_${n}`]).map((n) => `DP_${n}`);
}

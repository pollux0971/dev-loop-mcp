import { join } from 'node:path';
import { assertNotLegacy } from './legacy.mjs';
import { loadStack, stackName } from './stack.mjs';
import { assertValid } from './schema.mjs';
import { configSchema } from './schemas.mjs';
import { DlmError, readJson } from './util.mjs';

/**
 * gate definition files and agent settings. If a worker could change them, it could turn `test` into `exit 0` or swap the test framework,
 * defeating the last gate. Forbidden by default; when a change is really needed, go through user approval and a shared/* node whose owns lists that path explicitly.
 * v4.11: only the ones every project has are here; each stack adds its own build files (stacks/<name>/stack.json → add.forbidden), see buildConfigPaths.
 */
export const BUILD_CONFIG_PATHS = ['.mcp.json', '.github/**', '.gitattributes', '.gitignore'];

/** The gate definition files of this config: the core's plus the stack's. */
export const buildConfigPaths = (config) => [...BUILD_CONFIG_PATHS, ...(config?.stack_add?.forbidden ?? [])];

export const DEFAULTS = {
  main_branch: 'main',
  worktree_dir: '.dlm/worktrees',
  platform: 'generic',
  // v4.5: greenfield / brownfield (dlm setup asks). language decides the default paths for characterize and test files.
  // v4.11 stack: the folder under stacks/ with this project's template, default commands and extra checks; absent = detected (see stack.mjs), 'none' = core only
  project: { mode: 'greenfield', language: 'node' },
  caps: {
    parallel: 3, unmerged: 3, drift: 20, attempts: 3, lease_minutes: 90,
    // Infrastructure failures such as 429 / 5xx / connection timeout do not count as a worker attempt; they are re-dispatched with backoff, and the loop halts after too many in a row
    infra_halt_after: 5, infra_backoff_seconds: 60, infra_backoff_max_minutes: 30,
    // v4: how many times one node may be sent back to the test leg automatically; beyond that, ask the user (the spec itself may be wrong)
    test_reopens: 2,
    // v4.6: how many minutes to cool down when an account is rate limited and the reset time cannot be found in the log
    account_cooldown_minutes: 30,
  },
  pipeline: {
    phase: ['test', 'dev'],
    // v4: integration points get a test leg first too. In v3 there was only the integrate leg, and the step definitions of the integration gherkin live in features/steps (a test path),
    // which the integrate leg may not write, and no leg would write it, so the integration point was always undefined (seen in a real run)
    integration: ['test', 'integrate'],
    shared: ['dev'],
  },
  // npm scripts run in the temp tree of main + branch before merging. Must include the project's tests: running only check:dlm validates only metadata,
  // so node B breaking node A's tests would not be blocked.
  // How install:merge-tree gets its dependencies. auto = if there is a package-lock.json, install a clean copy with the local cache `npm ci --offline --ignore-scripts`
  // (unaffected by changes to the root node_modules); only without a lockfile, symlink the root.
  // commands (v4.5): the command each chain name maps to, for existing projects that do not run tests through npm scripts (e.g. { test: 'python3 -m pytest -q' }).
  gates: { chain: ['check:dlm', 'test'], timeout_minutes: 30, install: 'auto', commands: {} },
  autonomy: { level: 1 },
  // User authorization (decide / confirm / resume / unblock): trust what Front relays; --verbatim may be omitted.
  // When verbatim words signed by the hook and matching are given (within the last window_minutes minutes), the event records the hash of that sentence
  auth: { window_minutes: 30 },
  budget: { daily_usd: 5 },
  // v4: version gate (see AUTONOMY.md, WORKFLOW.md). The last integration point I<n> of each version; the next version's nodes depend on it,
  // and with gate_next_version = true, the next version does not start until the integration point is merged and you have confirmed it by hand trial (dlm confirm).
  // v4.7.3 precheck_green: before dispatching an integration point's test leg, run acceptance once on that tree; if it is already green (the capability nodes already did it), do not dispatch,
  // mark the test leg done and dispatch the integrate leg (saves one leg and one "stuck" question). false = dispatch as before, and let the user choose skip when stuck
  integration: { gate_next_version: true, precheck_green: true },
  // v4: runs when there is a new pending decision (env var DLM_NOTIFY_TEXT). Example: macOS `osascript -e "display notification \"$DLM_NOTIFY_TEXT\" with title \"dlm\""`
  notify: { cmd: null },
  agents: {
    worker: { cmd: null, timeout_minutes: 90 },
    critic: { cmd: null, timeout_minutes: 20 },
    verifier: { backend: 'none', cmd: null, runs: 2, max_input_chars: 6000, timeout_seconds: 120 },
  },
  paths: {
    forbidden: [
      'ledger/**', 'dag.json', 'STATUS.md', 'DECISIONS.md', 'standalone.json',
      'AGENTS.md', 'CLAUDE.md', 'AUTONOMY.md', 'dlm.config.json',
      '.claude/**', 'prompts/**', 'tools/**', 'contracts/**', '.dlm-install.json',
      // v4.5: the test baseline of an existing project (which tests were already red on main). If a worker could change it, it could write the tests it broke as "already broken"
      'docs/dlm-baseline.json',
      ...BUILD_CONFIG_PATHS,
    ],
    tests: ['**/*.test.*', '**/*.spec.*', 'features/**/*.feature', 'features/steps/**', 'docs/integration/**/*.feature'],
    rules: ['AGENTS.md', 'AUTONOMY.md', 'prompts/*.md', 'prompts/principles/*.md', '.claude/skills/*/SKILL.md', 'tools/stacks/*/rules.md'],
  },
  verify: {
    // Prefix match; the command itself may only contain alphanumerics, ._/:=@+- and spaces, run as argv without a shell.
    // No cat / ls: a worker could claim "the exit of cat ~/.aws/credentials is 1" and make dlm read the file on the host for it.
    // v4: added `node tools/dlm.mjs check` (the only command a contract node can use as evidence; in the v3 real run it was not allowed, so the whole thing became a question to the user)
    // v4.11: the test runners (npm test, pytest, ...) come from the stack (add.rerun_allow) and from gates.commands
    rerun_allow: ['node tools/dlm.mjs check', 'git diff', 'git log', 'git status'],
    rerun_timeout_seconds: 600,
    // Test leg: every step must be bound ({gherkin} is replaced with the node's gherkin path). null = do not run
    dry_run_cmd: null,
    // v4.11: used by a stack's own test-leg checks (node-ts: 'auto' = typecheck the files this leg wrote). null = do not run
    typecheck_cmd: null,
    // Last leg: run incremental mutation on the implementation files this leg changed ({files} is replaced with a comma-separated file list). cmd null = do not run
    mutation: {
      // v4: 50 for normal nodes, 70 for tier strict (v3 real run: CLI projects scored 52%, 54%, and a threshold of 60 made every run "unsure")
      cmd: null, report: 'reports/mutation/mutation.json', min: 50, min_strict: 70, timeout_minutes: 30,
      include: ['**/*'],
    },
  },
  checks: { placeholders: { exclude: [] } },
  limits: { rules_bytes: 6000, prompt_bytes: 60000 },
};

function merge(base, over) {
  if (over === undefined) return base;
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || base === null) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

/**
 * Settings removed in v4.1 (unused in real runs; add them back when needed, the code is in git history v4.0.0).
 * Old config files containing these do not error: they are dropped on read, and `dlm doctor` reminds you of each one. Returns [{ key, note }].
 */
const REMOVED = [
  ['agents.manager', 'Manager 已移除,改用預設優先序(解鎖下游數)', (v) => !v?.cmd],
  ['sandbox', '容器沙箱(docker / podman / srt)已移除;worker 一律在沒有 .git 的副本裡施工', (v) => (v?.backend ?? 'none') === 'none'],
  ['front', 'Front 的 strict 唯讀模式已移除(只剩防寫帳本的 light)', (v) => (v?.guard ?? 'light') === 'light'],
  ['auth.mode', 'signed / off 模式已移除:一律信任 Front 轉達,對得上簽章原話時另外記 hash', (v) => v === 'trust'],
  ['agents.verifier.url', 'Verifier 的 http(Ollama)模式已移除,改用 cmd', (v) => !v],
  // agents.verifier.model is not here: since v4.6 it is the model the CLI uses in account mode (dlm account use verifier ... --model), see stripRemovedSettings
  ['verify.clean_room_max_overlap', '外部程式匯入(intake import)已移除', () => true],
  ['pipeline.backfill', '既有專案補 gherkin(brownfield)已移除', (v) => String(v) === 'backfill'],
  ['pipeline.import-hard', '外部程式匯入(intake import)已移除', (v) => String(v) === 'test,port'],
  ['pipeline.import-soft', '外部程式匯入(intake import)已移除', (v) => String(v) === 'analyze,test,rebuild'],
];

export function stripRemovedSettings(raw) {
  const out = structuredClone(raw ?? {});
  const removed = [];
  // When v4.1 removed the http (Ollama) mode, agents.verifier.model was an Ollama model name and was always dropped; but since v4.6 the same field is the model the Verifier uses in account mode
  // (e.g. haiku, sonnet). Only an old http setting (backend http or a url) counts as a removed setting.
  // v4.7.3 real run: after dlm account use verifier <account> --model haiku, doctor warned "http mode removed", and the model was dropped so the default was always used
  const v0 = out.agents?.verifier;
  if (v0 && typeof v0 === 'object' && 'model' in v0 && (v0.backend === 'http' || 'url' in v0)) {
    const silent = !v0.model;
    delete v0.model;
    if (!silent) removed.push({ key: 'agents.verifier.model', note: 'Verifier 的 http(Ollama)模式已移除,改用 cmd' });
  }
  // silent(v) truthy = the old setting was just the default; drop it without a reminder
  for (const [key, note, silent] of REMOVED) {
    const parts = key.split('.');
    const parent = parts.slice(0, -1).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), out);
    const last = parts.at(-1);
    if (parent && typeof parent === 'object' && last in parent) {
      const v = parent[last];
      delete parent[last];
      if (!silent?.(v)) removed.push({ key, note });
    }
  }
  if (out.platform === 'codex') { out.platform = 'generic'; removed.push({ key: 'platform', note: 'Codex 專屬的支援已移除,codex 指令照 generic 執行(沒有 hooks)' }); }
  if (out.agents?.verifier?.backend === 'http') { out.agents.verifier.backend = 'none'; removed.push({ key: 'agents.verifier.backend', note: 'http(Ollama)已移除,Verifier 暫時停用;改成 cmd(dlm setup 可選 Claude Haiku)' }); }
  if (out.autonomy?.level === 3) { out.autonomy.level = 2; removed.push({ key: 'autonomy.level', note: 'L3 已移除,當成 L2(Critic 不代你做決定)' }); }
  return { config: out, removed };
}

export function loadConfig(root) {
  // A project from before 4.8.0 has dp.config.json; reading defaults here would run it with the wrong settings
  assertNotLegacy(root);
  const { config: raw } = stripRemovedSettings(readJson(join(root, 'dlm.config.json'), {}));
  try {
    assertValid(configSchema, raw, 'dlm.config.json');
  } catch (e) {
    throw new DlmError(e.message);
  }
  // v4.11: core defaults <- the stack's defaults <- the project's own settings. The stack's add.* lists extend the core's lists instead of replacing them
  const stack = loadStack(stackName(root, raw));
  const base = merge(DEFAULTS, stack.defaults ?? {});
  const add = stack.add ?? {};
  base.verify = { ...base.verify, rerun_allow: [...base.verify.rerun_allow, ...(add.rerun_allow ?? [])] };
  base.paths = { ...base.paths, forbidden: [...base.paths.forbidden, ...(add.forbidden ?? [])] };
  const config = merge(base, raw);
  config.project = { ...config.project, stack: stack.name };
  config.stack_add = add;
  // v4.5: the command for a gate (e.g. python3 -m pytest -q) is also a command the worker uses as evidence, so it is added to the rerun allowlist automatically.
  // What goes in is the test framework part (python3 -m pytest, go test, cargo test): the arguments differ when a worker runs only its own test files
  const runner = (c) => { const w = c.split(' ').filter(Boolean); return w.slice(0, w[1] === '-m' ? 3 : 2).join(' '); };
  const extra = Object.values(config.gates.commands ?? {}).filter((c) => /^[A-Za-z0-9 ._/:=@+-]+$/.test(c)).map(runner);
  if (extra.length) config.verify = { ...config.verify, rerun_allow: [...new Set([...config.verify.rerun_allow, ...extra])] };
  return config;

}

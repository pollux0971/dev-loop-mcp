import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../tools/lib/inbox.mjs';
import { init } from '../tools/lib/install.mjs';
import { proposeFeature } from '../tools/lib/intake.mjs';
import { readEvents } from '../tools/lib/ledger.mjs';
import { tick } from '../tools/lib/orchestrator.mjs';
import { loadDag } from '../tools/lib/dag.mjs';
import { replay } from '../tools/lib/state.mjs';
import { pidAlive, readJson, run, writeJson } from '../tools/lib/util.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Tests do not touch your real ~/.config/dlm/key: the whole test process (including the dlm child processes it starts) uses one temporary key
if (!process.env.DLM_KEY_FILE) process.env.DLM_KEY_FILE = join(mkdtempSync(join(tmpdir(), 'dlm-key-')), 'key');
// v4.7: accounts, the project list and the hub token do not touch your real ~/.config/dlm either
if (!process.env.DLM_CONFIG_DIR) process.env.DLM_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'dlm-config-'));
export const FAKE = join(REPO, 'test', 'fixtures', 'fake-worker.mjs');
export const FAKE_VERIFIER = join(REPO, 'test', 'fixtures', 'fake-verifier.mjs');
/** A test project has no node_modules: use node's built-in test runner as the project test, so the merge gate really runs every node's tests. */
export const TEST_SCRIPT = 'node --test "packages/**/*.test.mjs"';

const temps = [];
export function tempDir(prefix = 'dlm-test-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}
export function cleanup() {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function sh(cwd, cmd) {
  const r = run(cmd, { cwd });
  if (r.code !== 0) throw new Error(`${cmd} 失敗:${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

export function makeProject({ mode = 'good', level = 1, config = {} } = {}) {
  const proj = join(tempDir('dlm-proj-'), 'proj');
  init(proj, { name: 'demo' });
  const pkg = readJson(join(proj, 'package.json'));
  pkg.scripts.test = TEST_SCRIPT;
  writeJson(join(proj, 'package.json'), pkg);
  const cfg = readJson(join(proj, 'dlm.config.json'));
  cfg.agents.worker.cmd = `FAKE_MODE=${mode} node ${FAKE}`;
  cfg.autonomy.level = level;
  cfg.gates.chain = ['check:dlm', 'test'];
  // A test project has no node_modules / tsx / stryker: dry-run and mutation are opened by dedicated tests
  cfg.verify = { ...cfg.verify, dry_run_cmd: null, mutation: { ...cfg.verify?.mutation, cmd: null } };
  // The signed user-authorization flow is checked by the p1 tests; other tests decide directly as the user
  cfg.auth = { mode: 'off' };
  // Let the L2 tests run without a sandbox (a real project must turn this switch on yourself)
  cfg.sandbox = { backend: 'none', allow_unsandboxed_autonomy: true };
  // A fake small model is attached by default (always NO_OBJECTION); without a Verifier, the last leg of a node with gherkin is not merged automatically
  cfg.agents.verifier = { ...cfg.agents.verifier, backend: 'cmd', cmd: `FV=ok node ${FAKE_VERIFIER}` };
  cfg.verify = { ...cfg.verify, rerun_allow: ['node --test', 'node packages/'], ...(config.verify ?? {}) };
  for (const [k, v] of Object.entries(config)) {
    if (k === 'verify') continue;
    if (k === 'agents') for (const [a, av] of Object.entries(v)) cfg.agents[a] = { ...cfg.agents[a], ...av };
    else cfg[k] = typeof v === 'object' && !Array.isArray(v) ? { ...cfg[k], ...v } : v;
  }
  writeJson(join(proj, 'dlm.config.json'), cfg);
  sh(proj, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm config');
  return proj;
}

export function setWorkerMode(proj, mode) {
  const cfg = readJson(join(proj, 'dlm.config.json'));
  cfg.agents.worker.cmd = `FAKE_MODE=${mode} node ${FAKE}`;
  writeJson(join(proj, 'dlm.config.json'), cfg);
  sh(proj, `git add -A && git -c user.name=t -c user.email=t@t commit -qm "mode ${mode}"`);
}

export const CALC = {
  id: 'calc/v1', title: '加法', intent: '提供 run(a,b) 回傳兩數之和',
  owns: ['packages/calc/**'], depends_on: ['contracts@1'], accept: 'node --test packages/calc/src/calc.test.mjs',
};
export const CALC_GHERKIN = 'Feature: calc\n  Scenario: adds two numbers\n    When I add 2 and 3\n    Then the result is 5\n';
export const I1 = {
  id: 'I1', kind: 'integration', title: '可以用', intent: '使用者執行 app 看到 ok',
  owns: ['packages/app/**'], depends_on: ['calc/v1'], accept: 'node packages/app/main.mjs',
};
export const I1_GHERKIN = '@integration @i1\nFeature: app\n  @e2e\n  Scenario: user runs the app\n    When I run the app\n    Then I see ok\n';

/** Walk the full intake: proposal → user approval. The next tick applies it. */
export function addNode(proj, spec, gherkin) {
  const p = proposeFeature(proj, spec, gherkin);
  decide(proj, `node:${p.id}`, 'yes', '好,加進去');
  return p.id;
}

export function stateOf(proj) {
  const dag = loadDag(proj);
  return replay(readEvents(proj), dag);
}

export async function waitWorkers(proj, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    const running = [...stateOf(proj).dispatches.values()].filter((d) => ['dispatched', 'running'].includes(d.state) && d.pid && pidAlive(d.pid));
    if (!running.length) return;
    if (Date.now() - start > timeoutMs) throw new Error('worker 沒有結束');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Keep ticking until pred(state) holds; returns the last state. */
export async function tickUntil(proj, pred, { max = 25, log = () => {} } = {}) {
  for (let i = 0; i < max; i++) {
    const r = await tick(proj, { log });
    if (!r.ok) throw new Error(`tick 失敗:${r.reason}`);
    await waitWorkers(proj);
    const s = stateOf(proj);
    if (pred(s)) return s;
  }
  const s = stateOf(proj);
  throw new Error(`tick ${max} 次仍未達成條件。節點:${JSON.stringify([...s.nodes.values()].map((n) => [n.id, n.status, n.reason, n.findings]))}`);
}

export function writeFile(p, text) {
  writeFileSync(p, text);
}

// v4.5 既有專案(brownfield):模式開關、gate 跑專案自己的測試、測試基線、characterize 棒、onboard。
// 用一個沒有 package.json 的 Python 專案(標準庫 unittest,不用裝任何東西)。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { characterizeTestPath, detectProject, failingTests, knownRed, onboard } from '../tools/lib/brownfield.mjs';
import { loadConfig } from '../tools/lib/config.mjs';
import { dashboardData } from '../tools/lib/dashboard.mjs';
import { decide } from '../tools/lib/inbox.mjs';
import { init } from '../tools/lib/install.mjs';
import { proposeFeature } from '../tools/lib/intake.mjs';
import { readEvents } from '../tools/lib/ledger.mjs';
import { setup } from '../tools/lib/setup.mjs';
import { pipelineFor } from '../tools/lib/state.mjs';
import { readJson, run, writeJson } from '../tools/lib/util.mjs';
import { FAKE_VERIFIER, REPO, cleanup, sh, stateOf, tempDir, tickUntil } from './helpers.mjs';

after(cleanup);

const FAKE_BF = join(REPO, 'test', 'fixtures', 'fake-bf-worker.mjs');
const HAS_PY = run('python3 -c "import unittest"').code === 0;
const quiet = () => {};

const FILES = {
  'budget/__init__.py': '',
  'budget/core.py': [
    'def total(entries):', "    return sum(e['amount'] for e in entries)", '', '',
    'def label(name):', '    return name.title()', '', '',
    'def average(entries):', "    return round(sum(e['amount'] for e in entries) / len(entries), 2)", '',
  ].join('\n'),
  'tests/__init__.py': '',
  // test_rounding 在主線上本來就紅(1.5 != 1):基線要記下它,之後合併不算到 worker 頭上
  'tests/test_core.py': [
    'import unittest', 'from budget.core import total, label, average', '',
    'class CoreTest(unittest.TestCase):',
    "    def test_total(self):\n        self.assertEqual(total([{'amount': 1}]), 1)",
    "    def test_label(self):\n        self.assertEqual(label('food'), 'Food')",
    "    def test_rounding(self):\n        self.assertEqual(average([{'amount': 1}, {'amount': 2}]), 1)", '',
  ].join('\n'),
  'README.md': '# budget\n',
};

/** 既有的 Python 專案(有 git 歷史),裝上 dp,setup 選 brownfield。 */
async function existingPython(mode = 'good') {
  const proj = join(tempDir('dp-bf-'), 'budget');
  for (const [f, t] of Object.entries(FILES)) { mkdirSync(dirname(join(proj, f)), { recursive: true }); writeFileSync(join(proj, f), t); }
  sh(proj, 'git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm "existing project"');
  const r = init(proj, { name: 'budget', existing: true });
  // v4.7.3:已經有 git 的專案,init 自己把 dp 的檔 commit(以前這裡要手動 commit,真的使用者不會知道要這樣做)
  assert.ok(r.committed, 'init 把 dp 的檔 commit 了');
  assert.equal(sh(proj, 'git status --porcelain --untracked-files=no'), '');
  const asked = [];
  const answers = { platform: '2', worker_cmd: `FAKE_MODE=${mode} node ${FAKE_BF}` };
  await setup(proj, { ask: async (q) => { asked.push(q.id); return answers[q.id] ?? ''; }, detect: { claude: false }, log: quiet });
  // 測試用:假的小模型、不簽章
  const cfg = readJson(join(proj, 'dp.config.json'));
  cfg.agents.verifier = { ...cfg.agents.verifier, backend: 'cmd', cmd: `FV=ok node ${FAKE_VERIFIER}` };
  writeJson(join(proj, 'dp.config.json'), cfg);
  sh(proj, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm verifier');
  return { proj, init: r, asked };
}

const SPEC = {
  id: 'budget/v1', title: '匯出 CSV', intent: '把記帳資料匯出成 CSV',
  owns: ['budget/core.py'], tests: ['tests/test_export.py'], accept: 'python3 -m unittest tests/test_export.py',
};
const GHERKIN = 'Feature: export\n  Scenario: export one entry\n    Given an entry of 10\n    When I export to CSV\n    Then I get "amount" and "10"\n';

test('失敗測試名稱:各家測試框架的輸出都抓得到,看不懂回 null', () => {
  assert.deepEqual(failingTests('FAIL: test_rounding (tests.test_core.CoreTest.test_rounding)\n'), ['tests.test_core.CoreTest.test_rounding']);
  assert.deepEqual(failingTests('FAIL: test_x (test_core.CoreTest)\n'), ['test_core.CoreTest.test_x']);
  assert.deepEqual(failingTests('FAILED tests/test_a.py::test_one - assert 1 == 2\nERROR tests/test_b.py::test_two\n'), ['tests/test_a.py::test_one', 'tests/test_b.py::test_two']);
  assert.deepEqual(failingTests('    --- FAIL: TestAdd (0.00s)\nFAIL\n'), ['TestAdd']);
  assert.deepEqual(failingTests('test parse::bad ... FAILED\n'), ['parse::bad']);
  assert.deepEqual(failingTests('not ok 3 - adds two numbers\n'), ['adds two numbers']);
  assert.deepEqual(failingTests(' FAIL  src/a.test.ts > math > adds\n'), ['src/a.test.ts > math > adds']);
  assert.equal(failingTests('Segmentation fault\n'), null);
  const base = { gates: [{ name: 'test', exit: 1, failing: ['t.C.test_a'] }] };
  assert.equal(knownRed(base, 'test', 'FAIL: test_a (t.C.test_a)\n').ok, true);
  assert.deepEqual(knownRed(base, 'test', 'FAIL: test_a (t.C.test_a)\nERROR: test_b (t.C.test_b)\n'), { ok: false, fresh: ['t.C.test_b'] });
  assert.equal(knownRed(base, 'test', 'boom'), null, '看不懂的輸出不能當成跟基線一樣');
  assert.equal(knownRed({ gates: [{ name: 'test', exit: 0, failing: [] }] }, 'test', 'FAIL: test_a (t.C.test_a)\n'), null);
});

test('characterize 測試的預設路徑跟節點自己的測試分開', () => {
  assert.equal(characterizeTestPath('budget/core.py', 'python'), 'tests/test_core_characterize.py');
  assert.equal(characterizeTestPath('src/ledger/store.ts', 'node'), 'src/ledger/store.characterize.test.ts');
  assert.equal(characterizeTestPath('pkg/calc/add.go', 'go'), 'pkg/calc/add_characterize_test.go');
  assert.equal(characterizeTestPath('docs/x.md', 'node'), null);
});

test('新專案偵測成 greenfield,setup 預設不變', async () => {
  const proj = join(tempDir(), 'fresh');
  init(proj, { name: 'fresh' });
  assert.equal(detectProject(proj).suggested_mode, 'greenfield');
  await setup(proj, { ask: async (q) => (q.id === 'npm_install' ? 'n' : ''), detect: { claude: true }, log: quiet });
  const cfg = loadConfig(proj);
  assert.equal(cfg.project.mode, 'greenfield');
  assert.deepEqual(cfg.gates.chain, ['check:dp', 'typecheck', 'test', 'accept']);
});

test('既有 Python 專案:init 不裝 TS 工具鏈、setup 預設 brownfield、gate 跑 unittest', { skip: !HAS_PY && '沒有 python3' }, async () => {
  const { proj, init: r, asked } = await existingPython();
  assert.equal(r.profile, 'existing');
  for (const f of ['package.json', 'tsconfig.json', 'vitest.config.ts', 'scripts/check-boundaries.ts', 'features/steps/_world.ts']) {
    assert.ok(!existsSync(join(proj, f)), `${f} 不該裝進 Python 專案`);
  }
  assert.ok(existsSync(join(proj, 'tools/dp.mjs')) && existsSync(join(proj, '.claude/skills/brownfield-onboard/SKILL.md')));
  assert.ok(asked.includes('mode') && asked.includes('test_cmd'));
  const cfg = loadConfig(proj);
  assert.equal(cfg.project.mode, 'brownfield');
  assert.equal(cfg.project.language, 'python');
  assert.deepEqual(cfg.gates.chain, ['check:dp', 'test']);
  assert.equal(cfg.gates.commands.test, 'python3 -m unittest discover -s tests -t .');
  assert.equal(cfg.verify.dry_run_cmd, null);
  assert.equal(cfg.verify.mutation.cmd, null);
  assert.ok(cfg.verify.rerun_allow.includes('python3 -m unittest'));
  assert.ok(cfg.paths.tests.includes('**/test_*.py'));
  // upgrade 也記得這是既有專案:不會補裝 package.json
  assert.ok(!run('node tools/dp.mjs upgrade --dry-run', { cwd: proj }).stdout.includes('create package.json'));
});

test('onboard:基線記下本來就紅的測試,AS-IS 與 ROADMAP v0;doctor 看得到', { skip: !HAS_PY && '沒有 python3' }, async () => {
  const { proj } = await existingPython();
  const r = run('node tools/dp.mjs onboard', { cwd: proj });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /test 本來就紅.1 個測試/);
  const b = readJson(join(proj, 'docs/dp-baseline.json'));
  assert.deepEqual(b.gates.map((g) => g.name), ['test'], 'check:dp 不進基線');
  assert.deepEqual(b.gates[0].failing, ['tests.test_core.CoreTest.test_rounding']);
  const asis = readFileSync(join(proj, 'docs/AS-IS.md'), 'utf8');
  assert.match(asis, /python3 -m unittest discover/);
  assert.match(asis, /test_rounding/);
  assert.match(asis, /`budget\/` \| 2 \| 待補/);
  assert.match(readFileSync(join(proj, 'docs/ROADMAP.md'), 'utf8'), /^- v0 現況:/m);
  assert.equal(sh(proj, 'git status --porcelain -- docs'), '', 'onboard 要 commit');
  const doc = run('node tools/dp.mjs doctor', { cwd: proj }).stdout;
  assert.match(doc, /測試基線.*test 有 1 個本來就紅/);
  assert.match(doc, /合併 gate.*test\(python3 -m unittest discover -s tests -t \.\)/);
  // 主控台:模式與基線
  const d = dashboardData(proj);
  assert.equal(d.mode.mode, 'brownfield');
  assert.equal(d.mode.asis, true);
  assert.deepEqual(d.mode.baseline.gates, [{ name: 'test', exit: 1, failing: 1 }]);
  assert.deepEqual(d.roadmap.map((x) => x.release), ['v0', 'v1']);
});

test('intake:沒寫 accept 會擋;owns 碰到既有程式自動加 characterize;範圍太大要縮', { skip: !HAS_PY && '沒有 python3' }, async () => {
  const { proj } = await existingPython();
  const { accept, ...noAccept } = SPEC;
  assert.throws(() => proposeFeature(proj, noAccept, GHERKIN), /既有專案沒有 accept script/);
  const p = proposeFeature(proj, SPEC, GHERKIN);
  const node = readJson(join(proj, p.path)).nodes[0];
  assert.deepEqual(node.characterize, {
    targets: ['budget/core.py'], tests: ['tests/test_core_characterize.py'], cmd: 'python3 -m unittest tests/test_core_characterize.py',
  });
  assert.deepEqual(pipelineFor(node, loadConfig(proj)), ['characterize', 'test', 'dev']);
  const req = readEvents(proj).filter((e) => e.type === 'decision_request').at(-1);
  assert.match(req.question, /先釘住 1 個既有檔的現有行為/);
  const skipped = proposeFeature(proj, { ...SPEC, id: 'budget/v2', characterize: { skip: '整個要換掉' } }, GHERKIN);
  assert.deepEqual(pipelineFor(readJson(join(proj, skipped.path)).nodes[0], loadConfig(proj)), ['test', 'dev']);
  for (let i = 0; i < 11; i++) writeFileSync(join(proj, `budget/m${i}.py`), 'x = 1\n');
  sh(proj, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm more');
  assert.throws(() => proposeFeature(proj, { ...SPEC, id: 'budget/v3', owns: ['budget/**'] }, GHERKIN), /一棒釘不完/);
});

async function approved(mode) {
  const { proj } = await existingPython(mode);
  assert.equal(run('node tools/dp.mjs onboard', { cwd: proj }).code, 0);
  const p = proposeFeature(proj, SPEC, GHERKIN);
  decide(proj, `node:${p.id}`, 'yes', '好');
  return proj;
}

test('brownfield 從提案到合併:characterize(綠)→ test(紅)→ dev(綠),本來就紅的測試不擋合併', { skip: !HAS_PY && '沒有 python3' }, async () => {
  const proj = await approved('good');
  const s = await tickUntil(proj, (st) => st.nodes.get('budget/v1')?.status === 'done');
  const ds = [...s.dispatches.values()].filter((d) => d.node_id === 'budget/v1');
  assert.deepEqual(ds.map((d) => d.leg), ['characterize', 'test', 'dev']);
  const envs = ds.map((d) => readJson(join(proj, 'ledger/dispatch', d.dispatch_id, 'envelope.json')));
  // characterize:只能寫釘住的測試,原始碼與節點自己的測試都不准碰;必須綠
  assert.deepEqual(envs[0].allowed_paths, ['tests/test_core_characterize.py']);
  assert.ok(envs[0].forbidden_paths.includes('budget/core.py'));
  assert.deepEqual(envs[0].acceptance, [{ cmd: 'python3 -m unittest tests/test_core_characterize.py', expect_exit: 0 }]);
  // test:寫節點自己的測試(紅),不准改 characterize 測試
  assert.deepEqual(envs[1].allowed_paths.filter((p) => p.startsWith('tests/')), ['tests/test_export.py']);
  assert.ok(envs[1].forbidden_paths.includes('tests/test_core_characterize.py'));
  assert.deepEqual(envs[1].acceptance, [{ cmd: SPEC.accept, expect_exit: -1 }]);
  // dev:自己的驗收綠 + characterize 也要維持綠
  assert.deepEqual(envs[2].acceptance, [{ cmd: SPEC.accept, expect_exit: 0 }, { cmd: 'python3 -m unittest tests/test_core_characterize.py', expect_exit: 0 }]);
  const gates = readEvents(proj).filter((e) => e.type === 'gates').at(-1);
  assert.equal(gates.ok, true);
  assert.deepEqual(gates.results.map((g) => [g.name, g.exit === 0 || !!g.known_red]), [['check:dp', true], ['test', true]]);
  assert.equal(gates.results.find((g) => g.name === 'test').known_red, 1, 'test_rounding 本來就紅');
  assert.match(sh(proj, 'cat budget/core.py'), /def to_csv/);
  assert.ok(existsSync(join(proj, 'tests/test_core_characterize.py')));
  const d = dashboardData(proj);
  assert.deepEqual(d.nodes.find((n) => n.id === 'budget/v1').pipeline, ['characterize', 'test', 'dev']);
  assert.match(d.timeline.filter((e) => e.type === 'gates').at(-1).detail, /≈ test.*1 個是基線裡本來就紅的/);
});

test('實作棒改壞了 characterize 釘住的行為:退回', { skip: !HAS_PY && '沒有 python3' }, async () => {
  const proj = await approved('breaker');
  const s = await tickUntil(proj, (st) => [...st.dispatches.values()].some((d) => d.leg === 'dev' && d.state === 'rejected'));
  const dev = [...s.dispatches.values()].find((d) => d.leg === 'dev' && d.state === 'rejected');
  const v = readJson(join(proj, 'ledger/dispatch', dev.dispatch_id, 'verify.json'));
  const fail = v.find((x) => x.check === 'acceptance' && x.outcome === 'FAIL');
  assert.match(fail.detail, /test_core_characterize\.py → exit [1-9]/);
});

test('基線以外新紅一個測試:合併 gate 擋下,並指出是哪一個', { skip: !HAS_PY && '沒有 python3' }, async () => {
  const proj = await approved('regress');
  await tickUntil(proj, (st) => [...st.dispatches.values()].some((d) => d.leg === 'dev' && d.state === 'rejected'));
  const gates = readEvents(proj).filter((e) => e.type === 'gates').at(-1);
  assert.equal(gates.ok, false);
  assert.match(gates.output_tail, /基線以外新紅的測試:tests\.test_core\.CoreTest\.test_label/);
});

test('onboard 不覆蓋已經有的 AS-IS 與 ROADMAP', { skip: !HAS_PY && '沒有 python3' }, async () => {
  const { proj } = await existingPython();
  mkdirSync(join(proj, 'docs'), { recursive: true });
  writeFileSync(join(proj, 'docs/AS-IS.md'), '# mine\n');
  sh(proj, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm asis');
  const r = onboard(proj, loadConfig(proj));
  assert.deepEqual(r.written, ['docs/dp-baseline.json', 'docs/ROADMAP.md']);
  assert.equal(readFileSync(join(proj, 'docs/AS-IS.md'), 'utf8'), '# mine\n');
});

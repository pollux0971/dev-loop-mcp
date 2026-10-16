// v4 的改動:每一條都對應 v3 實測報告裡的一個問題(見 docs/dp/CHANGELOG.md 的 4.0.0)。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decide } from '../tools/lib/inbox.mjs';
import { proposeBundle, proposeFeature } from '../tools/lib/intake.mjs';
import { readEvents } from '../tools/lib/ledger.mjs';
import { Ctx, haltWorkers, tick } from '../tools/lib/orchestrator.mjs';
import { pendingFeatures } from '../tools/lib/pending.mjs';
import { depsStatus } from '../tools/lib/snapshot.mjs';
import { replay } from '../tools/lib/state.mjs';
import { codeChunks, gherkinLiterals } from '../tools/lib/verify/index.mjs';
import { pidAlive } from '../tools/lib/util.mjs';
import {
  CALC, CALC_GHERKIN, I1, I1_GHERKIN, REPO, addNode, cleanup, makeProject, stateOf, tempDir, tickUntil, writeFile,
} from './helpers.mjs';

after(cleanup);
const FAKE_AGENT = join(REPO, 'test', 'fixtures', 'fake-agent.mjs');
const agentCmd = (out) => `FAKE_OUT='${JSON.stringify(out)}' node ${FAKE_AGENT}`;
const openRequests = (s) => [...s.decisions.values()].filter((r) => r.request && !r.answer).map((r) => r.request);
const DP = join(REPO, 'tools', 'dp.mjs');

test('test-fix:實作棒說測試寫錯 → 問使用者(推薦退回)→ 退回測試棒修正 → 實作棒重來 → 合併', async () => {
  const proj = makeProject({ mode: 'badtest' });
  addNode(proj, CALC, CALC_GHERKIN);
  let s = await tickUntil(proj, (st) => openRequests(st).some((r) => r.ref.startsWith('testfix:')));
  const req = openRequests(s).find((r) => r.ref.startsWith('testfix:'));
  assert.equal(req.recommendation, 'reopen');
  assert.deepEqual(req.options.map((o) => o.key), ['reopen', 'retry', 'block']);
  decide(proj, req.ref, 'reopen', '測試寫錯了,改測試');
  s = await tickUntil(proj, (st) => st.nodes.get('calc/v1').status === 'done');
  const legs = readEvents(proj).filter((e) => e.type === 'dispatch').map((e) => e.leg);
  assert.deepEqual(legs, ['test', 'dev', 'test-fix', 'dev']);
  const reopen = readEvents(proj).find((e) => e.type === 'leg_reopen');
  assert.equal(reopen.leg, 'test-fix');
  assert.match(readFileSync(join(proj, 'packages/calc/src/calc.test.mjs'), 'utf8'), /run\(2, 3\), 5/);
});

test('test-fix(L2):Critic 確認測試寫錯就自動退回測試棒,不問使用者', async () => {
  const proj = makeProject({ mode: 'badtest', level: 2, config: { agents: { critic: { cmd: agentCmd({ verdict: 'PASS', reason: '測試期望 6,gherkin 是 5' }) } } } });
  addNode(proj, CALC, CALC_GHERKIN);
  const s = await tickUntil(proj, (st) => st.nodes.get('calc/v1').status === 'done');
  assert.ok(!openRequests(s).some((r) => r.ref.startsWith('testfix:')));
  assert.ok(readEvents(proj).some((e) => e.type === 'leg_reopen'));
});

test('test-fix 在 state 裡:插一棒、做完回到原 pipeline,退回次數有記', () => {
  const dag = { version: 1, nodes: [{ ...CALC, kind: 'phase' }] };
  const ev = (seq, type, f) => ({ seq, type, ts: '2026-01-01T00:00:00Z', ...f });
  const events = [
    ev(1, 'dispatch', { dispatch_id: 'd1', node_id: 'calc/v1', leg: 'test', attempt: 1, branch: 'b', worktree: 'w', base_sha: 'x' }),
    ev(2, 'leg_done', { dispatch_id: 'd1', node_id: 'calc/v1', leg: 'test' }),
    ev(3, 'leg_reopen', { node_id: 'calc/v1', leg: 'test-fix', ref: 'testfix:d2', findings: [{ check: 'test-fix', detail: 'x' }] }),
  ];
  let n = replay(events, dag).nodes.get('calc/v1');
  assert.equal(n.pendingLeg, 'test-fix');
  assert.equal(n.reopens, 1);
  assert.equal(n.status, 'todo');
  events.push(ev(4, 'dispatch', { dispatch_id: 'd3', node_id: 'calc/v1', leg: 'test-fix', attempt: 1, branch: 'b', worktree: 'w', base_sha: 'y' }));
  events.push(ev(5, 'leg_done', { dispatch_id: 'd3', node_id: 'calc/v1', leg: 'test-fix' }));
  n = replay(events, dag).nodes.get('calc/v1');
  assert.equal(n.pendingLeg, null);
  assert.deepEqual(n.legsDone, ['test']);
});

test('連續失敗卡住時推薦「擱置」,不再推薦沒有指示的重試', async () => {
  const proj = makeProject({ mode: 'forbidden' });
  addNode(proj, CALC, CALC_GHERKIN);
  const s = await tickUntil(proj, (st) => st.nodes.get('calc/v1').status === 'blocked');
  const stuck = openRequests(s).find((r) => r.ref.startsWith('stuck:'));
  assert.equal(stuck.recommendation, 'block');
  assert.ok(stuck.options.some((o) => o.key === 'reopen'), '實作棒卡住時可以選退回測試棒');
});

test('停機會終止還在跑的 worker:記成 halted,不算嘗試次數,worktree 不動', async () => {
  const proj = makeProject({ mode: 'hang' });
  addNode(proj, CALC, CALC_GHERKIN);
  await tick(proj);
  let s = stateOf(proj);
  const d = [...s.dispatches.values()][0];
  for (let i = 0; i < 50 && !d.pid; i++) await new Promise((r) => setTimeout(r, 50));
  const ctx = new Ctx(proj);
  const pid = ctx.state.dispatches.get(d.dispatch_id).pid;
  assert.ok(pid && pidAlive(pid));
  const stopped = haltWorkers(ctx);
  assert.deepEqual(stopped, [d.dispatch_id]);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!pidAlive(pid), 'worker 被終止');
  s = stateOf(proj);
  const n = s.nodes.get('calc/v1');
  assert.equal(n.status, 'todo');
  assert.equal(n.legAttempts, 0, '不算一次嘗試');
  assert.equal(n.findings.length, 0, '不留 findings');
  assert.equal(s.infraStreak, 0);
  assert.equal(readEvents(proj).find((e) => e.type === 'worker_failed').class, 'halted');
});

test('pending features:已批准但沒做完的 gherkin 不進全 gate;正在合併的節點自己的照跑', () => {
  const dag = { version: 1, nodes: [
    { id: 'a/v1', kind: 'phase', gherkin: 'features/a/v1.feature' },
    { id: 'b/v1', kind: 'phase', gherkin: 'features/b/v1.feature' },
    { id: 'c/v1', kind: 'phase', gherkin: 'features/c/v1.feature' },
    { id: 's', kind: 'shared' },
  ] };
  const state = { nodes: new Map([['a/v1', { status: 'done' }], ['b/v1', { status: 'review' }], ['c/v1', { status: 'todo' }], ['s', { status: 'todo' }]]) };
  assert.deepEqual(pendingFeatures(dag, state), ['features/b/v1.feature', 'features/c/v1.feature']);
  assert.deepEqual(pendingFeatures(dag, state, 'b/v1'), ['features/c/v1.feature']);
});

test('payload 的 cucumber.js:命令列給了路徑就只跑那些;沒給就跳過 pending 清單', () => {
  const dir = tempDir();
  for (const f of ['features/a/v1.feature', 'features/b/v1.feature', 'features/_template/x.feature', 'docs/integration/i1.feature']) {
    spawnSync('mkdir', ['-p', join(dir, f, '..')]);
    writeFile(join(dir, f), 'Feature: x\n');
  }
  spawnSync('mkdir', ['-p', join(dir, '.dp')]);
  const load = (args, pending) => {
    writeFile(join(dir, '.dp', 'pending-features.json'), JSON.stringify(pending));
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(join(REPO, 'payload', 'cucumber.js'))}); console.log(JSON.stringify(m.default.paths))`, 'cucumber-js', ...args], { cwd: dir, encoding: 'utf8' });
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(load([], []), ['features/a/v1.feature', 'features/b/v1.feature', 'docs/integration/i1.feature']);
  assert.deepEqual(load([], ['features/b/v1.feature']), ['features/a/v1.feature', 'docs/integration/i1.feature']);
  assert.deepEqual(load(['features/b/v1.feature'], ['features/b/v1.feature']), []);
  assert.deepEqual(load([], ['features/a/v1.feature', 'features/b/v1.feature', 'docs/integration/i1.feature']), ['features/__none__/*.feature']);
});

test('scenario-honesty 的材料:gherkin 的具體值、程式依行切段', () => {
  const dir = tempDir();
  spawnSync('mkdir', ['-p', join(dir, 'features')]);
  writeFile(join(dir, 'features', 'x.feature'), 'Feature: x\n  Scenario: y\n    Given a book "Groceries" on 2026-03-01\n    Then the total is 1250\n    | name | amount |\n    | rent | 900 |\n');
  const lit = gherkinLiterals(dir, 'features/x.feature');
  for (const v of ['Groceries', '2026-03-01', '1250', '900']) assert.ok(lit.includes(v), v);
  const code = Array.from({ length: 100 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const chunks = codeChunks(code, 400);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].from, 1);
  assert.equal(chunks.at(-1).to, 100);
  for (const [i, c] of chunks.entries()) if (i) assert.equal(c.from, chunks[i - 1].to + 1);
});

test('shared 節點附 gherkin 但沒指定路徑 → 說清楚,不寫出 undefined 檔', () => {
  const proj = makeProject();
  assert.throws(() => proposeFeature(proj, { id: 'shared/util', kind: 'shared', title: 'u', intent: 'u', owns: ['packages/util/**'] }, 'Feature: u\n'), /shared 沒有預設的 gherkin 路徑/);
  assert.ok(!existsSync(join(proj, 'undefined')));
});

test('非 shared 節點 owns gate 定義檔 → 提案時就拒絕', () => {
  const proj = makeProject();
  assert.throws(() => proposeFeature(proj, { ...I1, owns: ['packages/app/**', 'package.json'] }, I1_GHERKIN), /只有 shared 節點能改/);
});

test('intake bundle:一版一次批准;沒有整合點就拒絕;下一版自動依賴上一版的整合點', () => {
  const proj = makeProject();
  assert.throws(() => proposeBundle(proj, { release: 'v1', nodes: [{ ...CALC, gherkin_text: CALC_GHERKIN }] }), /沒有整合點/);
  assert.throws(() => proposeBundle(proj, { release: 'v1', nodes: [{ ...CALC, gherkin_text: CALC_GHERKIN }, { ...I1, depends_on: [], gherkin_text: I1_GHERKIN }] }), /沒有依賴這一版的 calc\/v1/);
  const p1 = proposeBundle(proj, { release: 'v1', goal: '能算加法', roadmap: '# 路線\n- v1 加法\n- v2 減法\n', nodes: [{ ...CALC, gherkin_text: CALC_GHERKIN }, { ...I1, gherkin_text: I1_GHERKIN }] });
  decide(proj, `node:${p1.id}`, 'yes', '好');
  const ctxTick = spawnSync(process.execPath, [DP, 'intake', 'apply', p1.id], { cwd: proj, encoding: 'utf8' });
  assert.equal(ctxTick.status, 0, ctxTick.stderr);
  assert.match(readFileSync(join(proj, 'docs/ROADMAP.md'), 'utf8'), /v2 減法/);
  const sub = { id: 'sub/v1', kind: 'phase', title: '減法', intent: '提供 sub(a,b)', owns: ['packages/sub/**'], depends_on: ['contracts@1'], accept: 'node --test packages/sub/src/sub.test.mjs' };
  const i2 = { id: 'I2', kind: 'integration', title: '減法能用', intent: '使用者看得到減法', owns: ['packages/app2/**'], depends_on: ['sub/v1'], accept: 'node packages/app2/main.mjs' };
  const p2 = proposeBundle(proj, { release: 'v2', nodes: [{ ...sub, gherkin_text: 'Feature: sub\n  Scenario: s\n    When I subtract 5 and 3\n    Then the result is 2\n' }, { ...i2, gherkin_text: '@integration\nFeature: app2\n  @e2e\n  Scenario: u\n    When I run app2\n    Then I see 2\n' }] });
  const proposal = JSON.parse(readFileSync(join(proj, p2.path), 'utf8'));
  assert.ok(proposal.nodes.find((n) => n.id === 'sub/v1').depends_on.includes('I1'), '這一版的起點依賴上一版的整合點');
  assert.ok(!proposal.nodes.find((n) => n.id === 'I2').depends_on.includes('I1'), '有內部依賴的節點不用再加');
  assert.ok(proposal.nodes.every((n) => n.release === 'v2'));
});

test('版本閘門:依賴的整合點合併了但使用者還沒試用 → 下一版不開工', () => {
  const dag = { nodes: [{ id: 'I1', kind: 'integration' }, { id: 'sub/v1', kind: 'phase', depends_on: ['I1'] }] };
  const state = { nodes: new Map([['I1', { status: 'done', e2e: { requestedSeq: 5, confirm: null } }]]) };
  const node = dag.nodes[1];
  assert.deepEqual(depsStatus(node, state, 1, { dag, gateE2e: true }), ['I1=等使用者試用']);
  assert.deepEqual(depsStatus(node, state, 1, { dag, gateE2e: false }), []);
  state.nodes.get('I1').e2e.confirm = { ok: true };
  assert.deepEqual(depsStatus(node, state, 1, { dag, gateE2e: true }), []);
});

test('dp run --help 只印說明,不啟動背景迴圈;不認得的旗標直接拒絕', () => {
  const proj = makeProject();
  const r = spawnSync(process.execPath, [DP, 'run', '--help'], { cwd: proj, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dp run/);
  assert.ok(!existsSync(join(proj, '.dp', 'run.lock')));
  assert.ok(!existsSync(join(proj, '.dp', 'run.log')));
  const bad = spawnSync(process.execPath, [DP, 'run', '--deamon'], { cwd: proj, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /不認得 --deamon/);
});

test('notify.cmd:有新的事等使用者時通知一次;user-prompt hook 附一行提醒', async () => {
  const out = join(tempDir(), 'notify.txt');
  const proj = makeProject({ level: 0, config: { notify: { cmd: `printf '%s' "$DP_NOTIFY_TEXT" >> ${out}` } } });
  addNode(proj, CALC, CALC_GHERKIN); // 提案是 Front 當著使用者的面提的:不通知
  await tickUntil(proj, (st) => openRequests(st).some((r) => r.ref.startsWith('accept:')));
  assert.match(readFileSync(out, 'utf8'), /1 件新的事.*accept:/);
  const before = readFileSync(out, 'utf8');
  await tick(proj);
  assert.equal(readFileSync(out, 'utf8'), before, '同一件事不重複通知');
  const h = spawnSync(process.execPath, [DP, 'hook', 'user-prompt'], { cwd: proj, encoding: 'utf8', input: JSON.stringify({ prompt: '你好', cwd: proj }), env: { ...process.env, CLAUDE_PROJECT_DIR: proj } });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /【dp】有 1 件決定/);
});

test('dp decide 一次決定多件(accept:* 與逗號清單)', async () => {
  const proj = makeProject({ level: 0, config: { caps: { parallel: 2 } } });
  const spec = (id) => ({ ...CALC, id, owns: [`packages/${id.split('/')[0]}/**`], accept: `node --test packages/${id.split('/')[0]}/src/${id.split('/')[0]}.test.mjs` });
  addNode(proj, spec('a/v1'), CALC_GHERKIN.replace('calc', 'a'));
  addNode(proj, spec('b/v1'), CALC_GHERKIN.replace('calc', 'b'));
  await tickUntil(proj, (st) => openRequests(st).filter((r) => r.ref.startsWith('accept:')).length === 2 || openRequests(st).filter((r) => r.ref.startsWith('accept:')).length >= 1 && [...st.nodes.values()].every((n) => n.status !== 'todo' && n.status !== 'in-progress'), { max: 10 });
  const n = openRequests(stateOf(proj)).filter((r) => r.ref.startsWith('accept:')).length;
  const r = spawnSync(process.execPath, [DP, 'decide', 'accept:*', 'yes', '--verbatim', '都合併'], { cwd: proj, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout.match(/已記錄/g) ?? []).length, n);
  assert.equal(openRequests(stateOf(proj)).filter((x) => x.ref.startsWith('accept:')).length, 0);
});

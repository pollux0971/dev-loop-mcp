// v4 的改動:每一條都對應 v3 實測報告裡的一個問題(見 docs/dp/CHANGELOG.md 的 4.0.0)。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { confirmE2e, decide } from '../tools/lib/inbox.mjs';
import { proposeBundle, proposeFeature } from '../tools/lib/intake.mjs';
import { readEvents } from '../tools/lib/ledger.mjs';
import { Ctx, haltWorkers, tick } from '../tools/lib/orchestrator.mjs';
import { pendingFeatures } from '../tools/lib/pending.mjs';
import { depsStatus } from '../tools/lib/snapshot.mjs';
import { openDecisions, replay } from '../tools/lib/state.mjs';
import { codeChunks, gherkinLiterals } from '../tools/lib/verify/index.mjs';
import { pidAlive } from '../tools/lib/util.mjs';
import {
  CALC, CALC_GHERKIN, FAKE_VERIFIER, I1, I1_GHERKIN, REPO, addNode, cleanup, makeProject, sh, stateOf, tempDir, tickUntil, writeFile,
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

test('新專案的節點把程式放在 packages/ 與 apps/ 以外 → 提案照樣建立,但回提醒(npm test 與 mutation 看不到);既有專案不檢查', () => {
  const proj = makeProject();
  const ok = proposeFeature(proj, CALC, CALC_GHERKIN);
  assert.deepEqual(ok.warnings, [], 'packages/calc/** 在範本的版面裡');
  const off = { ...CALC, id: 'todo/v1', owns: ['src/todo/**', 'bin/todo.mjs'], accept: 'node --test bin/todo.test.mjs' };
  const p = proposeFeature(proj, off, CALC_GHERKIN.replace('calc', 'todo'));
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /todo\/v1 的 owns(.*)不在 packages\/、apps\/ 底下/);
  assert.match(p.warnings[0], /packages\/<能力>\/src/);
  const req = readEvents(proj).filter((e) => e.type === 'decision_request').at(-1);
  assert.match(req.reason, /^提醒:todo\/v1/, '使用者在收件匣也看得到');
  assert.deepEqual(JSON.parse(readFileSync(join(proj, p.path), 'utf8')).warnings, p.warnings);
  const viaOp = spawnSync(process.execPath, [DP, 'op', 'propose_feature'], {
    cwd: proj, encoding: 'utf8', input: JSON.stringify({ spec: { ...off, id: 'todo2/v1', owns: ['lib/todo2/**'] }, gherkin: CALC_GHERKIN }),
  });
  const out = JSON.parse(viaOp.stdout.trim().split('\n').at(-1));
  assert.ok(out.ok, viaOp.stdout + viaOp.stderr);
  assert.equal(out.result.warnings.length, 1, 'MCP / API 的結果也帶提醒');

  const bf = makeProject({ config: { project: { mode: 'brownfield', language: 'node' } } });
  assert.deepEqual(proposeFeature(bf, off, CALC_GHERKIN).warnings, [], '既有專案照它自己的版面');
});

test('整合點的驗收在動手前就是綠的:測試棒卡住時多一個「跳過測試棒」,選了記 leg_done;整合棒零變動也能過;合併後請使用者試用', async () => {
  // 這裡測「派出去之後才發現綠、worker 回報卡住」的路徑,所以關掉派工前的檢查(下一個測試測它)
  const proj = makeProject({ mode: 'already-green', config: { integration: { precheck_green: false } } });
  addNode(proj, CALC, CALC_GHERKIN);
  await tickUntil(proj, (st) => st.nodes.get('calc/v1').status === 'done');
  // 能力節點那邊已經把整合點要的入口做好了(實測:只看得到 MCP 的 AI 把命令列入口放在能力節點裡)
  sh(proj, `mkdir -p packages/app && echo "console.log('ok');" > packages/app/main.mjs && git add -A && git -c user.name=t -c user.email=t@t commit -qm app`);
  addNode(proj, I1, I1_GHERKIN);
  const open = (st) => [...st.decisions.values()].find((r) => r.request?.ref.startsWith('escalation:') && !r.answer)?.request;
  let s = await tickUntil(proj, (st) => open(st));
  const req = open(s);
  assert.ok(req.options.some((o) => o.key === 'skip'), JSON.stringify(req.options));
  assert.equal(req.recommendation, 'skip');
  assert.match(req.reason, /node packages\/app\/main\.mjs,exit 0/);
  decide(proj, req.ref, 'skip', '跳過測試棒');
  s = await tickUntil(proj, (st) => st.nodes.get('I1').status === 'done');
  const iTest = [...s.dispatches.values()].find((d) => d.node_id === 'I1' && d.leg === 'test');
  assert.ok(readEvents(proj).some((e) => e.type === 'leg_done' && e.dispatch_id === iTest.dispatch_id && e.leg === 'test'), '記 leg_done');
  const integ = [...s.dispatches.values()].find((d) => d.node_id === 'I1' && d.leg === 'integrate' && d.state === 'accepted');
  assert.ok(integ, '接著跑整合棒並合併');
  assert.ok(integ.verify.results.some((r) => r.check === 'paths' && r.outcome === 'PASS' && /沒有檔案變動/.test(r.detail)), '整合棒零變動不算失敗');
  assert.ok(s.nodes.get('I1').e2e?.requestedSeq, '合併後請使用者試用');
});

test('整合點的驗收在派測試棒之前就是綠的:不派測試棒(記 note 與 leg_done)、接著派整合棒、合併後請使用者試用;重做時照樣派', async () => {
  const proj = makeProject({ mode: 'already-green' });
  addNode(proj, CALC, CALC_GHERKIN);
  await tickUntil(proj, (st) => st.nodes.get('calc/v1').status === 'done');
  sh(proj, `mkdir -p packages/app && echo "console.log('ok');" > packages/app/main.mjs && git add -A && git -c user.name=t -c user.email=t@t commit -qm app`);
  addNode(proj, I1, I1_GHERKIN);
  const s = await tickUntil(proj, (st) => st.nodes.get('I1')?.status === 'done');
  const ev = readEvents(proj);
  assert.ok(ev.some((e) => e.type === 'note' && e.node_id === 'I1' && /派測試棒之前就是綠的/.test(e.text)), '記下為什麼不派');
  assert.ok(ev.some((e) => e.type === 'leg_done' && e.node_id === 'I1' && e.leg === 'test' && e.dispatch_id === 'precheck-I1'));
  const legs = [...s.dispatches.values()].filter((d) => d.node_id === 'I1').map((d) => d.leg);
  assert.deepEqual(legs, ['integrate'], '測試棒沒有派 worker');
  assert.ok(!ev.some((e) => e.type === 'decision_request' && e.ref.startsWith('escalation:')), '不用問使用者');
  assert.ok(s.nodes.get('I1').e2e?.requestedSeq, '合併後照樣請使用者試用');
  // 試用失敗 → 重做帶 findings:測試棒照樣派(可能要補測試)
  confirmE2e(proj, 'I1', false, '還不行');
  const s2 = await tickUntil(proj, (st) => [...st.dispatches.values()].filter((d) => d.node_id === 'I1').length > 1);
  assert.equal([...s2.dispatches.values()].filter((d) => d.node_id === 'I1').at(-1).leg, 'test', '重做時派測試棒');
});

test('整合點的 gherkin 沿用能力的句子(一字不差)→ 提案帶提醒;句子不同就沒有', () => {
  const proj = makeProject();
  const clean = proposeBundle(proj, { release: 'v1', nodes: [{ ...CALC, gherkin_text: CALC_GHERKIN }, { ...I1, gherkin_text: I1_GHERKIN }] });
  assert.deepEqual(clean.warnings, []);
  const reused = '@integration\nFeature: app\n  @e2e\n  Scenario: u\n    When I add 2 and 3\n    Then the result is 5\n    And I see ok\n';
  const p = proposeBundle(proj, { release: 'v1b', nodes: [{ ...CALC, id: 'calc2/v1', owns: ['packages/calc2/**'], gherkin_text: CALC_GHERKIN }, { ...I1, id: 'I9', owns: ['packages/app9/**'], depends_on: ['calc2/v1'], gherkin_text: reused }] });
  assert.equal(p.warnings.length, 1, JSON.stringify(p.warnings));
  assert.match(p.warnings[0], /I9 的 gherkin 有 2\/3 句跟能力節點一字不差(.*)測試棒做不出紅燈/);
});

test('改提案:新提案帶 supersedes 取代還沒決定的舊提案(舊的不再待決、不能批准);沒帶又有同樣的節點會提醒', () => {
  const proj = makeProject();
  const p1 = proposeFeature(proj, CALC, CALC_GHERKIN);
  const p2 = proposeFeature(proj, { ...CALC, intent: '改過的 intent' }, CALC_GHERKIN, { supersedes: [p1.id] });
  assert.deepEqual(p2.supersedes, [`node:${p1.id}`]);
  assert.ok(!p2.warnings.some((w) => w.includes(p1.id)), '帶了 supersedes 就不提醒重複');
  let s = stateOf(proj);
  assert.equal(s.decisions.get(`node:${p1.id}`).superseded, `node:${p2.id}`);
  assert.ok(!openDecisions(s).some((r) => r.ref === `node:${p1.id}`), '舊的不再待決');
  assert.throws(() => decide(proj, `node:${p1.id}`, 'yes', '好'), /已經被 node:p-002 取代/);
  assert.match(readEvents(proj).filter((e) => e.type === 'decision_request').at(-1).question, /取代 p-001/);
  const p3 = proposeFeature(proj, { ...CALC, intent: '又改一次' }, CALC_GHERKIN);
  assert.ok(p3.warnings.some((w) => /p-002 還在等決定,也有 calc\/v1(.*)supersedes: \["p-002"\]/.test(w)), JSON.stringify(p3.warnings));
  assert.throws(() => proposeFeature(proj, CALC, CALC_GHERKIN, { supersedes: [p1.id] }), /已經被 node:p-002 取代了/);
  decide(proj, `node:${p3.id}`, 'no', '不要這份');
  assert.throws(() => proposeFeature(proj, CALC, CALC_GHERKIN, { supersedes: [p3.id] }), /已經決定過了/);
  decide(proj, `node:${p2.id}`, 'yes', '好');
  const viaOp = spawnSync(process.execPath, [DP, 'op', 'propose_feature'], { cwd: proj, encoding: 'utf8', input: JSON.stringify({ spec: { ...CALC, id: 'calc2/v1', owns: ['packages/calc2/**'] }, gherkin: CALC_GHERKIN, supersedes: ['p-009'] }) });
  assert.match(viaOp.stdout, /node:p-009 不是一份提案/);
});

test('宣稱的證據就是驗收指令、dp 已經重跑確認:不再問小模型,兩種問法不一致也不會變成沒把握;其他宣稱照舊問', async () => {
  const proj = makeProject({ config: { agents: { verifier: { backend: 'cmd', cmd: `FV=disagree node ${FAKE_VERIFIER}` } } } });
  addNode(proj, CALC, CALC_GHERKIN);
  const s = await tickUntil(proj, (st) => [...st.dispatches.values()].some((d) => d.leg === 'test' && d.verify));
  const t = [...s.dispatches.values()].find((d) => d.leg === 'test');
  const cs = t.verify.results.filter((r) => r.check === 'claim-supported');
  assert.ok(cs.length > 0);
  assert.ok(cs.every((r) => r.outcome === 'SKIPPED' && /證據就是驗收指令/.test(r.detail)), JSON.stringify(cs));
  assert.ok(!openDecisions(s).some((r) => r.ref === `accept:${t.dispatch_id}`), '測試棒不用問使用者');
  // 不是多餘的題目照舊問小模型:實作棒的「寫死測試值」題照樣有問(不是 SKIPPED)
  const s2 = await tickUntil(proj, (st) => [...st.dispatches.values()].some((d) => d.leg === 'dev' && d.verify));
  const dev = [...s2.dispatches.values()].find((d) => d.leg === 'dev');
  assert.ok(dev.verify.results.some((r) => r.check === 'scenario-honesty' && r.outcome !== 'SKIPPED'), JSON.stringify(dev.verify.results.map((r) => [r.check, r.outcome])));
  assert.ok(dev.verify.results.filter((r) => r.check === 'claim-supported').every((r) => r.outcome === 'SKIPPED'), '實作棒「驗收通過」的宣稱也不用再問');
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

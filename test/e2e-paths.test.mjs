import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadDag, getNode } from '../tools/lib/dag.mjs';
import { decide } from '../tools/lib/inbox.mjs';
import { append, readEvents } from '../tools/lib/ledger.mjs';
import { Ctx, commitState, harvest, tick } from '../tools/lib/orchestrator.mjs';
import { readJson, writeJson } from '../tools/lib/util.mjs';
import {
  CALC, CALC_GHERKIN, REPO, addNode, cleanup, makeProject, setWorkerMode, sh, stateOf, tempDir, tickUntil, waitWorkers,
} from './helpers.mjs';

after(cleanup);
const FAKE_AGENT = join(REPO, 'test', 'fixtures', 'fake-agent.mjs');
const agentCmd = (out, log) => `FAKE_OUT='${JSON.stringify(out)}'${log ? ` FAKE_PROMPT_LOG=${log}` : ''} node ${FAKE_AGENT}`;
const openRequests = (s) => [...s.decisions.values()].filter((r) => r.request && !r.answer).map((r) => r.request);

test('越界:實作棒偷改測試 → 每次被退回,第 3 次後封鎖並問使用者;使用者說重試才解封', async () => {
  const proj = makeProject({ mode: 'forbidden' });
  addNode(proj, CALC, CALC_GHERKIN);
  let s = await tickUntil(proj, (st) => st.nodes.get('calc/v1').status === 'blocked');
  const rejects = readEvents(proj).filter((e) => e.type === 'reject');
  assert.equal(rejects.length, 3, '同一棒三次');
  assert.ok(rejects.every((r) => r.findings.some((f) => f.check === 'paths' && /calc\.test\.mjs/.test(f.detail))), '退回原因指到被偷改的測試檔');
  const stuck = openRequests(s).find((r) => r.ref.startsWith('stuck:calc/v1'));
  assert.ok(stuck, '封鎖後有待決事項');
  assert.ok(!existsSync(join(proj, 'packages/calc/src/calc.mjs')), '沒有東西進主線');

  // 使用者說重試,並換成守規矩的 worker
  decide(proj, stuck.ref, 'retry', '再試一次,不要碰測試檔');
  setWorkerMode(proj, 'good');
  s = await tickUntil(proj, (st) => st.nodes.get('calc/v1').status === 'done');
  const env = readJson(join(proj, 'ledger/dispatch', [...s.dispatches.values()].at(-1).dispatch_id, 'envelope.json'));
  assert.ok(env.findings?.some((f) => /不要碰測試檔/.test(f.detail)), '使用者原話成為下一張工單的 findings');
});

test('說謊:宣稱驗收 exit 0 但重跑是紅的 → evidence 與 acceptance 都 FAIL', async () => {
  const proj = makeProject({ mode: 'lie' });
  addNode(proj, CALC, CALC_GHERKIN);
  await tickUntil(proj, (st) => readEvents(proj).some((e) => e.type === 'reject' && e.findings.some((f) => f.check === 'evidence')));
  const reject = readEvents(proj).find((e) => e.type === 'reject' && e.findings.some((f) => f.check === 'evidence'));
  assert.ok(reject.findings.some((f) => f.check === 'acceptance'));
  assert.match(reject.findings.find((f) => f.check === 'evidence').detail, /聲稱 exit 0,重跑得到 1/);
});

test('沒交 report → worker_failed,記下 log 尾巴,重派時帶上原因', async () => {
  const proj = makeProject({ mode: 'noreport' });
  addNode(proj, CALC, CALC_GHERKIN);
  await tickUntil(proj, (st) => readEvents(proj).filter((e) => e.type === 'worker_failed').length >= 2);
  const env = readJson(join(proj, 'ledger/dispatch/d-0002/envelope.json'));
  assert.equal(env.attempt, 2);
  assert.match(env.findings[0].detail, /沒有交 report/);
});

test('側向延伸 L2:worker 提 prereq 子節點 → 範圍在父節點內自動批准 → 子節點先完成 → 父節點恢復並完成', async () => {
  const proj = makeProject({ mode: 'spawn', level: 2 });
  addNode(proj, CALC, CALC_GHERKIN);
  const s = await tickUntil(proj, (st) => st.nodes.get('calc/v1').status === 'done', { max: 30 });
  const dag = loadDag(proj);
  const child = getNode(dag, 'calc/v1.1');
  assert.ok(child, '子節點進了 DAG');
  assert.equal(child.parent, 'calc/v1');
  assert.ok(getNode(dag, 'calc/v1').depends_on.includes('calc/v1.1'), 'prereq:父節點依賴子節點');
  assert.equal(s.nodes.get('calc/v1.1').status, 'done');
  const added = readEvents(proj).find((e) => e.type === 'node_added' && e.node_id === 'calc/v1.1');
  assert.match(added.approved_by, /autonomy-L2/);
  const order = readEvents(proj).filter((e) => e.type === 'accept').map((e) => e.node_id);
  assert.deepEqual(order, ['calc/v1.1', 'calc/v1']);
  assert.ok(existsSync(join(proj, 'features/calc/v1.1.feature')));
});

test('側向延伸 L1:同樣的提案要問使用者', async () => {
  const proj = makeProject({ mode: 'spawn', level: 1 });
  addNode(proj, CALC, CALC_GHERKIN);
  const s = await tickUntil(proj, (st) => openRequests(st).some((r) => r.ref === 'spawn:calc/v1.1'));
  assert.equal(s.nodes.get('calc/v1').status, 'blocked');
  assert.ok(!getNode(loadDag(proj), 'calc/v1.1'), '沒批准前不進 DAG');
});

test('冪等:worker 還在跑時連續 tick 不會重派', async () => {
  const proj = makeProject({ mode: 'slow' });
  addNode(proj, CALC, CALC_GHERKIN);
  await tick(proj);
  await tick(proj);
  await tick(proj);
  assert.equal(readEvents(proj).filter((e) => e.type === 'dispatch').length, 1);
  await waitWorkers(proj);
});

test('冪等:合併後、記帳前當機 → 下一次 tick 偵測到分支已在主線,補記 accept,不重複合併', async () => {
  const proj = makeProject();
  addNode(proj, CALC, CALC_GHERKIN);
  await tickUntil(proj, (st) => st.nodes.get('calc/v1').legsDone.includes('test') && st.nodes.get('calc/v1').openDispatch);
  await waitWorkers(proj);
  // 收件,但在驗證前「當機」;然後模擬「已經合併了」
  const ctx = new Ctx(proj);
  await harvest(ctx);
  const d = [...ctx.state.dispatches.values()].find((x) => x.state === 'done');
  assert.ok(d, '實作棒已交件');
  commitState(ctx, 'dlm: 合併前存檔(模擬 finalize 的第一步)');
  sh(proj, `git -c user.name=t -c user.email=t@t merge --no-ff -q -m crash-merge ${d.branch}`);
  const mergesBefore = sh(proj, 'git rev-list --merges --count HEAD');
  const r = await tick(proj);
  assert.ok(r.ok, r.reason);
  const s = stateOf(proj);
  assert.equal(s.nodes.get('calc/v1').status, 'done');
  assert.equal(sh(proj, 'git rev-list --merges --count HEAD'), mergesBefore, '沒有第二次合併');
});

test('L0:每次合併都要使用者點頭;說 no 時原話成為退回原因', async () => {
  const proj = makeProject({ level: 0 });
  addNode(proj, CALC, CALC_GHERKIN);
  let s = await tickUntil(proj, (st) => openRequests(st).some((r) => r.ref.startsWith('accept:')));
  const first = openRequests(s).find((r) => r.ref.startsWith('accept:'));
  decide(proj, first.ref, 'no', '測試太少,多寫一個負數的案例');
  s = await tickUntil(proj, (st) => readEvents(proj).some((e) => e.type === 'reject' && e.reason.includes('決定退回')));
  const reject = readEvents(proj).find((e) => e.type === 'reject');
  assert.match(reject.findings[0].detail, /負數/);
  // 之後每一棒都說 yes
  for (let i = 0; i < 6 && stateOf(proj).nodes.get('calc/v1').status !== 'done'; i++) {
    s = await tickUntil(proj, (st) => openRequests(st).some((r) => r.ref.startsWith('accept:')) || st.nodes.get('calc/v1').status === 'done');
    for (const r of openRequests(s).filter((x) => x.ref.startsWith('accept:'))) decide(proj, r.ref, 'yes', '可以');
    await tick(proj);
    await waitWorkers(proj);
  }
  assert.equal(stateOf(proj).nodes.get('calc/v1').status, 'done');
});

test('停機:halt 之後不派工;resume 之後繼續', async () => {
  const proj = makeProject();
  append(proj, 'dlm-cli', 'halt', { reason: '先停' });
  addNode(proj, CALC, CALC_GHERKIN);
  await tick(proj);
  assert.equal(readEvents(proj).filter((e) => e.type === 'dispatch').length, 0);
  append(proj, 'user', 'resume', { verbatim: '繼續' });
  await tickUntil(proj, (st) => st.nodes.get('calc/v1').status === 'done');
});

test('預算:今天花費到頂就不派工', async () => {
  const proj = makeProject();
  addNode(proj, CALC, CALC_GHERKIN);
  append(proj, 'orchestrator', 'cost', { dispatch_id: 'x', usd: 9, role: 'worker' });
  await tick(proj);
  assert.equal(readEvents(proj).filter((e) => e.type === 'dispatch').length, 0);
});

test('Critic(L2):strict 節點交 Critic;Critic 看不到 worker 敘述;PASS 就合併', async () => {
  // v4:證據指令不在白名單、但 dlm 自己重跑的驗收通過時,只記錄不升級(不再觸發 Critic);改用 strict 節點觸發
  const log = join(tempDir(), 'critic.log');
  const proj = makeProject({
    level: 2,
    config: {
      verify: { rerun_allow: ['git status'] },
      agents: { critic: { cmd: agentCmd({ verdict: 'PASS', reason: '我重跑了 node --test,綠的' }, log) } },
    },
  });
  addNode(proj, { ...CALC, tier: 'strict' }, CALC_GHERKIN);
  await tickUntil(proj, (st) => st.nodes.get('calc/v1').status === 'done');
  const critics = readEvents(proj).filter((e) => e.type === 'critic');
  assert.ok(critics.length >= 1);
  assert.ok(critics.every((c) => c.verdict === 'PASS'));
  const prompt = readFileSync(log, 'utf8');
  assert.match(prompt, /<data source="verify"/);
  assert.doesNotMatch(prompt, /實作完成|寫好測試,目前是紅的/, 'Critic 不讀 worker 的自我敘述');
});

test('Critic ASK_USER → 轉成使用者待決事項', async () => {
  const proj = makeProject({
    level: 2,
    config: {
      verify: { rerun_allow: ['git status'] },
      agents: { critic: { cmd: agentCmd({ verdict: 'ASK_USER', reason: '兩種行為都合理', question: '負數要怎麼處理?' }) } },
    },
  });
  addNode(proj, { ...CALC, tier: 'strict' }, CALC_GHERKIN);
  const s = await tickUntil(proj, (st) => openRequests(st).some((r) => r.ref.startsWith('accept:')));
  assert.equal(s.nodes.get('calc/v1').status, 'review');
});

test('根目錄有別人未 commit 的變更 → tick 拒絕執行,不動任何東西', async () => {
  const proj = makeProject();
  addNode(proj, CALC, CALC_GHERKIN);
  const cfg = readJson(join(proj, 'AGENTS.md').replace('AGENTS.md', 'dlm.config.json'));
  writeJson(join(proj, 'dlm.config.json'), { ...cfg, $comment: 'someone edited' });
  const r = await tick(proj);
  assert.equal(r.ok, false);
  assert.match(r.reason, /dlm\.config\.json/);
  assert.equal(readEvents(proj).filter((e) => e.type === 'dispatch').length, 0);
});

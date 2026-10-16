// 吃自己的狗糧:建一個新專案,走完「提案 → 批准 → 測試棒(紅)→ 實作棒(綠)→ 合併 → 整合點 → 使用者試用」。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runChecks } from '../tools/lib/checks.mjs';
import { confirmE2e, renderInbox } from '../tools/lib/inbox.mjs';
import { checkLedger, readEvents } from '../tools/lib/ledger.mjs';
import { CALC, CALC_GHERKIN, I1, I1_GHERKIN, addNode, cleanup, makeProject, sh, stateOf, tickUntil } from './helpers.mjs';

after(cleanup);

test('完整流程:一個能力 + 一個整合點,從提案到使用者確認', async () => {
  const proj = makeProject();
  addNode(proj, CALC, CALC_GHERKIN);

  // 第一個 tick 套用提案並派測試棒
  let s = await tickUntil(proj, (st) => st.nodes.get('calc/v1')?.legsDone.includes('test'));
  assert.ok(existsSync(join(proj, 'features/calc/v1.feature')), 'gherkin 由 dlm 寫入');
  const testLeg = [...s.dispatches.values()].find((d) => d.leg === 'test');
  const verify = testLeg.verify.results;
  assert.ok(verify.some((r) => r.check === 'acceptance' && r.outcome === 'PASS' && /預期 非 0/.test(r.detail)), '測試棒的驗收是「必須紅」');
  assert.ok(verify.some((r) => r.check === 'paths' && r.outcome === 'PASS'));

  // 實作棒 → 合併
  s = await tickUntil(proj, (st) => st.nodes.get('calc/v1').status === 'done');
  assert.equal(sh(proj, 'git rev-parse --abbrev-ref HEAD'), 'main');
  assert.ok(existsSync(join(proj, 'packages/calc/src/calc.mjs')), '實作已合併進主線');
  const devLeg = [...s.dispatches.values()].find((d) => d.leg === 'dev');
  assert.equal(devLeg.state, 'accepted');
  assert.ok(devLeg.gates.ok, '合併後臨時樹的全 gate 是綠的');
  assert.ok(sh(proj, 'git tag').includes(`dlm-archive/${devLeg.dispatch_id}`));
  assert.ok(!existsSync(devLeg.worktree), 'worktree 已清掉');
  assert.ok(existsSync(join(proj, 'ledger/dispatch', devLeg.dispatch_id, 'prompt.md')), 'worker 當時看到的 prompt 有留檔');

  // 整合點
  addNode(proj, I1, I1_GHERKIN);
  s = await tickUntil(proj, (st) => st.nodes.get('I1')?.status === 'done');
  const inbox = renderInbox(proj);
  assert.match(inbox, /E2E:I1/);
  assert.match(inbox, /user runs the app/);
  confirmE2e(proj, 'I1', true, '試過了,可以');
  s = await tickUntil(proj, (st) => st.nodes.get('I1').e2e.confirm?.ok === true);

  // 帳本與產生檔
  assert.ok(checkLedger(proj).ok, checkLedger(proj).problems.join('\n'));
  const checks = runChecks(proj);
  const failed = checks.filter((c) => c.result === 'FAIL');
  assert.deepEqual(failed, [], JSON.stringify(failed, null, 2));
  const status = readFileSync(join(proj, 'STATUS.md'), 'utf8');
  assert.match(status, /`calc\/v1` \| phase \| 加法 \| done/);
  const types = new Set(readEvents(proj).map((e) => e.type));
  for (const t of ['node_added', 'dispatch', 'launched', 'worker_done', 'verify', 'leg_done', 'gates', 'accept', 'e2e_request', 'e2e_confirm']) {
    assert.ok(types.has(t), `缺事件 ${t}`);
  }
  assert.equal(sh(proj, 'git status --porcelain --untracked-files=no'), '', 'tick 結束後主線是乾淨的');
  assert.ok(stateOf(proj).nodes.get('calc/v1').status === 'done');
});

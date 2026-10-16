import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dashboardData, renderDashboard, serveDashboard } from '../tools/lib/dashboard.mjs';
import { readEvents } from '../tools/lib/ledger.mjs';
import { CALC, CALC_GHERKIN, REPO, addNode, cleanup, makeProject, tickUntil } from './helpers.mjs';
import { applyApprovedProposals, proposeFeature } from '../tools/lib/intake.mjs';
import { run } from '../tools/lib/util.mjs';

after(cleanup);

describe('dlm dashboard(唯讀主控台)', () => {
  test('一打開看哪一頁:空專案、只有提案 → 規劃頁;批准後有節點可以派工 → 主控台;頁面照 initial_view 開', () => {
    const proj = makeProject();
    assert.equal(dashboardData(proj).initial_view, 'planning', '空專案');
    addNode(proj, CALC, CALC_GHERKIN);
    assert.equal(dashboardData(proj).initial_view, 'planning', '批准了但還沒寫進 DAG(下一個 tick 才套用):還在規劃頁');
    applyApprovedProposals(proj);
    const d = dashboardData(proj);
    assert.equal(d.building, true, '寫進 DAG、可以派工就算在開發');
    assert.equal(d.initial_view, 'console');
    const html = renderDashboard(d);
    assert.match(html, /ui\.view = data\.initial_view \|\|/, '頁面用 initial_view 決定第一頁');
    assert.doesNotMatch(html, /saved\.view/, '不再記住上次看的頁(沒有在開發時要回到規劃頁)');
  });

  test('等你的決定、節點狀態、花費都從帳本重播出來;不寫任何事件', async () => {
    const proj = makeProject();
    addNode(proj, CALC, CALC_GHERKIN);
    await tickUntil(proj, (s) => s.nodes.get('calc/v1')?.status === 'done');
    proposeFeature(proj, { ...CALC, id: 'calc/v2', title: '減法', depends_on: ['calc/v1'] }, CALC_GHERKIN.replace('adds', 'subtracts'));
    const before = readEvents(proj).length;

    const d = dashboardData(proj);
    assert.equal(readEvents(proj).length, before, 'dashboard 不能寫事件');
    assert.equal(d.building, false, '沒有東西在施工(只有一份等批准的提案)');
    assert.equal(d.initial_view, 'planning', '沒有軟體在開發時,一打開是規劃頁');
    assert.equal(d.counts.done, 1);
    assert.equal(d.decisions.length, 1);
    assert.match(d.decisions[0].question, /減法|calc\/v2/);
    const calc = d.nodes.find((n) => n.id === 'calc/v1');
    assert.equal(calc.status, 'done');
    assert.ok(calc.dispatches >= 1);
    assert.ok(d.timeline.some((e) => e.type === 'accept' && e.node === 'calc/v1'));
    assert.ok(d.timeline.filter((e) => e.type === 'verify').every((e) => e.node === 'calc/v1'), 'verify 事件要對回節點');
    const ds = d.dispatches.filter((x) => x.node === 'calc/v1');
    assert.ok(ds.length >= 1, '每次派工都列出來');
    assert.ok(ds.every((x) => x.envelope && x.envelope.allowed.length), '工單的 write-set 讀得到');
    assert.ok(ds.some((x) => x.report), '交件報告讀得到');
    const pv2 = d.proposals.find((p) => p.nodes.some((n) => n.id === 'calc/v2'));
    assert.ok(pv2, '規劃頁讀得到提案');
    assert.equal(pv2.gherkin[0].scenarios, 1);
    assert.ok(d.timeline.some((e) => e.type === 'decision' && e.raw.verbatim === '好,加進去'), '你的原話要留著');
  });

  test('資料裡的 </script> 關不掉 script 標籤', () => {
    const html = renderDashboard({ project: 'x', nodes: [], timeline: [{ text: '</script><script>alert(1)</script>' }] });
    const body = html.split('id="dlm-data">')[1].split('</script>')[0];
    assert.ok(!body.includes('<'), '嵌入的 JSON 不應含 <');
    assert.deepEqual(JSON.parse(body).timeline[0].text, '</script><script>alert(1)</script>');
  });

  test('dlm dashboard 寫出 .dlm/dashboard.html;--serve 只回 GET', async () => {
    const proj = makeProject();
    const r = run(`node ${join(REPO, 'tools', 'dlm.mjs')} dashboard`, { cwd: proj });
    assert.equal(r.code, 0, r.stderr);
    const out = join(proj, '.dlm', 'dashboard.html');
    assert.ok(existsSync(out));
    assert.match(readFileSync(out, 'utf8'), /id="dlm-data"/);
    assert.equal(run('git status --porcelain', { cwd: proj }).stdout.trim(), '', '.dlm/ 不進 git');

    const server = await serveDashboard(proj, { port: 0, log: () => {} });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const data = await (await fetch(`${base}/data.json`)).json();
      assert.equal(data.ledger_seq, dashboardData(proj).ledger_seq);
      assert.match(await (await fetch(`${base}/`)).text(), /var LIVE = 5000;/);
      assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
      assert.equal((await fetch(`${base}/../dlm.config.json`)).status, 404);
    } finally {
      server.close();
    }
  });

  test('不認得的旗標直接拒絕', () => {
    const proj = makeProject();
    const r = run(`node ${join(REPO, 'tools', 'dlm.mjs')} dashboard --open`, { cwd: proj });
    assert.notEqual(r.code, 0);
    assert.ok(!existsSync(join(proj, '.dlm', 'dashboard.html')));
  });
});

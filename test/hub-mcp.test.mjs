// v4.7: API definition, flows, project list, dlm op, cross-project accounts, dlm hub (HTTP + SSE), dlm mcp (stdio).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALC, CALC_GHERKIN, FAKE, I1, I1_GHERKIN, REPO, cleanup, makeProject, sh, tempDir, tickUntil } from './helpers.mjs';
import { nodeSchema } from '../tools/lib/schemas.mjs';
import { addAccount, globalUsage, logAccountEvent, pickAccount } from '../tools/lib/accounts.mjs';
import { ROUTES, buildArgs, matchRoute, openapi } from '../tools/lib/api.mjs';
import { FLOW, PROMPTS, toolName } from '../tools/lib/flow.mjs';
import { serveHub, hubToken } from '../tools/lib/hub.mjs';
import { readEvents } from '../tools/lib/ledger.mjs';
import { callTool, handle, refuseReason, toolList } from '../tools/lib/mcp.mjs';
import { addProject, loadProjects, removeProject, resolveProject } from '../tools/lib/projects.mjs';
import { readJson, run } from '../tools/lib/util.mjs';

after(cleanup);
const DLM = join(REPO, 'tools', 'dlm.mjs');
const dlm = (cwd, args, input) => run(`node ${JSON.stringify(DLM)} ${args}`, { cwd, ...(input !== undefined ? { input } : {}) });
const op = (cwd, name, args = {}) => JSON.parse(dlm(cwd, `op ${name}`, JSON.stringify(args)).stdout.trim().split('\n').at(-1));

describe('API 定義與流程', () => {
  test('路由表:id 不重複、MCP 工具名不重複、流程每一步都對得到路由、OpenAPI 有每一條', () => {
    const ids = ROUTES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    const names = toolList().map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    for (const st of FLOW) for (const x of st.steps) if (x.call) assert.ok(ids.includes(x.call), `流程 ${st.id} 用到不存在的 ${x.call}`);
    for (const p of PROMPTS) for (const f of p.flow) assert.ok(FLOW.some((s) => s.id === f), p.name);
    const spec = openapi('9.9.9');
    assert.equal(spec.openapi, '3.1.0');
    const n = Object.values(spec.paths).reduce((k, v) => k + Object.keys(v).length, 0);
    assert.equal(n, ROUTES.length);
    for (const r of ROUTES) assert.ok(spec.paths[r.path][r.method.toLowerCase()].operationId === r.id);
    // MCP has no streaming or openapi; every other route has a tool
    assert.equal(names.length, ROUTES.filter((r) => r.kind !== 'stream' && r.id !== 'openapi').length);
    assert.ok(names.includes(toolName('decide')) && toolName('setRole') === 'dlm_set_role');
  });

  test('提案的 spec / bundle 列出每個欄位(型別取自 nodeSchema),格式錯了指出是哪一個欄位;dlm_health 在 MCP 能用', async () => {
    const tools = Object.fromEntries(toolList().map((t) => [t.name, t]));
    const spec = tools.dlm_propose_feature.inputSchema.properties.spec;
    assert.deepEqual(Object.keys(spec.properties).sort(), Object.keys(nodeSchema.properties).sort(), 'spec 的欄位就是 dag.json 節點的欄位');
    assert.deepEqual(spec.required, ['id', 'title', 'intent', 'owns'], 'kind 有預設(phase),不必填;owns 是 validateDag 要求的');
    assert.equal(spec.properties.owns.minItems, 1);
    for (const [k, s] of Object.entries(spec.properties)) {
      assert.ok(s.description, `spec.${k} 要有說明`);
      assert.ok(s.type, `spec.${k} 要有 type(只有 enum 的也補上)`);
    }
    assert.equal(spec.properties.pipeline.items.type, 'string');
    assert.equal(spec.properties.intent.maxLength, nodeSchema.properties.intent.maxLength, '限制照抄 nodeSchema');
    const bundle = tools.dlm_propose_bundle.inputSchema.properties.bundle;
    assert.deepEqual(bundle.required, ['release', 'nodes']);
    const item = bundle.properties.nodes.items;
    for (const k of ['id', 'kind', 'owns', 'depends_on', 'gherkin_text', 'gherkin_file']) assert.ok(item.properties[k], `bundle.nodes[].${k}`);

    const route = (id) => ROUTES.find((r) => r.id === id);
    const err = (id, body) => buildArgs(route(id), { project: 'x' }, [], body).error;
    assert.match(err('proposeFeature', { spec: JSON.stringify(CALC) }), /body\.spec: 型別應為 object,實際是 string/);
    assert.match(err('proposeFeature', { spec: { id: 'calc/v1', intent: 'x' } }), /body\.spec: 缺必填欄位 title/);
    assert.match(err('proposeBundle', { bundle: { release: 'v1', nodes: [{ ...CALC, gherkin_text: CALC_GHERKIN }, (({ owns: _o, ...rest }) => rest)(I1)] } }), /body\.bundle\.nodes\[1\]: 缺必填欄位 owns/);
    assert.match(err('proposeFeature', { spec: { ...CALC, colour: 'red' } }), /body\.spec: 不認識的欄位 colour/);
    assert.equal(err('proposeFeature', { spec: CALC, gherkin: CALC_GHERKIN }), undefined);
    assert.match(err('proposeBundle', { bundle: { release: 'v1', nodes: [{ ...I1, kind: 'integ' }] } }), /body\.bundle\.nodes\[0\]\.kind/);
    assert.match(err('proposeBundle', { bundle: { release: 'v1', nodes: [] } }), /body\.bundle\.nodes: 項目數 < 1/);
    assert.equal(err('proposeBundle', { bundle: { release: 'v1', goal: 'g', nodes: [{ ...CALC, gherkin_text: CALC_GHERKIN }, { ...I1, gherkin_text: I1_GHERKIN }] } }), undefined);

    const h = await callTool('dlm_health', {}, { cwd: tempDir(), env: {} });
    assert.ok(!h.isError, h.content[0].text);
    assert.equal(JSON.parse(h.content[0].text).ok, true);
  });

  test('matchRoute / buildArgs:路徑參數、405、query 轉型、body 檢查', () => {
    const m = matchRoute('PUT', '/api/v1/projects/demo/roles/worker');
    assert.equal(m.route.id, 'setRole');
    assert.deepEqual(m.params, { project: 'demo', role: 'worker' });
    assert.deepEqual(matchRoute('DELETE', '/api/v1/overview').methodNotAllowed, ['GET']);
    assert.equal(matchRoute('GET', '/api/v1/nope'), null);
    assert.equal(matchRoute('POST', '/api/v1/projects/init').route.id, 'initProject');
    const ev = matchRoute('GET', '/api/v1/projects/demo/events');
    assert.deepEqual(buildArgs(ev.route, ev.params, new URLSearchParams('after=3&limit=10'), null).args, { after: 3, limit: 10 });
    assert.match(buildArgs(ev.route, ev.params, new URLSearchParams('bogus=1'), null).error, /不認得 query/);
    const d = matchRoute('POST', '/api/v1/projects/demo/decisions');
    assert.match(buildArgs(d.route, d.params, [], { choice: 'yes' }).error, /ref/);
    assert.match(buildArgs(d.route, d.params, [], { ref: 'x', choice: 'yes', extra: 1 }).error, /extra/);
    const role = matchRoute('PUT', '/api/v1/projects/demo/roles/boss');
    assert.match(buildArgs(role.route, role.params, [], { accounts: [] }).error, /role/);
  });
});

describe('專案清單與 dlm op', () => {
  test('登記 / 重複登記 / 名稱衝突 / 拿掉;不是 dlm 專案拒絕', () => {
    const a = makeProject();
    const p = addProject(a);
    assert.equal(p.existed, false);
    assert.equal(addProject(a).existed, true, '同一個路徑不重複');
    assert.equal(resolveProject(p.name).path, p.path);
    assert.equal(resolveProject(a).name, p.name, '用路徑也找得到');
    assert.throws(() => addProject(tempDir()), /不是 dlm 專案/);
    const b = makeProject();
    assert.notEqual(addProject(b).name, p.name, '同名(都叫 proj)自動加編號');
    removeProject(p.name);
    assert.ok(!loadProjects()[p.name]);
  });

  test('dlm op:status / 提案 / decide / set_role 都回 JSON;錯誤回 ok:false', () => {
    const proj = makeProject();
    const st = op(proj, 'status');
    assert.ok(st.ok);
    assert.equal(st.result.counts.nodes, 0);
    assert.equal(st.result.loop.running, false);
    const pr = op(proj, 'propose_feature', { spec: CALC, gherkin: CALC_GHERKIN });
    assert.ok(pr.ok, pr.error);
    const inbox = op(proj, 'inbox');
    assert.ok(inbox.result.decisions.some((d) => d.ref === pr.result.decide_ref));
    const bad = op(proj, 'decide', { ref: pr.result.decide_ref, choice: 'maybe', verbatim: 'x' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /選項只有/);
    const ok = op(proj, 'decide', { ref: pr.result.decide_ref, choice: 'yes', verbatim: '好,加進去' });
    assert.ok(ok.ok, ok.error);
    assert.equal(readEvents(proj).find((e) => e.type === 'decision').verbatim, '好,加進去');
    assert.equal(op(proj, 'nope').status, 404);
    addAccount('op-a', { cli: 'claude' });
    const sr = op(proj, 'set_role', { role: 'critic', accounts: ['op-a'], model: 'opus' });
    assert.ok(sr.ok, sr.error);
    assert.deepEqual(readJson(join(proj, 'dlm.config.json')).agents.critic.accounts, ['op-a']);
    const ev = op(proj, 'events', { types: 'decision' });
    assert.equal(ev.result.events.length, 1);
    assert.equal(ev.result.events[0].mac, undefined, '簽章欄位不外流');
  });
});

describe('帳號跨專案共用', () => {
  test('專案 A 讓帳號冷卻 → 專案 B 選號也跳過它;同時上限滿了回 busy', () => {
    addAccount('share-a', { cli: 'claude', maxParallel: 1 });
    addAccount('share-b', { cli: 'claude' });
    const until = new Date(Date.now() + 3600e3).toISOString();
    logAccountEvent('/proj/A', { type: 'dispatch', dispatch_id: 'd-0001', account: 'share-a' });
    logAccountEvent('/proj/A', { type: 'worker_failed', dispatch_id: 'd-0001', limited_account: 'share-a', limited_until: until });
    assert.equal(pickAccount(['share-a', 'share-b'], globalUsage()).name, 'share-b');
    addAccount('par-a', { cli: 'claude', maxParallel: 1 });
    logAccountEvent('/proj/B', { type: 'dispatch', dispatch_id: 'd-0001', account: 'par-a' });
    assert.equal(globalUsage()['par-a'].open, 1);
    assert.deepEqual(pickAccount(['par-a'], globalUsage()), { busy: ['par-a'] });
    assert.equal(pickAccount(['par-a'], globalUsage(), Date.now(), { ignoreParallel: true }).name, 'par-a');
    logAccountEvent('/proj/B', { type: 'worker_done', dispatch_id: 'd-0001' });
    assert.equal(pickAccount(['par-a'], globalUsage()).name, 'par-a', '做完就空出名額');
  });

  test('實際派工:dispatch 與結束都記進這台電腦的帳號紀錄', async () => {
    addAccount('real-a', { cli: 'claude' });
    const proj = makeProject();
    const cfg = readJson(join(proj, 'dlm.config.json'));
    cfg.agents.worker.accounts = ['real-a'];
    writeFileSync(join(proj, 'dlm.config.json'), JSON.stringify(cfg, null, 2));
    sh(proj, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm acct');
    const p = op(proj, 'propose_feature', { spec: CALC, gherkin: CALC_GHERKIN });
    op(proj, 'decide', { ref: p.result.decide_ref, choice: 'yes', verbatim: '好' });
    await tickUntil(proj, (s) => s.nodes.get('calc/v1')?.status === 'done', { max: 30 });
    const u = globalUsage()['real-a'];
    assert.ok(u.dispatches_5h >= 2, JSON.stringify(u));
    assert.equal(u.open, 0, '每一棒都結束了');
  });
});

/** Start a hub (port 0), returns { base, token, get, send, close }. */
async function startHub() {
  const server = await serveHub({ port: 0, intervalMs: 60000, log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = hubToken();
  const auth = { authorization: `Bearer ${token}` };
  const get = async (path, headers = auth) => { const r = await fetch(base + path, { headers }); return { status: r.status, body: await r.json() }; };
  const send = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { ...auth, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { base, token, get, send, close: () => server.close() };
}

describe('dlm hub(HTTP API)', () => {
  test('token、Host、Origin;overview 看得到每個專案;從 API 提案 → 決定 → 帳本有原話;openapi', async () => {
    const proj = makeProject();
    const name = addProject(proj).name;
    const h = await startHub();
    try {
      assert.equal((await h.get('/api/v1/overview', {})).status, 401);
      assert.equal((await h.get('/api/v1/overview', { authorization: 'Bearer nope' })).status, 401);
      assert.equal((await h.get('/api/v1/health', {})).status, 200, 'health 不用 token');
      assert.equal((await h.send('POST', `/api/v1/projects/${name}/halt`, { reason: 'x' }, { origin: 'http://evil.example' })).status, 403);
      const ov = await h.get('/api/v1/overview');
      assert.equal(ov.status, 200);
      const mine = ov.body.projects.find((p) => p.name === name);
      assert.equal(mine.counts.nodes, 0);
      assert.equal(mine.loop.running, false);
      const pr = await h.send('POST', `/api/v1/projects/${name}/proposals/feature`, { spec: CALC, gherkin: CALC_GHERKIN });
      assert.equal(pr.status, 201, JSON.stringify(pr.body));
      const inbox = await h.get(`/api/v1/projects/${name}/inbox`);
      assert.ok(inbox.body.decisions.some((d) => d.ref === pr.body.decide_ref), '寫入後快取有清掉');
      assert.equal((await h.send('POST', `/api/v1/projects/${name}/decisions`, { ref: pr.body.decide_ref, choice: 'nah' })).status, 400);
      const ok = await h.send('POST', `/api/v1/projects/${name}/decisions`, { ref: pr.body.decide_ref, choice: 'yes', verbatim: '好' });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(readEvents(proj).filter((e) => e.type === 'decision').length, 1);
      assert.equal((await h.get('/api/v1/projects/nope')).status, 404);
      const spec = await h.get('/api/v1/openapi.json', {});
      assert.equal(spec.body.openapi, '3.1.0');
      assert.match(spec.body.servers[0].url, /^http:\/\/127\.0\.0\.1:\d+$/);
      const flow = await h.get('/api/v1/flow');
      assert.ok(flow.body.stages.find((s) => s.id === 'plan').steps.some((x) => x.tool === 'dlm_propose_bundle'));
      const page = await fetch(`${h.base}/`).then((r) => r.text());
      assert.ok(page.includes(h.token), '首頁內嵌 token');
      // fetch does not let you change Host, so use http.request
      const badHost = await new Promise((ok, no) => request(`${h.base}/`, { headers: { host: 'evil.example' } }, (r) => { r.resume(); ok(r.statusCode); }).on('error', no).end());
      assert.equal(badHost, 403, 'DNS rebinding:Host 不是 127.0.0.1 / localhost 就拒絕');
      const dash = await fetch(`${h.base}/p/${name}/`).then((r) => r.text());
      assert.match(dash, /所有專案/);
    } finally {
      h.close();
    }
  });

  test('initProject + setupProject + 背景迴圈啟停 + SSE 推送新事件', async () => {
    const dir = join(tempDir('dlm-hubinit-'), 'fresh');
    const h = await startHub();
    try {
      const init = await h.send('POST', '/api/v1/projects/init', { path: dir });
      assert.equal(init.status, 201, JSON.stringify(init.body));
      const name = init.body.project;
      const setup = await h.send('POST', `/api/v1/projects/${name}/setup`, { answers: { platform: 'custom', worker_cmd: `FAKE_MODE=good node ${FAKE}`, verifier: 'none', autonomy: '1' } });
      assert.equal(setup.status, 200, JSON.stringify(setup.body));
      assert.equal(readJson(join(dir, 'dlm.config.json')).agents.worker.cmd, `FAKE_MODE=good node ${FAKE}`);
      // SSE: connect first, then write an event
      const ctrl = new AbortController();
      const res = await fetch(`${h.base}/api/v1/projects/${name}/events/stream?token=${h.token}`, { signal: ctrl.signal });
      assert.equal(res.headers.get('content-type').split(';')[0], 'text/event-stream');
      const reader = res.body.getReader();
      await new Promise((r) => setTimeout(r, 300));
      const halt = await h.send('POST', `/api/v1/projects/${name}/halt`, { reason: '測試停機' });
      assert.equal(halt.status, 200);
      let got = '';
      const deadline = Date.now() + 5000;
      while (!got.includes('event: ledger') && Date.now() < deadline) got += new TextDecoder().decode((await reader.read()).value);
      ctrl.abort();
      assert.match(got, /"type":"halt"/);
      assert.match(got, new RegExp(`"project":"${name}"`));
      // recent: on connect, backfill the latest events first (with recent:true)
      const ctrl2 = new AbortController();
      const res2 = await fetch(`${h.base}/api/v1/events/stream?recent=3&token=${h.token}`, { signal: ctrl2.signal });
      const first = new TextDecoder().decode((await res2.body.getReader().read()).value);
      ctrl2.abort();
      assert.match(first, /"type":"halt"/);
      assert.match(first, /"recent":true/);
      assert.doesNotMatch(first, /"mac"/, '不送簽章欄位');
      assert.equal((await h.send('POST', `/api/v1/projects/${name}/resume`, { verbatim: '繼續' })).status, 200);
      const start = await h.send('POST', `/api/v1/projects/${name}/loop/start`, { interval: 1 });
      assert.equal(start.status, 200, JSON.stringify(start.body));
      assert.equal((await h.send('POST', `/api/v1/projects/${name}/loop/start`, { interval: 1 })).status, 409, '已經在跑');
      const stop = await h.send('POST', `/api/v1/projects/${name}/loop/stop`, { wait: 20 });
      assert.equal(stop.body.stopped, true, JSON.stringify(stop.body));
    } finally {
      h.close();
    }
  });

  test('舊版 dlm 的專案:回 501 並說要升級', async () => {
    const proj = makeProject();
    writeFileSync(join(proj, 'tools', 'dlm.mjs'), "console.error('不認識的指令 op'); process.exit(1);\n");
    const name = addProject(proj).name;
    const h = await startHub();
    try {
      const r = await h.get(`/api/v1/projects/${name}`);
      assert.equal(r.status, 501);
      assert.match(r.body.error.message, /4\.7 以上/);
      const ov = await h.get('/api/v1/overview');
      assert.match(ov.body.projects.find((p) => p.name === name).error, /升級/);
    } finally {
      h.close();
    }
  });
});

describe('文件跟路由表、流程表一致', () => {
  test('payload/docs/dlm 的 API.md、openapi.json、FLOW.md 就是 dlm api 產生的(改了 api.mjs / flow.mjs 要重產)', () => {
    for (const [kind, file] of [['md', 'API.md'], ['openapi', 'openapi.json'], ['flow', 'FLOW.md']]) {
      const want = run(`node tools/dlm.mjs api ${kind}`, { cwd: REPO }).stdout;
      assert.equal(readFileSync(join(REPO, 'payload', 'docs', 'dlm', file), 'utf8'), want, `${file} 過期了:node tools/dlm.mjs api ${kind} > payload/docs/dlm/${file}`);
    }
  });
});

describe('dlm mcp', () => {
  test('refuseReason:worker / Critic 不能用', () => {
    assert.equal(refuseReason('/p', {}), null);
    assert.match(refuseReason('/p', { DLM_ROLE: 'worker' }), /DLM_ROLE/);
    assert.match(refuseReason('/p/.dlm/sandbox/d-1', {}), /\.dlm/);
  });

  test('handle:initialize(含流程說明)、prompts、未知方法、缺 project', async () => {
    const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, { cwd: tempDir(), env: {} });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.ok(init.result.capabilities.prompts);
    assert.match(init.result.instructions, /dlm_init_project/);
    assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.equal((await handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' })).error.code, -32601);
    const prompts = (await handle({ jsonrpc: '2.0', id: 3, method: 'prompts/list' })).result.prompts;
    assert.ok(prompts.some((p) => p.name === 'new-project'));
    const got = await handle({ jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'new-project', arguments: { path: '/tmp/x' } } });
    assert.match(got.result.messages[0].content.text, /dlm_init_project[\s\S]*dlm_propose_bundle/);
    assert.equal((await handle({ jsonrpc: '2.0', id: 5, method: 'prompts/get', params: { name: 'new-project', arguments: {} } })).error.code, -32602);
    const r = await callTool('dlm_get_inbox', {}, { cwd: tempDir(), env: {} });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /要指定 project/);
    for (const t of toolList()) {
      assert.equal(t.inputSchema.type, 'object', t.name);
      if (['dlm_decide', 'dlm_confirm', 'dlm_resume', 'dlm_unblock', 'dlm_set_settings'].includes(t.name)) assert.match(t.description, /親口/);
    }
  });

  test('提案工具帶節點欄位的 schema:agent 不用讀 INTAKE.md 也知道 spec / bundle 長什麼樣', () => {
    const tools = Object.fromEntries(toolList().map((t) => [t.name, t]));
    const spec = tools.dlm_propose_feature.inputSchema.properties.spec;
    for (const k of ['id', 'kind', 'title', 'intent', 'owns', 'depends_on', 'accept']) assert.ok(spec.properties[k]?.description || spec.properties[k], k);
    // 4.7.3: owns is required too (validateDag already requires it on every node)
    assert.deepEqual(spec.required, ['id', 'title', 'intent', 'owns']);
    const node = tools.dlm_propose_bundle.inputSchema.properties.bundle.properties.nodes.items;
    assert.ok(node.properties.gherkin_text && node.properties.kind);
    const r = ROUTES.find((x) => x.id === 'proposeFeature');
    assert.match(buildArgs(r, { project: 'p' }, [], { spec: { title: 'x' } }).error, /缺必填欄位 id/);
    assert.match(buildArgs(r, { project: 'p' }, [], { spec: { id: 'a/v1', title: 't', intent: 'i', owns: 'src/**' } }).error, /owns: 型別應為 array/);
    assert.equal(buildArgs(r, { project: 'p' }, [], { spec: { id: 'a/v1', title: 't', intent: 'i', owns: ['src/**'] } }).error, undefined);
    const b = ROUTES.find((x) => x.id === 'proposeBundle');
    assert.match(buildArgs(b, { project: 'p' }, [], { bundle: { release: 'v1', nodes: [] } }).error, /nodes: 項目數 < 1/);
  });

  test('stdio 實跑(在專案目錄啟動,project 可省略):tools/list → 提案 → inbox → decide', async () => {
    const proj = makeProject();
    const child = spawn(process.execPath, [DLM, 'mcp'], { cwd: proj, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map();
    let buf = '';
    child.stdout.on('data', (b) => {
      buf += b;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        pending.get(msg.id)?.(msg);
      }
    });
    let id = 0;
    const call = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); });
    const tool = async (name, args = {}) => { const r = (await call('tools/call', { name, arguments: args })).result; return { err: !!r.isError, text: r.content[0].text, json: (() => { try { return JSON.parse(r.content[0].text); } catch { return null; } })() }; };
    try {
      const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      assert.match(init.result.instructions, /目前目錄是 dlm 專案/);
      const tools = (await call('tools/list')).result.tools.map((t) => t.name);
      assert.ok(tools.includes('dlm_overview') && tools.includes('dlm_propose_bundle'));
      const st = await tool('dlm_get_project');
      assert.ok(!st.err, st.text);
      assert.equal(st.json.counts.nodes, 0);
      const p = await tool('dlm_propose_feature', { spec: CALC, gherkin: CALC_GHERKIN });
      assert.ok(!p.err, p.text);
      const inbox = await tool('dlm_get_inbox');
      assert.ok(inbox.json.decisions.some((d) => d.ref === p.json.decide_ref));
      const d = await tool('dlm_decide', { ref: p.json.decide_ref, choice: 'yes', verbatim: '好' });
      assert.ok(!d.err, d.text);
      const bad = await tool('dlm_show', { ref: 'no-such-thing' });
      assert.ok(bad.err);
      const ov = await tool('dlm_overview');
      assert.ok(ov.json.projects.some((x) => x.path === proj || x.path.endsWith('/proj')), '用過的專案自動登記');
    } finally {
      child.stdin.end();
      await new Promise((r) => child.on('close', r));
    }
  });

  test('DLM_ROLE 有值 → 拒絕啟動;dlm mcp install --client project 寫 .mcp.json 且不重複;dlm mcp config 印出設定', () => {
    const proj = makeProject();
    const r = run(`node ${JSON.stringify(DLM)} mcp < /dev/null`, { cwd: proj, env: { DLM_ROLE: 'worker' } });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /拒絕啟動/);
    assert.equal(dlm(proj, 'mcp install --client project').code, 0);
    assert.deepEqual(readJson(join(proj, '.mcp.json')).mcpServers.dlm, { command: 'node', args: ['tools/dlm.mjs', 'mcp'] });
    assert.match(dlm(proj, 'mcp install --client project').stdout, /已經有/);
    const cfg = dlm(proj, 'mcp config').stdout;
    assert.match(cfg, /claude mcp add --scope user dlm -- node/);
    assert.match(cfg, /\[mcp_servers\.dlm\]/);
    mkdirSync(join(proj, 'x'), { recursive: true });
    assert.ok(readFileSync(join(REPO, 'tools', 'lib', 'hub.html'), 'utf8').includes('__TOKEN__'));
  });
});

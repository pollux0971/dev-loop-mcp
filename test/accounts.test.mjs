// v4.6:多帳號(訂閱方案)輪流、限流換號、dlm account、主控台設定帳號。(MCP 的測試在 hub-mcp.test.mjs)
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALC, CALC_GHERKIN, FAKE, REPO, addNode, cleanup, makeProject, sh, stateOf, tempDir, tickUntil } from './helpers.mjs';
import { accountEnv, accountUsage, addAccount, isAccountLimit, limitedUntil, loadAccounts, pickAccount, removeAccount, roleCmd } from '../tools/lib/accounts.mjs';
import { accountArgv, dashboardData, serveDashboard } from '../tools/lib/dashboard.mjs';
import { readEvents } from '../tools/lib/ledger.mjs';
import { childEnv, readJson, run } from '../tools/lib/util.mjs';

// 測試不碰你真的 ~/.config/dlm/accounts.json
process.env.DLM_ACCOUNTS_FILE = join(tempDir('dlm-acct-'), 'accounts.json');
after(cleanup);

const DLM = join(REPO, 'tools', 'dlm.mjs');
const dlm = (cwd, args, env = {}) => run(`node ${JSON.stringify(DLM)} ${args}`, { cwd, env: { DLM_ACCOUNTS_FILE: process.env.DLM_ACCOUNTS_FILE, ...env } });

describe('帳號清單與選號', () => {
  test('add / rm:dlm 建的目錄跟著刪,名稱檢查', () => {
    const a = addAccount('t-one', { cli: 'claude', plan: 'max' });
    assert.ok(existsSync(a.home));
    assert.equal(loadAccounts()['t-one'].plan, 'max');
    assert.throws(() => addAccount('t-one', { cli: 'claude' }), /已經有了/);
    assert.throws(() => addAccount('bad name', { cli: 'claude' }), /英數/);
    assert.throws(() => addAccount('t-x', { cli: 'gemini' }), /不支援的 CLI/);
    const r = removeAccount('t-one');
    assert.ok(r.home_deleted);
    assert.ok(!existsSync(a.home));
  });

  test('accountEnv 指到帳號目錄,並清掉會蓋過它的金鑰', () => {
    const env = accountEnv({ name: 'x', cli: 'claude', home: '/h/x' });
    assert.equal(env.CLAUDE_CONFIG_DIR, '/h/x');
    assert.equal(env.DLM_ACCOUNT, 'x');
    assert.equal(env.ANTHROPIC_API_KEY, '');
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
    try {
      const merged = childEnv(env);
      assert.ok(!('ANTHROPIC_API_KEY' in merged), '空字串 = 刪掉');
      assert.equal(merged.CLAUDE_CONFIG_DIR, '/h/x');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
    }
    assert.equal(accountEnv({ name: 'c', cli: 'codex', home: '/h/c' }).CODEX_HOME, '/h/c');
  });

  test('roleCmd:自己寫的 cmd 優先;沒寫就用 CLI 預設,帶上 model', () => {
    const claude = { name: 'a', cli: 'claude', home: '/h' };
    assert.equal(roleCmd({ cmd: 'mine' }, 'worker', claude), 'mine');
    assert.match(roleCmd({ model: 'opus' }, 'worker', claude), /^claude -p --output-format json --model opus --permission-mode acceptEdits/);
    assert.match(roleCmd({}, 'verifier', claude), /--model haiku --tools ""/);
    assert.doesNotMatch(roleCmd({}, 'critic', claude), /\{model\}|--model/);
    assert.match(roleCmd({ model: 'gpt-5-codex' }, 'worker', { name: 'c', cli: 'codex', home: '/h' }), /^codex exec .* -m gpt-5-codex - < "\$DLM_PROMPT"$/);
    assert.equal(roleCmd({}, 'worker', null), null);
  });

  test('限流偵測與重置時間', () => {
    const now = Date.parse('2026-10-15T10:00:00Z');
    assert.ok(isAccountLimit('Claude AI usage limit reached|1760000000'));
    assert.ok(isAccountLimit('API Error: 429 Too Many Requests'));
    assert.ok(!isAccountLimit('TypeError: x is undefined'));
    assert.equal(limitedUntil('usage limit reached|1760000000', now), new Date(1760000000 * 1000).toISOString());
    assert.equal(limitedUntil('no hint', now, 30), new Date(now + 30 * 60000).toISOString());
    const reset = Date.parse(limitedUntil("You've hit your limit · resets 3pm", now));
    assert.ok(reset > now && reset - now <= 24 * 3600e3);
    assert.equal(new Date(reset).getHours(), 15);
  });

  test('pickAccount:冷卻中的跳過、最近派最少的先、全部冷卻回 wait', () => {
    addAccount('p-a', { cli: 'claude' });
    addAccount('p-b', { cli: 'claude' });
    const now = Date.now();
    const later = new Date(now + 3600e3).toISOString();
    assert.equal(pickAccount(['p-a', 'p-b'], {}, now).name, 'p-a');
    assert.equal(pickAccount(['p-a', 'p-b'], { 'p-a': { dispatches_5h: 2 }, 'p-b': { dispatches_5h: 1 } }, now).name, 'p-b');
    assert.equal(pickAccount(['p-a', 'p-b'], { 'p-a': { limited_until: later } }, now).name, 'p-b');
    assert.deepEqual(pickAccount(['p-a', 'p-b'], { 'p-a': { limited_until: later }, 'p-b': { limited_until: later } }, now), { wait: later });
    assert.equal(pickAccount([], {}, now), null);
    assert.throws(() => pickAccount(['nope'], {}, now), /這台電腦沒有的帳號/);
  });

  test('accountUsage:派工次數、花費、冷卻;交件成功提早解除冷卻', () => {
    const now = Date.parse('2026-10-15T10:00:00Z');
    const ts = (minAgo) => new Date(now - minAgo * 60000).toISOString();
    const until = new Date(now + 3600e3).toISOString();
    const u = accountUsage([
      { type: 'dispatch', dispatch_id: 'd-1', account: 'a', ts: ts(400) },
      { type: 'cost', dispatch_id: 'd-1', role: 'worker', usd: 0.5, ts: ts(390) },
      { type: 'dispatch', dispatch_id: 'd-2', account: 'a', ts: ts(10) },
      { type: 'worker_failed', dispatch_id: 'd-2', limited_account: 'a', limited_until: until, ts: ts(9) },
      { type: 'dispatch', dispatch_id: 'd-3', account: 'b', ts: ts(8) },
      { type: 'cost', role: 'critic', account: 'b', usd: 0.25, ts: ts(5) },
    ], now);
    assert.equal(u.a.dispatches_5h, 1);
    assert.equal(u.a.dispatches_7d, 2);
    assert.equal(u.a.usd_total, 0.5);
    assert.equal(u.a.usd_5h, 0);
    assert.equal(u.a.limited_until, until);
    assert.equal(u.b.usd_5h, 0.25);
    const u2 = accountUsage([
      { type: 'dispatch', dispatch_id: 'd-1', account: 'a', ts: ts(30) },
      { type: 'worker_failed', dispatch_id: 'd-1', limited_account: 'a', limited_until: until, ts: ts(29) },
      { type: 'dispatch', dispatch_id: 'd-2', account: 'a', ts: ts(5) },
      { type: 'worker_done', dispatch_id: 'd-2', ts: ts(1) },
    ], now);
    assert.equal(u2.a.limited_until, null);
  });
});

describe('派工帶帳號、限流換號', () => {
  test('帳號 A 額度用完 → A 冷卻、馬上改用 B 重派,不算嘗試、不算連續失敗;worker 拿不到 shell 的金鑰', async () => {
    addAccount('rot-a', { cli: 'claude' });
    addAccount('rot-b', { cli: 'claude' });
    const envLog = join(tempDir('dlm-envlog-'), 'env.jsonl');
    const proj = makeProject({ config: { caps: { infra_halt_after: 1 } } });
    const cfg = readJson(join(proj, 'dlm.config.json'));
    cfg.agents.worker.cmd = `FAKE_MODE=good LIMIT_ACCOUNT=rot-a FAKE_ENV_LOG=${envLog} node ${FAKE}`;
    cfg.agents.worker.accounts = ['rot-a', 'rot-b'];
    (await import('node:fs')).writeFileSync(join(proj, 'dlm.config.json'), JSON.stringify(cfg, null, 2));
    sh(proj, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm accounts');
    addNode(proj, CALC, CALC_GHERKIN);
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
    let s;
    try {
      s = await tickUntil(proj, (st) => st.nodes.get('calc/v1').status === 'done', { max: 30 });
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
    }
    assert.ok(!s.halted, `連續失敗上限是 1,換號不能觸發停機:${s.halted?.reason}`);
    const evs = readEvents(proj);
    const fails = evs.filter((e) => e.type === 'worker_failed');
    assert.equal(fails.length, 1, '只有第一次用 A 失敗');
    assert.equal(fails[0].limited_account, 'rot-a');
    assert.ok(fails[0].switched);
    assert.ok(Date.parse(fails[0].limited_until) > Date.now() + 2 * 3600e3, '用 log 裡的重置時間');
    const ds = evs.filter((e) => e.type === 'dispatch');
    assert.equal(ds[0].account, 'rot-a');
    assert.ok(ds.slice(1).every((d) => d.account === 'rot-b'), 'A 冷卻期間都派給 B');
    assert.ok(ds.every((d) => d.attempt === 1));
    const seen = readFileSync(envLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(seen.every((e) => !e.api_key), 'ANTHROPIC_API_KEY 有清掉');
    assert.ok(seen.every((e) => e.home && e.home.endsWith(e.account)), 'CLAUDE_CONFIG_DIR 指到帳號目錄');

    const data = dashboardData(proj);
    const a = data.accounts.find((x) => x.name === 'rot-a');
    assert.ok(a.limited_until && a.roles.includes('worker'));
    assert.ok(data.accounts.find((x) => x.name === 'rot-b').dispatches_5h >= 2);
  });

  test('pool 只有一個帳號又被限流 → 照舊退避;全部冷卻時這輪不派', async () => {
    addAccount('solo', { cli: 'claude' });
    const proj = makeProject({ config: { caps: { infra_backoff_seconds: 0.2 } } });
    const cfg = readJson(join(proj, 'dlm.config.json'));
    cfg.agents.worker.cmd = `FAKE_MODE=good LIMIT_ACCOUNT=solo node ${FAKE}`;
    cfg.agents.worker.accounts = ['solo'];
    (await import('node:fs')).writeFileSync(join(proj, 'dlm.config.json'), JSON.stringify(cfg, null, 2));
    sh(proj, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm accounts');
    addNode(proj, CALC, CALC_GHERKIN);
    await tickUntil(proj, () => readEvents(proj).some((e) => e.type === 'worker_failed'));
    const f = readEvents(proj).find((e) => e.type === 'worker_failed');
    assert.equal(f.limited_account, 'solo');
    assert.ok(!f.switched);
    await new Promise((r) => setTimeout(r, 300));
    const { tick } = await import('../tools/lib/orchestrator.mjs');
    const r = await tick(proj);
    assert.equal(readEvents(proj).filter((e) => e.type === 'dispatch').length, 1, '冷卻中不派');
    assert.ok(r.ok);
    assert.notEqual(stateOf(proj).nodes.get('calc/v1').status, 'blocked');
  });
});

describe('dlm account 指令', () => {
  test('add / list --json / use(改設定並 commit)/ rm', () => {
    const proj = makeProject();
    let r = dlm(proj, 'account add cli-a --cli claude --plan max');
    assert.equal(r.code, 0, r.stderr);
    r = dlm(proj, 'account add cli-b --cli codex');
    assert.equal(r.code, 0, r.stderr);
    r = dlm(proj, 'account use worker cli-a,cli-b --model sonnet');
    assert.equal(r.code, 0, r.stderr);
    const cfg = readJson(join(proj, 'dlm.config.json'));
    assert.deepEqual(cfg.agents.worker.accounts, ['cli-a', 'cli-b']);
    assert.equal(cfg.agents.worker.model, 'sonnet');
    assert.match(sh(proj, 'git log -1 --format=%s'), /dlm account use worker/);
    assert.equal(sh(proj, 'git status --porcelain -- dlm.config.json'), '');
    r = dlm(proj, 'account list --json', { CLAUDE_CONFIG_DIR: '' });
    assert.equal(r.code, 0, r.stderr);
    const list = JSON.parse(r.stdout).accounts;
    const a = list.find((x) => x.name === 'cli-a');
    assert.equal(a.plan, 'max');
    assert.deepEqual(a.roles, ['worker']);
    r = dlm(proj, 'account use verifier cli-a');
    assert.equal(readJson(join(proj, 'dlm.config.json')).agents.verifier.backend, 'cmd');
    r = dlm(proj, 'account use worker nope');
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /這台電腦沒有帳號 nope/);
    r = dlm(proj, 'account rm cli-b');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /還在用它/);
    r = dlm(proj, 'account login cli-a');
    assert.notEqual(r.code, 0, '沒有終端機不能登入');
    assert.match(r.stderr, /終端機/);
  });
});

describe('主控台設定帳號(--serve)', () => {
  test('accountArgv:只產生 dlm account 的 argv,值都先檢查', () => {
    assert.deepEqual(accountArgv({ action: 'add', name: 'max-a', cli: 'claude', plan: 'max' }), ['account', 'add', 'max-a', '--cli', 'claude', '--plan', 'max']);
    assert.deepEqual(accountArgv({ action: 'use', role: 'worker', accounts: ['a', 'b'], model: '' }), ['account', 'use', 'worker', 'a,b', '--model', 'none']);
    assert.deepEqual(accountArgv({ action: 'use', role: 'critic', accounts: [] }), ['account', 'use', 'critic', 'none', '--model', 'none']);
    assert.throws(() => accountArgv({ action: 'add', name: 'a;rm -rf /', cli: 'claude' }), /英數/);
    assert.throws(() => accountArgv({ action: 'use', role: 'boss', accounts: [] }), /角色/);
    assert.throws(() => accountArgv({ action: 'use', role: 'worker', accounts: ['a'], model: '$(x)' }), /模型/);
    assert.throws(() => accountArgv({ action: 'decide' }), /不支援/);
  });

  test('POST /api/account:沒 token / 別的 Origin / 非 JSON 一律擋;帶對的 token 才改設定並 commit', async () => {
    addAccount('dash-a', { cli: 'claude' });
    const proj = makeProject();
    const server = await serveDashboard(proj, { port: 0, log: () => {} });
    const port = server.address().port;
    try {
      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      const token = JSON.parse(html.match(/var TOKEN = ("[0-9a-f]+");/)[1]);
      const post = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/api/account`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dlm-token': token, ...headers }, body: JSON.stringify(body) });
      const use = { action: 'use', role: 'worker', accounts: ['dash-a'], model: 'opus' };
      assert.equal((await post(use, { 'x-dlm-token': 'nope' })).status, 403);
      assert.equal((await post(use, { origin: 'http://evil.example' })).status, 403);
      assert.equal((await post(use, { 'content-type': 'text/plain' })).status, 415);
      assert.equal((await post({ action: 'add', name: 'bad name', cli: 'claude' })).status, 400);
      assert.equal(readJson(join(proj, 'dlm.config.json')).agents.worker.accounts, undefined, '被擋的請求沒有改到設定');
      const r = await (await post(use)).json();
      assert.ok(r.ok, r.out);
      const w = readJson(join(proj, 'dlm.config.json')).agents.worker;
      assert.deepEqual(w.accounts, ['dash-a']);
      assert.equal(w.model, 'opus');
      assert.match(sh(proj, 'git log -1 --format=%s'), /dlm account use worker dash-a/);
      const data = await (await fetch(`http://127.0.0.1:${port}/data.json`)).json();
      assert.deepEqual(data.account_config.roles.worker.accounts, ['dash-a']);
      assert.ok(data.account_config.registry.some((a) => a.name === 'dash-a'));
      // 模型留空 = 拿掉
      assert.ok((await (await post({ ...use, model: '' })).json()).ok);
      assert.equal(readJson(join(proj, 'dlm.config.json')).agents.worker.model, undefined);
    } finally {
      server.close();
    }
  });
});

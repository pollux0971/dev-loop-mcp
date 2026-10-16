// 新手引導:dp setup(互動問答)與 dp doctor(健康檢查)。
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { roleCmd } from '../tools/lib/accounts.mjs';
import { keyPath } from '../tools/lib/auth.mjs';
import { doctor, executableOf, renderDoctor } from '../tools/lib/doctor.mjs';
import { DP_CLAUDE_HOOKS } from '../tools/lib/hooks.mjs';
import { init } from '../tools/lib/install.mjs';
import { loadConfig } from '../tools/lib/config.mjs';
import { CLAUDE_CRITIC_CMD, CLAUDE_VERIFIER_CMD, CLAUDE_WORKER_CMD, setup } from '../tools/lib/setup.mjs';
import { readJson, run } from '../tools/lib/util.mjs';
import { REPO, cleanup, sh, tempDir } from './helpers.mjs';

after(cleanup);

const DP = join(REPO, 'tools', 'dp.mjs');
const ENV = { claude: true };
const fresh = () => {
  const proj = join(tempDir(), 'app');
  init(proj, { name: 'app' });
  return proj;
};
/** 照題目 id 回答;沒列的回空字串(= 用預設)。也記下問過哪些題。 */
const scripted = (answers) => {
  const asked = [];
  return { asked, ask: async (q) => { asked.push(q.id); return answers[q.id] ?? ''; } };
};
const quiet = () => {};

test('payload 的 hooks 設定與 setup 合併用的是同一份', () => {
  assert.deepEqual(readJson(join(REPO, 'payload/.claude/settings.json')).hooks, DP_CLAUDE_HOOKS);
});

test('setup 全用預設:Claude Code 施工、Haiku 當 Verifier、L1、commit', async () => {
  const proj = fresh();
  const { ask, asked } = scripted({ npm_install: 'n' });
  const r = await setup(proj, { ask, detect: ENV, log: quiet });
  const cfg = readJson(join(proj, 'dp.config.json'));
  assert.equal(cfg.platform, 'claude');
  assert.equal(cfg.agents.worker.cmd, CLAUDE_WORKER_CMD);
  assert.match(cfg.agents.worker.cmd, /--disallowedTools "Bash\(rm -rf \*\)"/, '擋 rm -rf');
  assert.deepEqual(cfg.agents.verifier, { ...cfg.agents.verifier, backend: 'cmd', cmd: CLAUDE_VERIFIER_CMD });
  assert.equal(cfg.autonomy.level, 1);
  assert.equal(cfg.sandbox, undefined, '沒有沙箱設定');
  assert.ok(r.committed);
  assert.equal(sh(proj, 'git status --porcelain --untracked-files=no'), '', 'commit 之後根目錄乾淨,tick 才跑得動');
  assert.deepEqual(asked.filter((id) => ['platform', 'worker_cmd', 'verifier', 'autonomy'].includes(id)), ['platform', 'worker_cmd', 'verifier', 'autonomy']);
  // 原本 payload 設定裡的其他東西都還在
  assert.deepEqual(cfg.gates.chain, ['check:dp', 'typecheck', 'test', 'accept']);
});

test('setup:自訂指令;看不懂的自治等級要重問;L2 開 Critic 用 Claude 的唯讀指令', async () => {
  const proj = fresh();
  let autonomyTries = 0;
  const answers = { platform: 'custom', worker_cmd: 'my-agent < "$DP_PROMPT"', npm_install: 'n' };
  const ask = async (q) => (q.id === 'autonomy' ? (++autonomyTries === 1 ? '4' : '') : answers[q.id] ?? '');
  await setup(proj, { ask, detect: ENV, log: quiet });
  const cfg = readJson(join(proj, 'dp.config.json'));
  assert.equal(cfg.platform, 'generic');
  assert.equal(cfg.agents.worker.cmd, 'my-agent < "$DP_PROMPT"');
  assert.equal(cfg.autonomy.level, 1);
  assert.equal(autonomyTries, 2, '不存在的選項要重問');

  const proj2 = fresh();
  await setup(proj2, { ask: scripted({ autonomy: '2', critic: 'y', npm_install: 'n' }).ask, detect: ENV, log: quiet });
  const c2 = readJson(join(proj2, 'dp.config.json'));
  assert.equal(c2.autonomy.level, 2);
  assert.equal(c2.agents.critic.cmd, CLAUDE_CRITIC_CMD);
  assert.match(c2.agents.critic.cmd, /--disallowedTools "Edit" "Write"/, 'Critic 只能讀');
});

test('setup:已經有自己的 .claude/settings.json 時,把 dp 的 hooks 合併進去,原本的設定保留', async () => {
  const proj = fresh();
  writeFileSync(join(proj, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } }));
  sh(proj, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm mine');
  await setup(proj, { ask: scripted({ npm_install: 'n' }).ask, detect: ENV, log: quiet });
  const s = readJson(join(proj, '.claude/settings.json'));
  assert.deepEqual(s.permissions, { allow: ['Bash(npm test)'] });
  assert.ok(s.hooks.Stop);
  assert.match(JSON.stringify(s.hooks.UserPromptSubmit), /hook user-prompt/);
  // 再跑一次不會重複加
  await setup(proj, { ask: scripted({ npm_install: 'n' }).ask, detect: ENV, log: quiet });
  assert.equal(readJson(join(proj, '.claude/settings.json')).hooks.UserPromptSubmit.length, 1);
});

test('setup:還沒裝 dp 的目錄 → 告訴你先 init', async () => {
  await assert.rejects(() => setup(tempDir(), { ask: async () => '', detect: ENV, log: quiet }), /先跑.*init/);
});

test('doctor:剛 init 的專案 → worker 沒設定是 ✗,附修法;隔離 ⚠', async () => {
  const proj = fresh();
  const rep = await doctor(proj);
  assert.equal(rep.ok, false);
  const worker = rep.results.find((r) => r.name === 'worker 指令');
  assert.equal(worker.status, 'fail');
  assert.match(worker.fix, /dp setup/);
  assert.equal(rep.results.find((r) => r.name === '隔離').status, 'warn');
  assert.match(renderDoctor(rep), /最快的方法:node tools\/dp\.mjs setup/);
});

test('doctor:設定好之後通過;gate 少了 script 是 ✗;hooks 不見是 ⚠', async () => {
  const proj = fresh();
  const cfg = readJson(join(proj, 'dp.config.json'));
  cfg.agents.worker.cmd = 'FOO=1 node -e 0';
  cfg.gates.chain = ['check:dp', 'test'];
  writeFileSync(join(proj, 'dp.config.json'), JSON.stringify(cfg));
  const pkg = readJson(join(proj, 'package.json'));
  pkg.devDependencies = {};
  writeFileSync(join(proj, 'package.json'), JSON.stringify(pkg));
  sh(proj, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm ok');
  const good = await doctor(proj);
  assert.ok(good.ok, renderDoctor(good));

  cfg.gates.chain = ['check:dp', 'test', 'nope'];
  cfg.autonomy.level = 2;
  writeFileSync(join(proj, 'dp.config.json'), JSON.stringify(cfg));
  writeFileSync(join(proj, '.claude/settings.json'), '{}');
  const bad = await doctor(proj);
  const status = (rep, n) => rep.results.find((r) => r.name === n)?.status;
  assert.equal(status(bad, '合併 gate'), 'fail');
  assert.equal(status(bad, '隔離'), 'warn');
  assert.match(bad.results.find((r) => r.name === '隔離').detail, /自治等級 2/);
  assert.equal(status(bad, '授權 hooks'), 'warn', '沒有 hooks 不會擋你的決定');
  assert.ok(bad.results.some((r) => r.name === 'git' && r.status === 'warn'), '有未 commit 的變更要提醒');
});

test('舊設定檔裡已移除的設定:讀得進來,doctor 逐條提醒;只是預設值的不提醒', async () => {
  const proj = fresh();
  const cfg = readJson(join(proj, 'dp.config.json'));
  cfg.agents.worker.cmd = 'node -e 0';
  cfg.sandbox = { backend: 'docker', image: 'dp-worker:latest', pass_env: ['CLAUDE_CODE_OAUTH_TOKEN'] };
  cfg.agents.manager = { cmd: 'claude -p' };
  cfg.auth = { mode: 'signed', window_minutes: 30 };
  cfg.front = { guard: 'light' };
  cfg.agents.verifier = { backend: 'http', url: 'http://localhost:11434/v1/chat/completions', model: 'qwen3:4b' };
  cfg.autonomy = { level: 3 };
  writeFileSync(join(proj, 'dp.config.json'), JSON.stringify(cfg));
  const c = loadConfig(proj);
  assert.equal(c.autonomy.level, 2, 'L3 當成 L2');
  assert.equal(c.agents.verifier.backend, 'none', 'http 的 Verifier 停用');
  assert.equal(c.agents.manager, undefined);
  const warned = (await doctor(proj)).results.filter((r) => r.name === 'dp.config.json' && r.status === 'warn').map((r) => r.detail.split(':')[0]);
  for (const k of ['agents.manager', 'sandbox', 'auth.mode', 'agents.verifier.url', 'agents.verifier.model', 'agents.verifier.backend', 'autonomy.level']) assert.ok(warned.includes(k), k);
  assert.equal(c.agents.verifier.model, undefined, 'Ollama 的模型名拿掉');
  assert.ok(!warned.includes('front'), 'front.guard=light 是當時的預設,不用提醒');
});

test('帳號模式的 Verifier 模型(agents.verifier.model)留著、不提醒;派工指令帶上它', async () => {
  const proj = fresh();
  const cfg = readJson(join(proj, 'dp.config.json'));
  cfg.agents.verifier = { backend: 'cmd', accounts: ['max-a'], model: 'sonnet' };
  writeFileSync(join(proj, 'dp.config.json'), JSON.stringify(cfg));
  const c = loadConfig(proj);
  assert.equal(c.agents.verifier.model, 'sonnet', 'v4.6 的帳號模式用這個欄位選模型');
  const warned = (await doctor(proj)).results.filter((r) => r.name === 'dp.config.json' && r.status === 'warn').map((r) => r.detail.split(':')[0]);
  assert.ok(!warned.includes('agents.verifier.model'), '不是舊的 http 設定,不用提醒');
  assert.match(roleCmd(c.agents.verifier, 'verifier', { cli: 'claude' }), /--model sonnet/);
});

test('doctor:Verifier 指令找不到 → ✗', async () => {
  const proj = fresh();
  const cfg = readJson(join(proj, 'dp.config.json'));
  cfg.agents.verifier = { backend: 'cmd', cmd: 'no-such-verifier-xyz --json' };
  writeFileSync(join(proj, 'dp.config.json'), JSON.stringify(cfg));
  const v = (await doctor(proj)).results.find((r) => r.name === 'Verifier 小模型');
  assert.equal(v.status, 'fail');
  assert.match(v.detail, /找不到 no-such-verifier-xyz/);
});

test('CLI:dp setup --answers 不互動跑完並接著做健康檢查;非終端機又沒給答案就說明怎麼做', () => {
  const proj = fresh();
  const ans = join(tempDir(), 'a.json');
  writeFileSync(ans, JSON.stringify({ npm_install: 'n', platform: 'custom', worker_cmd: 'node -e 0' }));
  const r = run(`node ${DP} setup --answers ${ans} --root ${proj}`);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /— 健康檢查 —/);
  assert.equal(readJson(join(proj, 'dp.config.json')).agents.worker.cmd, 'node -e 0');
  const n = run(`node ${DP} setup --root ${proj} < /dev/null`);
  assert.notEqual(n.code, 0);
  assert.match(n.stderr, /--yes/);
  const d = run(`node ${DP} doctor --json --root ${proj}`);
  assert.ok(Array.isArray(JSON.parse(d.stdout).results));
});

test('init 之後的下一步指向 setup', () => {
  const dir = join(tempDir(), 'x');
  const r = run(`node ${DP} init ${dir} --name x`);
  assert.match(r.stdout, /tools\/dp\.mjs setup/);
});

test('executableOf 跳過環境變數設定', () => {
  assert.equal(executableOf('A=1 B="x" claude -p'), 'claude');
  assert.equal(executableOf(''), null);
});

test('Front 的 hook:Bash 照常放行;檔案工具讀不到金鑰目錄', () => {
  assert.equal(run(`echo '{"tool_name":"Bash","tool_input":{"command":"node tools/dp.mjs doctor"}}' | node ${DP} hook pre-tool`).code, 0);
  const r = run(`echo '{"tool_name":"Read","tool_input":{"file_path":"${join(dirname(keyPath()), 'anything')}"}}' | node ${DP} hook pre-tool`);
  assert.equal(r.code, 2);
});

test('payload 沒有已移除功能的殘留檔', () => {
  for (const p of ['payload/.codex', 'payload/.agents', 'payload/prompts/manager.md', 'tools/lib/migrate.mjs']) {
    assert.equal(run(`test -e ${join(REPO, p)}`).code, 1, p);
  }
  assert.doesNotMatch(readFileSync(join(REPO, 'payload/dp.config.json'), 'utf8'), /"(sandbox|manager|front)"/);
});

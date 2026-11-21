import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents } from '../tools/lib/ledger.mjs';
import { run } from '../tools/lib/util.mjs';
import { CALC, CALC_GHERKIN, REPO, cleanup, makeProject, tempDir } from './helpers.mjs';
import { proposeFeature } from '../tools/lib/intake.mjs';

after(cleanup);

const DLM = join(REPO, 'tools', 'dlm.mjs');
const dlm = (args, opts = {}) => run(`node '${DLM}' ${args}`, opts);

describe('CLI 的使用體驗', () => {
  test('不是專案的資料夾:專案指令直接說清楚,不在那裡留下任何檔', () => {
    const dir = tempDir('dlm-notproj-');
    for (const cmd of ['status', 'inbox', 'tick', 'show x']) {
      const r = dlm(cmd, { cwd: dir });
      assert.equal(r.code, 1, cmd);
      assert.match(r.stderr, /不是 dlm 專案[\s\S]*dlm project list/, cmd);
    }
    assert.deepEqual(readdirSync(dir), [], '以前 inbox 會在這裡寫 STATUS.md、ledger/、.dlm/');
  });

  test('在專案的子資料夾裡跑:往上找到專案', () => {
    const proj = makeProject();
    const sub = join(proj, 'packages', 'deep');
    mkdirSync(sub, { recursive: true });
    const r = dlm('status', { cwd: sub });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /下一步:還沒有任何節點/);
  });

  test('打錯指令:兩行就好,猜你要打什麼;--version 印版本', () => {
    const r = dlm('stauts', { cwd: REPO });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /你是不是要打 dlm status/);
    assert.ok(r.stderr.split('\n').length <= 4, `不要整份說明:${r.stderr}`);
    assert.match(dlm('--version').stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  test('單一指令的 --help 只印那個指令', () => {
    const r = dlm('run --help', { cwd: REPO });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /dlm run \[--interval/);
    assert.doesNotMatch(r.stdout, /dlm account add/);
  });

  test('--key=value 跟 --key value 一樣;數字旗標不是數字就拒絕、什麼都不做', () => {
    const proj = makeProject();
    const bad = dlm('run --max-ticks abc', { cwd: proj });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--max-ticks 要是正整數/);
    assert.match(dlm('run --interval=0', { cwd: proj }).stderr, /--interval 要是/);
    assert.match(dlm('settings --budget abc', { cwd: proj }).stderr, /--budget 要是數字/);
    const ok = dlm('settings --budget=7', { cwd: proj });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /daily_usd:5 → 7/);
  });

  test('一次決定好幾件:有一個 ref 不對就一件都不記,並列出現在能決定的', () => {
    const proj = makeProject();
    const p = proposeFeature(proj, CALC, CALC_GHERKIN);
    const before = readEvents(proj).length;
    const r = dlm(`decide node:${p.id},node:p-999 yes`, { cwd: proj });
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`沒有待決事項 node:p-999\\(現在等你決定的:node:${p.id}\\)`));
    assert.equal(readEvents(proj).length, before, '前面那件也不能被偷偷記下來');
  });
});

// v4.12 review batch 1
describe('dlm setup: answers format and Ctrl+D', () => {
  const pyInit = () => {
    const proj = join(tempDir(), 'app');
    const r = dlm(`init '${proj}' --name app --stack python`);
    assert.equal(r.code, 0, r.stderr);
    return proj;
  };

  test('--help and the non-terminal error name the answer ids and give an example', () => {
    const help = dlm('setup --help').stdout;
    for (const id of ['mode', 'test_cmd', 'main_branch', 'platform', 'worker_cmd', 'verifier', 'autonomy', 'critic', 'budget', 'parallel', 'npm_install', 'commit']) {
      assert.match(help, new RegExp(`\\b${id}\\b`), id);
    }
    assert.match(help, /AGENTS-SETUP\.md/);
    const r = run(`node '${DLM}' setup < /dev/null`, { cwd: pyInit() });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--answers a\.json/);
    assert.match(r.stderr, /"mode": "greenfield"/);
    assert.match(r.stderr, /題目 id:mode test_cmd main_branch platform/);
  });

  const hasScript = run('script -qec true /dev/null').code === 0;
  test('Ctrl+D at the first prompt: "已取消,設定沒有寫入", nothing written, exit 130', { skip: !hasScript && 'no script(1) for a pseudo terminal' }, () => {
    const proj = pyInit();
    const cfg = readFileSync(join(proj, 'dlm.config.json'), 'utf8');
    const r = run(`(sleep 1; printf '\\004') | script -qec "node '${DLM}' setup; echo EXIT=\\$?" /dev/null`, { cwd: proj, timeoutMs: 30000 });
    assert.match(r.stdout, /已取消,設定沒有寫入/);
    assert.match(r.stdout, /EXIT=130/);
    assert.doesNotMatch(r.stdout, /AbortError/);
    assert.equal(readFileSync(join(proj, 'dlm.config.json'), 'utf8'), cfg);
  });
});

// v4.12 review batch 2
describe('a repo whose branch is master', () => {
  test('setup asks to use master; doctor has no ✗ for git; tick runs', async () => {
    const { init } = await import('../tools/lib/install.mjs');
    const { setup } = await import('../tools/lib/setup.mjs');
    const { doctor } = await import('../tools/lib/doctor.mjs');
    const { tick } = await import('../tools/lib/orchestrator.mjs');
    const { readJson } = await import('../tools/lib/util.mjs');
    const proj = join(tempDir(), 'm');
    mkdirSync(proj);
    run('git init -q -b master && echo hi > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm first', { cwd: proj });
    init(proj, { name: 'm', existing: true });
    // before setup: main does not exist → blocking, with a fix that works (not `git switch main`)
    const pre = (await doctor(proj)).results.find((r) => r.name === 'git');
    assert.equal(pre.status, 'fail');
    assert.match(pre.detail, /主線分支 main 不存在/);
    assert.match(pre.fix, /main_branch 設成 "master"/);
    assert.match(pre.fix, /git branch -m master main/);
    assert.doesNotMatch(pre.fix, /git switch/);
    const asked = [];
    await setup(proj, { ask: async (q) => { asked.push(q.id); return q.id === 'npm_install' ? 'n' : ''; }, detect: { claude: true }, log: () => {} });
    assert.ok(asked.includes('main_branch'));
    assert.equal(readJson(join(proj, 'dlm.config.json')).main_branch, 'master');
    const git = (await doctor(proj)).results.find((r) => r.name === 'git');
    assert.notEqual(git.status, 'fail', JSON.stringify(git));
    const t = await tick(proj, { log: () => {} });
    assert.equal(t.ok, true, t.reason);
  });

  test('a repo on main is not asked about the branch', async () => {
    const { setup } = await import('../tools/lib/setup.mjs');
    const proj = makeProject();
    const asked = [];
    await setup(proj, { ask: async (q) => { asked.push(q.id); return q.id === 'npm_install' ? 'n' : ''; }, detect: { claude: true }, log: () => {} });
    assert.ok(!asked.includes('main_branch'));
  });

  test('dlm gates on an empty DAG says the check:dlm red is expected; init . skips the cd', () => {
    const proj = join(tempDir(), 'g');
    assert.equal(dlm(`init '${proj}' --name g`).code, 0);
    const r = dlm('gates', { cwd: proj });
    assert.match(r.stdout, /還沒有任何節點,check:dlm 失敗是正常的/);
    const here = join(tempDir(), 'h');
    mkdirSync(here);
    const i = dlm('init . --name h', { cwd: here });
    assert.equal(i.code, 0, i.stderr);
    assert.match(i.stdout, /下一步:node tools\/dlm\.mjs setup/);
    assert.doesNotMatch(i.stdout, /cd \./);
  });
});

describe('Verifier forms disagree: both reasons are kept', () => {
  test('ABSTAIN detail, verify results and dlm show carry each form\'s verdict and reason', async () => {
    const { FAKE_VERIFIER, addNode, tickUntil, waitWorkers } = await import('./helpers.mjs');
    const counter = join(tempDir(), 'fv-counter');
    const proj = makeProject({ config: { agents: { verifier: { backend: 'cmd', cmd: `FV=disagree-why FV_COUNTER='${counter}' node ${FAKE_VERIFIER}` } } } });
    addNode(proj, CALC, CALC_GHERKIN);
    const s = await tickUntil(proj, (st) => [...st.dispatches.values()].some((d) => d.leg === 'dev' && d.verify));
    await waitWorkers(proj);
    const dev = [...s.dispatches.values()].find((d) => d.leg === 'dev');
    const ab = dev.verify.results.find((r) => r.outcome === 'ABSTAIN' && r.forms);
    assert.ok(ab, JSON.stringify(dev.verify.results));
    assert.deepEqual(ab.forms.map((f) => [f.form, f.verdict]), [['a', 'FAIL'], ['b', 'NO_OBJECTION']]);
    assert.match(ab.detail, /a FAIL:exit 2 是收集錯誤,不是測試失敗;b NO_OBJECTION:ModuleNotFoundError 表示實作還不存在/);
    const shown = dlm(`show ${dev.dispatch_id}`, { cwd: proj }).stdout;
    assert.match(shown, /exit 2 是收集錯誤/);
    assert.match(shown, /ModuleNotFoundError 表示實作還不存在/);
  });
});

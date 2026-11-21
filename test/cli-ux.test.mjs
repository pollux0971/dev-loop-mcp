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
    for (const id of ['mode', 'test_cmd', 'platform', 'worker_cmd', 'verifier', 'autonomy', 'critic', 'budget', 'parallel', 'npm_install', 'commit']) {
      assert.match(help, new RegExp(`\\b${id}\\b`), id);
    }
    assert.match(help, /AGENTS-SETUP\.md/);
    const r = run(`node '${DLM}' setup < /dev/null`, { cwd: pyInit() });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--answers a\.json/);
    assert.match(r.stderr, /"mode": "greenfield"/);
    assert.match(r.stderr, /題目 id:mode test_cmd platform/);
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

// v4.11: the core names no language or framework; everything specific lives in stacks/<name>/.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { testTools } from '../tools/lib/agents.mjs';
import { DEFAULTS, loadConfig } from '../tools/lib/config.mjs';
import { init } from '../tools/lib/install.mjs';
import { ruleItems } from '../tools/lib/rules-doc.mjs';
import { defaultAcceptFor, existingProjectOff, listStacks, loadStack, stackName, stackRules, stackTestLegChecks } from '../tools/lib/stack.mjs';
import { matchAny, readJson, tail } from '../tools/lib/util.mjs';
import { r } from '../tools/lib/verify/script-checks.mjs';
import { REPO, cleanup, tempDir } from './helpers.mjs';

after(cleanup);

const lib = { r, tail, matchAny, readJson };
const put = (p, text) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };

test('核心不認得任何測試框架:tools/lib 與 payload 的規則裡沒有 vitest / cucumber / stryker / tsc 的指令', () => {
  const words = /\b(npx vitest|npx cucumber-js|stryker run|npm run accept|tsc --noEmit)\b/;
  for (const f of ['tools/lib/config.mjs', 'tools/lib/intake.mjs', 'tools/lib/setup.mjs', 'tools/lib/accounts.mjs', 'tools/lib/verify/script-checks.mjs', 'payload/prompts/worker.md', 'payload/dlm.config.json']) {
    assert.doesNotMatch(readFileSync(join(REPO, f), 'utf8'), words, f);
  }
  for (const f of ['package.json', 'tsconfig.json', 'cucumber.js', 'stryker.config.json', 'vitest.config.ts']) {
    assert.ok(!existsSync(join(REPO, 'payload', f)), `${f} 搬進 stacks/node-ts/template 了`);
  }
  assert.deepEqual(DEFAULTS.gates.chain, ['check:dlm', 'test']);
  assert.equal(DEFAULTS.verify.typecheck_cmd, null);
});

test('技術棧:有 node-ts;每個都有 stack.json,規則檔在上限內', () => {
  assert.ok(listStacks().includes('node-ts'));
  for (const name of listStacks()) {
    const s = loadStack(name);
    assert.equal(s.name, name);
    assert.ok(Buffer.byteLength(stackRules(s)) <= DEFAULTS.limits.rules_bytes, `${name}/rules.md 超過 rules_bytes`);
  }
  assert.deepEqual(loadStack('none'), { name: 'none' });
  assert.throws(() => loadStack('cobol'), /找不到技術棧 cobol/);
  assert.equal(defaultAcceptFor(loadStack('node-ts'), 'features/a/v1.feature'), 'npm run accept -- features/a/v1.feature');
  assert.equal(defaultAcceptFor(loadStack('none'), 'x'), null);
});

test('專案用哪個技術棧:寫了就照寫的;沒寫就偵測(4.11 以前的 Node 專案行為不變);Python 專案是 none', () => {
  const node = tempDir();
  writeFileSync(join(node, 'package.json'), '{}');
  assert.equal(stackName(node, {}), 'node-ts');
  assert.equal(stackName(node, { project: { stack: 'none' } }), 'none');
  const py = tempDir();
  writeFileSync(join(py, 'pyproject.toml'), '');
  assert.equal(stackName(py, {}), 'none');
  writeFileSync(join(py, 'dlm.config.json'), JSON.stringify({ gates: { commands: { test: 'python3 -m pytest -q' } } }));
  const cfg = loadConfig(py);
  assert.equal(cfg.project.stack, 'none');
  assert.deepEqual(cfg.gates.chain, ['check:dlm', 'test']);
  assert.ok(!cfg.verify.rerun_allow.some((p) => p.startsWith('npm')), 'Python 專案的證據指令不會出現 npm');
  assert.ok(cfg.verify.rerun_allow.includes('python3 -m pytest'), 'gates.commands 的測試框架照樣加進去');
  assert.ok(!cfg.paths.forbidden.includes('package.json'));
  writeFileSync(join(node, 'dlm.config.json'), '{}');
  const ncfg = loadConfig(node);
  assert.equal(ncfg.project.stack, 'node-ts');
  assert.deepEqual(ncfg.gates.chain, ['check:dlm', 'typecheck', 'test', 'accept']);
  assert.ok(ncfg.verify.rerun_allow.includes('npm test') && ncfg.verify.rerun_allow.includes('git diff'), '核心的加技術棧的');
  assert.ok(ncfg.paths.forbidden.includes('package.json') && ncfg.paths.forbidden.includes('ledger/**'));
});

test('Critic 能跑的指令跟著證據前綴走,不寫死任何框架', () => {
  assert.equal(testTools({ verify: { rerun_allow: ['npm test', 'python3 -m pytest', 'bad"quote'] } }), '"Bash(npm test*)" "Bash(python3 -m pytest*)"');
});

test('既有專案沒裝範本:沒有 accept:dry、stryker 就把對應的預設關掉', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
  assert.deepEqual(existingProjectOff(dir, loadStack('node-ts')), { dry_run_cmd: null, mutation: { cmd: null } });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'accept:dry': 'x' }, devDependencies: { '@stryker-mutator/core': '1' } }));
  assert.deepEqual(existingProjectOff(dir, loadStack('node-ts')), {});
  assert.deepEqual(existingProjectOff(dir, loadStack('none')), {});
});

test('init --stack none 只裝核心;預設 node-ts 裝範本並記在設定與 manifest', () => {
  const bare = join(tempDir(), 'bare');
  const r0 = init(bare, { name: 'bare', stack: 'none', commit: false });
  assert.equal(r0.stack, 'none');
  for (const f of ['package.json', 'tsconfig.json', 'scripts/check-dry-run.ts', 'features/steps/_world.ts']) assert.ok(!existsSync(join(bare, f)), f);
  assert.ok(existsSync(join(bare, 'tools/stacks/node-ts/stack.json')), '技術棧的宣告照樣裝在 tools/stacks');
  assert.ok(!existsSync(join(bare, 'tools/stacks/node-ts/template')), '範本不進 tools/');
  assert.equal(readJson(join(bare, 'dlm.config.json')).project.stack, 'none');
  assert.equal(loadConfig(bare).project.stack, 'none');
  const ts = join(tempDir(), 'ts');
  init(ts, { name: 'ts', commit: false });
  assert.equal(readJson(join(ts, 'package.json')).name, 'ts', '範本的 placeholder 也填好');
  assert.ok(existsSync(join(ts, 'features/steps/_world.ts')));
  assert.equal(readJson(join(ts, '.dlm-install.json')).stack, 'node-ts');
  assert.equal(readJson(join(ts, 'dlm.config.json')).project.stack, 'node-ts');
  assert.ok(readdirSync(join(ts, 'tools/stacks')).includes('README.md'));
});

test('node-ts 測試棒:這一棒寫的檔有型別錯誤 → FAIL;找不到實作模組不算;別人的檔不算', async () => {
  const wt = tempDir();
  const config = { ...DEFAULTS, verify: { ...DEFAULTS.verify, typecheck_cmd: 'auto' } };
  writeFileSync(join(wt, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }));
  const out = [
    "features/steps/a.steps.ts(3,7): error TS2375: Type '{ x: undefined; }' is not assignable (exactOptionalPropertyTypes).",
    "features/steps/a.steps.ts(1,20): error TS2307: Cannot find module '../../packages/a/src/index.js'.",
    "packages/b/src/b.ts(9,1): error TS2322: Type 'string' is not assignable to type 'number'.",
  ].join('\n');
  let ran = null;
  const ex = { cwd: wt, sh: (cmd) => { ran = cmd; return { code: 2, stdout: out, stderr: '' }; } };
  const stack = loadStack('node-ts');
  const res = await stackTestLegChecks(stack, { ex, wt, changed: ['features/steps/a.steps.ts'], config, lib });
  assert.equal(ran, 'npm run --silent typecheck');
  const tc = res.find((x) => x.check === 'typecheck');
  assert.equal(tc.outcome, 'FAIL');
  assert.match(tc.detail, /1 個型別錯誤.*TS2375/);
  const onlyMissing = { cwd: wt, sh: () => ({ code: 2, stdout: out.split('\n').slice(1).join('\n'), stderr: '' }) };
  const ok = await stackTestLegChecks(stack, { ex: onlyMissing, wt, changed: ['features/steps/a.steps.ts'], config, lib });
  assert.equal(ok.find((x) => x.check === 'typecheck').outcome, 'PASS', '只有找不到實作與別人的檔:不擋');
  const none = await stackTestLegChecks(stack, { ex, wt, changed: ['features/steps/a.steps.ts'], config: DEFAULTS, lib });
  assert.ok(!none.some((x) => x.check === 'typecheck'), 'typecheck_cmd 是 null 就不跑');
  assert.deepEqual(await stackTestLegChecks(loadStack('none'), { ex, wt, changed: ['x'], config, lib }), [], '沒有技術棧就沒有額外檢查');
});

test('node-ts 測試棒:import() 要寫字面路徑', async () => {
  const wt = tempDir();
  put(join(wt, 'features/steps/a.steps.ts'), [
    "const m = await import('../../packages/a/src/index.js');",
    'const t = await import(`../../packages/a/src/x.js`);',
    "const p = '../../packages/a/src/index.js';",
    'const n = await import(p);',
    'const q = await import(`../${dir}/index.js`);',
  ].join('\n'));
  put(join(wt, 'packages/a/src/impl.ts'), 'export const load = (p: string) => import(p);\n');
  const ex = { cwd: wt, sh: () => ({ code: 0, stdout: '', stderr: '' }) };
  const res = await stackTestLegChecks(loadStack('node-ts'), { ex, wt, changed: ['features/steps/a.steps.ts', 'packages/a/src/impl.ts'], config: DEFAULTS, lib });
  const li = res.find((x) => x.check === 'literal-import');
  assert.equal(li.outcome, 'FAIL');
  assert.match(li.detail, /a\.steps\.ts:4, features\/steps\/a\.steps\.ts:5$/, '只抓測試檔裡的變數路徑');
});

test('準則總表:列表項目(含續行、巢狀)抓得到,程式碼區塊不算', () => {
  const items = ruleItems('# t\n\n- 一\n  續行\n  - 子項\n```\n- 不算\n```\n1. 二\n<!-- REMINDER -->\n- 三\n');
  assert.deepEqual(items.map((i) => [i.depth, i.text]), [[0, '一 續行'], [1, '子項'], [0, '二'], [0, '三']]);
});

test('worker 的 prompt:核心規則後面接技術棧規則;工單帶證據前綴', async () => {
  const { buildWorkerPrompt } = await import('../tools/lib/orchestrator.mjs');
  const root = join(REPO, 'payload');
  const envelope = { dispatch_id: 'd-1', node_id: 'a/v1', leg: 'test', evidence_prefixes: ['npm test'] };
  const ctx = (stack) => ({ root, config: { ...DEFAULTS, project: { ...DEFAULTS.project, stack } }, state: { maxSeq: 0 }, dag: { nodes: [] } });
  const ts = buildWorkerPrompt(ctx('node-ts'), { id: 'a/v1' }, envelope, tempDir());
  assert.match(ts, /技術棧:node-ts[\s\S]*## 這一棒的原則/, '技術棧規則在核心規則之後、原則之前');
  assert.match(ts, /evidence_prefixes/);
  assert.doesNotMatch(buildWorkerPrompt(ctx('none'), { id: 'a/v1' }, envelope, tempDir()), /node-ts|tsc|vitest/);
});

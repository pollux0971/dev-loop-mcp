import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { loadDag } from '../tools/lib/dag.mjs';
import { decide } from '../tools/lib/inbox.mjs';
import { init, upgrade } from '../tools/lib/install.mjs';
import { applyProposal, proposeFeature } from '../tools/lib/intake.mjs';
import { tick } from '../tools/lib/orchestrator.mjs';
import { readJson, sha256, writeJson } from '../tools/lib/util.mjs';
import { CALC, CALC_GHERKIN, cleanup, makeProject, sh, tempDir } from './helpers.mjs';

after(cleanup);
const put = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };

describe('dp init / upgrade', () => {
  test('非空目錄沒加 --existing 拒絕;--existing 遇到內容不同的受管檔就一個都不寫', () => {
    const dir = tempDir();
    put(join(dir, 'README.md'), 'mine');
    assert.throws(() => init(dir), /不是空目錄/);
    put(join(dir, 'prompts/worker.md'), '我自己的 worker prompt');
    assert.throws(() => init(dir, { existing: true }), /prompts\/worker\.md/);
    assert.ok(!existsSync(join(dir, 'tools')), '衝突時一個檔都沒寫');
  });
  test('--existing:你的 package.json 等 seed 檔保留不動', () => {
    const dir = tempDir();
    put(join(dir, 'package.json'), '{"name":"legacy"}');
    const r = init(dir, { existing: true });
    assert.ok(r.kept.includes('package.json'));
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), '{"name":"legacy"}');
  });
  test('upgrade:沒改過的受管檔可更新、刪掉的補回;你改過的 → 衝突、一個都不寫', () => {
    const proj = join(tempDir(), 'p');
    init(proj, { name: 'x' });
    assert.deepEqual(upgrade(proj).update, [], '同版本升級什麼都不用動');
    rmSync(join(proj, 'docs/dp/ROLES.md'));
    assert.deepEqual(upgrade(proj).create, ['docs/dp/ROLES.md']);
    // 模擬「安裝時是舊版內容、之後範式更新了」:把檔案與清單都改成舊版
    const manifest = readJson(join(proj, '.dp-install.json'));
    writeFileSync(join(proj, 'prompts/worker.md'), 'old version');
    manifest.files['prompts/worker.md'] = sha256('old version');
    writeJson(join(proj, '.dp-install.json'), manifest);
    assert.deepEqual(upgrade(proj).update, ['prompts/worker.md']);
    // 使用者自己改過 → 衝突
    writeFileSync(join(proj, 'prompts/critic.md'), '我改過的 critic');
    writeFileSync(join(proj, 'docs/dp/VERIFIER.md'), 'changed too');
    assert.throws(() => upgrade(proj), (e) => /prompts\/critic\.md/.test(e.message) && /docs\/dp\/VERIFIER\.md/.test(e.message));
    assert.equal(readFileSync(join(proj, 'prompts/critic.md'), 'utf8'), '我改過的 critic', '衝突時不覆蓋');
  });
  test('init 產生的新專案:placeholder 已填、產生檔一致', () => {
    const proj = join(tempDir(), 'p');
    init(proj, { name: 'hello-app' });
    assert.match(readFileSync(join(proj, 'AGENTS.md'), 'utf8'), /^# hello-app/);
    assert.equal(readJson(join(proj, 'package.json')).name, 'hello-app');
    assert.equal(sh(proj, 'git status --porcelain'), '');
  });
});

describe('intake', () => {
  test('提案沒被批准前,tick 不會寫進 DAG;被拒絕也不會', async () => {
    const proj = makeProject();
    const p = proposeFeature(proj, CALC, CALC_GHERKIN);
    await tick(proj);
    assert.equal(loadDag(proj).nodes.length, 0);
    decide(proj, `node:${p.id}`, 'no', '先不要');
    await tick(proj);
    assert.equal(loadDag(proj).nodes.length, 0);
    assert.throws(() => applyProposal(proj, p.id), /被拒絕/);
  });
  test('提案不合法直接擋:沒有 gherkin、整合點沒有 @e2e、懸空依賴', () => {
    const proj = makeProject();
    assert.throws(() => proposeFeature(proj, CALC, null), /沒有 gherkin 不寫程式/);
    assert.throws(() => proposeFeature(proj, { id: 'I1', kind: 'integration', title: 't', intent: 'i', owns: ['packages/app/**'] }, 'Feature: x\n  Scenario: y\n'), /@e2e/);
    assert.throws(() => proposeFeature(proj, { ...CALC, depends_on: ['ghost/v1'] }, CALC_GHERKIN), /ghost\/v1/);
  });
});

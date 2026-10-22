/**
 * Tests for scripts/check-dry-run.ts (template 1.6.0, P-86).
 *
 * Same shape as the other scanner tests: build a throwaway temp directory as a fake consumer root, give `--root` explicitly,
 * and do not touch the real repo. **Real cucumber is run here** (the fixture's `node_modules` is a symlink to the template's own
 * `node_modules`, so `npx cucumber-js` finds the executable and tsx inside the fixture) —
 * because the whole value of this guard lies in the fact that "cucumber exits 0 for dry-run ambiguous/undefined",
 * a fact seen in a real run; testing with fake cucumber output would only test our own imagination.
 *
 * Pitfall 23 (source AI_KM): a guard proposal must be made to go red once before it is wired into CI — the "ambiguous" test below is
 * that "go red once", and on the same fixture it first asserts exit 0 directly against `cucumber-js --dry-run --strict`,
 * proving that "not trusting the exit code" is not redundant.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeIsolatedTempDir } from './_root.js';

const CHECK_DRY_RUN_TS = resolve(import.meta.dirname, 'check-dry-run.ts');
const TEMPLATE_NODE_MODULES = resolve(import.meta.dirname, '..', 'node_modules');
const CUCUMBER_BIN = join(TEMPLATE_NODE_MODULES, '.bin', 'cucumber-js');
const SPAWN_TIMEOUT_MS = 120_000;
const SCANNER_BROKEN = '這不是很乾淨,是掃描器壞了';

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function writeRaw(root: string, relPath: string, content: string): void {
  const p = join(root, relPath);
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

/** A minimal consumer that can run real cucumber: cucumber.json + one phase file in each of two folders +
 *  two steps files (CJS; the fixture has no package.json so .js is CJS). The default state is clean:
 *  exactly one definition per sentence. */
function makeCleanRoot(parentDir = tmpdir()): string {
  const root = makeIsolatedTempDir('lc-dry-run-', parentDir);
  tmpDirs.push(root);
  symlinkSync(TEMPLATE_NODE_MODULES, join(root, 'node_modules'), 'dir');
  writeRaw(
    root,
    'cucumber.json',
    JSON.stringify({ default: { paths: ['features/**/*.feature'], import: ['features/steps/**/*.js'] } }, null, 2),
  );
  writeRaw(root, 'scripts/gates.config.json', '{}');
  writeRaw(
    root,
    'features/01-alpha/phase-1.feature',
    ['@alpha @phase-1', 'Feature: alpha', '  Scenario: one', '    Given the store has 3 items', '    Then it exits with status 0', ''].join('\n'),
  );
  writeRaw(
    root,
    'features/02-beta/phase-1.feature',
    ['@beta @phase-1', 'Feature: beta', '  Scenario: two', '    Given the store has 5 items', '    Then the output mentions "x"', ''].join('\n'),
  );
  writeRaw(
    root,
    'features/steps/alpha.steps.js',
    [
      "const { Given, Then } = require('@cucumber/cucumber');",
      "Given('the store has {int} items', function () {});",
      "Then('it exits with status {int}', function () {});",
      '',
    ].join('\n'),
  );
  writeRaw(
    root,
    'features/steps/beta.steps.js',
    ["const { Then } = require('@cucumber/cucumber');", "Then('the output mentions {string}', function () {});", ''].join('\n'),
  );
  return root;
}

/** Reverse verification (a): paste alpha's first sentence verbatim into beta → two definitions → ambiguous. */
function injectAmbiguous(root: string): void {
  writeRaw(
    root,
    'features/steps/beta.steps.js',
    [
      "const { Given, Then } = require('@cucumber/cucumber');",
      "Given('the store has {int} items', function () {});",
      "Then('the output mentions {string}', function () {});",
      '',
    ].join('\n'),
  );
}

/**
 * Reverse verification (a2): **a parameterized definition covers a literal definition** — the two definition strings are **different**, but both match the same sentence.
 * This is the main reason this gate exists: `check-step-dup.ts` compares normalized literal shapes,
 * `{word}` and `rich` are different shapes, so it cannot see that the two definitions collide; cucumber can see it
 * (it prints ambiguous) but does not say so through the exit code. If only (a), verbatim identical, were tested, `check-step-dup.ts` would already
 * catch it, which means the piece this new gate really has to fill would not be verified.
 * Source: project A technical advisor, real-run report 2026-09-12 (with overlapping parameterization, both accept:dry and check-step-dup were all green).
 */
function injectParamOverlap(root: string): void {
  writeRaw(
    root,
    'features/steps/alpha.steps.js',
    [
      "const { Given, Then } = require('@cucumber/cucumber');",
      "Given('the store has {int} items', function () {});",
      "Given('the store loads the rich fixture set', function () {});",
      "Then('it exits with status {int}', function () {});",
      '',
    ].join('\n'),
  );
  writeRaw(
    root,
    'features/steps/beta.steps.js',
    [
      "const { Given, Then } = require('@cucumber/cucumber');",
      "Given('the store loads the {word} fixture set', function () {});",
      "Then('the output mentions {string}', function () {});",
      '',
    ].join('\n'),
  );
  writeRaw(
    root,
    'features/02-beta/phase-1.feature',
    [
      '@beta @phase-1',
      'Feature: beta',
      '  Scenario: two',
      '    Given the store loads the rich fixture set',
      '',
    ].join('\n'),
  );
}

/** Reverse verification (c): the feature file gets one more step that has no definition → undefined. */
function injectUndefined(root: string): void {
  writeRaw(
    root,
    'features/02-beta/phase-1.feature',
    [
      '@beta @phase-1',
      'Feature: beta',
      '  Scenario: two',
      '    Given the store has 5 items',
      '    Then the output mentions "x"',
      '    And nobody defined this line',
      '',
    ].join('\n'),
  );
}

function run(root: string, ...extra: string[]): { code: number; output: string } {
  const r = spawnSync('npx', ['tsx', CHECK_DRY_RUN_TS, '--root', root, ...extra], {
    cwd: root,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, GATES_CONFIG_DIR: join(root, 'scripts') },
  });
  return { code: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Run cucumber itself directly against the fixture (bypassing this guard), and get its exit code and summary line. */
function runRawCucumber(root: string, ...extra: string[]): { code: number; output: string } {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const r = spawnSync(CUCUMBER_BIN, ['--dry-run', '--format', 'summary', ...extra], {
    cwd: root,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env,
  });
  return { code: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const haveCucumber = existsSync(CUCUMBER_BIN);

describe.skipIf(!haveCucumber)('check-dry-run:讀摘要行,不信退出碼(P-86)', () => {
  it('乾淨的 fixture:exit 0、印 PASS 標記、scanned 是場景數', () => {
    const root = makeCleanRoot();
    const { code, output } = run(root);
    expect(output).toContain('2 scenarios');
    expect(output).toContain('gate=dry-run result=PASS scanned=2');
    expect(code).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  it('fixture 根目錄上層有 type=module package.json 仍然通過', () => {
    const fixtureParent = makeIsolatedTempDir('lc-dry-run-parent-');
    tmpDirs.push(fixtureParent);
    writeFileSync(join(fixtureParent, 'package.json'), JSON.stringify({ type: 'module' }));
    const root = makeCleanRoot(fixtureParent);
    const { code, output } = run(root);
    expect(output).toContain('gate=dry-run result=PASS scanned=2');
    expect(code).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  it('前提(cucumber 本人):同一份 ambiguous fixture,--dry-run 與 --dry-run --strict 都 exit 0', () => {
    // This test is the fact itself behind "why this guard is needed". If it ever goes red after a cucumber upgrade,
    // it means cucumber now blocks this itself — then this guard can retire, but only after seeing this go red.
    const root = makeCleanRoot();
    injectAmbiguous(root);
    const plain = runRawCucumber(root);
    expect(plain.output).toMatch(/\bambiguous\b/);
    expect(plain.code).toBe(0);
    const strict = runRawCucumber(root, '--strict');
    expect(strict.output).toMatch(/\bambiguous\b/);
    expect(strict.code).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  it('反向驗證 (a):跨檔逐字相同的 Cucumber Expression → exit 1、摘要行 ambiguous、列出兩個檔案', () => {
    const root = makeCleanRoot();
    injectAmbiguous(root);
    const { code, output } = run(root);
    expect(code).toBe(1);
    expect(output).toContain('ambiguous=');
    expect(output).toContain('alpha.steps.js');
    expect(output).toContain('beta.steps.js');
    expect(output).toContain('gate=dry-run result=FAIL scanned=2');
    expect(output).toContain('check:steps');
    expect(output).not.toContain('段 B'); // no tag given, section B is skipped
  }, SPAWN_TIMEOUT_MS);

  it('反向驗證 (a2):參數化定義蓋住字面定義(兩個字串不同)→ exit 1、摘要行 ambiguous', () => {
    const root = makeCleanRoot();
    injectParamOverlap(root);
    const { code, output } = run(root);
    expect(code).toBe(1);
    expect(output).toContain('ambiguous=');
    expect(output).toContain('alpha.steps.js');
    expect(output).toContain('beta.steps.js');
    expect(output).toContain('gate=dry-run result=FAIL');
  }, SPAWN_TIMEOUT_MS);

  it('反向驗證 (b):拿掉重複的定義 → 回綠', () => {
    const root = makeCleanRoot();
    injectAmbiguous(root);
    expect(run(root).code).toBe(1);
    // Restore the clean beta.steps.js
    writeRaw(
      root,
      'features/steps/beta.steps.js',
      ["const { Then } = require('@cucumber/cucumber');", "Then('the output mentions {string}', function () {});", ''].join('\n'),
    );
    const { code, output } = run(root);
    expect(output).toContain('gate=dry-run result=PASS scanned=2');
    expect(code).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  it('反向驗證 (c):沒有定義的步驟句 → exit 1、摘要行 undefined(cucumber 本人一樣 exit 0)', () => {
    const root = makeCleanRoot();
    injectUndefined(root);
    expect(runRawCucumber(root, '--strict').code).toBe(0);
    const { code, output } = run(root);
    expect(code).toBe(1);
    expect(output).toContain('undefined=1');
    expect(output).toContain('gate=dry-run result=FAIL scanned=2');
  }, SPAWN_TIMEOUT_MS);

  it('反向驗證 (d):--tags 比對到 0 個場景 → exit 1、印 0 個場景與掃描器壞了、scanned=0', () => {
    const root = makeCleanRoot();
    const { code, output } = run(root, '--tags', '@this-tag-does-not-exist');
    expect(code).toBe(1);
    expect(output).toContain('掃到 0 個場景');
    expect(output).toContain(SCANNER_BROKEN);
    expect(output).toContain('gate=dry-run result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);

  it('--tags 真的有傳給 cucumber:只選 @alpha 就只剩 1 個場景', () => {
    const root = makeCleanRoot();
    const { code, output } = run(root, '--tags', '@alpha');
    expect(output).toContain('1 scenario');
    expect(output).toContain('gate=dry-run result=PASS scanned=1');
    expect(code).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  it('-- 之後的參數原樣附給 cucumber:--name 過濾', () => {
    const root = makeCleanRoot();
    const { code, output } = run(root, '--', '--name', 'two');
    expect(output).toContain('gate=dry-run result=PASS scanned=1');
    expect(code).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  it('cucumber 自己說壞(feature 檔 Parse error,P-16):exit 1、標記 FAIL', () => {
    const root = makeCleanRoot();
    writeRaw(root, 'features/02-beta/phase-1.feature', '@beta @phase-1\nFeature: beta\n  Scenario: two\n    Given x\n</content>\n');
    const { code, output } = run(root);
    expect(code).toBe(1);
    expect(output).toContain('gate=dry-run result=FAIL');
  }, SPAWN_TIMEOUT_MS);

  // ---- Two sections (AI_KM second round): undefined counts only in the acceptance set, ambiguous counts in the full set ----

  /** A @todo scenario (the acceptance job excludes it with `not @todo`) containing one undefined step — a by-design todo. */
  function addTodoScenario(root: string, extraStep: string): void {
    writeRaw(
      root,
      'features/03-later/phase-1.feature',
      ['@later @phase-1', 'Feature: later', '  @todo', '  Scenario: not yet', `    Given ${extraStep}`, '    And nobody defined this line', ''].join('\n'),
    );
  }

  it('反向驗證 (e1):undefined 只出現在 @todo 場景、--tags "not @todo" → 綠,段 B 註明那是驗收集合外的 todo', () => {
    const root = makeCleanRoot();
    addTodoScenario(root, 'the store has 1 items');
    const { code, output } = run(root, '--tags', 'not @todo');
    expect(output).toContain('gate=dry-run result=PASS scanned=2');
    expect(output).toContain('視為設計上的 todo');
    expect(code).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  it('反向驗證 (e2):撞名的句子只出現在 @todo 場景、--tags "not @todo" → 紅(段 B 抓到,tag 排除不了 ambiguous)', () => {
    const root = makeCleanRoot();
    injectAmbiguous(root); // the store has {int} items, two copies
    // The acceptance set must not use that sentence: replace alpha's Given, so only the @todo scenario still uses it
    writeRaw(
      root,
      'features/01-alpha/phase-1.feature',
      ['@alpha @phase-1', 'Feature: alpha', '  Scenario: one', '    Then it exits with status 0', ''].join('\n'),
    );
    writeRaw(
      root,
      'features/02-beta/phase-1.feature',
      ['@beta @phase-1', 'Feature: beta', '  Scenario: two', '    Then the output mentions "x"', ''].join('\n'),
    );
    addTodoScenario(root, 'the store has 1 items');
    const { code, output } = run(root, '--tags', 'not @todo');
    expect(code).toBe(1);
    expect(output).toContain('段 B(全集)有 1 個 ambiguous');
    expect(output).toContain('gate=dry-run result=FAIL scanned=2');
  }, SPAWN_TIMEOUT_MS);

  it('沒帶 --tags 時 undefined 一律算(段 B 略過)', () => {
    const root = makeCleanRoot();
    addTodoScenario(root, 'the store has 1 items');
    const { code, output } = run(root);
    expect(code).toBe(1);
    expect(output).toContain('undefined=1');
    expect(output).not.toContain('段 B');
  }, SPAWN_TIMEOUT_MS);

  it('gates.config.json 的 dryRun.tags 當 --tags 用,--tags 旗標優先', () => {
    const root = makeCleanRoot();
    addTodoScenario(root, 'the store has 1 items');
    writeRaw(root, 'scripts/gates.config.json', JSON.stringify({ dryRun: { tags: 'not @todo' } }));
    const viaConfig = run(root);
    expect(viaConfig.output).toContain("tag 來源:gates.config.json 的 dryRun.tags('not @todo')");
    expect(viaConfig.output).toContain('gate=dry-run result=PASS scanned=2');
    expect(viaConfig.code).toBe(0);
    const viaFlag = run(root, '--tags', '@todo');
    expect(viaFlag.output).toContain("tag 來源:--tags 旗標('@todo')");
    expect(viaFlag.output).toContain('undefined=1');
    expect(viaFlag.code).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it('dryRun.tags 型別錯 / 空字串 → exit 1、設定錯訊息、scanned=0', () => {
    const root = makeCleanRoot();
    writeRaw(root, 'scripts/gates.config.json', JSON.stringify({ dryRun: { tags: ['not @todo'] } }));
    const typeErr = run(root);
    expect(typeErr.code).toBe(1);
    expect(typeErr.output).toContain('dryRun.tags');
    expect(typeErr.output).toContain('gate=dry-run result=FAIL scanned=0');
    writeRaw(root, 'scripts/gates.config.json', JSON.stringify({ dryRun: { tags: '  ' } }));
    const empty = run(root);
    expect(empty.code).toBe(1);
    expect(empty.output).toContain('"dryRun.tags" 是空字串');
  }, SPAWN_TIMEOUT_MS);

  it('--cwd 指到不存在的目錄:exit 1、名出路徑、scanned=0', () => {
    const root = makeCleanRoot();
    const missing = join(root, 'nope');
    const { code, output } = run(root, '--cwd', 'nope');
    expect(code).toBe(1);
    expect(output).toContain(missing);
    expect(output).toContain('gate=dry-run result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);

  it('gates.config.json 的 cucumberCwd 指到不存在的目錄:exit 1、不退回自動偵測', () => {
    const root = makeCleanRoot();
    writeRaw(root, 'scripts/gates.config.json', JSON.stringify({ cucumberCwd: 'elsewhere' }));
    const { code, output } = run(root);
    expect(code).toBe(1);
    expect(output).toContain('"cucumberCwd" 指定的目錄不存在');
    expect(output).toContain('gate=dry-run result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);
});

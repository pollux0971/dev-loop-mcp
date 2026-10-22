/**
 * Tests for scripts/check-step-dup.ts (template 1.6.0, P-87).
 *
 * This gate has no `--root` flag (see NO_ROOT_FLAG in zero-input.gates.test.ts). The repo root is
 * always inferred from cwd with `git rev-parse --show-toplevel`. So the fixture must itself be a
 * git repo (`git init`), and the child process's cwd points at the fixture. gates.config.json
 * is pointed at the fixture's own scripts/ with GATES_CONFIG_DIR, so it does not pick up the
 * template's own copy.
 *
 * The four reverse checks match (a)-(d) in the file header. (d) is the corner added in 1.6.0:
 * a definition that is **word-for-word identical across files but not yet used by any feature**
 * must also be red. 1.5.x only compared the sentences a feature already used, so this kind of
 * duplicate was completely invisible.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeIsolatedTempDir } from './_root.js';

const CHECK_STEP_DUP_TS = resolve(import.meta.dirname, 'check-step-dup.ts');
const SPAWN_TIMEOUT_MS = 60_000;
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

const COMMON_STEPS = [
  "import { Given, Then } from '@cucumber/cucumber';",
  "Then('it exits with status {int}', function () {});",
  '',
].join('\n');

const ALPHA_STEPS = [
  "import { Given, Then } from '@cucumber/cucumber';",
  "Given('the store has {int} items', function () {});",
  "Then('the log line(s) contain(s) {string}', function () {});",
  '',
].join('\n');

const BETA_STEPS = [
  "import { Given, Then } from '@cucumber/cucumber';",
  "Then('the output mentions {string}', function () {});",
  '',
].join('\n');

/** Clean fixture: two capability folders + one integration scenario, exactly one definition per sentence, and `it exits with status`
 *  spans three folders but is defined only in common (the situation of reverse check (c)). */
function makeCleanRoot(): string {
  const root = makeIsolatedTempDir('lc-step-dup-');
  tmpDirs.push(root);
  const git = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  if (git.status !== 0) throw new Error(`git init 失敗:${git.stderr}`);
  writeRaw(root, 'scripts/gates.config.json', '{}');
  writeRaw(
    root,
    'features/01-alpha/phase-1.feature',
    ['@alpha @phase-1', 'Feature: alpha', '  Scenario: one', '    Given the store has 3 items', '    Then it exits with status 0', ''].join('\n'),
  );
  writeRaw(
    root,
    'features/02-beta/phase-1.feature',
    ['@beta @phase-1', 'Feature: beta', '  Scenario: two', '    Then the output mentions "x"', '    Then it exits with status 1', ''].join('\n'),
  );
  writeRaw(
    root,
    'docs/integration/i1.feature',
    ['@integration @i1', 'Feature: i1', '  Scenario: end to end', '    Given the store has 9 items', '    Then it exits with status 0', ''].join('\n'),
  );
  writeRaw(root, 'features/steps/common.steps.ts', COMMON_STEPS);
  writeRaw(root, 'features/steps/alpha.steps.ts', ALPHA_STEPS);
  writeRaw(root, 'features/steps/beta.steps.ts', BETA_STEPS);
  return root;
}

function run(root: string, ...extra: string[]): { code: number; output: string } {
  const r = spawnSync('npx', ['tsx', CHECK_STEP_DUP_TS, ...extra], {
    cwd: root,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, GATES_CONFIG_DIR: join(root, 'scripts') },
  });
  return { code: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('check-step-dup:每種步驟形狀恰好一個定義', () => {
  it('乾淨的 fixture:exit 0、跨資料夾但只有一個定義的句子不算紅', () => {
    const root = makeCleanRoot();
    const { code, output } = run(root);
    expect(output).toContain('無重複定義');
    expect(output).toContain('gate=step-dup result=PASS scanned=6');
    expect(code).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  it('反向驗證 (a):common 的句子原樣貼進另一個 steps 檔 → exit 1、列出兩個定義檔與用到它的資料夾', () => {
    const root = makeCleanRoot();
    writeRaw(root, 'features/steps/beta.steps.ts', BETA_STEPS + "Then('it exits with status {int}', function () {});\n");
    const { code, output } = run(root);
    expect(code).toBe(1);
    expect(output).toContain('1 句被定義了 ≥2 次');
    expect(output).toContain('定義於:features/steps/common.steps.ts');
    expect(output).toContain('定義於:features/steps/beta.steps.ts');
    expect(output).toContain('用於:docs/integration, features/01-alpha, features/02-beta');
    expect(output).toContain('gate=step-dup result=FAIL scanned=6');
  }, SPAWN_TIMEOUT_MS);

  it('反向驗證 (b):刪掉剛貼的定義 → 回綠', () => {
    const root = makeCleanRoot();
    writeRaw(root, 'features/steps/beta.steps.ts', BETA_STEPS + "Then('it exits with status {int}', function () {});\n");
    expect(run(root).code).toBe(1);
    writeRaw(root, 'features/steps/beta.steps.ts', BETA_STEPS);
    const { code, output } = run(root);
    expect(output).toContain('gate=step-dup result=PASS scanned=6');
    expect(code).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  it('反向驗證 (d,P-87):跨檔逐字相同、但沒有任何 feature 用到的定義 → exit 1、明說沒有 feature 用到', () => {
    const root = makeCleanRoot();
    // alpha's optional-text sentence (no feature uses it) is copied word for word by beta
    writeRaw(root, 'features/steps/beta.steps.ts', BETA_STEPS + "Then('the log line(s) contain(s) {string}', function () {});\n");
    const { code, output } = run(root);
    expect(code).toBe(1);
    expect(output).toContain("'the log line(s) contain(s) {string}'");
    expect(output).toContain('定義於:features/steps/alpha.steps.ts');
    expect(output).toContain('定義於:features/steps/beta.steps.ts');
    expect(output).toContain('目前沒有任何 .feature 用到');
    expect(output).toContain('1 句目前沒有 feature 用到');
    expect(output).toContain('gate=step-dup result=FAIL scanned=6');
  }, SPAWN_TIMEOUT_MS);

  it('regex 定義與 expression 定義形狀相同也算重複(複製貼上換個寫法躲不掉)', () => {
    const root = makeCleanRoot();
    writeRaw(root, 'features/steps/beta.steps.ts', BETA_STEPS + "Then(/^it exits with status (\\d+)$/, function () {});\n");
    const { code, output } = run(root);
    expect(code).toBe(1);
    expect(output).toContain('/^it exits with status (\\d+)$/');
    expect(output).toContain('定義於:features/steps/common.steps.ts');
    expect(output).toContain('定義於:features/steps/beta.steps.ts');
  }, SPAWN_TIMEOUT_MS);

  it('AI_KM 坑 23 的原文(純字面、無參數)跨檔逐字相同 → 紅;前綴相同但不同句、參數句多一段的對照組 → 不誤報', () => {
    const root = makeCleanRoot();
    const sentence = 'a person has already asked a question in a conversation whose reply the server will generate itself, with real citations';
    writeRaw(
      root,
      'features/steps/app-shell-phase-3.steps.ts',
      [
        "import { Given, Then, When } from '@cucumber/cucumber';",
        `Given('${sentence}', function () {});`,
        "Then('a server-generated reply carries two citations', function () {});",
        "When('the vitest check for {string} is run', function () {});",
        '',
      ].join('\n'),
    );
    writeRaw(
      root,
      'features/steps/app-shell-phase-4.steps.ts',
      [
        "import { Given, Then, When } from '@cucumber/cucumber';",
        `Given('${sentence}', function () {});`,
        "Then('a server-generated reply carries one citation with its own projected text', function () {});",
        "When('the vitest check for {string} in message-thread.test.tsx is run', function () {});",
        '',
      ].join('\n'),
    );
    const { code, output } = run(root);
    expect(code).toBe(1);
    expect(output).toContain('1 句被定義了 ≥2 次');
    expect(output).toContain(sentence);
    expect(output).not.toContain('a server-generated reply carries');
    expect(output).not.toContain('the vitest check for');
  }, SPAWN_TIMEOUT_MS);

  it('註解掉的定義不算(反向驗證時 `// Then(...)` 不會誤判)', () => {
    const root = makeCleanRoot();
    writeRaw(root, 'features/steps/beta.steps.ts', BETA_STEPS + "// Then('it exits with status {int}', function () {});\n");
    const { code, output } = run(root);
    expect(output).toContain('gate=step-dup result=PASS');
    expect(code).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  it('0 個 .feature 檔 → exit 1、掃描器壞了、scanned=0', () => {
    const root = makeCleanRoot();
    rmSync(join(root, 'features/01-alpha'), { recursive: true, force: true });
    rmSync(join(root, 'features/02-beta'), { recursive: true, force: true });
    rmSync(join(root, 'docs'), { recursive: true, force: true });
    const { code, output } = run(root);
    expect(code).toBe(1);
    expect(output).toContain('掃到 0 個 .feature 檔');
    expect(output).toContain(SCANNER_BROKEN);
    expect(output).toContain('gate=step-dup result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);

  it('有 feature 但解析到 0 個步驟定義(steps 目錄不在 features/steps)→ exit 1、掃描器壞了', () => {
    const root = makeCleanRoot();
    rmSync(join(root, 'features/steps'), { recursive: true, force: true });
    const { code, output } = run(root);
    expect(code).toBe(1);
    expect(output).toContain('解析到 0 個步驟定義');
    expect(output).toContain(SCANNER_BROKEN);
    expect(output).toContain('gate=step-dup result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);

  it('--list 只列跨資料夾的句子,不判斷退出碼', () => {
    const root = makeCleanRoot();
    writeRaw(root, 'features/steps/beta.steps.ts', BETA_STEPS + "Then('it exits with status {int}', function () {});\n");
    const { code, output } = run(root, '--list');
    expect(output).toContain('[3 資料夾]');
    expect(output).toContain('gate=step-dup result=PASS scanned=6');
    expect(code).toBe(0);
  }, SPAWN_TIMEOUT_MS);
});

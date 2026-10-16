// Fake worker for tests: reads .dlm/envelope.json, acts by FAKE_MODE and leg, and finally writes .dlm/report.json.
//   good       normal work
//   forbidden  the dev leg also edits the test file (out of bounds)
//   lie        the implementation is wrong, but it claims acceptance exit 0
//   spawn      the parent node's dev leg first proposes a prereq child node
//   noreport   does nothing and exits
//   429        simulates rate limiting: prints 429 in the log and exits, no report handed in
//   nologin    simulates claude in the sandbox not logged in (real claude -p output)
//   breaker    for nodes other than calc, the dev leg breaks calc on the side (its own acceptance stays green)
//   pkg        the dev leg changes test in the root package.json to exit 0
//   syntax     the test leg hands in a test with a syntax error (red, but for the wrong reason)
//   git-hook   the dev leg creates .git/hooks/post-merge in the copy
//   ignored    the dev leg writes under reports/, which is in .gitignore
//   nm         the dev leg edits the test framework through node_modules (without a container, node_modules is a symlink)
//   hardcode   the dev leg hardcodes the test value (run always returns 5)
//   badtest    the test leg writes the wrong expected value (2+3=6); the dev leg notices and reports fix_leg=test; the test-fix leg corrects it (v4)
//   hang       sleeps 30 seconds (tests whether halt terminates the worker)
//   already-green integration point's test leg: acceptance is already green before any work, so it honestly reports stuck (no faked red); the integrate leg changes nothing and hands in as is; other legs act like good (v4.7.3)
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const env = JSON.parse(readFileSync('.dlm/envelope.json', 'utf8'));
const mode = process.env.FAKE_MODE ?? 'good';
const cap = env.node_id.split('/')[0];
const isChild = /\/v\d+\.\d+$/.test(env.node_id);
const dir = `packages/${cap}/src${isChild ? '/util' : ''}`;
const testFile = `${dir}/${cap}.test.mjs`;
const impl = `${dir}/${cap}.mjs`;

const sh = (c) => {
  try {
    execSync(c, { stdio: 'pipe' });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
};
const write = (p, text) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
// In the new flow the worker runs in a sandbox copy without .git and does not commit (dlm collects); the old flow (directly in the worktree) commits.
// Check .git/HEAD, not .git: git-hook mode creates .git/hooks itself, which is not a repo; dlm sets GIT_CEILING_DIRECTORIES, so git won't walk up to the project's repo either
const commit = (msg) => {
  if (existsSync('.git/HEAD')) execSync(`git add -A && (git diff --cached --quiet || git -c user.name=w -c user.email=w@w commit -qm "${msg}")`);
};
const report = (r) => writeFileSync('.dlm/report.json', JSON.stringify({ dispatch_id: env.dispatch_id, ...r }, null, 2));

// v4.6: FAKE_ENV_LOG = record the account env vars received on each launch; LIMIT_ACCOUNT = simulate quota exhausted when this account is used
if (process.env.FAKE_ENV_LOG) appendFileSync(process.env.FAKE_ENV_LOG, `${JSON.stringify({ account: process.env.DLM_ACCOUNT ?? null, home: process.env.CLAUDE_CONFIG_DIR ?? null, api_key: 'ANTHROPIC_API_KEY' in process.env })}\n`);
if (process.env.LIMIT_ACCOUNT && process.env.DLM_ACCOUNT === process.env.LIMIT_ACCOUNT) {
  console.log(`Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3 * 3600}`);
  process.exit(1);
}
if (mode === 'noreport') process.exit(0);
if (mode === 'nologin') {
  console.log('{"type":"result","is_error":true,"terminal_reason":"api_error","result":"Not logged in · Please run /login"}');
  process.exit(1);
}
if (mode === '429') {
  console.log('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Too Many Requests"}}');
  process.exit(1);
}
if (mode === 'hang') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
if (mode === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);

if (mode === 'escalate') {
  report({ kind: 'escalation', summary: `假 worker 不會做 ${env.leg}`, claims: [] });
} else if (env.leg === 'test' && mode === 'syntax') {
  write(testFile, `import { test } from 'node:test';\ntest('adds', () => {{{ \n`);
  const cmd = `node --test ${testFile}`;
  report({ kind: 'done', summary: '寫好測試', claims: [{ text: '測試是紅的', evidence: { cmd, exit: sh(cmd) } }] });
} else if (env.leg === 'test' && /^I\d+$/.test(env.node_id) && mode === 'already-green') {
  const cmd = env.acceptance[0].cmd;
  report({ kind: 'blocked', summary: `驗收在動手前就是綠的(${cmd} → exit ${sh(cmd)}),要紅只能造假`, claims: [] });
} else if (env.leg === 'test' && /^I\d+$/.test(env.node_id)) {
  // Integration point's test leg (v4): write a test that is red, until the integrate leg wires things up
  write('packages/app/app.test.mjs', `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { execFileSync } from 'node:child_process';\ntest('app prints ok', () => assert.match(execFileSync('node', ['packages/app/main.mjs'], { encoding: 'utf8' }), /ok/));\n`);
  commit('i-tests');
  const cmd = 'node --test packages/app/app.test.mjs';
  report({ kind: 'done', summary: '寫好整合測試,目前是紅的', claims: [{ text: '測試是紅的', evidence: { cmd, exit: sh(cmd) } }] });
} else if (env.leg === 'test' || env.leg === 'test-fix') {
  const expected = mode === 'badtest' && env.leg === 'test' ? 6 : 5;
  write(testFile, `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { run } from './${cap}.mjs';\ntest('adds', () => assert.equal(run(2, 3), ${expected}));\n`);
  commit('tests');
  const cmd = `node --test ${testFile}`;
  report({ kind: 'done', summary: '寫好測試,目前是紅的', claims: [{ text: '測試是紅的', evidence: { cmd, exit: sh(cmd) } }] });
} else if (env.leg === 'dev') {
  if (mode === 'spawn' && !isChild && !existsSync(`packages/${cap}/src/util/${cap}.mjs`)) {
    report({
      kind: 'blocked',
      summary: '需要先有 util',
      claims: [],
      spawn: {
        id: `${cap}/v1.1`, title: 'util', intent: '先提供 util', relation: 'prereq',
        owns: [`packages/${cap}/src/util/**`], accept: `node --test packages/${cap}/src/util/${cap}.test.mjs`,
        gherkin_draft: 'Feature: util\n  Scenario: util works\n    When util runs\n    Then it works\n',
      },
    });
    process.exit(0);
  }
  if (mode === 'badtest' && readFileSync(testFile, 'utf8').includes('run(2, 3), 6)')) {
    report({ kind: 'blocked', fix_leg: 'test', summary: `${testFile} 期望 run(2,3)=6,但 gherkin 說 2 加 3 是 5`, claims: [] });
    process.exit(0);
  }
  const body = mode === 'lie' ? 'return a - b;' : mode === 'hardcode' ? 'return 5;' : 'return a + b;';
  write(impl, `export function run(a, b) { ${body} }\n`);
  if (mode === 'git-hook') write('.git/hooks/post-merge', '#!/bin/sh\ntouch /tmp/dlm-pwned\n');
  if (mode === 'ignored') write('reports/leak.txt', 'x\n');
  if (mode === 'nm' && existsSync('node_modules/vitest/index.js')) appendFileSync('node_modules/vitest/index.js', '\n// 永遠回報通過\n');
  if (mode === 'forbidden') appendFileSync(testFile, '// 偷改測試\n');
  if (mode === 'breaker' && cap !== 'calc') write('packages/calc/src/calc.mjs', 'export function run(a, b) { return a * b; }\n');
  if (mode === 'pkg') {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    pkg.scripts.test = 'exit 0';
    writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  }
  commit('impl');
  const cmd = env.acceptance[0].cmd;
  const code = sh(cmd);
  report({ kind: 'done', summary: '實作完成', claims: [{ text: '驗收通過', evidence: { cmd, exit: mode === 'lie' ? 0 : code } }] });
} else if (env.leg === 'integrate' && mode === 'already-green') {
  // The composition layer is already wired: change nothing, hand in done with acceptance evidence as is (v4.7.3)
  const cmd = env.acceptance[0].cmd;
  report({ kind: 'done', summary: '組合層已經接通,沒有要改的', claims: [{ text: '整合驗收通過', evidence: { cmd, exit: sh(cmd) } }] });
} else if (env.leg === 'integrate') {
  write('packages/app/main.mjs', "import { run } from '../calc/src/calc.mjs';\nif (run(2, 3) !== 5) process.exit(1);\nconsole.log('ok');\n");
  commit('integrate');
  const cmd = env.acceptance[0].cmd;
  report({ kind: 'done', summary: '接通', claims: [{ text: '整合驗收通過', evidence: { cmd, exit: sh(cmd) } }] });
} else {
  report({ kind: 'escalation', summary: `假 worker 不會做 ${env.leg}`, claims: [] });
}

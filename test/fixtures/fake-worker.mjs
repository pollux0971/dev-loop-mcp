// 測試用的假 worker:讀 .dp/envelope.json,依 FAKE_MODE 與棒別做事,最後寫 .dp/report.json。
//   good       正常施工
//   forbidden  實作棒順手改了測試檔(越界)
//   lie        實作寫錯,卻宣稱驗收 exit 0
//   spawn      父節點實作棒第一次先提 prereq 子節點
//   noreport   什麼都不做就結束
//   429        模擬被限流:log 印 429 就結束,不交 report
//   nologin    模擬沙箱裡的 claude 沒登入(真實的 claude -p 輸出)
//   breaker    calc 以外的節點,實作棒順手把 calc 改壞(自己的驗收仍是綠的)
//   pkg        實作棒順手把根目錄 package.json 的 test 改成 exit 0
//   syntax     測試棒交出有語法錯誤的測試(紅,但紅錯原因)
//   git-hook   實作棒在副本裡建 .git/hooks/post-merge
//   ignored    實作棒寫到被 .gitignore 的 reports/ 底下
//   nm         實作棒透過 node_modules 改測試框架(沒有容器時 node_modules 是 symlink)
//   hardcode   實作棒對測試值寫死(run 永遠回 5)
//   badtest    測試棒把期望值寫錯(2+3=6);實作棒發現後回報 fix_leg=test;test-fix 棒改對(v4)
//   hang       睡 30 秒(測停機會不會終止 worker)
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const env = JSON.parse(readFileSync('.dp/envelope.json', 'utf8'));
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
// 新流程 worker 在沒有 .git 的沙箱副本裡,不 commit(dp 會收);舊流程(直接在 worktree)才 commit。
// 看 .git/HEAD 而不是 .git:git-hook 模式自己建了 .git/hooks,那不是 repo;dp 設了 GIT_CEILING_DIRECTORIES,git 也不會往上找到專案的 repo
const commit = (msg) => {
  if (existsSync('.git/HEAD')) execSync(`git add -A && (git diff --cached --quiet || git -c user.name=w -c user.email=w@w commit -qm "${msg}")`);
};
const report = (r) => writeFileSync('.dp/report.json', JSON.stringify({ dispatch_id: env.dispatch_id, ...r }, null, 2));

// v4.6:FAKE_ENV_LOG = 每次啟動記下拿到的帳號環境變數;LIMIT_ACCOUNT = 用這個帳號時模擬額度用完
if (process.env.FAKE_ENV_LOG) appendFileSync(process.env.FAKE_ENV_LOG, `${JSON.stringify({ account: process.env.DP_ACCOUNT ?? null, home: process.env.CLAUDE_CONFIG_DIR ?? null, api_key: 'ANTHROPIC_API_KEY' in process.env })}\n`);
if (process.env.LIMIT_ACCOUNT && process.env.DP_ACCOUNT === process.env.LIMIT_ACCOUNT) {
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
} else if (env.leg === 'test' && /^I\d+$/.test(env.node_id)) {
  // 整合點的測試棒(v4):寫一個會紅的測試,等 integrate 棒接通
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
  if (mode === 'git-hook') write('.git/hooks/post-merge', '#!/bin/sh\ntouch /tmp/dp-pwned\n');
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
} else if (env.leg === 'integrate') {
  write('packages/app/main.mjs', "import { run } from '../calc/src/calc.mjs';\nif (run(2, 3) !== 5) process.exit(1);\nconsole.log('ok');\n");
  commit('integrate');
  const cmd = env.acceptance[0].cmd;
  report({ kind: 'done', summary: '接通', claims: [{ text: '整合驗收通過', evidence: { cmd, exit: sh(cmd) } }] });
} else {
  report({ kind: 'escalation', summary: `假 worker 不會做 ${env.leg}`, claims: [] });
}

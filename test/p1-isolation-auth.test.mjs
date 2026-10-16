// P1:worker 隔離與授權(#14–#19)。每一項至少一個「壞樣本被擋下」的測試。
// (#13 容器沙箱在 v4.1 移除)
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { parseCost } from '../tools/lib/agents.mjs';
import { recordUtterance, UTTERANCES_REL, verifyVerbatim } from '../tools/lib/auth.mjs';
import { checkPlaceholders } from '../tools/lib/checks.mjs';
import { DEFAULTS } from '../tools/lib/config.mjs';
import { runHook } from '../tools/lib/hooks.mjs';
import { decide, resume } from '../tools/lib/inbox.mjs';
import { init } from '../tools/lib/install.mjs';
import { append, checkLedger, readEvents } from '../tools/lib/ledger.mjs';
import { tick } from '../tools/lib/orchestrator.mjs';
import { nodeModulesFingerprint, sandboxCommand } from '../tools/lib/sandbox.mjs';
import { CLAUDE_WORKER_CMD, CLAUDE_WORKER_DENY } from '../tools/lib/setup.mjs';
import { readJson, run, sha256, writeJson } from '../tools/lib/util.mjs';
import { badRedReason, hostExecutor, mutationScore } from '../tools/lib/verify/script-checks.mjs';
import { summarize } from '../tools/lib/verify/index.mjs';
import {
  CALC, CALC_GHERKIN, REPO, addNode, cleanup, makeProject, sh, stateOf, tempDir, tickUntil, waitWorkers,
} from './helpers.mjs';

after(cleanup);

const DLM = join(REPO, 'tools', 'dlm.mjs');
const FIX = join(REPO, 'test', 'fixtures');
const openRequests = (s) => [...s.decisions.values()].filter((r) => r.request && !r.answer).map((r) => r.request);
const lastVerify = (proj) => readEvents(proj).filter((e) => e.type === 'verify').at(-1);
const commitIn = (dir, msg) => sh(dir, `git add -A && git -c user.name=t -c user.email=t@t commit -qm "${msg}"`);

describe('#14 worker 不碰 .git', () => {
  test('正常交件:worker 不 commit,由 dlm 以 dlm 身分 commit;沙箱副本收件後刪掉', async () => {
    const proj = makeProject();
    addNode(proj, CALC, CALC_GHERKIN);
    const s = await tickUntil(proj, (st) => st.nodes.get('calc/v1').status === 'done');
    const authors = sh(proj, 'git log --format=%an --no-merges main').split('\n');
    assert.ok(!authors.includes('w'), 'worker 沒有自己 commit(假 worker 的身分是 w)');
    assert.match(sh(proj, 'git log --format=%an%x09%s --no-merges main'), /dlm\tdlm: d-0002 dev 交件/);
    const dev = [...s.dispatches.values()].find((d) => d.leg === 'dev');
    assert.ok(dev.sandbox.includes(join('.dlm', 'sandboxes')));
    assert.ok(!existsSync(dev.sandbox), '沙箱副本已清掉');
  });

  test('worker 在副本寫 .git/hooks → sandbox-escape FAIL,hook 沒進 worktree', async () => {
    const proj = makeProject({ mode: 'git-hook' });
    addNode(proj, CALC, CALC_GHERKIN);
    await tickUntil(proj, () => readEvents(proj).some((e) => e.type === 'reject' && e.findings.some((f) => f.check === 'sandbox-escape')));
    const rej = readEvents(proj).find((e) => e.type === 'reject' && e.findings.some((f) => f.check === 'sandbox-escape'));
    assert.match(rej.findings.find((f) => f.check === 'sandbox-escape').detail, /\.git\/hooks\/post-merge/);
    assert.ok(!existsSync(join(proj, '.git/hooks/post-merge')));
    assert.ok(lastVerify(proj).results.some((r) => r.check === 'execution' && r.outcome === 'SKIPPED'));
    await waitWorkers(proj);
  });

  test('寫到被 ignore 的路徑 → 一樣被 paths 抓到', async () => {
    const proj = makeProject({ mode: 'ignored' });
    addNode(proj, CALC, CALC_GHERKIN);
    await tickUntil(proj, () => readEvents(proj).some((e) => e.type === 'reject'));
    const paths = lastVerify(proj).results.find((r) => r.check === 'paths');
    assert.equal(paths.outcome, 'FAIL');
    assert.match(paths.detail, /reports\/leak\.txt/);
    await waitWorkers(proj);
  });
});

describe('#15 node_modules 隔離', () => {
  test('worker 透過 symlink 改了根目錄 node_modules → 被偵測、退回', async () => {
    const proj = makeProject({ mode: 'nm' });
    mkdirSync(join(proj, 'node_modules/vitest'), { recursive: true });
    writeFileSync(join(proj, 'node_modules/vitest/index.js'), 'export const ok = 1;\n');
    addNode(proj, CALC, CALC_GHERKIN);
    await tickUntil(proj, () => readEvents(proj).some((e) => e.type === 'reject' && e.findings.some((f) => f.check === 'sandbox-escape')));
    const rej = readEvents(proj).find((e) => e.type === 'reject' && e.findings.some((f) => f.check === 'sandbox-escape'));
    assert.match(rej.findings.find((f) => f.check === 'sandbox-escape').detail, /node_modules/);
    await waitWorkers(proj);
  });

  test('merge-tree 有 lockfile 時用 npm ci --offline 裝一份,不 symlink 根目錄;裝不起來就是紅的', async () => {
    const proj = makeProject();
    const pkg = readJson(join(proj, 'package.json'));
    delete pkg.devDependencies;
    delete pkg.workspaces;
    writeJson(join(proj, 'package.json'), pkg);
    writeJson(join(proj, 'package-lock.json'), { name: pkg.name, lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name } } });
    commitIn(proj, 'lockfile');
    addNode(proj, CALC, CALC_GHERKIN);
    const lines = [];
    for (let i = 0; i < 25 && stateOf(proj).nodes.get('calc/v1')?.status !== 'done'; i++) {
      await tick(proj, { log: (l) => lines.push(l) });
      await waitWorkers(proj);
    }
    assert.equal(stateOf(proj).nodes.get('calc/v1').status, 'done', lines.join('\n'));
    assert.ok(lines.some((l) => /install=npm-ci-offline exit=0/.test(l)), lines.join('\n'));

    // 依賴不在本機快取 → install 失敗 → gate 紅
    const q = makeProject();
    const qp = readJson(join(q, 'package.json'));
    delete qp.devDependencies;
    delete qp.workspaces;
    qp.dependencies = { 'dlm-test-not-in-cache-zz': '1.0.0' };
    writeJson(join(q, 'package.json'), qp);
    writeJson(join(q, 'package-lock.json'), {
      name: qp.name, lockfileVersion: 3, requires: true,
      packages: {
        '': { name: qp.name, dependencies: qp.dependencies },
        'node_modules/dlm-test-not-in-cache-zz': { version: '1.0.0', resolved: 'https://registry.npmjs.org/dlm-test-not-in-cache-zz/-/dlm-test-not-in-cache-zz-1.0.0.tgz', integrity: 'sha512-AAAA' },
      },
    });
    commitIn(q, 'bad lockfile');
    addNode(q, CALC, CALC_GHERKIN);
    await tickUntil(q, () => readEvents(q).some((e) => e.type === 'gates' && !e.ok));
    const g = readEvents(q).find((e) => e.type === 'gates' && !e.ok);
    assert.equal(g.results[0].name, 'install');
    assert.match(g.output_tail, /npm ci --offline 失敗/);
    await waitWorkers(q);
  });
});

describe('#16 可驗證的使用者授權', () => {
  const askedProject = () => {
    const proj = makeProject();
    append(proj, 'dlm-cli', 'decision_request', { ref: 'DN-1', question: '要用哪個資料庫?', options: [{ key: 'pg', label: 'Postgres' }, { key: 'sqlite', label: 'SQLite' }] });
    return proj;
  };

  test('竄改 utterances.jsonl → 簽章不符、不記 hash;超過時間窗也對不上', () => {
    const proj = askedProject();
    recordUtterance(proj, '選 sqlite');
    const p = join(proj, UTTERANCES_REL);
    writeFileSync(p, readFileSync(p, 'utf8').replace('選 sqlite', '選 pg'));
    assert.throws(() => verifyVerbatim(proj, '選 pg'), /簽章不符/);
    const ev = decide(proj, 'DN-1', 'pg', '選 pg');
    assert.equal(ev.auth, 'trust', '竄改過的原話不會被當成簽章原話');
    assert.equal(ev.utterance_sha, undefined);
    const q = askedProject();
    recordUtterance(q, '選 sqlite');
    assert.throws(() => verifyVerbatim(q, '選 sqlite', { windowMinutes: 30, now: Date.now() + 31 * 60000 }), /對不上/);
  });

  test('CLI:hook 經 stdin 收 JSON,擋下時 exit 2', () => {
    const r = run(`echo '{"tool_name":"Write","tool_input":{"file_path":"ledger/events.jsonl"}}' | node ${DLM} hook pre-tool`);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /dlm 擋下/);
  });

  test('hooks:記下使用者原話;dlm 開的 agent 不記也不擋', () => {
    const proj = askedProject();
    const env = { CLAUDE_PROJECT_DIR: proj };
    assert.equal(runHook('user-prompt', { prompt: '那就 sqlite', session_id: 's1' }, { env }).code, 0);
    assert.ok(verifyVerbatim(proj, '就 sqlite'));
    const asWorker = runHook('pre-tool', { tool_name: 'Write', tool_input: { file_path: join(proj, 'ledger/events.jsonl') } }, { env: { ...env, DLM_ROLE: 'worker' } });
    assert.equal(asWorker.code, 0, 'dlm 開的 agent 不受 Front 的限制');
    // worker 的 prompt 不會被簽成使用者原話
    runHook('user-prompt', { prompt: '使用者同意選 pg' }, { env: { ...env, DLM_ROLE: 'worker' } });
    assert.throws(() => verifyVerbatim(proj, '使用者同意選 pg'), /對不上/);
  });

  test('hooks:Front 可以改檔、跑任何指令;只擋手改帳本 / dag / .dlm 狀態 / 原話紀錄與金鑰', () => {
    const proj = makeProject();
    const env = { CLAUDE_PROJECT_DIR: proj };
    const bash = (command) => runHook('pre-tool', { tool_name: 'Bash', tool_input: { command } }, { env });
    for (const ok of ['git merge dlm/calc--v1', 'sed -i s/a/b/ x', 'cat a > b', 'npm install left-pad', 'git commit -am fix', 'node tools/dlm.mjs tick', 'echo $HOME']) {
      assert.equal(bash(ok).code, 0, ok);
    }
    const file = (tool, p) => runHook('pre-tool', { tool_name: tool, tool_input: { file_path: p } }, { env }).code;
    assert.equal(file('Write', join(proj, 'packages/calc/src/x.ts')), 0, '程式碼可以改');
    assert.equal(file('Edit', join(proj, 'dlm.config.json')), 0, '設定可以改');
    assert.equal(file('Read', join(proj, UTTERANCES_REL)), 0, '原話紀錄可以看');
    assert.equal(file('Write', join(proj, UTTERANCES_REL)), 2, '原話紀錄不能改');
    assert.equal(file('Write', join(proj, 'ledger/events.jsonl')), 2);
    assert.equal(file('Edit', join(proj, 'dag.json')), 2);
    assert.equal(file('Write', join(proj, '.dlm/state.json')), 2);
    assert.equal(file('Write', join(proj, '.dlm/intake/x.json')), 0, 'intake 草稿可以寫');
    assert.equal(file('Read', process.env.DLM_KEY_FILE), 2, '金鑰讀不到');
    assert.match(runHook('pre-tool', { tool_name: 'Edit', tool_input: { file_path: join(proj, 'dag.json') } }, { env }).stderr, /用 dlm 指令/);
  });

  test('信任 Front 轉達:不附原話也能決定;對得上簽章原話時記 hash,對不上記 trust', () => {
    const proj = makeProject();
    const ask = (ref) => append(proj, 'dlm-cli', 'decision_request', { ref, question: 'q', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] });
    ask('DN-1'); ask('DN-2'); ask('DN-3');
    const bare = decide(proj, 'DN-1', 'a');
    assert.equal(bare.auth, 'trust');
    assert.equal(bare.verbatim, '(Front 轉達,未附原話)');
    const paraphrase = decide(proj, 'DN-2', 'b', '使用者說選 B');
    assert.equal(paraphrase.auth, 'trust');
    assert.equal(paraphrase.utterance_sha, undefined);
    recordUtterance(proj, '好,第三個選 A');
    const said = decide(proj, 'DN-3', 'a', '第三個選 A');
    assert.equal(said.auth, 'utterance');
    assert.match(said.utterance_sha, /^[0-9a-f]{16}$/);
    append(proj, 'dlm-cli', 'halt', { reason: 'x' });
    assert.equal(resume(proj).auth, 'trust', 'resume 也不必附原話');
  });

  test('worker 指令:Claude 可以跑指令但擋 rm -rf / sudo,不跳過權限確認', () => {
    assert.match(CLAUDE_WORKER_CMD, /--allowedTools "Bash"/);
    for (const r of CLAUDE_WORKER_DENY) assert.ok(CLAUDE_WORKER_CMD.includes(`"${r}"`), r);
    assert.doesNotMatch(CLAUDE_WORKER_CMD, /dangerously/);
  });

  test('resume:對得上原話時記 hash', () => {
    const proj = askedProject();
    append(proj, 'orchestrator', 'halt', { reason: '[git-config] 測試' });
    recordUtterance(proj, '我看過 git config 了,繼續');
    assert.equal(resume(proj, '繼續').auth, 'utterance');
  });

  test('dlm init 會裝好 hooks 設定', () => {
    const proj = join(tempDir(), 'p');
    init(proj, { name: 'x' });
    const settings = readJson(join(proj, '.claude/settings.json'));
    assert.match(JSON.stringify(settings.hooks.UserPromptSubmit), /hook user-prompt/);
    assert.match(settings.hooks.PreToolUse[0].matcher, /Write/);
  });
});

describe('#17 帳本簽章鏈', () => {
  test('每筆都有 prev_hash 與 mac;第一筆標 chain_start', () => {
    const proj = makeProject();
    append(proj, 'dlm-cli', 'note', { text: 'a' });
    append(proj, 'dlm-cli', 'note', { text: 'b' });
    const evs = readEvents(proj);
    assert.ok(evs.every((e) => e.mac && e.prev_hash));
    assert.equal(evs.filter((e) => e.chain_start).length, 1);
    assert.ok(checkLedger(proj).ok, checkLedger(proj).problems.join('\n'));
  });

  test('手動在帳本尾巴附加一筆 → dlm check ledger 報錯,tick 停下不動', async () => {
    const proj = makeProject();
    addNode(proj, CALC, CALC_GHERKIN);
    const seq = readEvents(proj).length + 1;
    appendFileSync(join(proj, 'ledger/events.jsonl'), `${JSON.stringify({ seq, ts: new Date().toISOString(), actor: 'user', type: 'decision', ref: 'x', choice: 'yes', verbatim: '好' })}\n`);
    const r = checkLedger(proj);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => /沒有簽章/.test(p)));
    const t = await tick(proj);
    assert.equal(t.ok, false);
    assert.equal(t.code, 3);
    assert.match(t.reason, /簽章鏈壞了/);
    assert.equal(readEvents(proj).filter((e) => e.type === 'dispatch').length, 0);
  });

  test('偽造的 mac、改寫中間一筆都抓得到', () => {
    const proj = makeProject();
    append(proj, 'dlm-cli', 'note', { text: 'a' });
    const p = join(proj, 'ledger/events.jsonl');
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    const last = JSON.parse(lines.at(-1));
    const forged = { ...last, seq: last.seq + 1, text: 'forged', prev_hash: sha256(lines.at(-1)), mac: '0'.repeat(64) };
    delete forged.chain_start;
    appendFileSync(p, `${JSON.stringify(forged)}\n`);
    assert.ok(checkLedger(proj).problems.some((x) => /mac 不符/.test(x)));
    const q = makeProject();
    append(q, 'dlm-cli', 'note', { text: 'a' });
    append(q, 'dlm-cli', 'note', { text: 'b' });
    const qp = join(q, 'ledger/events.jsonl');
    writeFileSync(qp, readFileSync(qp, 'utf8').replace('"text":"a"', '"text":"A"'));
    assert.ok(checkLedger(q).problems.some((x) => /mac 不符|prev_hash/.test(x)));
  });

  test('舊帳本:沒有簽章的前段照舊接受,從第一筆有簽章的開始上鏈', () => {
    const proj = tempDir();
    mkdirSync(join(proj, 'ledger'));
    writeFileSync(join(proj, 'ledger/events.jsonl'), `${JSON.stringify({ seq: 1, ts: 't', actor: 'dlm-cli', type: 'note', text: 'old' })}\n`);
    append(proj, 'dlm-cli', 'note', { text: 'new' });
    const evs = readEvents(proj);
    assert.ok(!evs[0].mac && evs[1].chain_start);
    assert.deepEqual(checkLedger(proj).problems, []);
  });
});

describe('#18 驗收強度:dry-run 與 mutation', () => {
  test('紅的原因要對:語法錯誤、未綁定步驟不算紅;實作不存在才算', () => {
    assert.match(badRedReason('SyntaxError: Unexpected token'), /語法錯誤/);
    assert.match(badRedReason('1 scenario (1 undefined)\n2 steps (1 undefined, 1 skipped)'), /沒綁定/);
    assert.equal(badRedReason("SyntaxError: The requested module './calc.mjs' does not provide an export named 'run'"), null);
    assert.equal(badRedReason("Error [ERR_MODULE_NOT_FOUND]: Cannot find module './calc.mjs'"), null);
    assert.equal(badRedReason('2 scenarios (2 failed)'), null);
  });

  test('測試棒交出有語法錯誤的測試 → FAIL', async () => {
    const proj = makeProject({ mode: 'syntax' });
    addNode(proj, CALC, CALC_GHERKIN);
    await tickUntil(proj, () => readEvents(proj).some((e) => e.type === 'reject'));
    const acc = lastVerify(proj).results.find((r) => r.check === 'acceptance');
    assert.equal(acc.outcome, 'FAIL');
    assert.match(acc.detail, /語法錯誤/);
    await waitWorkers(proj);
  });

  test('測試棒 dry-run 有未綁定步驟 → FAIL(即使 dry-run exit 0)', async () => {
    const proj = makeProject({ config: { verify: { dry_run_cmd: `FAKE_DRY=undefined node ${join(FIX, 'fake-dryrun.mjs')} {gherkin}` } } });
    addNode(proj, CALC, CALC_GHERKIN);
    await tickUntil(proj, () => readEvents(proj).some((e) => e.type === 'reject'));
    const dry = lastVerify(proj).results.find((r) => r.check === 'dry-run');
    assert.equal(dry.outcome, 'FAIL');
    assert.match(dry.detail, /features\/calc\/v1\.feature/);
    await waitWorkers(proj);
  });

  test('mutation 分數', () => {
    const rep = { files: { a: { mutants: [{ status: 'Killed' }, { status: 'Timeout' }, { status: 'Survived' }, { status: 'NoCoverage' }, { status: 'CompileError' }] } } };
    assert.equal(mutationScore(rep).score, 50);
    assert.equal(mutationScore({ files: {} }), null);
  });

  const mutationProject = (score, extra = {}) => makeProject({
    mode: 'hardcode',
    config: {
      ...extra,
      verify: { mutation: { cmd: `FAKE_SCORE=${score} node ${join(FIX, 'fake-mutation.mjs')} {files}`, report: 'reports/mutation/mutation.json', min: 60 } },
    },
  });

  test('寫死測試值:mutation 分數低 → strict 判 FAIL;一般節點 ABSTAIN、不自動合併', async () => {
    const strict = mutationProject(20);
    addNode(strict, { ...CALC, tier: 'strict' }, CALC_GHERKIN);
    // strict 節點每一棒都要第二意見:測試棒由「使用者」放行,看實作棒怎麼被 mutation 擋下
    const rejected = () => readEvents(strict).some((e) => e.type === 'reject');
    for (let i = 0; i < 5 && !rejected(); i++) {
      const st = await tickUntil(strict, (x) => rejected() || openRequests(x).some((r) => r.ref.startsWith('accept:')));
      for (const r of openRequests(st).filter((x) => x.ref.startsWith('accept:'))) decide(strict, r.ref, 'yes', '測試棒可以');
    }
    assert.ok(rejected(), '實作棒應該被退回');
    const m = lastVerify(strict).results.find((r) => r.check === 'mutation');
    assert.equal(m.outcome, 'FAIL');
    assert.match(m.detail, /20\.0%/);
    await waitWorkers(strict);

    const std = mutationProject(20);
    addNode(std, CALC, CALC_GHERKIN);
    const s = await tickUntil(std, (st) => openRequests(st).some((r) => r.ref.startsWith('accept:')));
    assert.equal(lastVerify(std).results.find((r) => r.check === 'mutation').outcome, 'ABSTAIN');
    assert.notEqual(s.nodes.get('calc/v1').status, 'done');
    await waitWorkers(std);
  });

  test('mutation 達標時,沒有 Verifier 模型也可以自動合併(放寬 #11)', async () => {
    assert.ok(summarize([{ check: 'scenario-honesty', outcome: 'SKIPPED' }, { check: 'mutation', outcome: 'PASS' }], { verifierBackend: 'none' }).clear);
    const proj = mutationProject(90, { agents: { verifier: { backend: 'none', cmd: null } } });
    addNode(proj, CALC, CALC_GHERKIN);
    await tickUntil(proj, (st) => st.nodes.get('calc/v1').status === 'done');
  });
});

describe('#19 小瑕疵', () => {
  test('worker 的時限:lease 與 agents.worker.timeout_minutes 取小的', async () => {
    const proj = makeProject({ config: { agents: { worker: { timeout_minutes: 7 } } } });
    addNode(proj, CALC, CALC_GHERKIN);
    await tick(proj);
    const d = readEvents(proj).find((e) => e.type === 'dispatch');
    const minutes = (Date.parse(d.lease_until) - Date.parse(d.ts)) / 60000;
    assert.ok(minutes > 6.9 && minutes < 7.1, String(minutes));
    await waitWorkers(proj);
  });

  test('花費:也認 cost_usd;串流輸出取最後一筆', () => {
    assert.equal(parseCost('{"total_cost_usd": 0.5}'), 0.5);
    assert.equal(parseCost('{"cost_usd":0.1}\n{"cost_usd":0.3}'), 0.3);
    assert.equal(parseCost('no cost here'), null);
  });

  test('placeholders 可以排除模板目錄(不再靠 package 名稱豁免)', () => {
    const root = tempDir();
    mkdirSync(join(root, 'payload'));
    writeFileSync(join(root, 'payload/AGENTS.md'), '{{PROJECT_NAME}}');
    writeFileSync(join(root, 'README.md'), 'ok');
    assert.equal(checkPlaceholders(root).result, 'FAIL');
    const cfg = { ...DEFAULTS, checks: { placeholders: { exclude: ['payload/**'] } } };
    assert.equal(checkPlaceholders(root, cfg).result, 'PASS');
    writeFileSync(join(root, 'README.md'), '{{API_KEY}}');
    assert.equal(checkPlaceholders(root, cfg).result, 'FAIL', '排除以外的照抓');
  });
});

test('測試用的暫存金鑰,不是你的真金鑰', () => {
  assert.ok(process.env.DLM_KEY_FILE.startsWith(tmpdir()));
});

describe('v3:沒有容器時,驗收副本裡的 git 不會找到外層主 repo', () => {
  test('沙箱與驗收執行器都設 GIT_CEILING_DIRECTORIES;外層有 repo 時,副本裡 git rev-parse 找不到它', () => {
    const outer = tempDir();
    sh(outer, 'git init -q');
    const copy = join(outer, '.dlm', 'scratch', 'd-0001');
    mkdirSync(copy, { recursive: true });
    const cmd = sandboxCommand({ sandbox: { backend: 'none' } }, 'verify', 'x', { cwd: copy });
    assert.equal(cmd.env.GIT_CEILING_DIRECTORIES, join(outer, '.dlm', 'scratch'));
    const r = hostExecutor(copy).sh('git rev-parse --show-toplevel');
    assert.notEqual(r.code, 0, `副本不在任何 repo 裡,_root.ts 才會退回 cwd(實際:${r.stdout})`);
  });

  test('node_modules 指紋忽略 vitest 建的 .vite-temp', () => {
    const root = tempDir();
    mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'vitest', 'index.js'), 'x');
    const before = nodeModulesFingerprint(root);
    mkdirSync(join(root, 'node_modules', '.vite-temp'));
    assert.equal(nodeModulesFingerprint(root), before);
  });
});

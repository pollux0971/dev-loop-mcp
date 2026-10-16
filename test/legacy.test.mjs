// 4.8.0 renamed dp to dlm. These tests build real old projects with the 4.7.3 code from git history and upgrade them
// with this version: file renames, seed files rewritten in place, a node that was halfway through finishing under the
// new code, old projects still usable through their own CLI, the machine folder move and the MCP registration.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { doctor } from '../tools/lib/doctor.mjs';
import { upgrade } from '../tools/lib/install.mjs';
import { loadConfig } from '../tools/lib/config.mjs';
import { validateEvent } from '../tools/lib/ledger.mjs';
import { FORWARDER, isLegacyProject, legacyEnvVars, lockForMigration, migrateMachineDir, projectCli, remapStatePath, renameTokens } from '../tools/lib/legacy.mjs';
import { refuseReason } from '../tools/lib/mcp.mjs';
import { mergeMcpJson } from '../tools/lib/setup.mjs';
import { isDlmProject, projectVersion } from '../tools/lib/projects.mjs';
import { projectOp } from '../tools/lib/service.mjs';
import { readJson, run, writeJson } from '../tools/lib/util.mjs';
import { FAKE, FAKE_VERIFIER, REPO, cleanup, sh, stateOf, tempDir, tickUntil } from './helpers.mjs';

// the last commit of dev-paradigm-mcp 4.7.3, before the rename
const OLD_COMMIT = '3216bea';
const DLM = join(REPO, 'tools', 'dlm.mjs');

let OLD = null;
let oldH = null;
before(async () => {
  const dir = tempDir('dlm-old-');
  const r = run(`git -C '${REPO}' archive ${OLD_COMMIT} | tar -x -C '${dir}'`);
  if (r.code !== 0 || !existsSync(join(dir, 'tools', 'dp.mjs'))) return; // no git history (a tarball install): those tests skip
  OLD = dir;
  // the old code reads DP_*: same signing key and machine folder as the new code, like a real machine after the move
  process.env.DP_KEY_FILE = process.env.DLM_KEY_FILE;
  process.env.DP_CONFIG_DIR = process.env.DLM_CONFIG_DIR;
  oldH = await import(join(OLD, 'test', 'helpers.mjs'));
});
after(() => { oldH?.cleanup(); cleanup(); });

const skipNoHistory = () => (OLD ? false : `git 歷史裡沒有 ${OLD_COMMIT}(不是 git clone)`);
const read = (p) => readFileSync(p, 'utf8');
const status = (proj) => sh(proj, 'git status --porcelain --untracked-files=no');

/** The user's own lines in AGENTS.md: a dynamic-programming table, a dp variable, a folder. The upgrade must not touch them. */
const USER_LINES = '\n## 我們自己的規則\n- 用 dp[i][j] 存子問題,表叫 dp_table;dp 這個字是動態規劃\n- 草稿放 ~/.dp/notes 與 drafts/dp/\n';

/** A 4.7.3 project with the fake worker, built and committed by the old code. */
function oldProject() {
  const proj = oldH.makeProject();
  // the project-level MCP entry that `dp mcp install --client project` used to write
  writeJson(join(proj, '.mcp.json'), { mcpServers: { dp: { command: 'node', args: ['tools/dp.mjs', 'mcp'] } } });
  appendFileSync(join(proj, 'AGENTS.md'), USER_LINES);
  sh(proj, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm mcp');
  return proj;
}

/** Old code: add the calc node and run until its dev leg was sent out (worker finished, report not collected yet). */
async function oldHalfway(proj) {
  oldH.addNode(proj, oldH.CALC, oldH.CALC_GHERKIN);
  await oldH.tickUntil(proj, (s) => [...s.dispatches.values()].some((d) => d.leg === 'dev'));
  return [...oldH.stateOf(proj).dispatches.values()].find((d) => d.leg === 'dev');
}

describe('dp → dlm:舊專案升級(用 git 歷史裡的 4.7.3 建)', () => {
  test('做到一半的節點:升級改名、一次 commit,之後用新版做完', { skip: skipNoHistory() }, async () => {
    const proj = oldProject();
    // old code: run until the dev leg was sent out. Its worker has finished but no tick collected the report yet,
    // the node is still open and its worktree and sandbox live under .dp/
    const devLeg = await oldHalfway(proj);
    assert.ok(existsSync(join(proj, '.dp', 'sandboxes', devLeg.dispatch_id, '.dp', 'report.json')), '舊版 worker 交的報告還沒收');
    assert.notEqual(oldH.stateOf(proj).nodes.get('calc/v1').status, 'done');
    assert.ok(existsSync(join(proj, '.dp', 'worktrees', 'calc--v1')), '舊版把 worktree 放在 .dp/worktrees');
    assert.match(read(join(proj, 'ledger', 'events.jsonl')), /\/\.dp\/worktrees\//, '帳本裡是舊路徑');
    assert.ok(isLegacyProject(proj));
    assert.equal(projectCli(proj), join(proj, 'tools', 'dp.mjs'));

    const dry = upgrade(proj, { dryRun: true });
    assert.ok(dry.migrate.includes('.dp/ → .dlm/') && dry.migrate.includes('dp.config.json → dlm.config.json'), JSON.stringify(dry.migrate));
    assert.ok(existsSync(join(proj, 'dp.config.json')), 'dry-run 什麼都不動');

    const r = upgrade(proj);
    assert.equal(r.to, read(join(REPO, 'VERSION')).trim());
    for (const f of ['dlm.config.json', 'package.json', '.claude/settings.json', '.gitignore', '.mcp.json', 'cucumber.js', 'AGENTS.md']) {
      assert.ok(r.migrated.includes(f), `${f} 應該被改寫:${JSON.stringify(r.migrated)}`);
    }
    assert.ok(r.remove.includes('tools/dp.mjs') && r.create.includes('tools/dlm.mjs'));
    assert.match(r.note, /重開/);
    assert.equal(r.warnings, undefined);

    // new layout, nothing old left except the forwarder that old Claude Code sessions' hooks still call
    for (const f of ['dp.config.json', '.dp-install.json', 'docs/dp', '.dp', '.dlm/tick.lock']) assert.ok(!existsSync(join(proj, f)), `${f} 應該不見了`);
    assert.equal(read(join(proj, 'tools', 'dp.mjs')), FORWARDER);
    assert.ok(r.migrated.includes('tools/dp.mjs'));
    assert.match(run(`node tools/dp.mjs --help`, { cwd: proj }).stdout, /^dlm —— dev-loop-mcp v/, '舊路徑轉給 dlm');
    for (const f of ['dlm.config.json', '.dlm-install.json', 'tools/dlm.mjs', 'docs/dlm/WORKFLOW.md', '.dlm/worktrees/calc--v1']) assert.ok(existsSync(join(proj, f)), `${f} 應該在`);
    const cfg = readJson(join(proj, 'dlm.config.json'));
    assert.deepEqual(cfg.gates.chain, ['check:dlm', 'test']);
    const pkg = readJson(join(proj, 'package.json'));
    assert.equal(pkg.scripts['check:dlm'], 'node tools/dlm.mjs check');
    assert.ok(!('check:dp' in pkg.scripts));
    const hooks = read(join(proj, '.claude', 'settings.json'));
    assert.match(hooks, /tools\/dlm\.mjs\\?" hook user-prompt/);
    assert.doesNotMatch(hooks, /dp\.mjs/);
    assert.match(read(join(proj, '.gitignore')), /^\.dlm\/$/m);
    assert.doesNotMatch(read(join(proj, '.gitignore')), /^\.dp\/$/m);
    assert.match(read(join(proj, 'cucumber.js')), /\.dlm\/pending-features\.json/);
    assert.deepEqual(readJson(join(proj, '.mcp.json')).mcpServers, { dlm: { command: 'node', args: ['tools/dlm.mjs', 'mcp'] } });
    const agents = read(join(proj, 'AGENTS.md'));
    assert.ok(agents.endsWith(USER_LINES), '使用者自己寫的 dp 一個字都沒動');
    const template = agents.slice(0, -USER_LINES.length);
    assert.doesNotMatch(template, /`dp[` ]|dp_[a-z]|docs\/dp\/|dev-paradigm/, template);
    assert.match(template, /`dlm`/);
    assert.equal(projectVersion(proj), r.to);

    // one commit, clean tree, git still knows the moved worktree
    assert.equal(status(proj), '');
    assert.match(sh(proj, 'git log -1 --format=%s'), /rename dp → dlm/);
    assert.match(sh(proj, 'git worktree list'), /\.dlm\/worktrees\/calc--v1/);
    assert.equal(run('git status --porcelain', { cwd: join(proj, '.dlm', 'worktrees', 'calc--v1') }).code, 0);
    // the old ledger (dp-cli events, .dp paths) passes the new checks
    const check = run(`node '${join(proj, 'tools', 'dlm.mjs')}' check`, { cwd: proj });
    assert.equal(check.code, 0, check.stdout + check.stderr);

    // carry on with the new code: the fake worker and verifier of this version (they read DLM_*)
    cfg.agents.worker.cmd = `FAKE_MODE=good node ${FAKE}`;
    cfg.agents.verifier = { ...cfg.agents.verifier, cmd: `FV=ok node ${FAKE_VERIFIER}` };
    writeJson(join(proj, 'dlm.config.json'), cfg);
    sh(proj, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm "new fakes"');
    const s = await tickUntil(proj, (st) => st.nodes.get('calc/v1').status === 'done');
    assert.equal(s.nodes.get('calc/v1').status, 'done');
    // the report the old worker left in .dp/ of its sandbox was collected, not thrown away and redone
    const events = read(join(proj, 'ledger', 'events.jsonl')).trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(events.some((e) => e.type === 'worker_done' && e.dispatch_id === devLeg.dispatch_id), '舊版 worker 的交件被新版收下');
    assert.ok(!events.some((e) => e.type === 'worker_failed' && e.dispatch_id === devLeg.dispatch_id));
    assert.ok(existsSync(join(proj, 'packages', 'calc', 'src', 'calc.mjs')), '合併進主線了');
    assert.equal(run(`node '${join(proj, 'tools', 'dlm.mjs')}' check`, { cwd: proj }).code, 0);
  });

  test('上一次升級搬了 .dp/ 就停了:再跑一次補上 git worktree repair,然後做完', { skip: skipNoHistory() }, async () => {
    const proj = oldProject();
    await oldHalfway(proj);
    renameSync(join(proj, '.dp'), join(proj, '.dlm')); // what a run that stopped right after the move leaves behind
    assert.ok(isLegacyProject(proj));
    assert.match(sh(proj, 'git worktree list'), /prunable/, 'git 還以為 worktree 在 .dp/');
    const r = upgrade(proj);
    assert.ok(r.migrated.includes('dlm.config.json'));
    const list = sh(proj, 'git worktree list');
    assert.match(list, /\.dlm\/worktrees\/calc--v1/);
    assert.doesNotMatch(list, /prunable/);
    assert.ok(!existsSync(join(proj, '.dp')), '鎖檔沒有把 .dp/ 建回來');
    assert.equal(run(`node tools/dlm.mjs check`, { cwd: proj }).code, 0);
  });

  test('背景迴圈或 tick 還在跑 → 拒絕升級,一個檔都不動;dry-run 會說原因', { skip: skipNoHistory() }, () => {
    const proj = oldProject();
    mkdirSync(join(proj, '.dp'), { recursive: true });
    writeFileSync(join(proj, '.dp', 'run.lock'), String(process.pid));
    assert.match(upgrade(proj, { dryRun: true }).blocked, /背景迴圈還在跑/);
    assert.throws(() => upgrade(proj), /背景迴圈還在跑/);
    writeFileSync(join(proj, '.dp', 'run.lock'), '999999999');
    writeFileSync(join(proj, '.dp', 'tick.lock'), String(process.pid));
    assert.throws(() => upgrade(proj), /tick 正在跑/);
    assert.equal(lockForMigration(proj), null, 'tick 拿著鎖時拿不到');
    assert.ok(existsSync(join(proj, 'dp.config.json')) && existsSync(join(proj, 'tools', 'dp.mjs')) && !existsSync(join(proj, '.dlm')));
  });

  test('dlm.config.json 裡指到專案以外的 .dp 不改,升級結果會提醒', { skip: skipNoHistory() }, () => {
    const proj = oldProject();
    const cfg = readJson(join(proj, 'dp.config.json'));
    cfg.worktree_dir = '../shared/.dp/wt';
    writeJson(join(proj, 'dp.config.json'), cfg);
    sh(proj, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm wt');
    const r = upgrade(proj);
    const after = readJson(join(proj, 'dlm.config.json'));
    assert.equal(after.worktree_dir, '../shared/.dp/wt');
    assert.deepEqual(after.gates.chain, ['check:dlm', 'test']);
    assert.ok(r.warnings?.some((w) => /worktree_dir/.test(w)), JSON.stringify(r.warnings));
  });

  test('你改過要被移除的 tools/dp.mjs → 衝突,一個檔都不動', { skip: skipNoHistory() }, () => {
    const proj = oldProject();
    writeFileSync(join(proj, 'tools', 'dp.mjs'), `${read(join(proj, 'tools', 'dp.mjs'))}\n// mine\n`);
    assert.throws(() => upgrade(proj), (e) => /tools\/dp\.mjs/.test(e.message) && /新版已移除/.test(e.message));
    assert.ok(existsSync(join(proj, 'dp.config.json')) && existsSync(join(proj, '.dp-install.json')) && !existsSync(join(proj, 'dlm.config.json')));
  });

  test('還沒升級的舊專案:hub / MCP 照樣用它自己的 tools/dp.mjs;新版 CLI 與 doctor 叫你先升級', { skip: skipNoHistory() }, async () => {
    const proj = oldProject();
    assert.ok(isDlmProject(proj));
    const r = await projectOp(proj, 'status', {});
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.result.version, '4.7.3');
    assert.throws(() => loadConfig(proj), /4\.8\.0 以前/);
    const cli = run(`node '${DLM}' status`, { cwd: proj });
    assert.notEqual(cli.code, 0);
    assert.match(cli.stderr, /dlm_upgrade_project/);
    const d = await doctor(proj);
    assert.equal(d.ok, false);
    assert.ok(d.results.some((x) => x.name === 'dp → dlm' && x.status === 'fail'));
    // init on top of an old project is refused: upgrade is the way
    assert.match(run(`node '${DLM}' init '${proj}' --existing`, { cwd: proj }).stderr, /舊版 dp/);
  });
});

describe('dp → dlm:改寫規則與相容', () => {
  test('renameTokens 只改 dp 自己的路徑與名字;prose 也只改 dp 寫過的形式(`dp`、dp 的指令與工具),使用者的 dp 不動', () => {
    const code = '"check:dp": "node tools/dp.mjs check", ".dp/", \'.dp\', dp.config.json, docs/dp/WORKFLOW.md, docs/dp-baseline.json, .dp-install.json, < "$DP_PROMPT", DP_NOTIFY_TEXT';
    assert.equal(renameTokens(code), '"check:dlm": "node tools/dlm.mjs check", ".dlm/", \'.dlm\', dlm.config.json, docs/dlm/WORKFLOW.md, docs/dlm-baseline.json, .dlm-install.json, < "$DLM_PROMPT", DLM_NOTIFY_TEXT');
    assert.equal(renameTokens('DP_HOOKS=off ./.dp/x'), 'DLM_HOOKS=off ./.dlm/x');
    // a project's own names stay
    const mine = 'DP_DATABASE_URL dpkg .dpx my.dp.config.json dp-tools adp run dp ~/.dp/x ../a/.dp/b';
    assert.equal(renameTokens(mine), mine);
    assert.equal(renameTokens(USER_LINES, { prose: true }), USER_LINES);
    assert.equal(renameTokens('只由 `dp` 寫入;跑 `dp status --json`,或呼叫 dp_get_inbox;/mcp__dp__new-project;dev-paradigm-mcp(dp)', { prose: true }),
      '只由 `dlm` 寫入;跑 `dlm status --json`,或呼叫 dlm_get_inbox;/mcp__dlm__new-project;dev-loop-mcp(dlm)');
  });

  test('帳本裡 .dp/ 底下的舊路徑重播時指到 .dlm/', () => {
    assert.equal(remapStatePath('/p/.dp/worktrees/calc-v1'), '/p/.dlm/worktrees/calc-v1');
    assert.equal(remapStatePath('/p/.dp/sandboxes/d-0001'), '/p/.dlm/sandboxes/d-0001');
    assert.equal(remapStatePath('/p/.dlm/worktrees/x'), '/p/.dlm/worktrees/x');
    assert.equal(remapStatePath('/my.dp/x'), '/my.dp/x');
    // the project itself under a folder called .dp: the last .dp is the project's own
    assert.equal(remapStatePath('/home/u/.dp/proj/.dp/worktrees/a'), '/home/u/.dp/proj/.dlm/worktrees/a');
    const t = tempDir();
    mkdirSync(join(t, '.dp', 'x'), { recursive: true });
    assert.equal(remapStatePath(join(t, '.dp', 'x')), join(t, '.dp', 'x'), '還在的路徑不動');
    assert.equal(remapStatePath(undefined), undefined);
  });

  test('舊帳本的 actor dp-cli 照樣有效', () => {
    const base = { seq: 1, ts: 't', type: 'note', text: 'old' };
    assert.deepEqual(validateEvent({ ...base, actor: 'dp-cli' }), []);
    assert.deepEqual(validateEvent({ ...base, actor: 'dlm-cli' }), []);
  });

  test('MCP 也拒絕舊版 dp 派出去的 worker(DP_ROLE、.dp/ 底下)', () => {
    assert.match(refuseReason('/p', { DP_ROLE: 'worker' }), /DP_ROLE/);
    assert.match(refuseReason('/p/.dp/sandboxes/d-1', {}), /工作目錄/);
    assert.equal(refuseReason('/p', {}), null);
    assert.equal(refuseReason('/home/u/.dp/proj', {}), null, '專案上面剛好有個叫 .dp 的資料夾不算');
  });

  test('使用者自己設的 DP_* 環境變數:dlm doctor 會提醒改名', () => {
    assert.deepEqual(legacyEnvVars({ DP_CONFIG_DIR: '/x', DP_HOOKS: 'off' }), ['DP_CONFIG_DIR', 'DP_HOOKS']);
    assert.deepEqual(legacyEnvVars({ DP_CONFIG_DIR: '/x', DLM_CONFIG_DIR: '/y' }), []);
  });

  test('專案的 .mcp.json:舊的 dp 換成 dlm,其他 server 不動', () => {
    const dir = tempDir();
    writeJson(join(dir, '.mcp.json'), { mcpServers: { dp: { command: 'node', args: ['tools/dp.mjs', 'mcp'] }, other: { command: 'x' } } });
    assert.equal(mergeMcpJson(dir), true);
    assert.deepEqual(readJson(join(dir, '.mcp.json')).mcpServers, { other: { command: 'x' }, dlm: { command: 'node', args: ['tools/dlm.mjs', 'mcp'] } });
    assert.equal(mergeMcpJson(dir), false);
  });
});

describe('dp → dlm:這台電腦', () => {
  test('~/.config/dp 第一次執行時搬到 ~/.config/dlm,帳號路徑跟著改,舊位置留捷徑', () => {
    const home = tempDir('dlm-home-');
    const old = join(home, '.config', 'dp');
    mkdirSync(join(old, 'accounts', 'a1'), { recursive: true });
    writeFileSync(join(old, 'key'), 'k');
    writeJson(join(old, 'accounts.json'), { accounts: { a1: { cli: 'claude', home: join(old, 'accounts', 'a1') }, mine: { cli: 'claude', home: join(home, '.claude') } } });
    // a child process with only HOME: no DLM_CONFIG_DIR / DLM_ACCOUNTS_FILE from the test process
    const env = { HOME: home, DLM_CONFIG_DIR: '', DLM_ACCOUNTS_FILE: '', DLM_KEY_FILE: '', DLM_PROJECTS_FILE: '' };
    const code = `import('${join(REPO, 'tools', 'lib', 'accounts.mjs')}').then((m) => console.log(m.configDir()))`;
    const r = run(`node -e "${code}"`, { env });
    const neu = join(home, '.config', 'dlm');
    assert.equal(r.stdout.trim(), neu, r.stderr);
    assert.equal(read(join(neu, 'key')), 'k');
    const acc = readJson(join(neu, 'accounts.json')).accounts;
    assert.equal(acc.a1.home, join(neu, 'accounts', 'a1'));
    assert.equal(acc.mine.home, join(home, '.claude'), '別的路徑不動');
    assert.ok(lstatSync(old).isSymbolicLink());
    assert.equal(readlinkSync(old), 'dlm');
    // the second time nothing happens
    assert.equal(run(`node -e "${code}"`, { env }).stdout.trim(), neu);
    assert.equal(migrateMachineDir(old, neu), null);
  });

  // a child process with only HOME set: no DLM_CONFIG_DIR / DLM_ACCOUNTS_FILE from the test process
  const machineEnv = (home) => ({ HOME: home, DLM_CONFIG_DIR: '', DLM_ACCOUNTS_FILE: '', DLM_KEY_FILE: '', DLM_PROJECTS_FILE: '' });
  const configDirOf = (home) => run(`node -e "import('${join(REPO, 'tools', 'lib', 'accounts.mjs')}').then((m) => console.log(m.configDir()))"`, { env: machineEnv(home) }).stdout.trim();

  test('~/.config/dp 本身是捷徑(dotfiles):搬的是捷徑,還是指到同一個地方', () => {
    const home = tempDir('dlm-home-');
    const real = join(home, 'dotfiles', 'dp');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'key'), 'k');
    mkdirSync(join(home, '.config'));
    symlinkSync(real, join(home, '.config', 'dp'));
    const neu = join(home, '.config', 'dlm');
    assert.equal(configDirOf(home), neu);
    assert.ok(lstatSync(neu).isSymbolicLink());
    assert.equal(readlinkSync(neu), real);
    assert.equal(read(join(neu, 'key')), 'k');
    assert.equal(readlinkSync(join(home, '.config', 'dp')), 'dlm');
  });

  test('上次搬完沒改到帳號路徑(中途失敗):下次啟動補上', () => {
    const home = tempDir('dlm-home-');
    const old = join(home, '.config', 'dp');
    const neu = join(home, '.config', 'dlm');
    mkdirSync(join(neu, 'accounts', 'a1'), { recursive: true });
    writeJson(join(neu, 'accounts.json'), { accounts: { a1: { cli: 'claude', home: join(old, 'accounts', 'a1') } } });
    assert.equal(configDirOf(home), neu);
    assert.equal(readJson(join(neu, 'accounts.json')).accounts.a1.home, join(neu, 'accounts', 'a1'));
  });

  test('dlm mcp install:舊的 dp 在 local scope 就從 local 拿掉', () => {
    const bin = tempDir('dlm-bin-');
    const log = join(bin, 'calls.log');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$*" >> '${log}'\nif [ "$1 $2 $3" = "mcp get dp" ]; then printf 'dp:\\n  Scope: Local config (private to you in this project)\\n  Args: /old/tools/dp.mjs mcp\\n'; fi\nexit 0\n`, { mode: 0o755 });
    const r = run(`node '${DLM}' mcp install`, { env: { PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(read(log), /^mcp remove --scope local dp$/m);
  });

  test('dlm mcp install:裝 dlm,拿掉指到 tools/dp.mjs 的舊 dp;指到別的就不動', () => {
    for (const [args, removed] of [['/old/dev-paradigm-mcp/tools/dp.mjs mcp', true], ['/somewhere/else.mjs', false]]) {
      const bin = tempDir('dlm-bin-');
      const log = join(bin, 'calls.log');
      writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$*" >> '${log}'\nif [ "$1 $2 $3" = "mcp get dp" ]; then echo "dp:\\n  Command: node\\n  Args: ${args}"; fi\nexit 0\n`, { mode: 0o755 });
      const r = run(`node '${DLM}' mcp install`, { env: { PATH: `${bin}:${process.env.PATH}` } });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      const calls = read(log);
      assert.match(calls, /^mcp add --scope user dlm -- node \S+tools\/dlm\.mjs mcp$/m);
      assert.equal(/mcp remove --scope user dp/.test(calls), removed, calls);
      assert.equal(/拿掉了舊的 dp/.test(r.stdout), removed, r.stdout);
    }
  });
});

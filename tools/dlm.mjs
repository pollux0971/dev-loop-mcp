#!/usr/bin/env node
// dlm: the single command of dev-loop-mcp. Zero dependencies, Node >= 20.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { runChecks } from './lib/checks.mjs';
import { loadDag } from './lib/dag.mjs';
import { runGates } from './lib/gates.mjs';
import { pendingFeatures, writePendingFeatures } from './lib/pending.mjs';
import { dashboardData, renderDashboard, serveDashboard } from './lib/dashboard.mjs';
import { doctor, renderDoctor } from './lib/doctor.mjs';
import { runHook } from './lib/hooks.mjs';
import { mergeMcpJson, setup } from './lib/setup.mjs';
import { ROLES, accountEnv, accountsFile, addAccount, cliOf, getAccount, loadAccounts, loginStatus, removeAccount, updateAccount } from './lib/accounts.mjs';
import { VERSION, accountRows, decideOp, haltOp, loopPid, loopStart, loopStop, refreshRendered, runLockPath, runOp, runStopPath, setRole, setSettings } from './lib/ops.mjs';
import { addProject, isDlmProject, loadProjects, projectVersion, removeProject } from './lib/projects.mjs';
import { isLegacyProject, legacyMessage } from './lib/legacy.mjs';
import { hubToken, serveHub } from './lib/hub.mjs';
import { apiMarkdown, flowMarkdown, openapiJson } from './lib/apidoc.mjs';
import { serveMcp, toolList } from './lib/mcp.mjs';
import { BASELINE, onboard, recordBaseline } from './lib/brownfield.mjs';
import { commitAll } from './lib/git.mjs';
import { confirmE2e, decide, renderInbox, resume, show, unblockByUser } from './lib/inbox.mjs';
import { init, upgrade } from './lib/install.mjs';
import { applyProposal, proposeBundle, proposeFeature } from './lib/intake.mjs';
import { append, readEvents } from './lib/ledger.mjs';
import { Ctx, tick } from './lib/orchestrator.mjs';
import { renderAll, writeRendered } from './lib/render.mjs';
import { computeSnapshot } from './lib/snapshot.mjs';
import { replay } from './lib/state.mjs';
import { DlmError, ensureDir, readJson, tryLock, writeJson } from './lib/util.mjs';

const HELP = `dlm —— dev-loop-mcp v${VERSION}

第一次用:dlm mcp install(這台電腦裝一次)→ 在 Claude Code 說「用 dlm 開一個新專案在 <目錄>」
       或:dlm init <dir> → cd <dir> → dlm setup → dlm doctor → 在 Claude Code 打 /inbox

安裝與設定
  dlm init <dir> [--name X] [--existing] [--no-commit]   建新專案(或 --existing 補進既有專案;已經有 git 時會把 dlm 的檔 commit)
  dlm setup [--yes] [--answers file.json]     互動問答:選 AI、Verifier、自治等級,寫好設定並 commit
  dlm doctor [--json]                         健康檢查:每一項 ✓ / ⚠ / ✗,不對的附修法
  dlm upgrade [--dry-run]                     升級 dlm 管理的檔(衝突就一個都不寫)

既有專案(brownfield,dlm setup 選了 Brownfield 之後)
  dlm onboard [--no-commit]                   記下測試基線,產生 docs/AS-IS.md 草稿與 ROADMAP v0(已有的不覆蓋)
  dlm baseline [--no-commit]                  重記測試基線:主線上哪些測試本來就紅(合併時不算到 worker 頭上)

跑起來(背景那一條)
  dlm tick                                    跑一輪:收件→驗證→合併→派工
  dlm run [--interval 60] [--max-ticks N] [--until-idle] [--daemon]
  (任何指令加 --help 只印說明,不會執行)

單一窗口(Front 只用這些)
  dlm inbox [--no-mark]                       要你決定的 / 上次看之後 / 細節
  dlm show <ref|node|dispatch>
  dlm decide <ref> <choice> --verbatim "使用者原話"
  dlm decide <ref1,ref2,...|accept:*> <choice> --verbatim "..."   一句話決定好幾件(accept:* = 所有待合併)
  dlm confirm <node> yes|no --verbatim "使用者原話"
  dlm halt --reason "..." [--keep-workers]    停機,並終止還在跑的 worker(不算嘗試、不動 worktree)
  dlm resume --verbatim "..."
  dlm unblock <node> --verbatim "..."          使用者親自解除封鎖
  dlm settings [--autonomy 0|1|2] [--budget 8] [--parallel 3] --verbatim "..."   改自治等級、每日預算、同時幾個 worker(只改有給的)
  dlm status [--json]
  dlm dashboard [--out file.html] [--serve [port]]   視覺化主控台:寫成一個 HTML 檔,或開本機頁面即時更新(--serve 時可在「帳號」頁設定帳號)
  (--verbatim 是你的原話,可省略;對得上 hook 簽章過的原話時,事件會記下那句話的 hash)

訂閱帳號(v4.6,一個角色可以輪流用好幾個帳號,被限流就換下一個)
  dlm account add <name> --cli claude|codex [--plan max] [--max-parallel 2] [--home dir]   登記一個帳號(這台電腦的,不進 repo)
  dlm account set <name> [--plan max] [--max-parallel N|none]   改方案名稱、同時上限(所有專案加起來同時跑幾個 worker)
  dlm account login <name>                    在那個帳號的目錄登入一次(開瀏覽器;要在終端機跑)
  dlm account list [--json]                   帳號、登入狀態、這個專案的用量、冷卻到幾點、哪個角色在用
  dlm account use <worker|critic|verifier> <a,b,...|none> [--model sonnet|none]   角色輪流用這些帳號(改 dlm.config.json 並 commit)
  dlm account rm <name>

MCP(v4.7:這台電腦一個,管所有 dlm 專案;工具與 HTTP API 同一份定義)
  dlm mcp install [--client claude|cursor|codex|project]   裝進 Claude Code(預設,所有專案共用)/ Cursor / Codex / 只裝這個專案
  dlm mcp config                              印出各工具的設定寫法(自己貼)
  dlm mcp tools                               列出 MCP 工具
  dlm mcp                                     stdio MCP server(給工具啟動用,不是給人打的)

多專案(v4.7)
  dlm project add [<dir>] [--name X]          登記專案(dlm init 建的會自動登記)
  dlm project list [--json]                   這台電腦的 dlm 專案
  dlm project rm <name>                       從清單拿掉(不刪檔案)
  dlm hub [--port 7170] [--interval 5]        所有專案的總覽與監控頁 + HTTP API(/api/v1,規格 /api/v1/openapi.json)
  dlm hub token                               API 的 token(Authorization: Bearer <token>)
  dlm run --stop                              請背景迴圈這一輪做完就結束
  dlm op <操作> [--args '{json}']               以 JSON 執行一個操作(API 與 MCP 在專案裡呼叫的就是這個)
  dlm api [md|openapi|flow]                   印出 API 文件、OpenAPI 規格、流程(docs/dlm/API.md、FLOW.md 就是這樣產生的)

新東西進 DAG(都要使用者批准)
  dlm intake feature --spec spec.json [--gherkin file.feature] [--supersedes p-001]
  dlm intake bundle --spec bundle.json [--supersedes p-001]   一次提一整個版本(多個節點 + gherkin + 整合點),一次批准;--supersedes 取代還沒決定的舊提案
  dlm intake apply <proposal-id>

檢查
  dlm check [dag ledger generated contracts placeholders rule-size rule-conflicts controls]
  dlm gates        dlm render        dlm stats
`;

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** While the background loop sleeps, it checks every half second whether someone wants it to end (dlm run --stop, the stop button in dlm hub). */
async function sleepUnlessStopped(root, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(runStopPath(root))) return true;
    await sleep(Math.min(500, until - Date.now()));
  }
  return existsSync(runStopPath(root));
}

function need(flags, key, hint) {
  if (!flags[key] || flags[key] === true) throw new DlmError(`缺 --${key}${hint ? `(${hint})` : ''}`);
  return flags[key];
}

function summaryLine(s) {
  return `完成 ${s.counts.done}/${s.counts.nodes} · 進行 ${s.in_progress.length} · 審核 ${s.review.length} · 可派 ${s.dispatchable.length} · 卡住 ${s.blocked.length} · 待你 ${s.awaiting_user.decisions.length + s.awaiting_user.e2e.length} · $${s.budget.today_usd}`;
}

/** After a command that writes events finishes, regenerate STATUS/DECISIONS so the generated files always match the ledger (the commit is left to the next tick). */
const MUTATING = new Set(['inbox', 'decide', 'confirm', 'halt', 'resume', 'unblock', 'intake']);
// commands that work outside a project, or that handle an old dp project themselves (upgrade migrates it, doctor explains)
const NO_PROJECT = new Set([undefined, 'help', '--help', 'init', 'upgrade', 'doctor', 'mcp', 'hub', 'project', 'account', 'api']);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const code = await dispatchCommand(cmd, rest);
  if (code === 0 && MUTATING.has(cmd) && !(cmd === 'inbox' && rest.includes('--no-mark'))) {
    const { flags } = parseArgs(rest);
    refreshRendered(resolve(flags.root ?? process.cwd()));
  }
  return code;
}

// v4: the flags each command recognizes. v3's `dlm run --help` ignored --help as an unknown flag and started the loop in the background (seen in a real run).
const FLAGS = {
  init: ['name', 'existing', 'no-commit'], setup: ['yes', 'answers'], doctor: ['json'], upgrade: ['dry-run'],
  tick: [], run: ['interval', 'max-ticks', 'until-idle', 'daemon', 'stop'],
  status: ['json'], dashboard: ['out', 'serve', 'interval'], inbox: ['no-mark'], show: [], decide: ['verbatim', 'as'], confirm: ['verbatim'],
  halt: ['reason', 'keep-workers'], resume: ['verbatim'], unblock: ['verbatim'],
  intake: ['spec', 'gherkin', 'supersedes'], onboard: ['no-commit'], baseline: ['no-commit'], check: [], gates: [], render: [], stats: [], hook: [],
  account: ['cli', 'plan', 'home', 'model', 'json', 'max-parallel'], mcp: ['client'],
  project: ['name', 'json'], hub: ['port', 'interval'], op: ['args'], api: [],
};

function commandHelp(cmd) {
  const lines = HELP.split('\n').filter((l) => new RegExp(`\\bdp ${cmd}\\b`).test(l));
  return lines.length ? lines.join('\n') : HELP;
}

async function dispatchCommand(cmd, rest) {
  const { pos, flags } = parseArgs(rest);
  const root = resolve(flags.root ?? process.cwd());
  const log = (l) => console.log(l);
  if (cmd && cmd !== 'help' && cmd !== '--help' && (flags.help || rest.includes('-h'))) {
    console.log(commandHelp(cmd));
    return 0;
  }
  if (FLAGS[cmd]) {
    const unknown = Object.keys(flags).filter((k) => k !== 'root' && !FLAGS[cmd].includes(k));
    if (unknown.length) throw new DlmError(`dlm ${cmd} 不認得 ${unknown.map((k) => `--${k}`).join(' ')}(什麼都沒做)。\n${commandHelp(cmd)}`);
  }
  // 4.8.0 renamed dp to dlm: project commands in a project that still has dp's file names would read the defaults
  if (!NO_PROJECT.has(cmd) && isLegacyProject(root)) throw new DlmError(legacyMessage(root));
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
      console.log(HELP);
      return 0;
    case 'init': {
      const r = init(need({ dir: pos[0] }, 'dir', 'dlm init <dir>'), { name: flags.name, existing: !!flags.existing, commit: !flags['no-commit'] });
      console.log(`建立 ${r.created.length} 個檔${r.kept.length ? `,保留你既有的 ${r.kept.length} 個` : ''};git ${r.git}${r.committed ? `,已 commit ${r.committed.slice(0, 8)}` : ''}`);
      try { const p = addProject(pos[0]); console.log(`已登記到這台電腦的專案清單:${p.name}(dlm project list)`); } catch { /* 登記失敗不影響 init */ }
      console.log(`下一步:cd ${pos[0]} && node tools/dlm.mjs setup(一題一題帶你設定,大約兩分鐘)`);
      return 0;
    }
    case 'setup': {
      let ask;
      let close = () => {};
      if (flags.yes || flags.answers) {
        const answers = flags.answers && flags.answers !== true ? readJson(resolve(flags.answers)) : {};
        ask = async (q) => {
          const a = answers[q.id];
          process.stdout.write(`${q.text}${a ?? ''}\n`);
          return a ?? '';
        };
      } else {
        if (!process.stdin.isTTY) throw new DlmError('dlm setup 要在終端機互動執行;不互動請加 --yes(全用預設)或 --answers file.json');
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        ask = (q) => rl.question(q.text);
        close = () => rl.close();
      }
      try {
        await setup(root, { ask });
      } finally {
        close();
      }
      console.log('\n— 健康檢查 —');
      const report = await doctor(root);
      console.log(renderDoctor(report));
      return 0;
    }
    case 'doctor': {
      const report = await doctor(root);
      console.log(flags.json ? JSON.stringify(report, null, 2) : renderDoctor(report));
      return report.ok ? 0 : 1;
    }
    case 'upgrade': {
      const r = upgrade(root, { dryRun: !!flags['dry-run'] });
      console.log(`${r.from} → ${r.to}:更新 ${r.update.length}、新增 ${r.create.length}、移除 ${r.remove.length}${flags['dry-run'] ? '(dry-run,沒寫)' : ''}`);
      for (const k of ['update', 'create', 'remove']) for (const f of r[k]) console.log(`  ${k} ${f}`);
      // 4.8.0: an old dp project is renamed in the same upgrade
      if (r.migrate) {
        console.log('dp → dlm 改名:');
        for (const s of r.migrate) console.log(`  ${s}`);
        if (r.blocked) console.log(`現在還不能升級:${r.blocked}`);
      }
      if (r.migrated) console.log(`dp → dlm 改名完成(改了 ${r.migrated.length} 個檔)。${r.note}`);
      if (r.commit) console.log(`已 commit ${r.commit.slice(0, 8)}`);
      return 0;
    }
    case 'tick': {
      const r = await tick(root, { log });
      if (r.busy) { console.log(r.reason); return 0; }
      if (!r.ok) { console.error(`tick 沒跑:${r.reason}`); return r.code; }
      console.log(summaryLine(r.snapshot));
      return 0;
    }
    case 'run': {
      if (flags.stop) {
        const r = await loopStop(root, { wait: 60 });
        console.log(!r.was_running ? '背景迴圈沒在跑' : r.stopped ? `背景迴圈(pid ${r.pid})已結束` : `已要求背景迴圈(pid ${r.pid})結束;${r.note}`);
        return 0;
      }
      const running = loopPid(root);
      if (running) throw new DlmError(`背景迴圈已經在跑(pid ${running});同一個 repo 只能有一個`);
      ensureDir(join(root, '.dlm'));
      if (flags.daemon) {
        const r = await loopStart(root, { interval: flags.interval ?? 60, maxTicks: flags['max-ticks'] ?? null });
        console.log(`背景迴圈已啟動 pid ${r.pid},紀錄在 .dlm/run.log(停止:dlm run --stop)`);
        return 0;
      }
      if (existsSync(runStopPath(root))) unlinkSync(runStopPath(root));
      const release = tryLock(runLockPath(root));
      if (!release) throw new DlmError(`背景迴圈已經在跑(pid ${loopPid(root) ?? '?'});同一個 repo 只能有一個`);
      process.on('exit', release);
      for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(0); });
      const interval = Number(flags.interval ?? 60) * 1000;
      const max = flags['max-ticks'] ? Number(flags['max-ticks']) : Infinity;
      for (let i = 1; i <= max; i++) {
        if (existsSync(runStopPath(root))) { unlinkSync(runStopPath(root)); console.log('收到停止要求,結束'); return 0; }
        const r = await tick(root, { log });
        if (r.busy) {
          console.log(`[tick ${i}] ${r.reason}`);
          if (i < max) await sleepUnlessStopped(root, interval);
          continue;
        }
        if (!r.ok) { console.error(`[tick ${i}] 停:${r.reason}`); return r.code; }
        const s = r.snapshot;
        console.log(`[tick ${i}] ${new Date().toISOString()} ${summaryLine(s)}`);
        const idle = !s.in_progress.length && !s.review.length && !s.dispatchable.length && !s.backoff.length;
        if (flags['until-idle'] && idle) { console.log('沒有可做的事了(全部完成,或都在等你)'); return 0; }
        if (i < max) await sleepUnlessStopped(root, interval);
      }
      return 0;
    }
    case 'status': {
      const ctx = new Ctx(root);
      const s = computeSnapshot({ root, config: ctx.config, dag: ctx.dag, state: ctx.state });
      const pid = loopPid(root);
      console.log(flags.json ? JSON.stringify({ ...s, loop: pid ? { running: true, pid } : { running: false } }, null, 2)
        : `${summaryLine(s)}\n背景迴圈:${pid ? `執行中(pid ${pid})` : '沒在跑'}${s.halted ? `;停機中:${s.halted.reason}` : ''}`);
      return 0;
    }
    case 'dashboard': {
      if (flags.serve) {
        const port = flags.serve === true ? 7171 : Number(flags.serve);
        const interval = flags.interval ? Number(flags.interval) : 5;
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new DlmError(`--serve 的 port 不對:${flags.serve}`);
        if (!(interval > 0)) throw new DlmError(`--interval 要是正數(秒):${flags.interval}`);
        await serveDashboard(root, { port, intervalMs: interval * 1000 });
        await new Promise(() => {}); // Stays open until Ctrl+C
      }
      const out = resolve(flags.out && flags.out !== true ? flags.out : join(root, '.dlm', 'dashboard.html'));
      ensureDir(dirname(out));
      writeFileSync(out, renderDashboard(dashboardData(root)));
      console.log(`已寫出 ${out}(快照,不會自己更新;要即時看用 dlm dashboard --serve)`);
      return 0;
    }
    case 'inbox':
      console.log(renderInbox(root, { markSeen: !flags['no-mark'] }));
      return 0;
    case 'show':
      console.log(show(root, need({ ref: pos[0] }, 'ref')));
      return 0;
    case 'decide': {
      const [ref, choice] = pos;
      if (!ref || !choice) throw new DlmError('dlm decide <ref> <choice> --verbatim "..."');
      // Without --as: the user's decision is written only by the user; a Critic's stand-in can only be written by the orchestrator inside a tick
      if (flags.as !== undefined) throw new DlmError('--as 已移除:dlm decide 只記錄使用者的決定;Critic 的判決由 tick 代寫');
      // v4: one sentence decides several things (v3 real run: four nodes waited for merge at once and the user had to say yes one by one)
      for (const r of decideOp(root, { ref, choice, verbatim: flags.verbatim }).recorded) console.log(`已記錄 #${r.seq} ${r.ref}=${choice};下一個 tick 會執行`);
      return 0;
    }
    case 'confirm': {
      const [node, yn] = pos;
      if (!node || !['yes', 'no'].includes(yn)) throw new DlmError('dlm confirm <node> yes|no --verbatim "..."');
      const ev = confirmE2e(root, node, yn === 'yes', flags.verbatim === true ? '' : flags.verbatim);
      console.log(`已記錄 #${ev.seq}`);
      return 0;
    }
    case 'unblock': {
      const ev = unblockByUser(root, need({ node: pos[0] }, 'node', 'dlm unblock <節點>'), flags.verbatim === true ? '' : flags.verbatim);
      console.log(`#${ev.seq} 已解除 ${pos[0]};下一個 tick 會重新派工`);
      return 0;
    }
    case 'hook': {
      // Claude Code hooks: stdin is JSON. The stdout of user-prompt is treated as conversation context: print only the one reminder line that dlm itself generates.
      let input = {};
      try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* 空輸入 */ }
      const r = runHook(pos[0], input);
      if (r.stdout) console.log(r.stdout);
      if (r.stderr) console.error(r.stderr);
      return r.code;
    }
    case 'halt': {
      const r = haltOp(root, { reason: need(flags, 'reason'), keep_workers: !!flags['keep-workers'] });
      console.log(`#${r.seq} 已停機`);
      if (r.keep_workers) console.log('(--keep-workers:還在跑的 worker 會跑完,結果等恢復後再處理)');
      else if (r.deferred) console.log('背景迴圈正在跑一輪;下一輪會終止還在跑的 worker');
      else console.log(r.stopped.length ? `終止了 ${r.stopped.join(', ')}(不算嘗試次數;worktree 保持原樣)` : '沒有正在跑的 worker');
      return 0;
    }
    case 'resume':
      console.log(`#${resume(root, flags.verbatim === true ? '' : flags.verbatim).seq} 已恢復`);
      return 0;
    case 'settings': {
      // v4.7.3: change only the items the user said to change (before, you had to rerun dlm setup, which asked about and wrote all the other settings too)
      const num = (k) => (flags[k] === undefined || flags[k] === true ? undefined : Number(flags[k]));
      const r = setSettings(root, { autonomy_level: num('autonomy'), daily_usd: num('budget'), parallel: num('parallel'), verbatim: flags.verbatim });
      for (const [k, v] of Object.entries(r.changed)) console.log(`✓ ${k}:${v.from} → ${v.to}`);
      for (const n of r.notes ?? []) console.log(`提醒:${n}`);
      return 0;
    }
    case 'onboard':
    case 'baseline': {
      const config = loadConfig(root);
      if (config.project?.mode !== 'brownfield') console.log('提醒:dlm.config.json 的 project.mode 不是 brownfield(重跑 dlm setup 可以改);照樣執行。');
      const written = cmd === 'onboard' ? onboard(root, config, { log }).written : (recordBaseline(root, config, { log }), [BASELINE]);
      const b = readJson(join(root, BASELINE));
      const red = b.gates.filter((g) => g.exit !== 0);
      console.log(red.length
        ? `基線:${red.map((g) => `${g.name} 本來就紅(${g.failing ? `${g.failing.length} 個測試` : '看不出是哪些測試,修好前每次合併都會擋'})`).join('、')}`
        : '基線:主線上專案的測試全綠');
      console.log(`寫了 ${written.join('、')}`);
      if (!flags['no-commit']) {
        commitAll(root, written, cmd === 'onboard' ? 'dlm onboard:測試基線、AS-IS 草稿、ROADMAP v0' : 'dlm baseline:重記測試基線');
        console.log('已 commit');
      }
      if (cmd === 'onboard') console.log('下一步:請 Front 照 brownfield-onboard 讀程式、補完 docs/AS-IS.md 的「待補」段落並跟你確認');
      return 0;
    }
    case 'check': {
      const results = runChecks(root, pos.length ? pos : undefined);
      for (const r of results) {
        console.log(`check=${r.name} result=${r.result}`);
        for (const l of r.lines) console.log(`  ${l}`);
      }
      const fail = results.some((r) => r.result === 'FAIL');
      console.log(`check=all result=${fail ? 'FAIL' : 'PASS'} ran=${results.length}`);
      return fail ? 1 : 0;
    }
    case 'gates': {
      const gdag = loadDag(root);
      writePendingFeatures(root, pendingFeatures(gdag, replay(readEvents(root), gdag)));
      const r = runGates(root, loadConfig(root), { log });
      return r.ok ? 0 : 1;
    }
    case 'render': {
      const dag = loadDag(root);
      const events = readEvents(root);
      writeRendered(root, renderAll(root, dag, replay(events, dag), events));
      console.log('已重新產生 STATUS.md、DECISIONS.md、standalone.json');
      return 0;
    }
    case 'intake': {
      const [mode, arg] = pos;
      if (mode === 'feature') {
        const spec = readJson(resolve(need(flags, 'spec', 'JSON 檔:id/title/intent/owns/...')));
        const gherkin = flags.gherkin ? readFileSync(resolve(flags.gherkin), 'utf8') : null;
        const sup = flags.supersedes && flags.supersedes !== true ? String(flags.supersedes).split(',') : undefined;
        const p = proposeFeature(root, spec, gherkin, { supersedes: sup });
        console.log(`提案 ${p.id} 已建立,等使用者決定 node:${p.id}`);
        for (const w of p.warnings) console.log(`⚠ ${w}`);
      } else if (mode === 'bundle') {
        const sup = flags.supersedes && flags.supersedes !== true ? String(flags.supersedes).split(',') : undefined;
        const p = proposeBundle(root, readJson(resolve(need(flags, 'spec', 'JSON 檔:{ release, goal, roadmap?, nodes: [...] }'))), { supersedes: sup });
        console.log(`提案 ${p.id} 已建立(整個版本一次批准),等使用者決定 node:${p.id}`);
        for (const w of p.warnings) console.log(`⚠ ${w}`);
      } else if (mode === 'apply') {
        const r = applyProposal(root, need({ id: arg }, 'id'));
        console.log(r.applied ? `已加入 ${r.nodes.join(', ')}` : '已經套用過了');
      } else {
        throw new DlmError('dlm intake feature|bundle|apply');
      }
      return 0;
    }
    case 'account':
      return accountCommand(root, pos, flags);
    case 'mcp':
      return mcpCommand(root, pos, flags);
    case 'project':
      return projectCommand(pos, flags);
    case 'api': {
      // The docs are generated from the route table and the flow table (the API.md, openapi.json and FLOW.md in payload/docs/dlm come from this)
      const kind = pos[0] ?? 'md';
      const gen = { md: apiMarkdown, openapi: openapiJson, flow: flowMarkdown }[kind];
      if (!gen) throw new DlmError('dlm api [md|openapi|flow]');
      process.stdout.write(gen(VERSION));
      return 0;
    }
    case 'hub': {
      if (pos[0] === 'token') { console.log(hubToken()); return 0; }
      const port = flags.port ? Number(flags.port) : 7170;
      const interval = flags.interval ? Number(flags.interval) : 5;
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new DlmError(`--port 不對:${flags.port}`);
      if (!(interval > 0)) throw new DlmError(`--interval 要是正數(秒):${flags.interval}`);
      await serveHub({ port, intervalMs: interval * 1000 });
      await new Promise(() => {}); // Stays open until Ctrl+C
      return 0;
    }
    case 'op': {
      // Entry point for API / MCP to run an operation inside a project: stdin (or --args) is JSON, and the last stdout line is { ok, result } / { ok:false, error, status }
      let args = {};
      try {
        const raw = flags.args && flags.args !== true ? flags.args : (process.stdin.isTTY ? '' : readFileSync(0, 'utf8'));
        args = raw.trim() ? JSON.parse(raw) : {};
      } catch (e) {
        console.log(JSON.stringify({ ok: false, error: `參數不是合法的 JSON:${e.message}`, status: 400 }));
        return 1;
      }
      const r = await runOp(need({ name: pos[0] }, 'name', 'dlm op <操作>'), root, args);
      console.log(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    case 'stats': {
      const events = readEvents(root);
      const per = {};
      for (const ev of events.filter((e) => e.type === 'verify')) {
        for (const r of ev.results) {
          per[r.check] ??= { PASS: 0, FAIL: 0, NO_OBJECTION: 0, ABSTAIN: 0, SKIPPED: 0 };
          per[r.check][r.outcome]++;
        }
      }
      console.log('檢查               PASS  FAIL  NO_OBJ ABSTAIN SKIP');
      for (const [k, v] of Object.entries(per)) console.log(`${k.padEnd(18)} ${String(v.PASS).padStart(4)} ${String(v.FAIL).padStart(5)} ${String(v.NO_OBJECTION).padStart(6)} ${String(v.ABSTAIN).padStart(7)} ${String(v.SKIPPED).padStart(4)}`);
      const critics = events.filter((e) => e.type === 'critic');
      console.log(`Critic ${critics.length} 次:${['PASS', 'FAIL', 'ASK_USER'].map((v) => `${v} ${critics.filter((c) => c.verdict === v).length}`).join(' / ')}`);
      const byRole = {};
      for (const c of events.filter((e) => e.type === 'cost')) byRole[c.role ?? '?'] = (byRole[c.role ?? '?'] ?? 0) + c.usd;
      console.log(`花費:${Object.entries(byRole).map(([k, v]) => `${k} $${v.toFixed(2)}`).join(' / ') || '無紀錄'}`);
      return 0;
    }
    default:
      console.error(`不認識的指令 ${cmd}\n\n${HELP}`);
      return 1;
  }
}

// ------------------------------------------------------------------ v4.6 dlm account

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

function rolesUsing(root) {
  const out = {};
  let config;
  try { config = loadConfig(root); } catch { return out; }
  for (const role of ROLES) for (const n of config.agents[role]?.accounts ?? []) (out[n] ??= []).push(role);
  return out;
}

function accountCommand(root, pos, flags) {
  const [sub, name, list] = pos;
  switch (sub) {
    case 'add': {
      const a = addAccount(name, { cli: need(flags, 'cli', 'claude 或 codex'), plan: flags.plan === true ? null : flags.plan, home: flags.home && flags.home !== true ? resolve(flags.home) : null, maxParallel: flags['max-parallel'] === true ? null : flags['max-parallel'] });
      console.log(`✓ 帳號 ${a.name}(${cliOf(a.cli).label}${a.plan ? ` · ${a.plan}` : ''})登記好了,目錄 ${a.home}`);
      console.log(`下一步:node tools/dlm.mjs account login ${a.name}`);
      return 0;
    }
    case 'login': {
      const a = getAccount(need({ name }, 'name', 'dlm account login <name>'));
      if (!process.stdin.isTTY) throw new DlmError(`登入要開瀏覽器,請在終端機自己跑:node tools/dlm.mjs account login ${a.name}`);
      const c = cliOf(a.cli);
      console.log(`用 ${c.label} 登入帳號 ${a.name}(目錄 ${a.home})。登入你要給這個帳號用的那個訂閱。`);
      const env = { ...process.env, ...accountEnv(a) };
      for (const [k, v] of Object.entries(env)) if (v === '') delete env[k];
      const r = spawnSync(c.login, { shell: true, stdio: 'inherit', env });
      const st = loginStatus(a);
      console.log(st.ok ? `✓ ${a.name} 已登入:${st.detail}` : `✗ ${a.name} 還沒登入(${st.detail})`);
      return st.ok ? 0 : (r.status || 1);
    }
    case 'list': {
      const rows = accountRows(root, { login: true });
      if (flags.json) { console.log(JSON.stringify({ file: accountsFile(), accounts: rows }, null, 2)); return 0; }
      if (!rows.length) { console.log(`還沒登記帳號(${accountsFile()})。dlm account add max-a --cli claude --plan max`); return 0; }
      for (const r of rows) {
        console.log(`${r.login.ok ? '✓' : '✗'} ${r.name.padEnd(14)} ${r.cli.padEnd(6)} ${(r.plan ?? '').padEnd(8)} ${r.login.ok ? r.login.detail : '沒登入'}`);
        console.log(`    所有專案近5小時 ${r.dispatches_5h} 次派工、正在跑 ${r.open}${r.max_parallel ? `/${r.max_parallel}` : ''} · 近7天 ${r.dispatches_7d} 次 $${r.usd_7d} · ${r.limited_until ? `冷卻到 ${fmtTime(r.limited_until)}` : '可用'} · ${r.roles.length ? `這個專案用在 ${r.roles.join('、')}` : '這個專案沒用它'}`);
      }
      return 0;
    }
    case 'set': {
      const a = updateAccount(need({ name }, 'name', 'dlm account set <name> [--plan X] [--max-parallel N|none]'), {
        ...(flags.plan !== undefined ? { plan: flags.plan === true || flags.plan === 'none' ? null : flags.plan } : {}),
        ...(flags['max-parallel'] !== undefined ? { maxParallel: flags['max-parallel'] === 'none' ? null : flags['max-parallel'] } : {}),
      });
      console.log(`✓ ${a.name}:${a.plan ?? '(沒寫方案)'} · 同時上限 ${a.max_parallel ?? '不限'}`);
      return 0;
    }
    case 'rm': {
      const r = removeAccount(need({ name }, 'name', 'dlm account rm <name>'));
      console.log(`已移除 ${r.removed}${r.home_deleted ? '(連同 dlm 建的登入目錄)' : '(你指定的目錄沒動)'}`);
      const using = rolesUsing(root)[r.removed];
      if (using) console.log(`提醒:dlm.config.json 的 ${using.join('、')} 還在用它,派工時會報錯;用 dlm account use 改掉`);
      return 0;
    }
    case 'use': {
      const spec = need({ list }, 'list', `dlm account use ${name} a,b(none = 不用帳號)`);
      const r = setRole(root, { role: name, accounts: spec === 'none' ? [] : spec.split(','), ...(flags.model && flags.model !== true ? { model: flags.model } : {}) });
      console.log(r.accounts.length ? `✓ ${r.role} 輪流用 ${r.accounts.join('、')}${r.model ? `(模型 ${r.model})` : ''}` : `✓ ${r.role} 不用帳號了${r.role === 'verifier' && r.backend === 'none' ? '(Verifier 關掉)' : ''}`);
      if (r.custom_cmd && r.accounts.length) {
        const all = loadAccounts();
        console.log(`  注意:${r.role} 有自己寫的 cmd,會照你的指令跑,只是帶上帳號的環境變數(${[...new Set(r.accounts.map((n) => cliOf(all[n].cli).homeEnv))].join('、')})。`);
      }
      if (r.not_logged_in.length) console.log(`  還沒登入:${r.not_logged_in.map((n) => `dlm account login ${n}`).join(';')}`);
      return 0;
    }
    default:
      throw new DlmError(`dlm account add|login|list|use|rm\n${commandHelp('account')}`);
  }
}

// ------------------------------------------------------------------ v4.7 dlm project / dlm mcp

function projectCommand(pos, flags) {
  const [sub, arg] = pos;
  switch (sub) {
    case 'add': {
      const p = addProject(arg ?? process.cwd(), { name: flags.name && flags.name !== true ? flags.name : null });
      console.log(p.existed ? `已經登記過了:${p.name} ${p.path}` : `✓ 已登記 ${p.name} ${p.path}`);
      return 0;
    }
    case 'list': {
      const rows = Object.entries(loadProjects()).map(([name, p]) => ({ name, path: p.path, exists: isDlmProject(p.path), version: isDlmProject(p.path) ? projectVersion(p.path) : null }));
      if (flags.json) { console.log(JSON.stringify({ projects: rows }, null, 2)); return 0; }
      if (!rows.length) { console.log('還沒登記專案。dlm project add <目錄>(dlm init 建的會自動登記)'); return 0; }
      for (const r of rows) console.log(`${r.exists ? '✓' : '✗'} ${r.name.padEnd(20)} ${(r.version ?? '?').padEnd(7)} ${r.path}${r.exists ? '' : '(不見了)'}`);
      return 0;
    }
    case 'rm': {
      const r = removeProject(need({ name: arg }, 'name', 'dlm project rm <name>'));
      console.log(`已從清單拿掉 ${r.removed}(${r.path} 的檔案沒動)`);
      return 0;
    }
    default:
      throw new DlmError(`dlm project add|list|rm\n${commandHelp('project')}`);
  }
}

const DLM_PATH = fileURLToPath(import.meta.url);

function mcpSnippets() {
  const json = { mcpServers: { dlm: { command: 'node', args: [DLM_PATH, 'mcp'] } } };
  return {
    claude: `claude mcp add --scope user dlm -- node ${JSON.stringify(DLM_PATH)} mcp`,
    json: JSON.stringify(json, null, 2),
    codex: `[mcp_servers.dlm]\ncommand = "node"\nargs = [${JSON.stringify(DLM_PATH)}, "mcp"]`,
  };
}

/**
 * Before 4.8.0 the server was registered as dp. Remove that registration when it still runs a tools/dp.mjs,
 * so the same tools don't show up twice (dp_* from the old copy and dlm_* from this one). Returns a line to print, or null.
 */
function removeLegacyMcp(cli, removeArgsList) {
  const g = spawnSync(cli, ['mcp', 'get', 'dp'], { encoding: 'utf8' });
  const out = `${g.stdout}${g.stderr}`;
  if (g.error || g.status !== 0 || !/tools[\\/]dp\.mjs/.test(out)) return null;
  // `claude mcp get` also finds a project or local entry; remove from the scope it reports, not just user
  const scope = /Scope:\s*(User|Local|Project)/i.exec(out)?.[1]?.toLowerCase();
  const tries = scope && cli === 'claude' ? [['mcp', 'remove', '--scope', scope, 'dp']] : removeArgsList;
  for (const args of tries) {
    if (spawnSync(cli, args, { encoding: 'utf8' }).status === 0) return `✓ 拿掉了舊的 dp MCP server(4.8.0 以前的名字,指到 tools/dp.mjs)`;
  }
  return `⚠ 舊的 dp MCP server 還在(指到 tools/dp.mjs),沒能自動拿掉:${cli} mcp remove${scope ? ` --scope ${scope}` : ''} dp`;
}

function mcpCommand(root, pos, flags) {
  const sn = mcpSnippets();
  const where = '(用的是這一份 dlm:' + DLM_PATH + ';之後要換版本,從新版的目錄再裝一次)';
  if (pos[0] === 'tools') {
    for (const t of toolList()) console.log(`${t.name.padEnd(24)} ${t.annotations.readOnlyHint ? '讀' : '寫'}  ${t.title}`);
    return 0;
  }
  if (pos[0] === 'config') {
    console.log(`Claude Code(所有專案共用):\n  ${sn.claude}\n\nCursor(~/.cursor/mcp.json)、Claude Desktop、其他吃 mcpServers JSON 的工具:\n${sn.json}\n\nCodex(~/.codex/config.toml):\n${sn.codex}`);
    return 0;
  }
  if (pos[0] === 'install') {
    const client = flags.client && flags.client !== true ? flags.client : 'claude';
    if (client !== 'project' && !existsSync(join(dirname(DLM_PATH), '..', 'payload'))) {
      throw new DlmError(`這一份 dlm(${DLM_PATH})是裝在專案裡的副本,沒有 payload,dlm_init_project / dlm_upgrade_project 會不能用。\n`
        + '請從 dev-loop-mcp 的目錄裝:node <dev-loop-mcp>/tools/dlm.mjs mcp install(只想給這個專案用:--client project)');
    }
    if (client === 'project') {
      console.log(mergeMcpJson(root) ? '✓ 已把 dlm 加進這個專案的 .mcp.json(重開 Claude Code 後 /mcp 會看到 dlm)' : '.mcp.json 裡已經有 dlm 了');
      return 0;
    }
    if (client === 'claude') {
      const r = spawnSync('claude', ['mcp', 'add', '--scope', 'user', 'dlm', '--', 'node', DLM_PATH, 'mcp'], { encoding: 'utf8' });
      if (r.error?.code === 'ENOENT') {
        console.log(`沒找到 claude 指令。裝好 Claude Code 後跑:\n  ${sn.claude}\n其他工具的寫法:dlm mcp config`);
        return 1;
      }
      const out = `${r.stdout}${r.stderr}`.trim();
      const legacy = () => removeLegacyMcp('claude', [['mcp', 'remove', '--scope', 'user', 'dp'], ['mcp', 'remove', 'dp']]);
      if (r.status !== 0) {
        if (/already exists/i.test(out)) {
          console.log(`Claude Code 已經有叫 dlm 的 MCP server 了。要換成這一份:claude mcp remove --scope user dlm,再跑一次 dlm mcp install`);
          const l = legacy();
          if (l) console.log(l);
          return 0;
        }
        throw new DlmError(`claude mcp add 失敗:${out}`);
      }
      console.log(`✓ 已裝進 Claude Code(user scope,所有專案共用)${where}`);
      const l = legacy();
      if (l) console.log(l);
      console.log('重開 Claude Code 後打 /mcp 會看到 dlm;試著說「我的 dlm 專案現在怎麼樣?」或用 /mcp__dlm__new-project');
      return 0;
    }
    if (client === 'cursor') {
      const p = join(homedir(), '.cursor', 'mcp.json');
      const cur = existsSync(p) ? readJson(p) : {};
      cur.mcpServers ??= {};
      // the old dp entry (before 4.8.0) goes away when it runs a tools/dp.mjs
      const legacy = cur.mcpServers.dp && /tools[\\/]dp\.mjs/.test(JSON.stringify(cur.mcpServers.dp));
      if (legacy) delete cur.mcpServers.dp;
      if (cur.mcpServers.dlm && !legacy) { console.log(`${p} 裡已經有 dlm 了`); return 0; }
      cur.mcpServers.dlm ??= { command: 'node', args: [DLM_PATH, 'mcp'] };
      ensureDir(dirname(p));
      writeJson(p, cur);
      console.log(`✓ 已加進 ${p}${legacy ? '(也拿掉了舊的 dp)' : ''}${where}`);
      return 0;
    }
    if (client === 'codex') {
      const r = spawnSync('codex', ['mcp', 'add', 'dlm', '--', 'node', DLM_PATH, 'mcp'], { encoding: 'utf8' });
      if (r.status === 0) {
        console.log(`✓ 已裝進 Codex${where}`);
        const l = removeLegacyMcp('codex', [['mcp', 'remove', 'dp']]);
        if (l) console.log(l);
        return 0;
      }
      console.log(`沒辦法自動裝(${r.error?.code === 'ENOENT' ? '沒找到 codex 指令' : `${r.stdout}${r.stderr}`.trim().slice(0, 200)})。把這段加進 ~/.codex/config.toml:\n${sn.codex}`);
      return 1;
    }
    throw new DlmError('--client 是 claude、cursor、codex 或 project');
  }
  if (pos.length) throw new DlmError('dlm mcp [install|config|tools]');
  if (process.stdin.isTTY) console.error('dlm mcp 是給 Claude Code 等工具啟動的 stdio server;要安裝請跑 dlm mcp install。(Ctrl-C 離開)');
  return serveMcp({ cwd: root });
}

main().then((code) => process.exit(code ?? 0), (e) => {
  if (e instanceof DlmError) {
    console.error(`✗ ${e.message}`);
    process.exit(e.code || 1);
  }
  console.error(e);
  process.exit(1);
});

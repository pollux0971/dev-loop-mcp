// v4.7 操作層:CLI、HTTP API(dp hub)、`dp op` 共用的那一份邏輯。每個操作吃一個 JSON 物件、回一個 JSON 物件。
// CLI 把結果印成給人看的字;API 原樣回 JSON。
//
// 一個專案的操作永遠由「那個專案自己的 tools/dp.mjs」執行(dp hub 透過 `dp op` 呼叫),
// 所以好幾個專案裝的 dp 版本不一樣也不會互相讀錯格式。
import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLES, globalUsage, loadAccounts, loginStatus } from './accounts.mjs';
import { criticConfigured } from './agents.mjs';
import { loadConfig } from './config.mjs';
import { dashboardData } from './dashboard.mjs';
import { loadDag } from './dag.mjs';
import { doctor } from './doctor.mjs';
import { commitAll } from './git.mjs';
import { confirmE2e, decide, inboxData, resume, show, unblockByUser } from './inbox.mjs';
import { proposeBundle, proposeFeature } from './intake.mjs';
import { append, readEvents } from './ledger.mjs';
import { Ctx, commitState, haltWorkers, tick } from './orchestrator.mjs';
import { renderAll, writeRendered } from './render.mjs';
import { BASELINE, onboard, recordBaseline } from './brownfield.mjs';
import { CLAUDE_CRITIC_CMD, CLAUDE_VERIFIER_CMD, CLAUDE_WORKER_CMD, setup } from './setup.mjs';
import { computeSnapshot } from './snapshot.mjs';
import { replay } from './state.mjs';
import { DpError, ensureDir, lockHolder, pidAlive, readJson, tryLock } from './util.mjs';

const DP = fileURLToPath(new URL('../dp.mjs', import.meta.url));
/** 這一份 dp 的版本:dev-paradigm-mcp repo 裡看 VERSION;裝進專案的看 .dp-install.json。 */
function readVersion() {
  try { return readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim(); } catch { /* 裝進專案的沒有 VERSION */ }
  try { return JSON.parse(readFileSync(new URL('../../.dp-install.json', import.meta.url), 'utf8')).version; } catch { return 'unknown'; }
}
export const VERSION = readVersion();

/** 寫了事件就重新產生 STATUS / DECISIONS(commit 交給下一個 tick)。 */
export function refreshRendered(root) {
  const dag = loadDag(root);
  const events = readEvents(root);
  writeRendered(root, renderAll(root, dag, replay(events, dag), events));
}

const text = (v) => (typeof v === 'string' ? v : '');
const verbatimOf = (a) => (a.verbatim === true ? '' : text(a.verbatim));

// ------------------------------------------------------------------ 背景迴圈

export const runLockPath = (root) => join(root, '.dp', 'run.lock');
export const runStopPath = (root) => join(root, '.dp', 'run.stop');

export function loopPid(root) {
  const held = lockHolder(runLockPath(root));
  if (held) return held;
  const legacy = join(root, '.dp', 'run.pid');
  if (!existsSync(legacy)) return null;
  const pid = Number(readFileSync(legacy, 'utf8').trim());
  return pidAlive(pid) ? pid : null;
}

export function loopStatus(root) {
  const pid = loopPid(root);
  return { running: !!pid, pid: pid ?? null, stopping: !!pid && existsSync(runStopPath(root)) };
}

/** 在背景啟動 dp run;等到它真的拿到鎖才回(最多 10 秒),所以緊接著再呼叫一次一定是「已經在跑」。 */
export async function loopStart(root, { interval = 60, maxTicks = null } = {}) {
  const running = loopPid(root);
  if (running) throw new DpError(`背景迴圈已經在跑(pid ${running});同一個 repo 只能有一個`, 2);
  const sec = Number(interval);
  if (!(sec >= 1 && sec <= 3600)) throw new DpError('interval 要是 1–3600 秒');
  ensureDir(join(root, '.dp'));
  if (existsSync(runStopPath(root))) unlinkSync(runStopPath(root));
  const args = [DP, 'run', '--root', root, '--interval', String(sec)];
  if (maxTicks) args.push('--max-ticks', String(maxTicks));
  const out = openSync(join(root, '.dp', 'run.log'), 'a');
  const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ['ignore', out, out] });
  let exited = null;
  child.on('exit', (code) => { exited = code ?? 'signal'; });
  child.unref();
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const pid = loopPid(root);
    if (pid === child.pid) return { started: true, pid, log: '.dp/run.log' };
    if (pid) throw new DpError(`背景迴圈已經在跑(pid ${pid});同一個 repo 只能有一個`, 2);
    if (exited === 0) return { started: true, pid: child.pid, log: '.dp/run.log', finished: true };
    if (exited !== null) {
      const log = readFileSync(join(root, '.dp', 'run.log'), 'utf8').trim().split('\n').slice(-5).join('\n');
      throw new DpError(`背景迴圈一啟動就結束了(exit ${exited}):${log}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { started: true, pid: child.pid, log: '.dp/run.log', note: '已啟動,但 10 秒內還沒看到它拿到鎖;看 .dp/run.log' };
}

/** 請背景迴圈在這一輪做完後結束(不會在合併到一半時被砍)。wait 秒內等它真的結束。 */
export async function loopStop(root, { wait = 0 } = {}) {
  const pid = loopPid(root);
  if (!pid) return { stopped: true, was_running: false };
  ensureDir(join(root, '.dp'));
  writeFileSync(runStopPath(root), `${new Date().toISOString()}\n`);
  const until = Date.now() + Math.min(Number(wait) || 0, 120) * 1000;
  while (Date.now() < until && loopPid(root)) await new Promise((r) => setTimeout(r, 200));
  const still = loopPid(root);
  return { stopped: !still, was_running: true, pid, ...(still ? { note: '已要求結束;這一輪做完就會停' } : {}) };
}

// ------------------------------------------------------------------ 帳號與角色

export function projectRoles(root) {
  const config = loadConfig(root);
  return Object.fromEntries(ROLES.map((r) => {
    const c = config.agents[r] ?? {};
    return [r, { accounts: c.accounts ?? [], model: c.model ?? null, custom_cmd: !!c.cmd, ...(r === 'verifier' ? { backend: c.backend } : {}) }];
  }));
}

/** 這台電腦的帳號 + 所有專案加起來的用量;root 有給就附上這個專案哪個角色在用。login = 順便問 CLI 登入狀態(慢)。 */
export function accountRows(root = null, { login = false } = {}) {
  const accounts = loadAccounts();
  const usage = globalUsage();
  let roles = {};
  if (root) {
    try { for (const [r, c] of Object.entries(projectRoles(root))) for (const n of c.accounts) (roles[n] ??= []).push(r); } catch { roles = {}; }
  }
  const now = Date.now();
  return Object.entries(accounts).map(([n, a]) => {
    const u = usage[n] ?? {};
    return {
      name: n, cli: a.cli, plan: a.plan ?? null, home: a.home, max_parallel: a.max_parallel ?? null,
      ...(login ? { login: loginStatus({ name: n, ...a }) } : {}),
      roles: roles[n] ?? [], open: u.open ?? 0, dispatches_5h: u.dispatches_5h ?? 0, dispatches_7d: u.dispatches_7d ?? 0,
      usd_5h: u.usd_5h ?? 0, usd_7d: u.usd_7d ?? 0,
      limited_until: u.limited_until && Date.parse(u.limited_until) > now ? u.limited_until : null, last_used: u.last_used ?? null,
    };
  });
}

/** 設定一個角色輪流用哪些帳號(空陣列 = 不用帳號)、模型(null / '' = 拿掉)。改 dp.config.json 並 commit。 */
export function setRole(root, { role, accounts = [], model } = {}) {
  if (!ROLES.includes(role)) throw new DpError(`角色是 ${ROLES.join(' / ')} 其中一個`);
  if (!Array.isArray(accounts)) throw new DpError('accounts 要是陣列');
  const pool = accounts.map((s) => String(s).trim()).filter(Boolean);
  const registry = loadAccounts();
  const missing = pool.filter((n) => !registry[n]);
  if (missing.length) throw new DpError(`這台電腦沒有帳號 ${missing.join(', ')}(dp account list)`);
  const p = join(root, 'dp.config.json');
  const before = readFileSync(p, 'utf8');
  const raw = JSON.parse(before);
  raw.agents ??= {};
  const cur = { ...(raw.agents[role] ?? {}), accounts: pool };
  if (!pool.length) delete cur.accounts;
  if (model === null || model === '' || model === 'none') delete cur.model;
  else if (typeof model === 'string') cur.model = model;
  // 原本是 dp setup 寫的 Claude 預設指令 → 拿掉,改用帳號那個 CLI 的預設(才換得了 CLI、帶得進 model)
  const defaults = { worker: CLAUDE_WORKER_CMD, critic: CLAUDE_CRITIC_CMD, verifier: CLAUDE_VERIFIER_CMD };
  if (pool.length && (cur.cmd === defaults[role] || cur.cmd === 'claude -p --output-format json')) cur.cmd = null;
  if (!pool.length && !cur.cmd) {
    if (role === 'worker') throw new DpError('worker 不用帳號的話要有 agents.worker.cmd(重跑 dp setup 會填 Claude 的預設)');
    if (role === 'verifier') cur.backend = 'none';
  }
  if (role === 'verifier' && pool.length) cur.backend = 'cmd';
  raw.agents[role] = cur;
  writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`);
  try { loadConfig(root); } catch (e) { writeFileSync(p, before); throw new DpError(`設定不合法,已還原:${e.message}`); }
  const commit = commitAll(root, ['dp.config.json'], `dp account use ${role} ${pool.join(',') || 'none'}`);
  const notLoggedIn = pool.filter((n) => !loginStatus({ name: n, ...registry[n] }).ok);
  return { role, accounts: pool, model: cur.model ?? null, custom_cmd: !!cur.cmd, backend: cur.backend ?? null, commit, not_logged_in: notLoggedIn };
}

/**
 * v4.7.3 改使用者親口決定的設定:自治等級、每日預算、同時幾個 worker。只改有給的欄位,改 dp.config.json 並 commit(訊息帶原話)。
 * 以前只能重跑 dp setup:MCP 那邊的 AI 寫不了檔,重跑 setup 又會順手改到別的設定(實測:為了把預算從 $3 改成 $8,
 * AI 先停背景迴圈、重跑 setup,worker 的帳號被換成固定指令,再用 setRole 改回來)。
 */
export const SETTING_LIMITS = { autonomy_level: [0, 2], daily_usd: [0.01, 10000], parallel: [1, 20] };
export function setSettings(root, { autonomy_level, daily_usd, parallel, verbatim } = {}) {
  const asked = { autonomy_level, daily_usd, parallel };
  const changes = {};
  for (const [k, v] of Object.entries(asked)) {
    if (v === undefined || v === null) continue;
    const [lo, hi] = SETTING_LIMITS[k];
    const ok = typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi && (k === 'daily_usd' || Number.isInteger(v));
    if (!ok) throw new DpError(`${k} 要是 ${lo}–${hi} 的${k === 'daily_usd' ? '數字' : '整數'}(收到 ${JSON.stringify(v)})`);
    changes[k] = v;
  }
  if (!Object.keys(changes).length) throw new DpError('沒有要改的:給 autonomy_level、daily_usd、parallel 其中至少一個');
  const cur = loadConfig(root);
  const was = { autonomy_level: cur.autonomy.level, daily_usd: cur.budget.daily_usd, parallel: cur.caps.parallel };
  const p = join(root, 'dp.config.json');
  const before = readFileSync(p, 'utf8');
  const raw = JSON.parse(before);
  if ('autonomy_level' in changes) raw.autonomy = { ...(raw.autonomy ?? {}), level: changes.autonomy_level };
  if ('daily_usd' in changes) raw.budget = { ...(raw.budget ?? {}), daily_usd: changes.daily_usd };
  if ('parallel' in changes) raw.caps = { ...(raw.caps ?? {}), parallel: changes.parallel };
  writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`);
  let next;
  try { next = loadConfig(root); } catch (e) { writeFileSync(p, before); throw new DpError(`設定不合法,已還原:${e.message}`); }
  const summary = Object.keys(changes).map((k) => `${k} ${was[k]} → ${changes[k]}`).join(', ');
  const said = verbatimOf({ verbatim });
  const commit = commitAll(root, ['dp.config.json'], `dp settings: ${summary}${said ? `\n\n使用者原話:${said}` : ''}`);
  const notes = [];
  if (changes.autonomy_level === 2 && !criticConfigured(next)) notes.push('L2 沒設 Critic:Verifier 沒把握的交件照樣來問你(dp_set_role critic 設帳號,或重跑 setup 開 Critic)');
  return { changed: Object.fromEntries(Object.keys(changes).map((k) => [k, { from: was[k], to: changes[k] }])), commit, ...(notes.length ? { notes } : {}) };
}

// ------------------------------------------------------------------ 專案的操作

export function status(root) {
  const ctx = new Ctx(root);
  const s = computeSnapshot({ root, config: ctx.config, dag: ctx.dag, state: ctx.state });
  return {
    project: basename(root), root, version: VERSION, mode: ctx.config.project?.mode ?? 'greenfield',
    ledger_seq: ctx.state.maxSeq, last_event_ts: ctx.events.at(-1)?.ts ?? null,
    ...s, loop: loopStatus(root),
    awaiting_user: { decisions: s.awaiting_user.decisions.length, e2e: s.awaiting_user.e2e.length, halted: !!s.halted },
  };
}

export function events(root, { after = 0, limit = 200, types = null } = {}) {
  const all = readEvents(root);
  const want = types ? new Set(Array.isArray(types) ? types : String(types).split(',')) : null;
  const list = all.filter((e) => e.seq > Number(after || 0) && (!want || want.has(e.type)));
  const n = Math.max(1, Math.min(Number(limit) || 200, 2000));
  // mac / prev_hash 是帳本內部的簽章,API 不外流
  const clean = list.slice(0, n).map(({ mac: _m, prev_hash: _p, chain_start: _c, ...e }) => e);
  return { events: clean, last_seq: all.at(-1)?.seq ?? 0, more: list.length > n };
}

export function decideOp(root, { ref, choice, verbatim } = {}) {
  if (!ref || !choice) throw new DpError('要 ref 與 choice');
  let refs = (Array.isArray(ref) ? ref : String(ref).split(',')).map((r) => String(r).trim()).filter(Boolean);
  if (refs.length === 1 && refs[0] === 'accept:*') {
    const dg = loadDag(root);
    refs = [...replay(readEvents(root), dg).decisions.values()].filter((r) => r.request && !r.answer && r.request.ref.startsWith('accept:')).map((r) => r.request.ref);
    if (!refs.length) throw new DpError('沒有等待合併的決定');
  }
  const recorded = refs.map((r) => ({ ref: r, choice, seq: decide(root, r, choice, verbatimOf({ verbatim })).seq }));
  refreshRendered(root);
  return { recorded };
}

export function haltOp(root, { reason, keep_workers = false } = {}) {
  if (!text(reason).trim()) throw new DpError('要 reason(停機理由或使用者的原話)');
  const seq = append(root, 'dp-cli', 'halt', { reason }).seq;
  let out = { seq, stopped: [], deferred: false, keep_workers: !!keep_workers };
  if (!keep_workers) {
    // 背景迴圈正在 tick 的話,它下一輪看到停機會自己收掉 worker;這裡拿得到鎖就立刻收
    const release = tryLock(join(root, '.dp', 'tick.lock'));
    if (!release) out = { ...out, deferred: true };
    else {
      try {
        const ctx = new Ctx(root);
        const stopped = haltWorkers(ctx);
        commitState(ctx, `dp: 停機,終止 ${stopped.length} 個 worker`);
        out = { ...out, stopped };
      } finally {
        release();
      }
    }
  }
  refreshRendered(root);
  return out;
}

/**
 * 不互動的 dp setup。answers 的 key 就是問題的 id(mode、test_cmd、platform、worker_cmd、verifier、autonomy、critic、
 * budget、parallel、npm_install、commit),沒給的用預設值;npm_install 預設不裝(要下載,幾分鐘)。
 */
export async function setupOp(root, { answers = {} } = {}) {
  const a = { npm_install: 'n', ...Object.fromEntries(Object.entries(answers ?? {}).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? 'y' : 'n') : String(v)])) };
  const asked = {};
  const lines = [];
  const r = await setup(root, {
    log: (l) => lines.push(l),
    ask: async (q) => {
      asked[q.id] = (asked[q.id] ?? 0) + 1;
      if (asked[q.id] > 1 && q.id in a) throw new DpError(`setup 看不懂 answers.${q.id}「${a[q.id]}」:${q.text.split('\n')[0]}`);
      if (asked[q.id] > 2) throw new DpError(`setup 的 ${q.id} 一定要給值:${q.text.split('\n')[0]}`);
      return a[q.id] ?? '';
    },
  });
  const report = await doctor(root);
  return { written: r.written, committed: r.committed, config: { mode: r.config.project?.mode, platform: r.config.platform, autonomy: r.config.autonomy?.level }, doctor: report, log: lines };
}

function brownfieldOp(root, which, { commit = true } = {}) {
  const config = loadConfig(root);
  const lines = [];
  const written = which === 'onboard' ? onboard(root, config, { log: (l) => lines.push(l) }).written : (recordBaseline(root, config, { log: (l) => lines.push(l) }), [BASELINE]);
  const b = readJsonSafe(join(root, BASELINE));
  if (commit) commitAll(root, written, which === 'onboard' ? 'dp onboard:測試基線、AS-IS 草稿、ROADMAP v0' : 'dp baseline:重記測試基線');
  return {
    written, committed: !!commit, mode: config.project?.mode ?? 'greenfield',
    red_gates: (b?.gates ?? []).filter((g) => g.exit !== 0).map((g) => ({ name: g.name, failing: g.failing ?? null })),
    log: lines,
  };
}
const readJsonSafe = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

const done = (root, ev, extra = {}) => { refreshRendered(root); return { seq: ev.seq, ...extra }; };

/** 每個操作:project = 要在專案裡執行;write = 會改東西(API 用 POST / PUT / DELETE)。 */
export const OPS = {
  status: { project: true, fn: (root) => status(root) },
  dashboard: { project: true, fn: (root) => dashboardData(root) },
  inbox: { project: true, fn: (root, a) => inboxData(root, { markSeen: !!a.mark }) },
  inbox_seen: { project: true, write: true, fn: (root) => done(root, append(root, 'dp-cli', 'inbox_viewed', {})) },
  show: { project: true, fn: (root, a) => { if (!a.ref) throw new DpError('要 ref'); return { ref: a.ref, text: show(root, a.ref) }; } },
  events: { project: true, fn: (root, a) => events(root, a) },
  nodes: { project: true, fn: (root) => ({ nodes: dashboardData(root).nodes }) },
  proposals: { project: true, fn: (root) => ({ proposals: dashboardData(root).proposals }) },
  doctor: { project: true, fn: (root) => doctor(root) },
  decide: { project: true, write: true, fn: (root, a) => decideOp(root, a) },
  confirm: {
    project: true, write: true,
    fn: (root, a) => { if (!a.node || typeof a.ok !== 'boolean') throw new DpError('要 node 與 ok(true / false)'); return done(root, confirmE2e(root, a.node, a.ok, verbatimOf(a)), { node: a.node, ok: a.ok }); },
  },
  unblock: { project: true, write: true, fn: (root, a) => { if (!a.node) throw new DpError('要 node'); return done(root, unblockByUser(root, a.node, verbatimOf(a)), { node: a.node }); } },
  resume: { project: true, write: true, fn: (root, a) => done(root, resume(root, verbatimOf(a))) },
  halt: { project: true, write: true, fn: (root, a) => haltOp(root, a) },
  propose_feature: {
    project: true, write: true,
    fn: (root, a) => {
      if (!a.spec || typeof a.spec !== 'object') throw new DpError('要 spec(節點的 JSON 物件)');
      const p = proposeFeature(root, a.spec, a.gherkin ? String(a.gherkin) : null);
      refreshRendered(root);
      return { proposal_id: p.id, decide_ref: `node:${p.id}`, ...(p.warnings.length ? { warnings: p.warnings } : {}) };
    },
  },
  propose_bundle: {
    project: true, write: true,
    fn: (root, a) => {
      if (!a.bundle || typeof a.bundle !== 'object') throw new DpError('要 bundle');
      const p = proposeBundle(root, a.bundle);
      refreshRendered(root);
      return { proposal_id: p.id, decide_ref: `node:${p.id}`, ...(p.warnings.length ? { warnings: p.warnings } : {}) };
    },
  },
  tick: {
    project: true, write: true,
    fn: async (root) => {
      const lines = [];
      const r = await tick(root, { log: (l) => lines.push(l) });
      return { ok: !!r.ok, busy: !!r.busy, reason: r.reason ?? null, log: lines.slice(-50), ...(r.snapshot ? { counts: r.snapshot.counts } : {}) };
    },
  },
  roles: { project: true, fn: (root) => ({ roles: projectRoles(root) }) },
  set_role: { project: true, write: true, fn: (root, a) => setRole(root, a) },
  set_settings: { project: true, write: true, fn: (root, a) => setSettings(root, a) },
  loop: { project: true, fn: (root) => loopStatus(root) },
  loop_start: { project: true, write: true, fn: (root, a) => loopStart(root, { interval: a.interval ?? 60, maxTicks: a.max_ticks ?? null }) },
  loop_stop: { project: true, write: true, fn: (root, a) => loopStop(root, { wait: a.wait ?? 0 }) },
  setup: { project: true, write: true, fn: (root, a) => setupOp(root, a) },
  onboard: { project: true, write: true, fn: (root, a) => brownfieldOp(root, 'onboard', a) },
  baseline: { project: true, write: true, fn: (root, a) => brownfieldOp(root, 'baseline', a) },
  accounts: { project: false, fn: (root, a) => ({ accounts: accountRows(root, { login: !!a.login }) }) },
};

/** 執行一個操作。回 { ok: true, result } 或 { ok: false, error, status }(status 是給 HTTP 用的狀態碼)。 */
export async function runOp(name, root, args = {}) {
  const op = OPS[name];
  if (!op) return { ok: false, error: `沒有這個操作:${name}`, status: 404 };
  if (op.project && !existsSync(join(root, 'dp.config.json'))) return { ok: false, error: `${root} 不是 dp 專案(沒有 dp.config.json)`, status: 404 };
  try {
    return { ok: true, result: await op.fn(root, args ?? {}) };
  } catch (e) {
    if (e instanceof DpError) return { ok: false, error: e.message, status: e.code === 2 ? 409 : 400 };
    return { ok: false, error: String(e?.stack ?? e), status: 500 };
  }
}


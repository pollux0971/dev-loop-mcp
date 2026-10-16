// orchestrator:取代 v1 的「接線 agent」與「整合/清樹 agent」。純 script,不做判斷。
// 每一步都由 ledger 狀態決定,所以任何時候中斷後重跑都得到同樣結果(冪等)。
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { globalUsage, isAccountLimit, limitedUntil, logAccountEvent, pickAccount } from './accounts.mjs';
import { callAgent, criticConfigured, launchWorker, parseCost, workerConfigured } from './agents.mjs';
import { acceptRoute, escalationRoute, spawnRoute } from './autonomy.mjs';
import { BUILD_CONFIG_PATHS, loadConfig } from './config.mjs';
import { capabilityOf, contractMajor, getNode, loadDag, saveDag, scopeContained, validateDag, withSpawn } from './dag.mjs';
import { readScenarios } from './gherkin.mjs';
import { applyApprovedProposals } from './intake.mjs';
import { NO_TEST_GATE, hasTestGate, runGates } from './gates.mjs';
import { pendingFeatures, writePendingFeatures } from './pending.mjs';
import {
  addWorktree, behindCount, changedBetween, commitAll, currentBranch, deleteBranch, dirtyTracked, gitConfigFingerprint,
  headSha, isAncestor, mergeNoFf, readConfigBaseline, removeWorktree, syncWithMain, tag, withMergeTree, writeConfigBaseline, git,
} from './git.mjs';
import { append, readEvents, verifyChain } from './ledger.mjs';
import { assemblePrompt, dataFile, readRolePrompt } from './prompt.mjs';
import { renderAll, writeRendered } from './render.mjs';
import { assertValid, validate } from './schema.mjs';
import { criticSchema, envelopeSchema, reportSchema } from './schemas.mjs';
import { computeSnapshot } from './snapshot.mjs';
import { characterizes, pipelineFor, replay } from './state.mjs';
import {
  atomicWrite, ensureDir, globPrefix, lockHolder, pidAlive, readJson, sha256, slug, stableJson, tail, tryLock, writeJson,
} from './util.mjs';
import { runVerify, summarize } from './verify/index.mjs';
import {
  copyTree, diffManifest, killSandboxed, linkDeps, nodeModulesFingerprint, removeTree, scratchCopy, treeManifest,
} from './sandbox.mjs';
import { hostExecutor } from './verify/script-checks.mjs';
import { runArgv } from './util.mjs';

export const STATE_PATHS = ['ledger', 'dag.json', 'STATUS.md', 'DECISIONS.md', 'standalone.json'];

/** 因 git 設定被改而停機時,halt 的 reason 以此開頭;使用者 resume 時 dlm 才會把現在的設定記成新基準。 */
export const GIT_CONFIG_HALT = '[git-config]';

export class Ctx {
  constructor(root, log = () => {}) {
    this.root = root;
    this.log = log;
    this.config = loadConfig(root);
    this.refresh();
  }

  refresh() {
    this.dag = loadDag(this.root);
    this.events = readEvents(this.root);
    this.state = replay(this.events, this.dag);
  }

  append(actor, type, fields) {
    const d = fields?.dispatch_id ? this.state.dispatches.get(fields.dispatch_id) : null;
    const ev = append(this.root, actor, type, fields);
    this.refresh();
    mirrorAccountEvent(this.root, ev, d);
    return ev;
  }

  dispatchDir(id) {
    const d = join(this.root, 'ledger', 'dispatch', id);
    ensureDir(d);
    return d;
  }
}

/** v4.7:跟帳號有關的事件另外記一份在這台電腦(跨專案選號用,見 accounts.mjs)。 */
function mirrorAccountEvent(root, ev, d) {
  const account = ev.account ?? d?.account ?? null;
  if (ev.type === 'dispatch' && ev.account) logAccountEvent(root, { type: 'dispatch', dispatch_id: ev.dispatch_id, account: ev.account });
  else if (['worker_done', 'worker_blocked', 'worker_failed'].includes(ev.type) && account) {
    logAccountEvent(root, { type: ev.type, dispatch_id: ev.dispatch_id, ...(ev.limited_account ? { limited_account: ev.limited_account, limited_until: ev.limited_until } : {}) });
  } else if (ev.type === 'cost' && account) logAccountEvent(root, { type: 'cost', account, usd: ev.usd, role: ev.role ?? null });
}

export function commitState(ctx, message) {
  writeRendered(ctx.root, renderAll(ctx.root, ctx.dag, ctx.state, ctx.events));
  return commitAll(ctx.root, STATE_PATHS.filter((p) => existsSync(join(ctx.root, p))), message);
}

// ---------------------------------------------------------------- 沙箱副本(worker 不碰 .git)
//
// worker 不在 git worktree 裡施工:dlm 把 worktree 匯出成一份沒有 .git 的副本(.dlm/sandboxes/<dispatch>/),
// worker 只看得到這份。結束後 dlm 在沙箱外比對「副本 vs 派工時的清單」(含被 ignore 的檔),
// 範圍內的變動同步回 worktree、由 dlm commit;碰到 .git、.dlm、node_modules、symlink 的一律記成違規。

// 沙箱副本裡 dlm 自己管理的檔(工單、prompt、report、log),不算 worker 的變動
const SANDBOX_DLM_FILES = ['.dlm/envelope.json', '.dlm/prompt.md', '.dlm/report.json', '.dlm/worker.log'];
const manifestPath = (ctx, id) => join(ctx.root, '.dlm', 'manifests', `${id}.json`);

function prepareSandbox(ctx, wt, dispatchId, envelope, prompt) {
  const sbx = join(ctx.root, '.dlm', 'sandboxes', dispatchId);
  // .mcp.json 不給 worker(v4.6):裡面註冊了 dlm 自己的 MCP,worker 的 CLI 載入它就能替使用者 decide
  copyTree(wt, sbx, { skip: ['.git', 'node_modules', '.dlm', '.mcp.json'] });
  ensureDir(join(sbx, '.dlm'));
  writeJson(join(sbx, '.dlm', 'envelope.json'), envelope);
  atomicWrite(join(sbx, '.dlm', 'prompt.md'), prompt);
  linkDeps(ctx.root, sbx);
  writeJson(manifestPath(ctx, dispatchId), treeManifest(sbx, { skipPaths: SANDBOX_DLM_FILES }));
  return sbx;
}

/** worker 結束後:比對副本、同步範圍內的變動、dlm commit。回傳 { changed, violations }。 */
function syncSandbox(ctx, d, message) {
  const before = readJson(manifestPath(ctx, d.dispatch_id), {});
  const after = treeManifest(d.sandbox, { skipPaths: SANDBOX_DLM_FILES });
  const changed = diffManifest(before, after);
  const violations = [];
  const safe = [];
  for (const p of changed) {
    if (p === '.git' || p.startsWith('.git/')) violations.push(`${p}(在副本裡建立 .git)`);
    else if (p.startsWith('.dlm/')) violations.push(`${p}(寫到 dlm 的工作目錄)`);
    else if (p === 'node_modules/' || p.startsWith('node_modules/')) violations.push(`${p}(把 node_modules 換掉了)`);
    else if (String(after[p] ?? '').startsWith('link:')) violations.push(`${p}(建立 symlink,可能指到範圍外)`);
    else safe.push(p);
  }
  if (d.nm_fingerprint && nodeModulesFingerprint(ctx.root) !== d.nm_fingerprint) {
    violations.push('node_modules/(根目錄的依賴在施工期間被改了,例如測試框架被換掉)');
  }
  for (const p of safe) {
    const src = join(d.sandbox, p);
    const dst = join(d.worktree, p);
    if (p in after) {
      ensureDir(dirname(dst));
      rmSync(dst, { recursive: true, force: true });
      copyFileSync(src, dst);
    } else {
      rmSync(dst, { recursive: true, force: true });
    }
  }
  if (safe.length) {
    // -f:被 ignore 的檔也要進 commit,這樣 paths 檢查才看得到(worker 寫到 dist/ 之類的地方不會被漏掉)
    git(d.worktree, `add -A -f -- ${safe.map((x) => `'${x.replace(/'/g, `'\\''`)}'`).join(' ')}`);
    const staged = git(d.worktree, 'diff --cached --quiet', { allowFail: true });
    if (staged.code !== 0) git(d.worktree, `-c user.name=dlm -c user.email=dlm@localhost commit --quiet -m '${message.replace(/'/g, '')}'`);
  }
  return { changed, violations };
}

function cleanupSandbox(ctx, d) {
  if (!d.sandbox) return;
  removeTree(d.sandbox);
  try { unlinkSync(manifestPath(ctx, d.dispatch_id)); } catch { /* 已刪 */ }
}

// ---------------------------------------------------------------- harvest

// 從 worker log 尾巴辨識基礎設施失敗(限流、5xx、過載、連線)。拿不準就當 quality:寧可多算一次嘗試,
// 也不要把 worker 自己的問題當成網路問題無限重派。
const INFRA_LOG = new RegExp([
  '\\b429\\b', 'too many requests', 'rate[ _-]?limit', 'overloaded', 'insufficient_quota', 'quota exceeded',
  '\\b(?:500|502|503|504|529)\\b[^\\n]{0,40}(?:error|internal|gateway|unavailable|timeout|overloaded)',
  '(?:status|http|code)[^\\n]{0,20}\\b5\\d\\d\\b', 'service unavailable', 'api_error',
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'socket hang up',
  'request timed out', 'connection (?:timed out|reset|refused)',
].join('|'), 'i');

// 沒登入 / 金鑰錯:重試幾次都一樣,不退避、直接停機請你處理(放在 infra 前面判斷,因為這類輸出常同時帶 api_error)
const AUTH_LOG = /not logged in|please run \/login|invalid (?:x-)?api[ _-]?key|authentication_error|\b401\b[^\n]{0,40}(?:unauthori[sz]ed|auth)|missing api key|no api key|OAuth token has expired/i;

/** 'auth' | 'infra' | 'quality'。auth 在帳本裡記成 infra(不算 worker 的嘗試),但會立刻停機。 */
export function classifyFailure(logText) {
  const t = tail(logText ?? '', 4000);
  if (AUTH_LOG.test(t)) return 'auth';
  // v4.6:訂閱額度用完(usage limit reached / weekly limit / resets 3pm)也是基礎設施,換帳號或等重置就好
  return INFRA_LOG.test(t) || isAccountLimit(t) ? 'infra' : 'quality';
}

/** worker 的工作目錄:新流程是沙箱副本,舊的在途派工是 worktree 本身。 */
const workDir = (d) => d.sandbox ?? d.worktree;

function readWorkerLog(d) {
  const p = join(workDir(d), '.dlm', 'worker.log');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

/**
 * 記一次 worker 失敗。infra 不加嘗試次數,改成指數退避(上限可設);全系統連續 N 次 infra 就停機通知,
 * 不把節點判成卡住——三個 worker 共用一個帳號時,429 會一起來,那不是任何一個節點的錯。
 */
function workerFailed(ctx, d, reason, cls) {
  if (cls === 'auth') {
    ctx.append('orchestrator', 'worker_failed', { dispatch_id: d.dispatch_id, reason: `${reason}(worker 沒登入或金鑰無效)`, class: 'infra' });
    if (!ctx.state.halted) {
      const where = d.account ? `執行 node tools/dlm.mjs account login ${d.account}` : '在這台電腦上執行 claude 並登入';
      ctx.append('orchestrator', 'halt', { reason: `[auth] worker 沒登入(log:Not logged in / 金鑰無效)。重試沒有用,先停下來。請${where},再說「繼續」` });
    }
    return;
  }
  const fields = { dispatch_id: d.dispatch_id, reason, class: cls };
  if (cls === 'infra') {
    const caps = ctx.config.caps;
    const n = (ctx.state.nodes.get(d.node_id)?.infraFailures ?? 0) + 1;
    const delayMs = Math.min(caps.infra_backoff_seconds * 1000 * 2 ** (n - 1), caps.infra_backoff_max_minutes * 60000);
    fields.retry_after = new Date(Date.now() + delayMs).toISOString();
    fields.reason = `${reason}(基礎設施失敗,不算嘗試次數;這個節點第 ${n} 次,${Math.round(delayMs / 1000)} 秒後重派)`;
    // v4.6:帳號額度用完 → 那個帳號冷卻;pool 裡還有別的帳號就馬上換一個重派,不退避、不算連續失敗
    const log = readWorkerLog(d);
    if (d.account && isAccountLimit(log)) {
      fields.limited_account = d.account;
      fields.limited_until = limitedUntil(log, Date.now(), caps.account_cooldown_minutes ?? 30);
      const usage = globalUsage();
      usage[d.account] = { ...(usage[d.account] ?? {}), limited_until: fields.limited_until };
      let next = null;
      try { next = pickAccount(ctx.config.agents.worker.accounts, usage); } catch { /* 帳號清單有問題:照舊退避 */ }
      if (next?.name) {
        fields.retry_after = new Date().toISOString();
        fields.switched = true;
        fields.reason = `${reason}(帳號 ${d.account} 額度用完,冷卻到 ${fields.limited_until};改用 ${next.name} 重派,不算嘗試次數)`;
      } else {
        fields.reason = `${reason}(帳號 ${d.account} 額度用完,冷卻到 ${fields.limited_until};沒有別的帳號可換)`;
      }
    }
  }
  ctx.append('orchestrator', 'worker_failed', fields);
  const streak = ctx.state.infraStreak;
  if (cls === 'infra' && streak >= ctx.config.caps.infra_halt_after && !ctx.state.halted) {
    ctx.append('orchestrator', 'halt', {
      reason: `[infra] 連續 ${streak} 次基礎設施失敗(限流、5xx、連線、沒啟動成功)。先停下來;確認帳號額度或網路沒問題後說「繼續」`,
    });
  }
}

function saveLogTail(ctx, d) {
  const log = join(workDir(d), '.dlm', 'worker.log');
  if (existsSync(log)) atomicWrite(join(ctx.dispatchDir(d.dispatch_id), 'worker.log.tail'), tail(readFileSync(log, 'utf8'), 6000));
}

/**
 * v4:停機時把還在跑的 worker 收掉。v3 的 halt 只寫一筆事件,worker 繼續跑到 lease 到期,
 * 恢復後被當成失敗 reset --hard,把使用者停機期間在 worktree 手動修好的東西一起洗掉(v3 實測)。
 * 這裡不碰 worktree:沙箱副本直接丟掉,worktree 保持停機當下的樣子;記成 halted,不算嘗試、不退避。
 */
export function haltWorkers(ctx) {
  const stopped = [];
  for (const d of [...ctx.state.dispatches.values()]) {
    if (!['dispatched', 'running'].includes(d.state)) continue;
    if (d.pid) killSandboxed({ pid: d.pid });
    saveLogTail(ctx, d);
    ctx.append('orchestrator', 'worker_failed', { dispatch_id: d.dispatch_id, reason: '使用者停機,dlm 終止了這個 worker(不算嘗試次數)', class: 'halted' });
    cleanupSandbox(ctx, ctx.state.dispatches.get(d.dispatch_id));
    stopped.push(d.dispatch_id);
  }
  return stopped;
}

/** 現在有哪些事在等使用者(決定、試用、停機),給通知比對用。 */
export function awaitingKeys(state) {
  const keys = [...state.decisions.values()].filter((r) => r.request && !r.answer).map((r) => r.request.ref);
  for (const n of state.nodes.values()) if (n.e2e?.requestedSeq && !n.e2e.confirm) keys.push(`e2e:${n.id}`);
  if (state.halted) keys.push(`halt:${state.halted.seq}`);
  return keys;
}

/**
 * v4:有新的事要使用者處理時,跑 dlm.config.json 的 notify.cmd(例:`osascript -e 'display notification ...'`、
 * `curl -d @- https://ntfy.sh/xxx`)。內容走環境變數 DLM_NOTIFY_TEXT 與 stdin,不會被拼進指令字串。
 * 通知失敗不影響 tick。
 */
export function notifyNew(ctx, before) {
  const cmd = ctx.config.notify?.cmd;
  if (!cmd) return null;
  const seen = new Set(before);
  const fresh = awaitingKeys(ctx.state).filter((k) => !seen.has(k));
  if (!fresh.length) return null;
  const text = `dlm:${fresh.length} 件新的事等你處理(${fresh.slice(0, 3).join('、')}${fresh.length > 3 ? '…' : ''})。在 Front 說「看收件匣」`;
  const r = runArgv('sh', ['-c', cmd], { cwd: ctx.root, env: { ...process.env, DLM_NOTIFY_TEXT: text }, input: text, timeoutMs: 15000 });
  ctx.log(`notify exit=${r.code}`);
  return { text, code: r.code };
}

export async function harvest(ctx) {
  for (const d of [...ctx.state.dispatches.values()]) {
    if (!['dispatched', 'running'].includes(d.state)) continue;
    try {
      await harvestOne(ctx, d);
    } finally {
      const now = ctx.state.dispatches.get(d.dispatch_id);
      if (now && !['dispatched', 'running'].includes(now.state)) cleanupSandbox(ctx, now);
    }
  }
}

async function harvestOne(ctx, d) {
  const reportPath = join(workDir(d), '.dlm', 'report.json');
  const alive = d.pid ? pidAlive(d.pid) : false;
  const leaseOver = Date.now() > Date.parse(d.lease_until);
  if (alive && !leaseOver) return;
  if (alive && leaseOver) {
    killSandboxed({ pid: d.pid });
    saveLogTail(ctx, d);
    resetAttempt(ctx, d);
    // lease 到期是 worker 做太久(或卡在迴圈),算它一次;log 裡看得出是限流/連線才算 infra
    workerFailed(ctx, d, 'lease 到期,已終止 worker', classifyFailure(readWorkerLog(d)));
    return;
  }
  if (!d.pid) {
    if (Date.now() - Date.parse(d.ts) < 120000) return;
    workerFailed(ctx, d, 'dispatch 之後沒有成功啟動 worker', 'infra');
    return;
  }
  const logText = readWorkerLog(d);
  const usd = parseCost(logText);
  if (usd !== null) ctx.append('orchestrator', 'cost', { dispatch_id: d.dispatch_id, usd, role: 'worker' });
  if (!existsSync(reportPath)) {
    saveLogTail(ctx, d);
    resetAttempt(ctx, d);
    const cls = classifyFailure(logText);
    workerFailed(ctx, d, {
      infra: 'worker 沒交 report,log 顯示是限流/服務端錯誤/連線問題',
      auth: 'worker 沒交 report',
      quality: 'worker 結束了但沒有交 report(.dlm/report.json)',
    }[cls], cls);
    return;
  }
  let report;
  let errors;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
    errors = validate(reportSchema, report);
    if (report.dispatch_id !== d.dispatch_id) errors.push(`dispatch_id 應為 ${d.dispatch_id}`);
  } catch (e) {
    errors = [`不是 JSON:${e.message}`];
  }
  if (errors.length) {
    saveLogTail(ctx, d);
    resetAttempt(ctx, d);
    workerFailed(ctx, d, `report 格式不符:${errors.slice(0, 3).join('; ')}`, 'quality');
    return;
  }
  const stored = `ledger/dispatch/${d.dispatch_id}/report.json`;
  writeJson(join(ctx.root, stored), report);
  let extra = {};
  if (d.sandbox) {
    const sy = syncSandbox(ctx, d, `dlm: ${d.dispatch_id} ${d.leg} 交件(worker 在沙箱副本施工,由 dlm commit)`);
    extra = { changes: sy.changed.length };
    if (sy.violations.length) {
      const vp = `ledger/dispatch/${d.dispatch_id}/violations.json`;
      writeJson(join(ctx.root, vp), sy.violations);
      extra.violations_path = vp;
    }
  }
  if (report.kind === 'done') {
    ctx.append('orchestrator', 'worker_done', { dispatch_id: d.dispatch_id, commit: headSha(d.worktree), report_path: stored, ...extra });
  } else {
    ctx.append('orchestrator', 'worker_blocked', {
      dispatch_id: d.dispatch_id, reason: report.summary, report_path: stored, ...(report.spawn ? { spawn: report.spawn } : {}),
      ...(report.fix_leg ? { fix_leg: report.fix_leg } : {}),
      ...(extra.violations_path ? { violations_path: extra.violations_path } : {}),
    });
    await routeBlocked(ctx, ctx.state.dispatches.get(d.dispatch_id), report);
  }
}

// ---------------------------------------------------------------- blocked / spawn

async function routeBlocked(ctx, d, report) {
  const node = getNode(ctx.dag, d.node_id);
  const level = ctx.config.autonomy.level;
  if (report.spawn) {
    const spawn = report.spawn;
    let problems = [];
    let child;
    if (getNode(ctx.dag, spawn.id)) problems.push(`節點 ${spawn.id} 已存在`);
    if (!spawn.gherkin_draft) problems.push('子節點提案必須附 gherkin_draft(沒有 gherkin 不寫程式)');
    if (!problems.length) {
      try {
        const r = withSpawn(ctx.dag, node.id, spawn);
        child = r.child;
        problems = validateDag(r.dag, contractMajor(ctx.root));
      } catch (e) {
        problems = [e.message];
      }
    }
    if (problems.length) {
      ctx.append('orchestrator', 'unblock', { node_id: node.id, ref: `spawn-invalid:${d.dispatch_id}`, note: `子節點提案不合法,請修正後重提或直接完成原範圍:${problems.join('; ')}` });
      return;
    }
    const contained = scopeContained(child, node);
    if (spawnRoute({ level, contained }) === 'auto') {
      applySpawn(ctx, d, spawn, `autonomy-L${level}(子節點範圍在 ${node.id} 之內)`);
    } else {
      ctx.append('orchestrator', 'decision_request', {
        ref: `spawn:${spawn.id}`,
        question: `${node.id} 的 worker 提議新增子節點 ${spawn.id}(${spawn.relation});提案內容是 worker 寫的,見下方`,
        untrusted_text: `title: ${spawn.title}\nintent: ${spawn.intent}\nowns: ${spawn.owns.join(', ')}`,
        untrusted_source: `worker:${d.dispatch_id}`,
        options: [{ key: 'yes', label: '批准,加進 DAG' }, { key: 'no', label: '不加,請 worker 在原範圍內完成' }],
        recommendation: contained ? 'yes' : 'no',
        reason: contained ? '範圍在父節點之內' : '子節點要寫父節點範圍以外的路徑',
        blocks: [node.id],
        from: 'orchestrator',
        detail_path: d.report_path,
      });
    }
    return;
  }
  const s = ctx.state.nodes.get(node.id);
  const route = escalationRoute({ level, criticAvailable: criticConfigured(ctx.config) });
  const reopenable = canReopenTest(ctx, node, d.leg);
  if (report.fix_leg === 'test' && reopenable) {
    // v4:實作棒說「測試/步驟寫錯了」。v3 只會把同一棒原樣重派(Critic PASS → unblock),實作棒改不了測試,永遠卡住。
    const findings = [{ check: 'test-fix', detail: `實作棒(${d.dispatch_id})回報測試或步驟定義與 gherkin 矛盾:${tail([report.summary, ...(report.ticket_problems ?? [])].join(';'), 1200)}` }];
    const tooMany = s.reopens >= (ctx.config.caps.test_reopens ?? 2);
    if (route === 'critic' && !tooMany) {
      const c = callCritic(ctx, d, node, { escalation: report, testFix: true });
      if (c.value) {
        ctx.append('critic', 'critic', { ref: `testfix:${d.dispatch_id}`, dispatch_id: d.dispatch_id, verdict: c.value.verdict, reason: c.value.reason });
        if (c.value.verdict === 'PASS') {
          reopenTestLeg(ctx, d, `testfix:${d.dispatch_id}`, [...findings, { check: 'critic', detail: `Critic 確認:${c.value.reason}` }]);
          return;
        }
        if (c.value.verdict === 'FAIL') {
          ctx.append('orchestrator', 'unblock', { node_id: node.id, ref: `escalation:${d.dispatch_id}`, note: `Critic 判定測試沒有寫錯,請照現有測試完成實作:${c.value.reason}` });
          return;
        }
      }
    }
    ctx.append('orchestrator', 'decision_request', {
      ref: `testfix:${d.dispatch_id}`,
      question: `${node.id} 的實作棒說測試寫錯了,要退回測試棒修正嗎?${tooMany ? `(這個節點已經退回過 ${s.reopens} 次)` : ''}它的說法見下方`,
      untrusted_text: [report.summary, ...(report.ticket_problems ?? []).map((t) => `- ${t}`)].join('\n'),
      untrusted_source: `worker:${d.dispatch_id}`,
      options: [
        { key: 'reopen', label: '退回測試棒修正(原話會交給測試棒)' },
        { key: 'retry', label: '測試沒錯,照我的指示重做實作' },
        { key: 'block', label: '先擱置' },
      ],
      recommendation: tooMany ? 'block' : 'reopen',
      reason: tooMany ? '同一個節點已經在測試棒和實作棒之間來回多次,先看一下規格本身' : '實作棒改不了測試;不退回只會重複卡住',
      blocks: [node.id],
      from: 'orchestrator',
      detail_path: d.report_path,
    });
    return;
  }
  // v4:Critic 已經「指引重試」過一次還是卡住,再叫 Critic 只會原樣重派同一棒(v3 實測的迴圈),直接問使用者
  let criticSays = null;
  if (route === 'critic' && s.escalations < 1) {
    const c = callCritic(ctx, d, node, { escalation: report });
    if (c.value?.verdict === 'PASS') {
      ctx.append('critic', 'critic', { ref: `escalation:${d.dispatch_id}`, dispatch_id: d.dispatch_id, verdict: 'PASS', reason: c.value.reason });
      ctx.append('orchestrator', 'unblock', { node_id: node.id, ref: `escalation:${d.dispatch_id}`, note: `Critic 回覆:${c.value.reason}` });
      return;
    }
    if (c.value) ctx.append('critic', 'critic', { ref: `escalation:${d.dispatch_id}`, dispatch_id: d.dispatch_id, verdict: c.value.verdict, reason: c.value.reason });
    criticSays = c.value?.verdict === 'ASK_USER' ? c.value.reason : null;
  }
  const repeated = s.escalations >= 1;
  const green = integrationAlreadyGreen(ctx, d, node);
  ctx.append('orchestrator', 'decision_request', {
    ref: `escalation:${d.dispatch_id}`,
    question: `${node.id} 的 worker 回報卡住${repeated ? '(Critic 指引重試後又卡住)' : ''};它的說法見下方`,
    untrusted_text: [report.summary, ...(report.ticket_problems ?? []).map((t) => `- ${t}`), ...(criticSays ? [`Critic:${criticSays.slice(0, 600)}`] : [])].join('\n'),
    untrusted_source: `worker:${d.dispatch_id}`,
    options: [
      { key: 'retry', label: '照我的指示重試(把指示寫在原話裡)' },
      ...(reopenable ? [{ key: 'reopen', label: '退回測試棒修正測試' }] : []),
      ...(green?.green ? [SKIP_TEST_LEG] : []),
      { key: 'block', label: '先擱置' },
    ],
    // v4:重複卡住、或 Critic 判斷要你決定時,不推薦「重試」——沒有新指示的重試通常重蹈覆轍(v3/v4 實測)
    recommendation: green?.green ? 'skip' : repeated || criticSays ? 'block' : 'retry',
    reason: green?.green ? skipReason(green)
      : criticSays ? 'Critic 判斷這不是 worker 能自己解的(見 Critic 的說明),要重試請在原話裡寫具體指示'
      : repeated ? '同一棒已經被指引重試過還是卡住;要重試請在原話裡寫具體指示' : 'worker 第一次回報卡住',
    blocks: [node.id],
    from: 'orchestrator',
    detail_path: d.report_path,
  });
}

/** 這個節點的 pipeline 有測試棒,而且卡住的是測試棒之後的實作類棒:才能退回測試棒修正。 */
function canReopenTest(ctx, node, leg) {
  const pipeline = pipelineFor(node, ctx.config);
  return pipeline.includes('test') && !['characterize', 'test', 'test-fix'].includes(leg) && !!node.gherkin;
}

/** v4:插一棒 test-fix。實作棒這一次的內容退回(留標籤),測試修好後實作棒從乾淨的狀態重來。 */
function reopenTestLeg(ctx, d, ref, findings) {
  const tagName = resetAttempt(ctx, d);
  if (tagName) findings = [...findings, { check: 'previous-attempt', detail: `實作棒卡住時的內容留在標籤 ${tagName};測試棒不要改實作` }];
  ctx.append('orchestrator', 'leg_reopen', { node_id: d.node_id, leg: 'test-fix', ref, findings: findings.map((f) => ({ check: f.check, detail: tail(f.detail, 1500) })) });
  ctx.log(`↺ ${d.node_id} 退回測試棒修正(${ref})`);
}

function applySpawn(ctx, d, spawn, approvedBy) {
  const { dag, child } = withSpawn(ctx.dag, d.node_id, spawn);
  const gherkinPath = join(ctx.root, child.gherkin);
  if (!existsSync(gherkinPath)) atomicWrite(gherkinPath, spawn.gherkin_draft.endsWith('\n') ? spawn.gherkin_draft : `${spawn.gherkin_draft}\n`);
  saveDag(ctx.root, dag);
  ctx.refresh();
  ctx.append('orchestrator', 'node_added', { node_id: child.id, approved_by: approvedBy, spec_sha: sha256(stableJson(child)).slice(0, 12) });
  commitAll(ctx.root, [child.gherkin], `dlm: 新增子節點 ${child.id} 的 gherkin`);
  ctx.append('orchestrator', 'unblock', {
    node_id: d.node_id,
    ref: `spawn:${child.id}`,
    note: spawn.relation === 'prereq'
      ? `子節點 ${child.id} 已加入 DAG,完成後才會再派你;恢復時分支會先同步主線,你會拿到它的成果`
      : `子節點 ${child.id} 已另排在你之後;請把原本範圍做完,不要做它的內容`,
  });
}

// ---------------------------------------------------------------- verify & route

function callCritic(ctx, d, node, extra) {
  const { rules, reminder } = readRolePrompt(ctx.root, 'critic');
  const data = [];
  const add = (source, content) => data.push({ source, at: `ledger#${ctx.state.maxSeq}`, content: typeof content === 'string' ? content : JSON.stringify(content, null, 2) });
  add('dag.json#node', node);
  if (d.verify) add('verify', d.verify.results);
  if (d.gates) add('gates', { ok: d.gates.ok, results: d.gates.results });
  if (existsSync(d.worktree)) {
    const diff = git(d.worktree, `diff ${d.leg_base ?? d.base_sha} HEAD`, { allowFail: true }).stdout;
    add('diff', diff.length > 15000 ? `${diff.slice(0, 15000)}\n…(截斷)` : diff);
  }
  if (node.gherkin) {
    const g = dataFile(existsSync(d.worktree) ? d.worktree : ctx.root, node.gherkin);
    if (g) data.push(g);
  }
  if (extra?.escalation) add('worker-escalation', { summary: extra.escalation.summary, ticket_problems: extra.escalation.ticket_problems ?? [] });
  if (extra?.testFix && existsSync(d.worktree)) {
    // 測試棒寫的東西不在這一棒的 diff 裡:從分支和主線分岔的地方算起,只看測試與步驟定義
    const fork = git(d.worktree, `merge-base ${ctx.config.main_branch} HEAD`, { allowFail: true }).stdout.trim();
    const tdiff = fork ? git(d.worktree, `diff ${fork} HEAD -- features/steps ${testGlobs(node, ctx.config).map((g) => `':(glob)${g}'`).join(' ')}`, { allowFail: true }).stdout : '';
    add('test-diff', tdiff.length > 15000 ? `${tdiff.slice(0, 15000)}\n…(截斷)` : tdiff || '(找不到測試棒的改動)');
  }
  const question = extra?.testFix ? 'test-fix' : extra?.escalation ? 'escalation' : 'accept';
  let prompt;
  try {
    prompt = assemblePrompt({
      role: 'critic', rules, reminder, platform: ctx.config.platform, maxBytes: ctx.config.limits.prompt_bytes,
      envelope: { ref: `${question}:${d.dispatch_id}`, question, node_id: node.id, leg: d.leg, tier: node.tier ?? 'standard' },
      data, outputSchema: criticSchema,
    });
  } catch (e) {
    return { error: e.message };
  }
  atomicWrite(join(ctx.dispatchDir(d.dispatch_id), `critic-prompt-${ctx.state.maxSeq}.md`), prompt);
  // v4:在交件分支的 worktree 裡審(v3 在主線根目錄跑,Critic 讀到的是還沒合併的舊程式)
  const cwd = existsSync(d.worktree) ? d.worktree : ctx.root;
  let account = null;
  if (ctx.config.agents.critic.accounts?.length) {
    try { account = pickAccount(ctx.config.agents.critic.accounts, globalUsage(), Date.now(), { ignoreParallel: true }); } catch (e) { return { error: e.message }; }
    if (account?.wait) return { error: `Critic 的帳號都在冷卻(最早 ${account.wait})` };
  }
  const r = callAgent(ctx.config.agents.critic, prompt, criticSchema, { cwd, config: ctx.config, role: 'critic', account });
  if (r.cost) ctx.append('orchestrator', 'cost', { dispatch_id: d.dispatch_id, usd: r.cost, role: 'critic', ...(account ? { account: account.name } : {}) });
  // 帳本只存摘要長度;完整回覆另存檔(v3 實測:reason 超過上限時整個回覆被當成格式錯誤丟掉)
  if (r.value) {
    atomicWrite(join(ctx.dispatchDir(d.dispatch_id), `critic-${ctx.state.maxSeq}.json`), `${JSON.stringify(r.value, null, 2)}\n`);
    if (r.value.reason?.length > 1500) r.value.reason = `${r.value.reason.slice(0, 1500)}…(全文見 ledger/dispatch/${d.dispatch_id}/critic-${ctx.state.maxSeq}.json)`;
  }
  return r;
}

/** 被退回或失敗的一次嘗試:留標籤、把 worktree 退回這次嘗試開始前的樣子。越界的改動不會跟著下一次進主線。 */
function resetAttempt(ctx, d) {
  if (!existsSync(d.worktree)) return null;
  const tagName = `dlm-rejected/${d.dispatch_id}`;
  git(d.worktree, `tag -f ${tagName} HEAD`, { allowFail: true });
  git(d.worktree, `reset --hard ${d.base_sha}`, { allowFail: true });
  git(d.worktree, 'clean -fd -e .dlm', { allowFail: true });
  return tagName;
}

const WORKER_CHOSEN = ['evidence', 'claim-supported'];

function reject(ctx, d, reason, findings) {
  const tagName = resetAttempt(ctx, d);
  if (tagName) findings = [...findings, { check: 'previous-attempt', detail: `上一次的內容留在標籤 ${tagName}(worktree 已退回這次開始前);可以參考,但被指出的問題不要帶回來` }];
  ctx.append('orchestrator', 'reject', {
    dispatch_id: d.dispatch_id,
    node_id: d.node_id,
    reason,
    // 回灌給 worker 的只有驗收與 gate 的輸出;worker 自選指令的重跑輸出不帶(否則就是外洩通道)
    findings: findings.map((f) => ({
      check: f.check, detail: f.detail,
      ...(f.evidence && !WORKER_CHOSEN.includes(f.check) ? { evidence: tail(f.evidence, 1500) } : {}),
    })),
  });
}

/**
 * merge-tree 的依賴。不再一律 symlink 根目錄的 node_modules:worker(沒有沙箱時)寫得到它,
 * 改壞測試框架就能讓最後一道 gate 失效。有 lockfile 就用本機快取裝一份乾淨的(--ignore-scripts,不執行任何安裝腳本)。
 */
function installDeps(ctx, dir) {
  const mode = ctx.config.gates.install ?? 'auto';
  const lock = existsSync(join(dir, 'package-lock.json'));
  if (mode === 'link' || (mode === 'auto' && !lock)) {
    linkDeps(ctx.root, dir);
    return { ok: true };
  }
  const r = runArgv('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, timeoutMs: ctx.config.gates.timeout_minutes * 60000 });
  ctx.log(`  [merge-tree] install=npm-ci-offline exit=${r.code} ms=${r.ms}`);
  if (r.code === 0) return { ok: true };
  // v4:worker 在 workspaces(packages/*、apps/*)底下新增一個套件的 package.json,lockfile 就對不上,npm ci 一定失敗,
  // 而 worker 改不到 package-lock.json(gate 定義檔)。這種情況退回 symlink 根目錄的 node_modules,不把它當成 gate 紅(v4 實測)
  if (mode === 'auto' && /can only install packages when your package\.json and package-lock\.json/.test(r.stdout + r.stderr)) {
    ctx.log('  [merge-tree] lockfile 跟新增的 workspace 套件對不上,改用根目錄的 node_modules(之後在根目錄 npm install 更新 lockfile)');
    linkDeps(ctx.root, dir);
    return { ok: true, note: 'lockfile-out-of-sync' };
  }
  return {
    ok: false, code: r.code, ms: r.ms,
    output: `npm ci --offline 失敗(本機快取缺套件、或沒有 lockfile)。先在根目錄跑一次 npm install 填快取,或把 gates.install 設成 link:\n${tail(r.stdout + r.stderr, 2000)}`,
  };
}

function runMergeGates(ctx, d) {
  const dir = join(ctx.root, '.dlm', 'merge-tree');
  const mainSha = headSha(ctx.root, ctx.config.main_branch);
  const g = withMergeTree(ctx.root, dir, mainSha, d.branch, (t) => {
    if (!t.ok) return { ok: false, results: [], output_tail: `和主線合併就衝突:\n${tail(t.output, 2000)}` };
    const inst = installDeps(ctx, t.dir);
    if (!inst.ok) return { ok: false, results: [{ name: 'install', exit: inst.code, ms: inst.ms }], output_tail: inst.output, tree_sha: t.sha };
    // 別的節點已批准但還沒做完的 gherkin 不算進這次的全 gate(它們一定紅);這個節點自己的照跑
    writePendingFeatures(t.dir, pendingFeatures(ctx.dag, ctx.state, d.node_id));
    return { ...runGates(t.dir, ctx.config, { log: (l) => ctx.log(`  [merge-tree] ${l}`), root: ctx.root }), tree_sha: t.sha };
  });
  return ctx.append('orchestrator', 'gates', {
    dispatch_id: d.dispatch_id, ok: g.ok, tree_sha: g.tree_sha ?? '', main_sha: mainSha, results: g.results, output_tail: g.output_tail ?? '',
  });
}

/**
 * gate 結果過期了嗎:跑 gate 之後主線的程式碼有沒有變。只有 dlm 狀態檔(ledger、STATUS.md…)變動不算,
 * 否則每次 tick 存檔都會讓結果過期。沒有 main_sha 的舊紀錄一律當過期。
 */
function gatesStale(ctx, d) {
  const main = headSha(ctx.root, ctx.config.main_branch);
  if (!d.gates?.main_sha) return true;
  if (d.gates.main_sha === main) return false;
  const isState = (p) => STATE_PATHS.some((s) => p === s || p.startsWith(`${s}/`));
  return changedBetween(ctx.root, d.gates.main_sha, main).some((p) => !isState(p));
}

function finalize(ctx, d, node) {
  const pipeline = pipelineFor(node, ctx.config);
  const isLast = d.leg === pipeline.at(-1);
  if (!isLast) {
    ctx.append('orchestrator', 'leg_done', { dispatch_id: d.dispatch_id, node_id: node.id, leg: d.leg });
    return;
  }
  const main = ctx.config.main_branch;
  // 等決定的這段時間(可能幾小時)別的節點可能已經合併;在舊主線上綠的 gate 不代表在新主線上綠
  if (!isAncestor(ctx.root, d.branch, main) && gatesStale(ctx, d)) {
    ctx.log(`  ${d.dispatch_id} 的 gate 結果是在舊主線上跑的,在新主線上重跑`);
    runMergeGates(ctx, d);
    d = ctx.state.dispatches.get(d.dispatch_id);
    if (!d.gates.ok) {
      reject(ctx, d, '等待期間主線前進了;在新主線上重跑全 gate 是紅的', [{ check: 'gates', detail: '在「新 main + 分支」的臨時樹重跑全 gate 失敗', evidence: d.gates.output_tail }]);
      return;
    }
  }
  commitState(ctx, `dlm: 合併前存檔 ${d.dispatch_id}`);
  let mergeSha;
  if (isAncestor(ctx.root, d.branch, main)) {
    mergeSha = headSha(ctx.root);
  } else {
    const m = mergeNoFf(ctx.root, d.branch, `dlm: accept ${node.id} (${d.dispatch_id}, ledger#${ctx.state.maxSeq})`);
    if (!m.ok) {
      reject(ctx, d, '合併進主線衝突', [{ check: 'merge', detail: '跟主線衝突;下一次派工會先同步主線再請你解', evidence: m.output }]);
      return;
    }
    mergeSha = m.sha;
  }
  ctx.append('orchestrator', 'accept', { dispatch_id: d.dispatch_id, node_id: node.id, merge_sha: mergeSha });
  tag(ctx.root, `dlm-archive/${d.dispatch_id}`, d.branch);
  removeWorktree(ctx.root, d.worktree);
  deleteBranch(ctx.root, d.branch);
  if (node.kind === 'integration') {
    const scenarios = readScenarios(ctx.root, node.gherkin).filter((s) => s.tags.includes('@e2e')).map((s) => ({ file: s.file, line: s.line, name: s.name }));
    ctx.append('orchestrator', 'e2e_request', { node_id: node.id, scenarios });
  }
  ctx.log(`✓ 合併 ${node.id}`);
}

export async function processDone(ctx) {
  for (const d0 of [...ctx.state.dispatches.values()]) {
    if (d0.state !== 'done') continue;
    const node = getNode(ctx.dag, d0.node_id);
    if (!node) {
      ctx.append('orchestrator', 'note', { text: `交件 ${d0.dispatch_id} 指向不存在的節點 ${d0.node_id},忽略`, dispatch_id: d0.dispatch_id });
      continue;
    }
    const envelope = readJson(join(ctx.root, 'ledger', 'dispatch', d0.dispatch_id, 'envelope.json'));
    const report = readJson(join(ctx.root, d0.report_path));
    if (!d0.verify) {
      const v = await runVerify({ root: ctx.root, config: ctx.config, dag: ctx.dag, node, dispatch: d0, envelope, report });
      writeJson(join(ctx.dispatchDir(d0.dispatch_id), 'verify.json'), v.results);
      ctx.append('verifier', 'verify', {
        dispatch_id: d0.dispatch_id,
        results: v.results.map((r) => ({ ...r, ...(r.evidence ? { evidence: tail(r.evidence, 600) } : {}) })),
      });
    }
    let d = ctx.state.dispatches.get(d0.dispatch_id);
    const summary = summarize(d.verify.results, { verifierBackend: ctx.config.agents.verifier.backend });
    if (!summary.ok) {
      reject(ctx, d, `Verifier 否決 ${summary.fails.length} 項`, summary.fails);
      continue;
    }
    const isLast = d.leg === pipelineFor(node, ctx.config).at(-1);
    if (isLast && !d.gates) {
      runMergeGates(ctx, d);
      d = ctx.state.dispatches.get(d.dispatch_id);
    }
    if (isLast && !d.gates.ok) {
      reject(ctx, d, '合併後的全 gate 是紅的', [{ check: 'gates', detail: '在 main + 分支 的臨時樹跑全 gate 失敗', evidence: d.gates.output_tail }]);
      continue;
    }
    const acceptRef = `accept:${d.dispatch_id}`;
    if (ctx.state.decisions.has(acceptRef)) continue; // 等使用者或已由 applyDecisions 處理
    const route = acceptRoute({
      level: ctx.config.autonomy.level, summary, tier: node.tier, criticAvailable: criticConfigured(ctx.config),
      kind: node.kind, hasAccept: !!node.accept,
    });
    if (route === 'accept') {
      finalize(ctx, d, node);
      continue;
    }
    if (route === 'critic') {
      const c = callCritic(ctx, d, node);
      if (c.value) {
        ctx.append('critic', 'critic', { ref: acceptRef, dispatch_id: d.dispatch_id, verdict: c.value.verdict, reason: c.value.reason, findings: c.value.findings ?? [] });
        if (c.value.verdict === 'PASS') { finalize(ctx, d, node); continue; }
        if (c.value.verdict === 'FAIL') {
          reject(ctx, d, 'Critic 否決', c.value.findings?.length ? c.value.findings : [{ check: 'critic', detail: c.value.reason }]);
          continue;
        }
      } else {
        ctx.append('orchestrator', 'note', { text: `Critic 呼叫失敗(${c.error}),改問使用者`, dispatch_id: d.dispatch_id });
      }
    }
    // v4:機器檢查(mutation、證據…)排前面、模型題排後面,每行截短;v3 用 tail 截 1500 字,最重要的 mutation 那行被切掉
    const MODEL_CHECKS = ['scenario-honesty', 'claim-supported'];
    const ordered = [...summary.abstains].sort((a, b) => MODEL_CHECKS.includes(a.check) - MODEL_CHECKS.includes(b.check));
    const lines = ordered.map((a) => `- ${a.check}:${String(a.detail ?? '').slice(0, 220)}`);
    let abstains = '';
    for (const [i, l] of lines.entries()) {
      if (abstains.length + l.length > 1400) { abstains += `\n…另外 ${lines.length - i} 項見 verify.json`; break; }
      abstains += (abstains ? '\n' : '') + l;
    }
    const unverifiedShared = node.kind === 'shared' && !node.accept;
    ctx.append('orchestrator', 'decision_request', {
      ref: acceptRef,
      question: `要合併 ${node.id} 的 ${d.leg} 棒嗎?${abstains ? `有 ${summary.abstains.length} 項沒把握,見下方` : ''}${unverifiedShared ? '(shared 節點沒有 accept 指令,沒有機器驗收)' : ''}`,
      ...(abstains ? { untrusted_text: abstains, untrusted_source: 'verifier' } : {}),
      options: [{ key: 'yes', label: '合併' }, { key: 'no', label: '退回重做(原話會交給 worker)' }],
      // v4:能走到這裡代表 script 檢查與合併後全 gate 都綠、沒有任何 FAIL;「沒把握」不是「有問題」,v3 推薦退回只會讓人每次都改選合併
      recommendation: 'yes',
      reason: `script 檢查全過、合併後全 gate 綠;FAIL 0、ABSTAIN ${summary.abstains.length}${summary.abstains.length ? '(沒把握的項目值得看一眼,但沒有找到問題)' : ''}${unverifiedShared ? ';shared 節點沒有機器驗收,請確認用途' : ''}`,
      blocks: [],
      from: 'orchestrator',
      detail_path: `ledger/dispatch/${d.dispatch_id}/verify.json`,
    });
  }
}

// ---------------------------------------------------------------- decisions

export function applyDecisions(ctx) {
  for (const rec of [...ctx.state.decisions.values()]) {
    if (!rec.answer || !rec.request) continue;
    const { ref } = rec.request;
    const { choice, verbatim } = rec.answer;
    const [kind, target] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
    if (kind === 'accept') {
      const d = ctx.state.dispatches.get(target);
      if (!d || d.state !== 'done') continue;
      const node = getNode(ctx.dag, d.node_id);
      if (choice === 'yes') finalize(ctx, d, node);
      else reject(ctx, d, '使用者/Critic 決定退回', [{ check: 'decision', detail: verbatim }]);
    } else if (kind === 'spawn') {
      if (getNode(ctx.dag, target)) continue;
      const d = [...ctx.state.dispatches.values()].reverse().find((x) => x.spawn?.id === target);
      if (!d) continue;
      const parent = ctx.state.nodes.get(d.node_id);
      if (parent.status !== 'blocked') continue;
      // v4:決定之後父節點又被封鎖(別的原因)時不要再套用一次(v3 會重複 unblock,把新的待決事項繞過去,實測)
      if (parent.lastSeq > rec.answer.seq) continue;
      if (choice === 'yes') applySpawn(ctx, d, d.spawn, `decision:${ref}`);
      else ctx.append('orchestrator', 'unblock', { node_id: d.node_id, ref, note: `子節點提案沒被批准:${verbatim}。請在原範圍內完成。` });
    } else if (kind === 'escalation' || kind === 'stuck' || kind === 'testfix') {
      const nodeId = kind === 'stuck' ? target.split('#')[0] : ctx.state.dispatches.get(target)?.node_id;
      const s = nodeId && ctx.state.nodes.get(nodeId);
      if (!s || s.status !== 'blocked') continue;
      if (s.lastSeq > rec.answer.seq) continue; // 決定之後又被封鎖,是新的一次
      if (choice === 'retry') ctx.append('orchestrator', 'unblock', { node_id: nodeId, ref, note: verbatim });
      if (choice === 'skip') {
        // v4.7.3:使用者決定跳過整合點的測試棒。決定時的狀態可能變了,套用前再重跑一次驗收:還是綠的才記 leg_done
        const d = kind === 'stuck'
          ? [...ctx.state.dispatches.values()].reverse().find((x) => x.node_id === nodeId && x.leg === 'test')
          : ctx.state.dispatches.get(target);
        const node = getNode(ctx.dag, nodeId);
        const g = integrationAlreadyGreen(ctx, d, node);
        if (g?.green) {
          ctx.append('orchestrator', 'unblock', { node_id: nodeId, ref, note: `使用者決定跳過測試棒:${skipReason(g)}` });
          ctx.append('orchestrator', 'leg_done', { dispatch_id: d.dispatch_id, node_id: nodeId, leg: 'test' });
        } else {
          ctx.append('orchestrator', 'unblock', { node_id: nodeId, ref, note: `使用者要跳過測試棒,但 dlm 重跑驗收不是綠的${g ? `(${g.cmd} → exit ${g.exit})` : ''}:照原本的測試棒做,寫出紅的測試` });
        }
      }
      if (choice === 'reopen') {
        const d = kind === 'stuck'
          ? [...ctx.state.dispatches.values()].reverse().find((x) => x.node_id === nodeId)
          : ctx.state.dispatches.get(target);
        if (d) reopenTestLeg(ctx, d, ref, [{ check: 'decision', detail: `使用者決定退回測試棒:${verbatim}` }]);
      }
    }
  }
}

// ---------------------------------------------------------------- dispatch

function testGlobs(node, config) {
  // v4.5:節點自己寫了 tests 就用它;沒寫就從 owns 推,加上專案語言的慣例(go 的 *_test.go 跟程式放在一起)
  if (node.tests?.length) return node.tests;
  const lang = config?.project?.language ?? 'node';
  return (node.owns ?? []).flatMap((g) => {
    const p = globPrefix(g);
    const out = [`${p}**/*.test.*`, `${p}**/*.spec.*`];
    if (lang === 'go') out.push(`${p}**/*_test.go`);
    if (lang === 'python') out.push(`${p}**/test_*.py`);
    return out;
  });
}

export function buildEnvelope(ctx, node, cand, { dispatchId, branch, base }) {
  const cfg = ctx.config;
  const cap = capabilityOf(node.id);
  const steps = [`features/steps/${cap}.steps.*`, `features/steps/${cap}/**`];
  // 整合點的步驟照 features/steps/README.md 放 integration.steps.ts
  if (node.kind === 'integration') steps.push('features/steps/integration.steps.*', 'features/steps/integration/**');
  // 例外只有兩種,都走使用者批准的 shared 節點(變更也走 DAG,不走旁路):
  //   shared/contracts* 可以改 contracts/;
  //   shared/* 的 owns 明列某個 gate 定義檔(例:shared/deps 列 package.json、package-lock.json)時可以改那個檔。
  const owns = new Set(node.owns ?? []);
  const forbidden = cfg.paths.forbidden.filter((g) => {
    if (node.id.startsWith('shared/contracts') && g.startsWith('contracts/')) return false;
    if (node.kind === 'shared' && BUILD_CONFIG_PATHS.includes(g) && owns.has(g)) return false;
    return true;
  });
  let allowed;
  let acceptance = [];
  let doneWhen;
  const green = node.accept ? [{ cmd: node.accept, expect_exit: 0 }] : [];
  // v4.5:characterize 棒寫的測試只有那一棒能改;後面每一棒都不准動,實作棒還要讓它保持綠(現有行為沒被改壞)
  const ch = characterizes(node) ? node.characterize : null;
  if (ch && cand.leg !== 'characterize') forbidden.push(...ch.tests);
  if (ch && !['characterize', 'test', 'test-fix'].includes(cand.leg)) green.push({ cmd: ch.cmd, expect_exit: 0 });
  switch (cand.leg) {
    case 'characterize':
      allowed = [...ch.tests];
      forbidden.push(...(node.owns ?? []), ...ch.targets);
      if (node.gherkin) forbidden.push(node.gherkin);
      acceptance = [{ cmd: ch.cmd, expect_exit: 0 }];
      doneWhen = `為既有程式(${ch.targets.slice(0, 8).join(', ')}${ch.targets.length > 8 ? ' …' : ''})的現有行為寫測試,在現在的程式上全綠;`
        + '只寫 allowed_paths 裡的測試檔,沒改任何原始碼、沒改 gherkin。測的是「現在實際怎麼做」,不是「應該怎麼做」;'
        + '看起來像 bug 的行為也照實釘住,在 report 的 ticket_problems 列出來';
      break;
    case 'test':
      allowed = [...testGlobs(node, cfg), ...steps];
      if (node.gherkin) forbidden.push(node.gherkin);
      acceptance = node.accept ? [{ cmd: node.accept, expect_exit: -1 }] : [];
      doneWhen = '依 gherkin 寫好步驟定義與單元測試,跑起來是紅的(實作還不存在);沒改任何實作檔、沒改 gherkin';
      break;
    case 'test-fix':
      allowed = [...testGlobs(node, cfg), ...steps];
      if (node.gherkin) forbidden.push(node.gherkin);
      // 實作棒卡住時的內容已退回,實作仍不存在,修好的測試一樣應該是紅的。
      // v4.7.3:整合點例外——它接的東西多半已經在主線上(能力節點做的),修好的測試常常就是綠的,要求紅只會讓這一棒永遠過不了
      // (實跑:minilang 的 I3,test-fix 棒回報「實作已經讓它全綠,硬改紅會不忠於規格」)。整合點的 test-fix 不檢查紅綠,下一棒(integrate)照樣要綠
      acceptance = node.accept && node.kind !== 'integration' ? [{ cmd: node.accept, expect_exit: -1 }] : [];
      doneWhen = '只修正 findings 指出的測試或步驟定義錯誤,讓測試忠實反映規格(gherkin,以及 findings 引用的節點規格);不改任何實作檔、不改 gherkin。'
        + (node.kind === 'integration' ? '整合點的實作可能已經存在,修好的測試是綠的也沒關係,下一棒會驗。' : '')
        + '如果你判斷測試其實沒錯,不要改,回報 kind=blocked 並說明理由';
      break;
    default:
      allowed = [...node.owns];
      forbidden.push(...cfg.paths.tests);
      if (node.gherkin) forbidden.push(node.gherkin);
      acceptance = green;
      forbidden.push(...(node.tests ?? []));
      doneWhen = cand.leg === 'integrate'
        ? '在指定的組合層接通真實資料流,整合 gherkin 全綠,不 import 任何 __stubs__,不改來源能力的內部'
        : `實作讓 gherkin 與單元測試全綠;沒改任何測試、沒改 gherkin${ch ? ';characterize 棒釘住的現有行為測試也要維持綠' : ''}`;
  }
  const envelope = {
    dispatch_id: dispatchId,
    node_id: node.id,
    leg: cand.leg,
    attempt: cand.attempt,
    objective: node.intent,
    authority: { gherkin: node.gherkin ?? null, contracts: `contracts@${contractMajor(ctx.root)}`, ledger_seq: ctx.state.maxSeq, node_sha: sha256(stableJson(node)).slice(0, 12) },
    base_ref: base,
    branch,
    allowed_paths: allowed,
    forbidden_paths: [...new Set(forbidden)],
    acceptance,
    done_when: doneWhen,
    report_path: '.dlm/report.json',
    ...(cand.findings?.length ? { findings: cand.findings } : {}),
  };
  return envelope;
}

export function buildWorkerPrompt(ctx, node, envelope, wt) {
  const { rules, reminder } = readRolePrompt(ctx.root, 'worker');
  const at = `ledger#${ctx.state.maxSeq}`;
  const data = [];
  if (node.gherkin) {
    const g = dataFile(wt, node.gherkin, { at });
    if (g) data.push(g);
  }
  const schemaDir = join(wt, 'contracts', 'schema');
  if (existsSync(schemaDir)) {
    const files = readdirSync(schemaDir).filter((f) => f.endsWith('.json'));
    const total = files.reduce((n, f) => n + readFileSync(join(schemaDir, f), 'utf8').length, 0);
    if (total < 12000) files.forEach((f) => data.push(dataFile(wt, `contracts/schema/${f}`, { at })));
    else data.push({ source: 'contracts/schema', at, content: `契約檔太大不內嵌,請自己讀:${files.join(', ')}` });
  }
  if (node.parent) {
    const p = getNode(ctx.dag, node.parent);
    if (p) data.push({ source: `dag.json#${p.id}`, at, content: `你是 ${p.id} 的子節點(${node.relation})。父節點意圖:${p.intent}` });
  }
  if (envelope.leg === 'integrate') {
    const deps = (node.depends_on ?? []).map((id) => getNode(ctx.dag, id)).filter(Boolean)
      .map((n) => ({ id: n.id, intent: n.intent, owns: n.owns, standalone: n.standalone ?? null }));
    data.push({ source: 'dag.json#depends_on', at, content: JSON.stringify(deps, null, 2) });
  }
  return assemblePrompt({
    role: 'worker', rules, reminder, envelope, data, outputSchema: reportSchema,
    platform: ctx.config.platform, maxBytes: ctx.config.limits.prompt_bytes,
  });
}

/**
 * v4.7.3 整合點的測試棒做不出紅燈:能力節點已經把整合 gherkin 全部做到了(驗收在動手前就是綠的)。
 * 測試棒只能造假(重複定義步驟弄成 ambiguous、寫故意失敗的測試);誠實的 worker 會回報卡住,重試也一樣,版本永遠到不了試用。
 * dlm 自己在這一棒的樹上重跑驗收(用完即丟的副本):綠的才多給使用者一個選項「跳過測試棒」(記 leg_done,接著跑整合棒)。
 * 只限整合點的測試棒:能力節點的驗收一開始就綠,代表 gherkin 沒寫到新東西,該回頭改規格。
 * 實測:todo-cli 的 I1。只看得到 MCP 的 AI 把命令列入口放在能力節點裡,整合 gherkin 又沿用能力的句子,I1 的測試棒卡住。
 */
export function integrationAlreadyGreen(ctx, d, node) {
  if (!d || d.leg !== 'test' || node?.kind !== 'integration' || !node.accept || !d.worktree || !existsSync(d.worktree)) return null;
  const scratch = scratchCopy(ctx.root, d.worktree, `${d.dispatch_id}-green`);
  try {
    linkDeps(ctx.root, scratch);
    const res = hostExecutor(scratch).sh(node.accept, ctx.config.verify.rerun_timeout_seconds * 1000);
    return { green: res.code === 0, cmd: node.accept, exit: res.code };
  } finally {
    removeTree(scratch);
  }
}
/**
 * v4.7.3 派整合點的測試棒之前先檢查:驗收在這棵樹(主線 + 分支)上已經是綠的 → 測試棒不可能誠實地先紅,派了只會卡住、問使用者、再跳過。
 * 只在第一次派這個節點、而且不是重做(沒有 findings,例如試用失敗後重做,測試棒可能要補測試)時檢查。
 * 實跑:todo-cli I1、wordfreq I1、minilang I3 都是測試棒卡住 → 使用者選 skip;minilang I3 的 worker 直接建議「把 I3 當作已滿足」。
 */
function integrationGreenBeforeTest(ctx, node, cand, wt) {
  if (cand.leg !== 'test' || node.kind !== 'integration' || !node.accept) return null;
  if (ctx.config.integration?.precheck_green === false) return null;
  if (cand.findings?.length || [...ctx.state.dispatches.values()].some((x) => x.node_id === node.id)) return null;
  const scratch = scratchCopy(ctx.root, wt, `precheck-${slug(node.id)}`);
  try {
    linkDeps(ctx.root, scratch);
    const res = hostExecutor(scratch).sh(node.accept, ctx.config.verify.rerun_timeout_seconds * 1000);
    return res.code === 0 ? { cmd: node.accept } : null;
  } finally {
    removeTree(scratch);
  }
}

const SKIP_TEST_LEG = { key: 'skip', label: '驗收已經是綠的(dlm 重跑過):跳過測試棒,接著跑整合棒' };
const skipReason = (g) => `dlm 在這一棒的樹上重跑 ${g.cmd},exit 0:整合點的驗收在動手前就是綠的(能力節點已經做到),測試棒做不出誠實的紅燈`;

function blockStuck(ctx, cand) {
  const s = ctx.state.nodes.get(cand.id);
  const last = [...ctx.state.dispatches.values()].reverse().find((x) => x.node_id === cand.id && x.leg === cand.leg);
  const green = integrationAlreadyGreen(ctx, last, getNode(ctx.dag, cand.id));
  ctx.append('orchestrator', 'block', { node_id: cand.id, reason: `${cand.leg} 棒已 ${cand.attempt - 1} 次沒通過` });
  ctx.append('orchestrator', 'decision_request', {
    ref: `stuck:${cand.id}#${ctx.state.maxSeq}`,
    question: `${cand.id} 的 ${cand.leg} 棒連續 ${cand.attempt - 1} 次沒通過;最後一次的原因見下方`,
    untrusted_text: (s.findings ?? []).map((f) => `- ${f.check}:${f.detail}`).join('\n').slice(0, 1500),
    untrusted_source: 'findings',
    options: [
      { key: 'retry', label: '再試(把你的指示寫在原話裡)' },
      ...(canReopenTest(ctx, getNode(ctx.dag, cand.id), cand.leg) ? [{ key: 'reopen', label: '退回測試棒修正測試' }] : []),
      ...(green?.green ? [SKIP_TEST_LEG] : []),
      { key: 'block', label: '先擱置' },
    ],
    // v4:v3 一律推薦 retry;連續失敗後沒有新指示的重試幾乎都是同樣的結果
    recommendation: green?.green ? 'skip' : 'block',
    reason: green?.green ? skipReason(green) : `同一棒已連續 ${cand.attempt - 1} 次沒通過;要重試請在原話裡寫具體指示,不然會重複同樣的失敗`,
    blocks: [cand.id],
    from: 'orchestrator',
  });
}

/**
 * 這一棒從哪裡算起。同一棒的重試沿用第一次的起點(被 blocked 前收進來的半成品也要一起驗);
 * v4:換了一棒(被退回測試棒、或 pipeline 改了)就從現在算起——v3 會沿用前一棒的起點,
 * 測試棒被算進前一棒 integrate 留下的實作檔,判越界三次後卡住(實測)。
 */
function legBaseFor(ctx, nodeId, leg, base) {
  const s = ctx.state.nodes.get(nodeId);
  if (!s.legBase) return base;
  // 這個節點最近連續幾次都是同一棒:起點是那一串的第一次派工當下的分支頭
  const mine = [...ctx.state.dispatches.values()].filter((x) => x.node_id === nodeId);
  let first = null;
  for (let i = mine.length - 1; i >= 0 && mine[i].leg === leg; i--) first = mine[i];
  return first ? first.base_sha : base;
}

export async function dispatchPhase(ctx) {
  const cfg = ctx.config;
  const main = cfg.main_branch;
  const snap = computeSnapshot({ root: ctx.root, config: cfg, dag: ctx.dag, state: ctx.state });
  if (snap.halted) return 'halted';
  if (!workerConfigured(cfg)) return 'no-worker-cmd';
  if (snap.budget.exceeded) return 'budget';
  if (snap.counts.unmerged >= cfg.caps.unmerged) return 'unmerged-cap';
  const slots = cfg.caps.parallel - snap.counts.open_dispatches;
  if (slots <= 0) return 'full';
  const candidates = [];
  for (const c of snap.dispatchable) {
    if (c.attempt > cfg.caps.attempts) blockStuck(ctx, c);
    else candidates.push(c);
  }
  if (!candidates.length) return 'nothing-ready';
  const order = candidates.map((c) => c.id);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  let started = 0;
  for (const id of order) {
    if (started >= slots) break;
    const cand = byId.get(id);
    const node = getNode(ctx.dag, id);
    // v4.6:這一棒用哪個帳號(pool 裡沒在冷卻、最近用得最少的)。全部都在冷卻就這輪不派
    let account = null;
    if (cfg.agents.worker.accounts?.length) {
      account = pickAccount(cfg.agents.worker.accounts, globalUsage());
      if (account?.wait) {
        ctx.log(`  所有 worker 帳號都在冷卻,最早 ${account.wait} 可用;這輪不派工`);
        return started ? `started-${started}` : 'accounts-limited';
      }
      if (account?.busy) {
        ctx.log(`  worker 帳號 ${account.busy.join('、')} 都到了同時上限(所有專案加起來);這輪先不派`);
        return started ? `started-${started}` : 'accounts-busy';
      }
    }
    const dispatchId = `d-${String(ctx.state.dispatches.size + 1).padStart(4, '0')}`;
    const branch = `dlm/${slug(node.id)}`;
    const wt = resolve(ctx.root, cfg.worktree_dir, slug(node.id));
    try {
      addWorktree(ctx.root, wt, branch, main);
      ensureDir(join(wt, '.dlm'));
      if (behindCount(ctx.root, branch, main) > 0) {
        const sy = syncWithMain(wt, main);
        if (!sy.ok) {
          ctx.append('orchestrator', 'block', { node_id: id, reason: '分支和主線同步時衝突' });
          ctx.append('orchestrator', 'decision_request', {
            ref: `stuck:${id}#${ctx.state.maxSeq}`, question: `${id} 的分支和主線同步時衝突;git 輸出見下方`,
            untrusted_text: tail(sy.output, 600), untrusted_source: 'git',
            options: [{ key: 'retry', label: '再試(附指示)' }, { key: 'block', label: '先擱置' }], recommendation: 'retry', blocks: [id], from: 'orchestrator',
          });
          continue;
        }
      }
      const green = integrationGreenBeforeTest(ctx, node, cand, wt);
      if (green) {
        ctx.append('orchestrator', 'note', {
          node_id: id,
          text: `${id} 的驗收在派測試棒之前就是綠的(${green.cmd} → exit 0):能力節點已經做到,測試棒做不出誠實的紅燈,不派;測試棒記為完成,接著派整合棒`,
        });
        ctx.append('orchestrator', 'leg_done', { dispatch_id: `precheck-${slug(id)}`, node_id: id, leg: 'test' });
        ctx.log(`  ${id}:驗收已經是綠的,不派測試棒,下一輪派整合棒`);
        continue;
      }
      const base = headSha(wt);
      const envelope = buildEnvelope(ctx, node, cand, { dispatchId, branch, base });
      assertValid(envelopeSchema, envelope, 'envelope');
      const prompt = buildWorkerPrompt(ctx, node, envelope, wt);
      const ddir = ctx.dispatchDir(dispatchId);
      writeJson(join(ddir, 'envelope.json'), envelope);
      atomicWrite(join(ddir, 'prompt.md'), prompt);
      writeJson(join(wt, '.dlm', 'envelope.json'), envelope);
      atomicWrite(join(wt, '.dlm', 'prompt.md'), prompt);
      if (existsSync(join(wt, '.dlm', 'report.json'))) unlinkSync(join(wt, '.dlm', 'report.json'));
      const sbx = prepareSandbox(ctx, wt, dispatchId, envelope, prompt);
      // worker 的時限:lease 與 agents.worker.timeout_minutes 取小的
      const leaseMin = Math.min(cfg.caps.lease_minutes, cfg.agents.worker.timeout_minutes ?? cfg.caps.lease_minutes);
      ctx.append('orchestrator', 'dispatch', {
        dispatch_id: dispatchId, node_id: id, leg: cand.leg, attempt: cand.attempt, branch, worktree: wt, base_sha: base,
        leg_base: legBaseFor(ctx, id, cand.leg, base),
        envelope_sha: sha256(stableJson(envelope)).slice(0, 12),
        lease_until: new Date(Date.now() + leaseMin * 60000).toISOString(),
        sandbox: sbx,
        ...(account ? { account: account.name } : {}),
      });
      const nm = nodeModulesFingerprint(ctx.root);
      const launched = launchWorker(cfg, {
        cwd: sbx, promptPath: join(sbx, '.dlm', 'prompt.md'), reportPath: join(sbx, '.dlm', 'report.json'),
        logPath: join(sbx, '.dlm', 'worker.log'), dispatchId, account,
      });
      ctx.append('orchestrator', 'launched', {
        dispatch_id: dispatchId, pid: launched.pid ?? 0,
        ...(nm ? { nm_fingerprint: nm } : {}),
      });
      ctx.log(`→ 派工 ${dispatchId} ${id} [${cand.leg}] 第 ${cand.attempt} 次${account ? `(帳號 ${account.name})` : ''}`);
      started++;
    } catch (e) {
      // 還沒記 dispatch 就失敗的話,沙箱副本沒人會收,在這裡清掉
      if (!ctx.state.dispatches.has(dispatchId)) removeTree(join(ctx.root, '.dlm', 'sandboxes', dispatchId));
      ctx.append('orchestrator', 'block', { node_id: id, reason: `派工失敗:${String(e.message).slice(0, 300)}` });
    }
  }
  return `started-${started}`;
}

// ---------------------------------------------------------------- tick

/**
 * 整個 tick 在一把鎖裡:daemon 在跑時手動再 `dlm tick`,兩個 tick 會同時處理同一個交件(重複 merge、重複派工)。
 * 拿不到鎖就直接跳過(ok,不是錯誤)。
 */
export async function tick(root, { log = () => {} } = {}) {
  const lockPath = join(root, '.dlm', 'tick.lock');
  const release = tryLock(lockPath);
  if (!release) return { ok: true, code: 0, busy: true, reason: `另一個 tick 正在執行(pid ${lockHolder(lockPath) ?? '?'}),這次跳過` };
  try {
    return await tickLocked(root, log);
  } finally {
    release();
  }
}

/** git 設定指紋:第一次記基準;之後不一致就停機,等使用者檢查後 resume(resume 會重記基準)。 */
function checkGitConfig(ctx) {
  const known = readConfigBaseline(ctx.root);
  if (!known) {
    writeConfigBaseline(ctx.root);
    return;
  }
  if (known === gitConfigFingerprint(ctx.root) || ctx.state.halted) return;
  ctx.append('orchestrator', 'halt', {
    reason: `${GIT_CONFIG_HALT} .git/config 在上次 tick 之後被改了(worker 可能加了 filter、diff driver、fsmonitor 之類會執行程式的設定)。`
      + '請先看 `git config --list --show-origin`,確認沒問題再說「繼續」',
  });
  ctx.log('✗ .git/config 被改了,已停機');
}

async function tickLocked(root, log) {
  const config = loadConfig(root);
  const branch = currentBranch(root);
  if (branch !== config.main_branch) return { ok: false, code: 2, reason: `根目錄不在 ${config.main_branch}(目前 ${branch})` };
  const dirty = dirtyTracked(root, STATE_PATHS);
  if (dirty.length) return { ok: false, code: 2, reason: `根目錄有未 commit 的變更(不是 dlm 寫的):${dirty.join(', ')}。是你或 Front 改的就先 commit(git add <檔> && git commit),背景迴圈才會繼續` };
  const problems = validateDag(loadDag(root), contractMajor(root));
  if (problems.length) return { ok: false, code: 2, reason: `dag.json 不合法:${problems.join('; ')}` };
  if (config.autonomy.level >= 1 && !hasTestGate(config.gates.chain)) return { ok: false, code: 2, reason: NO_TEST_GATE };
  const ledgerFile = join(root, 'ledger', 'events.jsonl');
  if (existsSync(ledgerFile)) {
    const chain = verifyChain(readFileSync(ledgerFile, 'utf8'));
    if (chain.problems.length) {
      return { ok: false, code: 3, reason: `帳本簽章鏈壞了,不執行任何事(可能有人直接寫了 ledger):${chain.problems.slice(0, 3).join('; ')}。查 \`dlm check ledger\`` };
    }
  }
  applyApprovedProposals(root, log);
  const ctx = new Ctx(root, log);
  const awaitingBefore = awaitingKeys(ctx.state);
  writePendingFeatures(root, pendingFeatures(ctx.dag, ctx.state));
  checkGitConfig(ctx);
  if (ctx.state.halted) {
    const stopped = haltWorkers(ctx);
    if (stopped.length) log(`停機:終止了 ${stopped.join(', ')}`);
  }
  if (!ctx.state.halted) {
    await harvest(ctx);
    await processDone(ctx);
    applyDecisions(ctx);
    await processDone(ctx); // 決定剛解開的交件
    const r = await dispatchPhase(ctx);
    log(`dispatch: ${r}`);
  } else {
    log(`停機中:${ctx.state.halted.reason}(使用者 \`dlm resume\` 才會繼續)`);
  }
  writePendingFeatures(root, pendingFeatures(ctx.dag, ctx.state));
  commitState(ctx, `dlm: tick @${ctx.state.maxSeq}`);
  notifyNew(ctx, awaitingBefore);
  const snap = computeSnapshot({ root, config: ctx.config, dag: ctx.dag, state: ctx.state });
  return { ok: true, code: 0, snapshot: snap };
}

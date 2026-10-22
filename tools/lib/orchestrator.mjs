// orchestrator: replaces v1's "wiring agent" and "integration / tree-cleaning agent". Pure script, makes no judgments.
// Every step is decided by the ledger state, so re-running after an interruption at any point gives the same result (idempotent).
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { globalUsage, isAccountLimit, limitedUntil, logAccountEvent, pickAccount } from './accounts.mjs';
import { callAgent, criticConfigured, launchWorker, parseCost, workerConfigured } from './agents.mjs';
import { acceptRoute, escalationRoute, spawnRoute } from './autonomy.mjs';
import { buildConfigPaths, loadConfig } from './config.mjs';
import { loadStack, stackRules } from './stack.mjs';
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
import { assemblePrompt, dataFile, readPrinciples, readRolePrompt, withPrinciples } from './prompt.mjs';
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

/** When halting because the git config was changed, the halt reason starts with this; only when the user resumes does dlm record the current config as the new baseline. */
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

/** v4.7: events about accounts are also logged separately on this machine (used to pick an account across projects, see accounts.mjs). */
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

// ---------------------------------------------------------------- sandbox copy (the worker never touches .git)
//
// The worker does not work inside the git worktree: dlm exports the worktree as a copy with no .git (.dlm/sandboxes/<dispatch>/),
// and the worker sees only that copy. When it finishes, dlm compares outside the sandbox "the copy vs the manifest taken at dispatch" (including ignored files),
// syncs in-scope changes back into the worktree and commits them itself; anything touching .git, .dlm, node_modules or symlinks is always recorded as a violation.

// Files in the sandbox copy that dlm manages itself (work order, prompt, report, log); they do not count as worker changes
const SANDBOX_DLM_FILES = ['.dlm/envelope.json', '.dlm/prompt.md', '.dlm/report.json', '.dlm/worker.log'];
const manifestPath = (ctx, id) => join(ctx.root, '.dlm', 'manifests', `${id}.json`);

function prepareSandbox(ctx, wt, dispatchId, envelope, prompt) {
  const sbx = join(ctx.root, '.dlm', 'sandboxes', dispatchId);
  // .mcp.json is not given to the worker (v4.6): it registers dlm's own MCP, and if the worker's CLI loaded it the worker could decide on behalf of the user
  copyTree(wt, sbx, { skip: ['.git', 'node_modules', '.dlm', '.mcp.json'] });
  ensureDir(join(sbx, '.dlm'));
  writeJson(join(sbx, '.dlm', 'envelope.json'), envelope);
  atomicWrite(join(sbx, '.dlm', 'prompt.md'), prompt);
  linkDeps(ctx.root, sbx);
  writeJson(manifestPath(ctx, dispatchId), treeManifest(sbx, { skipPaths: SANDBOX_DLM_FILES }));
  return sbx;
}

/** After the worker finishes: compare the copy, sync in-scope changes, dlm commits. Returns { changed, violations }. */
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
    // -f: ignored files must also go into the commit so the paths check can see them (a worker writing to dist/ or similar is not missed)
    git(d.worktree, `add -A -f -- ${safe.map((x) => `'${x.replace(/'/g, `'\\''`)}'`).join(' ')}`);
    const staged = git(d.worktree, 'diff --cached --quiet', { allowFail: true });
    if (staged.code !== 0) git(d.worktree, `-c user.name=dlm -c user.email=dlm@localhost commit --quiet -m '${message.replace(/'/g, '')}'`);
  }
  return { changed, violations };
}

function cleanupSandbox(ctx, d) {
  if (!d.sandbox) return;
  removeTree(d.sandbox);
  try { unlinkSync(manifestPath(ctx, d.dispatch_id)); } catch { /* already deleted */ }
}

// ---------------------------------------------------------------- harvest

// Recognize infrastructure failures (rate limit, 5xx, overload, connection) from the tail of the worker log. When unsure, treat it as quality: better to count one extra attempt
// than to treat the worker's own problem as a network problem and dispatch again forever.
const INFRA_LOG = new RegExp([
  '\\b429\\b', 'too many requests', 'rate[ _-]?limit', 'overloaded', 'insufficient_quota', 'quota exceeded',
  '\\b(?:500|502|503|504|529)\\b[^\\n]{0,40}(?:error|internal|gateway|unavailable|timeout|overloaded)',
  '(?:status|http|code)[^\\n]{0,20}\\b5\\d\\d\\b', 'service unavailable', 'api_error',
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'socket hang up',
  'request timed out', 'connection (?:timed out|reset|refused)',
].join('|'), 'i');

// Not logged in / wrong key: retrying gives the same result, so no backoff; halt right away and ask you to handle it (checked before infra, because this kind of output often also carries api_error)
const AUTH_LOG = /not logged in|please run \/login|invalid (?:x-)?api[ _-]?key|authentication_error|\b401\b[^\n]{0,40}(?:unauthori[sz]ed|auth)|missing api key|no api key|OAuth token has expired/i;

/** 'auth' | 'infra' | 'quality'. auth is recorded as infra in the ledger (it does not count as a worker attempt), but halts at once. */
export function classifyFailure(logText) {
  const t = tail(logText ?? '', 4000);
  if (AUTH_LOG.test(t)) return 'auth';
  // v4.6: running out of subscription quota (usage limit reached / weekly limit / resets 3pm) is also infrastructure; switch account or wait for the reset
  return INFRA_LOG.test(t) || isAccountLimit(t) ? 'infra' : 'quality';
}

/** The worker's working directory: in the new flow it is the sandbox copy; for old in-flight dispatches it is the worktree itself. */
const workDir = (d) => d.sandbox ?? d.worktree;

function readWorkerLog(d) {
  const p = join(workDir(d), '.dlm', 'worker.log');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

/**
 * Record one worker failure. infra does not add to the attempt count; it uses exponential backoff instead (cap is configurable); N consecutive infra failures across the whole system halt and notify,
 * without judging the node as stuck: when three workers share one account, the 429s arrive together, and that is not any one node's fault.
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
    // v4.6: account quota used up -> that account goes into cooldown; if the pool has another account, switch to it and dispatch again at once, with no backoff and no counting as a consecutive failure
    const log = readWorkerLog(d);
    if (d.account && isAccountLimit(log)) {
      fields.limited_account = d.account;
      fields.limited_until = limitedUntil(log, Date.now(), caps.account_cooldown_minutes ?? 30);
      const usage = globalUsage();
      usage[d.account] = { ...(usage[d.account] ?? {}), limited_until: fields.limited_until };
      let next = null;
      try { next = pickAccount(ctx.config.agents.worker.accounts, usage); } catch { /* problem with the account list: back off as before */ }
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
 * v4: on halt, stop the workers that are still running. v3's halt only wrote one event; the worker kept running until the lease expired,
 * and after resume it was treated as a failure and reset --hard, wiping out what the user had fixed by hand in the worktree during the halt (v3 real run).
 * This does not touch the worktree: the sandbox copy is simply discarded and the worktree stays as it was at halt; recorded as halted, not counted as an attempt, no backoff.
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

/** What is waiting on the user right now (decisions, hand trials, halt), used to compare for notifications. */
export function awaitingKeys(state) {
  const keys = [...state.decisions.values()].filter((r) => r.request && !r.answer).map((r) => r.request.ref);
  for (const n of state.nodes.values()) if (n.e2e?.requestedSeq && !n.e2e.confirm) keys.push(`e2e:${n.id}`);
  if (state.halted) keys.push(`halt:${state.halted.seq}`);
  return keys;
}

/**
 * v4: when something new needs the user, run notify.cmd from dlm.config.json (e.g. `osascript -e 'display notification ...'`,
 * `curl -d @- https://ntfy.sh/xxx`). The content goes through the environment variable DLM_NOTIFY_TEXT and stdin, and is never spliced into the command string.
 * A notification failure does not affect the tick.
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
    // lease expiry means the worker took too long (or is stuck in a loop); count it once; it counts as infra only if the log shows rate limiting / connection problems
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
    // v4: the dev leg says "the tests / steps are wrong". v3 could only dispatch the same leg again as is (Critic PASS -> unblock); the dev leg cannot change tests, so it stayed stuck forever.
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
  // v4: if the Critic already "guided a retry" once and the node is still stuck, calling the Critic again would only dispatch the same leg as is (the loop seen in a v3 real run), so ask the user directly
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
    // v4: when stuck repeatedly, or when the Critic says you must decide, do not recommend "retry": a retry with no new instructions usually repeats the same mistake (v3/v4 real run)
    recommendation: green?.green ? 'skip' : repeated || criticSays ? 'block' : 'retry',
    reason: green?.green ? skipReason(green)
      : criticSays ? 'Critic 判斷這不是 worker 能自己解的(見 Critic 的說明),要重試請在原話裡寫具體指示'
      : repeated ? '同一棒已經被指引重試過還是卡住;要重試請在原話裡寫具體指示' : 'worker 第一次回報卡住',
    blocks: [node.id],
    from: 'orchestrator',
    detail_path: d.report_path,
  });
}

/** Only when this node's pipeline has a test leg and the stuck leg is a dev-type leg after it can we send it back to the test leg to fix. */
function canReopenTest(ctx, node, leg) {
  const pipeline = pipelineFor(node, ctx.config);
  return pipeline.includes('test') && !['characterize', 'test', 'test-fix'].includes(leg) && !!node.gherkin;
}

/** v4: insert a test-fix leg. This dev leg's content is sent back (a tag is kept); after the tests are fixed, the dev leg starts over from a clean state. */
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
  const role = readRolePrompt(ctx.root, 'critic');
  const question0 = extra?.testFix ? 'test-fix' : extra?.escalation ? 'escalation' : 'accept';
  const principleFor = { accept: ['critic-accept'], escalation: ['critic-escalation'], 'test-fix': ['test'] };
  const rules = withPrinciples(role.rules, readPrinciples(ctx.root, principleFor[question0]));
  const { reminder } = role;
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
    // What the test leg wrote is not in this leg's diff: count from where the branch forked from main, and look only at tests and step definitions
    const fork = git(d.worktree, `merge-base ${ctx.config.main_branch} HEAD`, { allowFail: true }).stdout.trim();
    const tdiff = fork ? git(d.worktree, `diff ${fork} HEAD -- features/steps ${testGlobs(node, ctx.config).map((g) => `':(glob)${g}'`).join(' ')}`, { allowFail: true }).stdout : '';
    add('test-diff', tdiff.length > 15000 ? `${tdiff.slice(0, 15000)}\n…(截斷)` : tdiff || '(找不到測試棒的改動)');
  }
  const question = question0;
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
  // v4: review inside the worktree of the handed-in branch (v3 ran it in the main root directory, so the Critic read the old code that was not merged yet)
  const cwd = existsSync(d.worktree) ? d.worktree : ctx.root;
  let account = null;
  if (ctx.config.agents.critic.accounts?.length) {
    try { account = pickAccount(ctx.config.agents.critic.accounts, globalUsage(), Date.now(), { ignoreParallel: true }); } catch (e) { return { error: e.message }; }
    if (account?.wait) return { error: `Critic 的帳號都在冷卻(最早 ${account.wait})` };
  }
  const r = callAgent(ctx.config.agents.critic, prompt, criticSchema, { cwd, config: ctx.config, role: 'critic', account });
  if (r.cost) ctx.append('orchestrator', 'cost', { dispatch_id: d.dispatch_id, usd: r.cost, role: 'critic', ...(account ? { account: account.name } : {}) });
  // The ledger stores only a summary-length reason; the full reply is saved to a separate file (v3 real run: when reason exceeded the limit, the whole reply was thrown away as a format error)
  if (r.value) {
    atomicWrite(join(ctx.dispatchDir(d.dispatch_id), `critic-${ctx.state.maxSeq}.json`), `${JSON.stringify(r.value, null, 2)}\n`);
    if (r.value.reason?.length > 1500) r.value.reason = `${r.value.reason.slice(0, 1500)}…(全文見 ledger/dispatch/${d.dispatch_id}/critic-${ctx.state.maxSeq}.json)`;
  }
  return r;
}

/** An attempt that was sent back or failed: keep a tag and reset the worktree to how it was before this attempt started. Out-of-bounds changes do not follow the next attempt into main. */
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
    // Only acceptance and gate output is fed back to the worker; the re-run output of commands the worker chose itself is not included (otherwise it is a leak channel)
    findings: findings.map((f) => ({
      check: f.check, detail: f.detail,
      ...(f.evidence && !WORKER_CHOSEN.includes(f.check) ? { evidence: tail(f.evidence, 1500) } : {}),
    })),
  });
}

/**
 * Dependencies for the merge tree. No longer always a symlink to the root node_modules: the worker (when there is no sandbox) can write to it,
 * and breaking the test framework would defeat the last gate. If there is a lockfile, install a clean copy from the local cache (--ignore-scripts, runs no install scripts).
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
  // v4: when the worker adds a package.json for a new package under workspaces (packages/*, apps/*), the lockfile no longer matches and npm ci always fails,
  // and the worker cannot change package-lock.json (a gate definition file). In that case fall back to a symlink to the root node_modules and do not count it as a red gate (v4 real run)
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
    // Gherkin of other nodes that are approved but not finished is left out of this full gate (it is always red); this node's own gherkin still runs
    writePendingFeatures(t.dir, pendingFeatures(ctx.dag, ctx.state, d.node_id));
    return { ...runGates(t.dir, ctx.config, { log: (l) => ctx.log(`  [merge-tree] ${l}`), root: ctx.root }), tree_sha: t.sha };
  });
  return ctx.append('orchestrator', 'gates', {
    dispatch_id: d.dispatch_id, ok: g.ok, tree_sha: g.tree_sha ?? '', main_sha: mainSha, results: g.results, output_tail: g.output_tail ?? '',
  });
}

/**
 * Is the gate result stale: did the code on main change after the gate ran. A change only in dlm state files (ledger, STATUS.md...) does not count,
 * otherwise every tick's save would make the result stale. Old records without main_sha are always treated as stale.
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
  // While waiting for a decision (possibly hours) other nodes may have merged; a gate that was green on the old main does not mean it is green on the new main
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
    if (ctx.state.decisions.has(acceptRef)) continue; // waiting on the user, or already handled by applyDecisions
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
    // v4: machine checks (mutation, evidence...) first, model questions after, each line shortened; v3 cut to the last 1500 characters with tail, and the most important mutation line got cut off
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
      // v4: reaching here means the script checks and the post-merge full gate are all green, with no FAIL; "not sure" is not "has a problem", and v3 recommending send-back only made people switch to merge every time
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
      // v4: if the parent node was blocked again (for another reason) after the decision, do not apply it a second time (v3 would unblock again and bypass the new pending decision, seen in a real run)
      if (parent.lastSeq > rec.answer.seq) continue;
      if (choice === 'yes') applySpawn(ctx, d, d.spawn, `decision:${ref}`);
      else ctx.append('orchestrator', 'unblock', { node_id: d.node_id, ref, note: `子節點提案沒被批准:${verbatim}。請在原範圍內完成。` });
    } else if (kind === 'escalation' || kind === 'stuck' || kind === 'testfix') {
      const nodeId = kind === 'stuck' ? target.split('#')[0] : ctx.state.dispatches.get(target)?.node_id;
      const s = nodeId && ctx.state.nodes.get(nodeId);
      if (!s || s.status !== 'blocked') continue;
      if (s.lastSeq > rec.answer.seq) continue; // blocked again after the decision, so this is a new one
      if (choice === 'retry') ctx.append('orchestrator', 'unblock', { node_id: nodeId, ref, note: verbatim });
      if (choice === 'skip') {
        // v4.7.3: the user decided to skip the integration point's test leg. The state may have changed since the decision, so re-run acceptance before applying: only record leg_done if it is still green
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
  // v4.5: if the node wrote its own tests, use them; otherwise infer from owns, plus the project language's convention (go's *_test.go sits next to the code)
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
  // Integration point steps go in integration.steps.ts, per features/steps/README.md
  if (node.kind === 'integration') steps.push('features/steps/integration.steps.*', 'features/steps/integration/**');
  // There are only two exceptions, both through a shared node approved by the user (the change also goes through the DAG, not a side path):
  //   shared/contracts* may change contracts/;
  //   when the owns of shared/* explicitly lists a gate definition file (e.g. shared/deps lists package.json, package-lock.json), that file may be changed.
  const owns = new Set(node.owns ?? []);
  const forbidden = cfg.paths.forbidden.filter((g) => {
    if (node.id.startsWith('shared/contracts') && g.startsWith('contracts/')) return false;
    if (node.kind === 'shared' && buildConfigPaths(cfg).includes(g) && owns.has(g)) return false;
    return true;
  });
  let allowed;
  let acceptance = [];
  let doneWhen;
  const green = node.accept ? [{ cmd: node.accept, expect_exit: 0 }] : [];
  // v4.5: tests written by the characterize leg can be changed only by that leg; no later leg may touch them, and the dev leg must also keep them green (existing behavior not broken)
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
      // The content from when the dev leg got stuck has been sent back, so the implementation still does not exist and the fixed tests should still be red.
      // v4.7.3: integration points are an exception. What they wire up is mostly already on main (done by capability nodes), so the fixed tests are often green, and requiring red would make this leg never pass
      // (seen in a real run: minilang's I3, where the test-fix leg reported "the implementation already makes it all green; forcing it red would not be faithful to the spec"). The test-fix leg of an integration point does not check red / green, and the next leg (integrate) must still be green
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
    // v4.11: the command prefixes dlm will re-run as evidence (core + stack + gates.commands); the worker rules no longer name any test runner
    evidence_prefixes: cfg.verify.rerun_allow,
    ...(cand.findings?.length ? { findings: cand.findings } : {}),
  };
  return envelope;
}

/** Which principle files a worker leg gets (prompts/principles/<name>.md); a retry also gets `retry`. */
export function workerPrinciples(leg, retry) {
  const base = ['characterize', 'test', 'test-fix'].includes(leg) ? ['test'] : leg === 'integrate' ? ['integrate'] : ['dev'];
  return retry ? [...base, 'retry'] : base;
}

export function buildWorkerPrompt(ctx, node, envelope, wt) {
  const role = readRolePrompt(ctx.root, 'worker');
  // v4.11: core rules, then this project's stack rules (stacks/<name>/rules.md), then the principles of this leg
  const rules = withPrinciples(withPrinciples(role.rules, stackRules(loadStack(ctx.config.project?.stack))),
    readPrinciples(ctx.root, workerPrinciples(envelope.leg, !!envelope.findings?.length)));
  const { reminder } = role;
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
 * v4.7.3: the integration point's test leg cannot produce a red: the capability nodes already did all of the integration gherkin (acceptance was green before any work started).
 * The test leg could only fake it (define steps twice to make them ambiguous, write tests that fail on purpose); an honest worker reports stuck, and a retry is the same, so the version never reaches hand trial.
 * dlm re-runs acceptance itself on this leg's tree (a throwaway copy): only if it is green does the user get one extra option, "skip the test leg" (record leg_done, then run the integrate leg).
 * Only for an integration point's test leg: if a capability node's acceptance is green from the start, the gherkin did not describe anything new and the spec should be revised.
 * Seen in a real run: todo-cli's I1. An AI that could only see the MCP put the command-line entry point in a capability node, the integration gherkin reused the capability's sentences, and I1's test leg got stuck.
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
 * v4.7.3: before dispatching an integration point's test leg, check: if acceptance is already green on this tree (main + branch), the test leg cannot honestly go red first, and dispatching it would only get stuck, ask the user, then skip.
 * Checked only the first time this node is dispatched, and not on a redo (no findings; for example after a failed hand trial the test leg may need to add tests).
 * Seen in a real run: todo-cli I1, wordfreq I1 and minilang I3 all got stuck at the test leg -> the user chose skip; minilang I3's worker directly suggested "treat I3 as already satisfied".
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
    // v4: v3 always recommended retry; after repeated failures a retry with no new instructions almost always gives the same result
    recommendation: green?.green ? 'skip' : 'block',
    reason: green?.green ? skipReason(green) : `同一棒已連續 ${cand.attempt - 1} 次沒通過;要重試請在原話裡寫具體指示,不然會重複同樣的失敗`,
    blocks: [cand.id],
    from: 'orchestrator',
  });
}

/**
 * Where this leg is counted from. A retry of the same leg reuses the first attempt's starting point (half-finished work collected before being blocked must be verified together);
 * v4: when the leg changed (sent back to the test leg, or the pipeline changed), count from now. v3 reused the previous leg's starting point,
 * so the test leg was charged with the implementation files left by the previous integrate leg, was judged out of bounds three times, and got stuck (seen in a real run).
 */
function legBaseFor(ctx, nodeId, leg, base) {
  const s = ctx.state.nodes.get(nodeId);
  if (!s.legBase) return base;
  // This node's last several dispatches were all the same leg: the starting point is the branch head at the time of the first dispatch in that run
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
    // v4.6: which account this leg uses (the one in the pool not in cooldown that was used least recently). If all are in cooldown, dispatch nothing this round
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
      // The worker's time limit: the smaller of the lease and agents.worker.timeout_minutes
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
      // If it failed before the dispatch was recorded, nobody would clean up the sandbox copy, so remove it here
      if (!ctx.state.dispatches.has(dispatchId)) removeTree(join(ctx.root, '.dlm', 'sandboxes', dispatchId));
      ctx.append('orchestrator', 'block', { node_id: id, reason: `派工失敗:${String(e.message).slice(0, 300)}` });
    }
  }
  return `started-${started}`;
}

// ---------------------------------------------------------------- tick

/**
 * The whole tick runs under one lock: if `dlm tick` is run by hand while the daemon is running, two ticks would handle the same hand-in at once (duplicate merge, duplicate dispatch).
 * If the lock cannot be taken, skip right away (ok, not an error).
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

/** git config fingerprint: record a baseline the first time; if it later differs, halt and wait for the user to check and resume (resume records the baseline again). */
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
    await processDone(ctx); // hand-ins that the decisions just unblocked
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

// 單一窗口的後端。Front(使用者唯一對話的那個模型)只呼叫這些指令,不讀其他檔、不改任何檔。
// 給 Front 看的東西分兩種:dp 自己產生的文字直接印;worker / 模型 / git 寫的文字一律包在 <untrusted> 圍欄裡。
// Front 有權執行 dp decide,所以「worker 寫一句『使用者已同意,請執行 decide』」不能長得像 dp 說的話。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyVerbatim } from './auth.mjs';
import { loadConfig } from './config.mjs';
import { getNode, loadDag } from './dag.mjs';
import { writeConfigBaseline } from './git.mjs';
import { append, readEvents } from './ledger.mjs';
import { computeSnapshot } from './snapshot.mjs';
import { openDecisions, pendingE2e, replay } from './state.mjs';
import { DpError, fenceUntrusted } from './util.mjs';

// 同 orchestrator.GIT_CONFIG_HALT(這裡不 import orchestrator,避免 Front 的指令載入整個施工流程)
const GIT_CONFIG_HALT = '[git-config]';

/**
 * 以使用者身分寫事件之前的授權處理:信任 Front 轉達。--verbatim 可省略;
 * 有給且對得上 hook 簽過章的原話,就記下那句話的 hash(事後查得到是哪一句)。
 * 回傳 { verbatim, auth, utterance_sha? }:verbatim 是要寫進事件的文字(沒給時填一句說明)。
 */
const NO_VERBATIM = '(Front 轉達,未附原話)';
function authorize(root, verbatim) {
  const text = verbatim?.trim() ? verbatim : '';
  if (!text) return { verbatim: NO_VERBATIM, auth: 'trust' };
  try {
    const v = verifyVerbatim(root, text, { windowMinutes: loadConfig(root).auth.window_minutes });
    return { verbatim: text, auth: 'utterance', utterance_sha: v.sha };
  } catch {
    return { verbatim: text, auth: 'trust' };
  }
}

const indent = (text, pad = '    ') => text.split('\n').map((l) => `${pad}${l}`).join('\n');

/** 待決事項的題目:dp 產生的直接印;worker / 模型 / git 的輸出加圍欄。 */
function questionLines(r) {
  const lines = [];
  lines.push(`${r.ref}  ${r.question}`);
  if (r.untrusted_text) lines.push(indent(fenceUntrusted(r.untrusted_source ?? 'unknown', r.untrusted_text)));
  return lines;
}

function load(root) {
  const config = loadConfig(root);
  const dag = loadDag(root);
  const events = readEvents(root);
  const state = replay(events, dag);
  return { config, dag, events, state };
}

/**
 * v4.7:單一窗口的資料(API 與 dp op 用)。renderInbox 把它排成給 Front 轉述的文字。
 * worker / 模型 / git 寫的字放在 untrusted_text,呼叫端要自己當資料看待。
 */
export function inboxData(root, { markSeen = false } = {}) {
  const { config, dag, events, state } = load(root);
  const snap = computeSnapshot({ root, config, dag, state });
  const decisions = openDecisions(state).map((d) => ({
    ref: d.ref, question: d.question, options: d.options, recommendation: d.recommendation ?? null, reason: d.reason ?? null,
    ...(d.untrusted_text ? { untrusted_text: d.untrusted_text, untrusted_source: d.untrusted_source ?? 'unknown' } : {}),
  }));
  const e2e = pendingE2e(state).map((n) => ({ id: n.id, intent: getNode(dag, n.id)?.intent ?? '', scenarios: n.e2e.scenarios }));
  const since = events.filter((e) => e.seq > state.lastInboxSeq);
  const count = (t, f = () => true) => since.filter((e) => e.type === t && f(e)).length;
  const result = {
    halted: state.halted ? { reason: state.halted.reason } : null,
    decisions,
    e2e,
    since: {
      from_seq: state.lastInboxSeq + 1, to_seq: state.maxSeq,
      accepted: count('accept'), rejected: count('reject'),
      verifier_fails: since.filter((e) => e.type === 'verify').reduce((n, e) => n + e.results.filter((r) => r.outcome === 'FAIL').length, 0),
      critic: count('critic'), nodes_added: count('node_added'), worker_failed: count('worker_failed'),
      usd: Math.round(since.filter((e) => e.type === 'cost').reduce((n, e) => n + e.usd, 0) * 100) / 100,
    },
    counts: { done: snap.counts.done, nodes: snap.counts.nodes, in_progress: snap.in_progress.length, review: snap.review.length, dispatchable: snap.dispatchable.length, blocked: snap.blocked.length },
    budget: { today_usd: snap.budget.today_usd, daily_usd: snap.budget.daily_usd },
    warnings: snap.warnings,
  };
  if (markSeen) append(root, 'dp-cli', 'inbox_viewed', {});
  return result;
}

export function renderInbox(root, { markSeen = true } = {}) {
  const d = inboxData(root, { markSeen });
  const out = [];
  out.push(`【要你決定的 · ${d.decisions.length + d.e2e.length + (d.halted ? 1 : 0)}】`);
  if (d.halted) out.push(`HALT  系統停機中:${d.halted.reason} → 說「恢復」我就寫 resume`);
  for (const q of d.decisions) {
    const opts = q.options.map((o) => `${o.key} ${o.label}`).join(' / ');
    out.push(...questionLines(q));
    out.push(`    ${opts}${q.recommendation ? `   建議 ${q.recommendation}${q.reason ? `(${q.reason})` : ''}` : ''}`);
  }
  for (const n of d.e2e) {
    out.push(`E2E:${n.id}  ${n.intent} —— 你親手試過了嗎? yes / no(說哪裡不對)`);
    for (const s of n.scenarios) out.push(`    ${s.file}:${s.line} ${s.name}`);
    if (!n.scenarios.length) out.push('    ⚠ 這個整合點的 gherkin 沒有 @e2e 場景;照理不該發生,請要求補場景');
  }
  if (!d.decisions.length && !d.e2e.length && !d.halted) out.push('(沒有)');
  const s = d.since;
  const c = d.counts;
  out.push('');
  out.push(`【上次看之後 · ledger #${s.from_seq}–#${s.to_seq}】`);
  out.push(`合併 ${s.accepted} · 退回 ${s.rejected} · Verifier 否決 ${s.verifier_fails} 項 · Critic ${s.critic} 次 · 新節點 ${s.nodes_added} · 失敗 ${s.worker_failed} · 花費 $${s.usd.toFixed(2)}`);
  out.push(`完成 ${c.done}/${c.nodes} · 進行中 ${c.in_progress} · 審核中 ${c.review} · 可派 ${c.dispatchable} · 卡住 ${c.blocked} · 今日 $${d.budget.today_usd}/${d.budget.daily_usd}`);
  for (const w of d.warnings) out.push(`⚠ ${w}`);
  out.push('');
  out.push('【要看細節,說 ref 或節點 id】');
  return out.join('\n');
}

export function show(root, ref) {
  const { dag, state } = load(root);
  const rec = state.decisions.get(ref);
  if (rec?.request) {
    const r = rec.request;
    const lines = [`# ${r.ref}`, ''];
    lines.push(r.question);
    if (r.untrusted_text) lines.push('', fenceUntrusted(r.untrusted_source ?? 'unknown', r.untrusted_text));
    lines.push('', ...r.options.map((o) => `- ${o.key}:${o.label}`));
    if (r.recommendation) lines.push('', `建議:${r.recommendation}${r.reason ? `——${r.reason}` : ''}`);
    if (r.detail_path && existsSync(join(root, r.detail_path))) {
      // 附件是 worker 的 report 或 Verifier 結果,整份當資料
      lines.push('', `## 附件 ${r.detail_path}`, '', fenceUntrusted(r.detail_path, readFileSync(join(root, r.detail_path), 'utf8').slice(0, 6000)));
    }
    if (rec.answer) lines.push('', `已決:${rec.answer.choice}(${rec.answer.actor},原話:${rec.answer.verbatim})`);
    return lines.join('\n');
  }
  const node = getNode(dag, ref);
  if (node) {
    const s = state.nodes.get(ref);
    // reason / findings 可能是 worker 或模型寫的
    return fenceUntrusted(`node:${ref}`, JSON.stringify({ node, status: s.status, reason: s.reason, legsDone: s.legsDone, findings: s.findings, e2e: s.e2e }, null, 2));
  }
  const d = state.dispatches.get(ref);
  if (d) return fenceUntrusted(`dispatch:${ref}`, JSON.stringify(d, null, 2));
  throw new DpError(`找不到 ${ref}(可以是決定 ref、節點 id 或 dispatch id)`);
}

function checkDecision(root, ref, choice) {
  const { state } = load(root);
  const rec = state.decisions.get(ref);
  if (!rec?.request) throw new DpError(`沒有待決事項 ${ref}`);
  if (rec.answer) throw new DpError(`${ref} 已經決定過了(${rec.answer.choice}),要推翻請開新的決定`);
  if (rec.superseded) throw new DpError(`${ref} 已經被 ${rec.superseded} 取代,不能再決定;要決定的是 ${rec.superseded}`);
  const keys = rec.request.options.map((o) => o.key);
  if (!keys.includes(choice)) throw new DpError(`${ref} 的選項只有 ${keys.join('/')}`);
  return rec.request;
}

/** 使用者的決定。actor 固定是 user;Critic 的代行只由 orchestrator 在 tick 裡寫,不經過這裡。 */
export function decide(root, ref, choice, verbatim) {
  checkDecision(root, ref, choice);
  return append(root, 'user', 'decision', { ref, choice, ...authorize(root, verbatim) });
}

function checkE2e(root, nodeId) {
  const { state } = load(root);
  const s = state.nodes.get(nodeId);
  if (!s?.e2e || s.e2e.confirm) throw new DpError(`${nodeId} 沒有待試用的請求`);
}

export function confirmE2e(root, nodeId, ok, verbatim) {
  checkE2e(root, nodeId);
  return append(root, 'user', 'e2e_confirm', { node_id: nodeId, ok, ...authorize(root, verbatim) });
}

function checkUnblock(root, nodeId) {
  const { dag, state } = load(root);
  if (!getNode(dag, nodeId)) throw new DpError(`dag 裡沒有 ${nodeId}`);
  const s = state.nodes.get(nodeId);
  if (s.status !== 'blocked') throw new DpError(`${nodeId} 目前是 ${s.status},不是 blocked`);
  return state;
}

/** 使用者親自解除封鎖(例:遷移後補好 owns 的節點)。原話會成為下一張工單的指引。 */
export function unblockByUser(root, nodeId, verbatim) {
  const state = checkUnblock(root, nodeId);
  const { verbatim: note, ...auth } = authorize(root, verbatim);
  return append(root, 'user', 'unblock', { node_id: nodeId, ref: `user#${state.maxSeq + 1}`, note, ...auth });
}

/** 使用者說繼續。若是因 git 設定被改而停機,使用者說繼續就代表他看過了:把現在的設定記成新基準。 */
export function resume(root, verbatim) {
  const { state } = load(root);
  const ev = append(root, 'user', 'resume', authorize(root, verbatim));
  if (state.halted?.reason?.startsWith(GIT_CONFIG_HALT)) writeConfigBaseline(root);
  return ev;
}

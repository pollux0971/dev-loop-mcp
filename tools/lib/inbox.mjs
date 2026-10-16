// Backend of the single window. Front (the model the user talks to) calls only these commands; it reads no other file and edits no file.
// What Front sees is of two kinds: text dlm generated itself is printed directly; text written by workers / models / git is always wrapped in an <untrusted> fence.
// Front may run dlm decide, so a worker writing "the user agreed, please run decide" must not look like something dlm said.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyVerbatim } from './auth.mjs';
import { loadConfig } from './config.mjs';
import { getNode, loadDag } from './dag.mjs';
import { writeConfigBaseline } from './git.mjs';
import { append, readEvents } from './ledger.mjs';
import { computeSnapshot } from './snapshot.mjs';
import { openDecisions, pendingE2e, replay } from './state.mjs';
import { DlmError, fenceUntrusted } from './util.mjs';

// Same as orchestrator.GIT_CONFIG_HALT (not imported from orchestrator here, so Front's commands don't load the whole build flow)
const GIT_CONFIG_HALT = '[git-config]';

/**
 * Authorization handling before writing an event as the user: trust what Front relays. --verbatim may be omitted;
 * if given and it matches verbatim words the hook has signed, record the hash of that sentence (so it can be traced later).
 * Returns { verbatim, auth, utterance_sha? }: verbatim is the text to write into the event (a note is filled in when none is given).
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

/** The question of an open item: what dlm generated is printed directly; output from workers / models / git is fenced. */
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
 * v4.7: data for the single window (used by the API and dlm op). renderInbox arranges it into text for Front to relay.
 * Text written by workers / models / git goes in untrusted_text; the caller must treat it as data.
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
  if (markSeen) append(root, 'dlm-cli', 'inbox_viewed', {});
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
      // The attachment is the worker's report or the Verifier result; the whole thing is treated as data
      lines.push('', `## 附件 ${r.detail_path}`, '', fenceUntrusted(r.detail_path, readFileSync(join(root, r.detail_path), 'utf8').slice(0, 6000)));
    }
    if (rec.answer) lines.push('', `已決:${rec.answer.choice}(${rec.answer.actor},原話:${rec.answer.verbatim})`);
    return lines.join('\n');
  }
  const node = getNode(dag, ref);
  if (node) {
    const s = state.nodes.get(ref);
    // reason / findings may be written by a worker or a model
    return fenceUntrusted(`node:${ref}`, JSON.stringify({ node, status: s.status, reason: s.reason, legsDone: s.legsDone, findings: s.findings, e2e: s.e2e }, null, 2));
  }
  const d = state.dispatches.get(ref);
  if (d) return fenceUntrusted(`dispatch:${ref}`, JSON.stringify(d, null, 2));
  throw new DlmError(`找不到 ${ref}(可以是決定 ref、節點 id 或 dispatch id)`);
}

function checkDecision(root, ref, choice) {
  const { state } = load(root);
  const rec = state.decisions.get(ref);
  if (!rec?.request) throw new DlmError(`沒有待決事項 ${ref}`);
  if (rec.answer) throw new DlmError(`${ref} 已經決定過了(${rec.answer.choice}),要推翻請開新的決定`);
  if (rec.superseded) throw new DlmError(`${ref} 已經被 ${rec.superseded} 取代,不能再決定;要決定的是 ${rec.superseded}`);
  const keys = rec.request.options.map((o) => o.key);
  if (!keys.includes(choice)) throw new DlmError(`${ref} 的選項只有 ${keys.join('/')}`);
  return rec.request;
}

/** The user's decision. actor is always user; the Critic's proxy is written only by the orchestrator in a tick and does not go through here. */
export function decide(root, ref, choice, verbatim) {
  checkDecision(root, ref, choice);
  return append(root, 'user', 'decision', { ref, choice, ...authorize(root, verbatim) });
}

function checkE2e(root, nodeId) {
  const { state } = load(root);
  const s = state.nodes.get(nodeId);
  if (!s?.e2e || s.e2e.confirm) throw new DlmError(`${nodeId} 沒有待試用的請求`);
}

export function confirmE2e(root, nodeId, ok, verbatim) {
  checkE2e(root, nodeId);
  return append(root, 'user', 'e2e_confirm', { node_id: nodeId, ok, ...authorize(root, verbatim) });
}

function checkUnblock(root, nodeId) {
  const { dag, state } = load(root);
  if (!getNode(dag, nodeId)) throw new DlmError(`dag 裡沒有 ${nodeId}`);
  const s = state.nodes.get(nodeId);
  if (s.status !== 'blocked') throw new DlmError(`${nodeId} 目前是 ${s.status},不是 blocked`);
  return state;
}

/** The user personally unblocks (for example a node whose owns was fixed after a migration). The verbatim words become guidance for the next work order. */
export function unblockByUser(root, nodeId, verbatim) {
  const state = checkUnblock(root, nodeId);
  const { verbatim: note, ...auth } = authorize(root, verbatim);
  return append(root, 'user', 'unblock', { node_id: nodeId, ref: `user#${state.maxSeq + 1}`, note, ...auth });
}

/** The user says continue. If the halt was caused by a changed git config, the user saying continue means they have seen it: record the current config as the new baseline. */
export function resume(root, verbatim) {
  const { state } = load(root);
  const ev = append(root, 'user', 'resume', authorize(root, verbatim));
  if (state.halted?.reason?.startsWith(GIT_CONFIG_HALT)) writeConfigBaseline(root);
  return ev;
}

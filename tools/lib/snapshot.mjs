// snapshot = 機器算好的結論 + 理由 + 證據指標。Front 與派工只讀這一份,不讀 dag、不讀 markdown。
import { contractMajor, contractRefMajor, descendantCounts, isContractRef } from './dag.mjs';
import { NO_TEST_GATE, hasTestGate } from './gates.mjs';
import { openDecisions, pendingE2e, pipelineFor } from './state.mjs';
import { nowIso, todayUtc } from './util.mjs';

/**
 * gateE2e(v4,config.integration.gate_next_version):依賴的是整合點時,除了合併,還要等使用者親手試用說 OK。
 * 這就是「版本整合時間點」:下一版的節點依賴上一版的整合點,上一版沒試用過,下一版不開工。
 */
export function depsStatus(node, state, currentMajor, { dag = null, gateE2e = false } = {}) {
  const unmet = [];
  for (const d of node.depends_on ?? []) {
    if (isContractRef(d)) {
      if (contractRefMajor(d) !== currentMajor) unmet.push(`${d}(契約目前是 @${currentMajor})`);
    } else {
      const s = state.nodes.get(d);
      if (!s || s.status !== 'done') unmet.push(`${d}=${s?.status ?? '?'}`);
      else if (gateE2e && dag?.nodes.find((n) => n.id === d)?.kind === 'integration' && s.e2e?.requestedSeq && !s.e2e.confirm?.ok) {
        unmet.push(`${d}=等使用者試用`);
      }
    }
  }
  return unmet;
}

function blockingDecision(nodeId, state) {
  for (const rec of state.decisions.values()) {
    if (rec.request && !rec.answer && (rec.request.blocks ?? []).includes(nodeId)) return rec.request.ref;
  }
  return null;
}

export function computeSnapshot({ root, config, dag, state, behind = () => 0 }) {
  const major = contractMajor(root);
  const prio = descendantCounts(dag);
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  const dispatchable = [];
  const inProgress = [];
  const review = [];
  const blocked = [];
  const backoff = [];
  const warnings = [];
  const now = Date.now();

  for (const node of dag.nodes) {
    const s = state.nodes.get(node.id);
    const pipeline = pipelineFor(node, config);
    const nextLeg = s.pendingLeg ?? pipeline.find((l) => !s.legsDone.includes(l)) ?? pipeline[0];
    const decision = blockingDecision(node.id, state);
    for (const d of node.depends_on ?? []) {
      if (isContractRef(d) && contractRefMajor(d) < major && s.status !== 'done') {
        warnings.push(`${node.id} 依賴舊契約 ${d}(目前 @${major}),要先改 dag 的依賴`);
      }
    }
    if (s.status === 'blocked') {
      blocked.push({ id: node.id, reason: s.reason });
      continue;
    }
    if (s.openDispatch) {
      const d = state.dispatches.get(s.openDispatch);
      const entry = {
        id: node.id,
        dispatch: d.dispatch_id,
        leg: d.leg,
        attempt: d.attempt,
        age_min: Math.round((now - Date.parse(d.ts)) / 60000),
        lease_left_min: Math.round((Date.parse(d.lease_until) - now) / 60000),
        behind_main: behind(d.branch),
        state: d.state,
        account: d.account ?? null,
      };
      if (s.status === 'review') review.push(entry);
      else inProgress.push(entry);
      continue;
    }
    if (s.status === 'done') continue;
    if (s.status === 'review') {
      review.push({ id: node.id, dispatch: null, state: 'awaiting-verdict' });
      continue;
    }
    if (decision) {
      blocked.push({ id: node.id, reason: `等待決定 ${decision}` });
      continue;
    }
    if (s.status === 'in-progress') {
      dispatchable.push({ id: node.id, leg: nextLeg, kind: 'next-leg', why: `已完成 ${s.legsDone.join(',')},接下一棒 ${nextLeg}`, priority: prio.get(node.id) ?? 0, attempt: 1 });
      continue;
    }
    // todo / stale
    const unmet = depsStatus(node, state, major, { dag, gateE2e: config.integration?.gate_next_version !== false });
    if (unmet.length) continue;
    if (s.retryAfter && Date.parse(s.retryAfter) > now) {
      backoff.push({ id: node.id, until: s.retryAfter, infra_failures: s.infraFailures });
      continue;
    }
    const isRework = s.findings.length > 0;
    dispatchable.push({
      id: node.id,
      leg: nextLeg,
      kind: s.status === 'stale' ? 'reverify' : isRework ? 'rework' : 'fresh',
      why: (node.depends_on ?? []).length
        ? `依賴全部滿足:${node.depends_on.join(', ')}`
        : '沒有依賴',
      priority: prio.get(node.id) ?? 0,
      attempt: isRework ? s.legAttempts + 1 : 1,
      findings: isRework ? s.findings : undefined,
    });
  }
  // 解鎖愈多下游的愈先;同分時重做優先於新開(把已花掉的成本收回來)
  const kindRank = { 'next-leg': 0, rework: 1, reverify: 2, fresh: 3 };
  dispatchable.sort((a, b) => b.priority - a.priority || kindRank[a.kind] - kindRank[b.kind] || a.id.localeCompare(b.id));

  for (const [id, s] of state.nodes) {
    if (s.orphan) warnings.push(`帳本裡有事件指向 dag 不存在的節點 ${id}`);
    if (!byId.has(id)) continue;
  }
  if (config.agents.verifier.backend === 'none') warnings.push('Verifier 模型未設定:模型檢查全部 SKIPPED;有 gherkin 的最後一棒不會自動合併,會交 Critic 或問你');
  if (config.autonomy.level >= 1 && !hasTestGate(config.gates.chain)) warnings.push(NO_TEST_GATE);
  if (backoff.length) warnings.push(`基礎設施失敗(限流/5xx/連線)退避中:${backoff.map((b) => `${b.id} 到 ${b.until}`).join(', ')}`);

  const openDispatches = [...state.dispatches.values()].filter((d) => ['dispatched', 'running'].includes(d.state)).length;
  const unmerged = [...state.dispatches.values()].filter((d) => d.state === 'done').length
    + [...state.decisions.values()].filter((r) => r.request?.ref.startsWith('accept:') && !r.answer).length;
  const today = state.costsByDay.get(todayUtc()) ?? 0;

  return {
    generated_at: nowIso(),
    ledger_seq: state.maxSeq,
    contract_major: major,
    halted: state.halted,
    dispatchable,
    in_progress: inProgress,
    review,
    blocked,
    backoff,
    awaiting_user: {
      decisions: openDecisions(state).map((r) => ({ ref: r.ref, question: r.question, recommendation: r.recommendation ?? null })),
      e2e: pendingE2e(state).map((n) => ({ node: n.id, scenarios: n.e2e.scenarios })),
    },
    counts: {
      nodes: dag.nodes.length,
      done: [...state.nodes.values()].filter((n) => n.status === 'done').length,
      open_dispatches: openDispatches,
      unmerged,
    },
    caps: config.caps,
    budget: { today_usd: Math.round(today * 100) / 100, daily_usd: config.budget.daily_usd, exceeded: today >= config.budget.daily_usd },
    autonomy: config.autonomy.level,
    warnings,
  };
}

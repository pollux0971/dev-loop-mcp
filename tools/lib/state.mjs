// 重播 ledger 得出現況。所有「現在是什麼狀態」的問題都從這裡回答,不讀任何 markdown。

export function pipelineFor(node, config) {
  const base = node.pipeline ?? config.pipeline[node.kind] ?? ['dev'];
  // v4.5:要改到既有程式的節點,先釘住現有行為(characterize),再寫新功能的測試
  if (characterizes(node) && !base.includes('characterize')) return ['characterize', ...base];
  return base;
}

export function characterizes(node) {
  return !!(node.characterize?.targets?.length && node.characterize.tests?.length && node.characterize.cmd && !node.characterize.skip);
}

function freshNode(id) {
  return {
    id,
    status: 'todo',
    legsDone: [],
    legAttempts: 0,
    openDispatch: null,
    branch: null,
    worktree: null,
    findings: [],
    reason: null,
    legBase: null,
    lastSeq: 0,
    acceptedSeq: null,
    e2e: null,
    source: null,
    infraFailures: 0,
    retryAfter: null,
    pendingLeg: null, // v4:退回測試棒修正時是 'test-fix';那一棒做完就清掉,回到原本的 pipeline
    reopens: 0, // v4:這個節點被退回測試棒幾次(上限之後改問使用者,避免來回踢皮球)
    escalations: 0, // v4:這一棒被 Critic 以「照原範圍再試」解鎖幾次;第二次起改問使用者
  };
}

export function replay(events, dag) {
  const nodes = new Map(dag.nodes.map((n) => [n.id, freshNode(n.id)]));
  const dispatches = new Map();
  const decisions = new Map();
  const costsByDay = new Map();
  let halted = null;
  let lastInboxSeq = 0;
  let infraStreak = 0; // 全系統連續幾次基礎設施失敗(共用帳號被限流時會一起發生)
  const ensure = (id) => {
    if (!nodes.has(id)) nodes.set(id, { ...freshNode(id), orphan: true });
    return nodes.get(id);
  };

  for (const ev of events) {
    const n = ev.node_id ? ensure(ev.node_id) : null;
    const d = ev.dispatch_id ? dispatches.get(ev.dispatch_id) : null;
    const dn = d ? ensure(d.node_id) : null;
    const touch = (x) => { if (x) x.lastSeq = ev.seq; };
    switch (ev.type) {
      case 'node_imported':
        n.status = ev.status;
        n.source = ev.source;
        if (ev.status === 'blocked') n.reason = ev.source;
        if (ev.status === 'done') n.acceptedSeq = ev.seq;
        touch(n);
        break;
      case 'dispatch': {
        dispatches.set(ev.dispatch_id, { ...ev, state: 'dispatched', pid: null, seqs: [ev.seq] });
        n.status = 'in-progress';
        n.openDispatch = ev.dispatch_id;
        n.branch = ev.branch;
        n.worktree = ev.worktree;
        n.legAttempts = ev.attempt;
        n.legBase = ev.leg_base ?? n.legBase ?? ev.base_sha;
        touch(n);
        break;
      }
      case 'launched':
        if (d) {
          d.pid = ev.pid; d.state = 'running'; d.seqs.push(ev.seq);
          d.nm_fingerprint = ev.nm_fingerprint ?? null;
        }
        break;
      case 'worker_done':
        if (d) { d.state = 'done'; d.commit = ev.commit; d.report_path = ev.report_path; d.violations_path = ev.violations_path ?? null; d.seqs.push(ev.seq); }
        if (dn) { dn.status = 'review'; dn.infraFailures = 0; dn.retryAfter = null; touch(dn); }
        infraStreak = 0;
        break;
      case 'worker_blocked':
        infraStreak = 0;
        if (d) { d.state = 'blocked'; d.spawn = ev.spawn ?? null; d.reason = ev.reason; d.report_path = ev.report_path; d.seqs.push(ev.seq); }
        if (dn) { dn.status = 'blocked'; dn.reason = ev.spawn ? `等待批准子節點 ${ev.spawn.id}` : ev.reason; dn.openDispatch = null; touch(dn); }
        break;
      case 'worker_failed':
        if (d) { d.state = 'failed'; d.reason = ev.reason; d.failClass = ev.class ?? 'quality'; d.seqs.push(ev.seq); }
        if (ev.class === 'halted') {
          // v4:使用者停機時 dp 主動終止的 worker。不是 worker 的錯:不算嘗試、不動 findings、不退避、不算 infra 連續失敗
          if (dn) {
            dn.status = 'todo';
            dn.openDispatch = null;
            dn.legAttempts = d ? d.attempt - 1 : dn.legAttempts;
            touch(dn);
          }
          break;
        }
        if (ev.class === 'infra') {
          // 不是 worker 的錯:不加嘗試次數、不改 findings,退避到 retry_after 之後用同一個 attempt 重派
          // v4.6:帳號額度用完、但還有別的帳號可換(switched)時不算連續失敗
          if (!ev.switched) infraStreak++;
          if (dn) {
            dn.status = 'todo';
            dn.openDispatch = null;
            dn.legAttempts = d ? d.attempt - 1 : dn.legAttempts;
            dn.infraFailures++;
            dn.retryAfter = ev.retry_after ?? null;
            touch(dn);
          }
          break;
        }
        infraStreak = 0;
        if (dn) {
          dn.status = 'todo';
          dn.openDispatch = null;
          dn.findings = [{ check: 'worker', detail: ev.reason }];
          dn.infraFailures = 0;
          dn.retryAfter = null;
          touch(dn);
        }
        break;
      case 'verify':
        if (d) { d.verify = ev; d.seqs.push(ev.seq); }
        break;
      case 'gates':
        if (d) { d.gates = ev; d.seqs.push(ev.seq); }
        break;
      case 'critic':
        if (d) { d.critic = ev; d.seqs.push(ev.seq); }
        break;
      case 'reject':
        if (d) { d.state = 'rejected'; d.seqs.push(ev.seq); }
        n.status = 'todo';
        n.openDispatch = null;
        n.findings = ev.findings ?? [{ check: 'reject', detail: ev.reason }];
        touch(n);
        break;
      case 'leg_done':
        if (d) { d.state = 'leg_done'; d.seqs.push(ev.seq); }
        if (ev.leg === 'test-fix') n.pendingLeg = null;
        else if (!n.legsDone.includes(ev.leg)) n.legsDone.push(ev.leg);
        n.escalations = 0;
        n.status = 'in-progress';
        n.openDispatch = null;
        n.legAttempts = 0;
        n.findings = [];
        n.legBase = null;
        touch(n);
        break;
      case 'accept':
        if (d) { d.state = 'accepted'; d.merge_sha = ev.merge_sha; d.seqs.push(ev.seq); }
        n.status = 'done';
        n.pendingLeg = null;
        n.reopens = 0;
        n.escalations = 0;
        n.openDispatch = null;
        n.legsDone = [];
        n.legAttempts = 0;
        n.findings = [];
        n.legBase = null;
        n.acceptedSeq = ev.seq;
        touch(n);
        break;
      case 'block':
        n.status = 'blocked';
        n.reason = ev.reason;
        n.openDispatch = null;
        touch(n);
        break;
      case 'leg_reopen':
        // v4:實作棒判定是測試/步驟定義寫錯 → 插一棒 test-fix(同一分支),做完再回到原本卡住的那一棒
        n.status = 'todo';
        n.reason = null;
        n.openDispatch = null;
        n.pendingLeg = ev.leg;
        n.legAttempts = 0;
        n.findings = ev.findings?.length ? ev.findings : [{ check: 'test-fix', detail: '實作棒回報測試寫錯' }];
        n.reopens++;
        touch(n);
        break;
      case 'unblock':
        n.status = n.acceptedSeq ? 'done' : 'todo';
        n.reason = null;
        n.legAttempts = 0;
        if (String(ev.ref ?? '').startsWith('escalation:') && /^Critic/.test(ev.note ?? '')) n.escalations++;
        if (ev.note) n.findings = [{ check: 'guidance', detail: ev.note }];
        touch(n);
        break;
      case 'decision_request':
        decisions.set(ev.ref, { request: ev, answer: decisions.get(ev.ref)?.answer ?? null });
        // v4.7.3:新提案取代舊的(還沒決定的)→ 舊的關掉,不再待決
        for (const old of ev.supersedes ?? []) {
          const rec = decisions.get(old);
          if (rec?.request && !rec.answer) rec.superseded = ev.ref;
        }
        break;
      case 'decision': {
        const rec = decisions.get(ev.ref) ?? { request: null, answer: null };
        rec.answer = ev;
        decisions.set(ev.ref, rec);
        break;
      }
      case 'e2e_request':
        n.e2e = { requestedSeq: ev.seq, scenarios: ev.scenarios, confirm: null };
        touch(n);
        break;
      case 'e2e_confirm':
        if (n.e2e) n.e2e.confirm = ev;
        else n.e2e = { requestedSeq: null, scenarios: [], confirm: ev };
        if (!ev.ok) {
          n.status = 'todo';
          n.findings = [{ check: 'e2e', detail: `使用者試用不通過:${ev.verbatim}` }];
          n.acceptedSeq = null;
        }
        touch(n);
        break;
      case 'contract_bump':
        for (const id of ev.stale) {
          const s = ensure(id);
          if (s.status === 'done') { s.status = 'stale'; s.acceptedSeq = null; touch(s); }
        }
        break;
      case 'cost': {
        const day = ev.ts.slice(0, 10);
        costsByDay.set(day, (costsByDay.get(day) ?? 0) + ev.usd);
        break;
      }
      case 'halt':
        halted = { reason: ev.reason, seq: ev.seq };
        break;
      case 'resume':
        halted = null;
        infraStreak = 0;
        break;
      case 'inbox_viewed':
        lastInboxSeq = ev.seq;
        break;
      default:
        break;
    }
  }
  return {
    nodes,
    dispatches,
    decisions,
    costsByDay,
    halted,
    lastInboxSeq,
    infraStreak,
    maxSeq: events.at(-1)?.seq ?? 0,
  };
}

export function openDecisions(state) {
  return [...state.decisions.values()].filter((d) => d.request && !d.answer && !d.superseded).map((d) => d.request);
}

export function pendingE2e(state) {
  return [...state.nodes.values()].filter((n) => n.e2e && n.e2e.requestedSeq && !n.e2e.confirm);
}

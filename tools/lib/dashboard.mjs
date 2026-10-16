// Visual dashboard: data comes only from replaying dag + ledger (the same source as dlm status). It writes no events.
// The output is one HTML file with its data embedded. With --serve, the same page re-fetches /data.json every few seconds. Zero dependencies.
// v4.6: with --serve, the "accounts" page can set subscription accounts (add, remove, which role uses which). This is the only place that writes. It runs one `dlm account …`,
// exactly like typing the command in a terminal. It needs the token made at this launch and accepts only requests from 127.0.0.1. Decisions and approvals still go only through Front or dlm decide.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { loadConfig } from './config.mjs';
import { loadDag } from './dag.mjs';
import { readEvents } from './ledger.mjs';
import { describe } from './render.mjs';
import { computeSnapshot } from './snapshot.mjs';
import { openDecisions, pendingE2e, pipelineFor, replay } from './state.mjs';
import { ASIS, readBaseline } from './brownfield.mjs';
import { CLIS, ROLES, accountUsage, globalUsage, loadAccounts } from './accounts.mjs';

/** Decisions that exist only while building (not new-feature proposals node: or hand trials; those two are handled on the planning page). */
const BUILD_REFS = /^(accept|escalation|stuck|testfix|spawn):/;

/** All the data the dashboard needs. A pure function (apart from reading files); tests compare against it directly. */
export function dashboardData(root, extra = {}) {
  const config = loadConfig(root);
  const dag = loadDag(root);
  const events = readEvents(root);
  const state = replay(events, dag);
  const snapshot = computeSnapshot({ root, config, dag, state });

  // event -> node: use node_id if present; if only dispatch_id, look up the dispatch
  const dispatchNode = new Map(events.filter((e) => e.type === 'dispatch').map((e) => [e.dispatch_id, e.node_id]));
  const nodeOf = (e) => e.node_id ?? (e.dispatch_id ? dispatchNode.get(e.dispatch_id) : null)
    ?? (typeof e.ref === 'string' && e.ref.startsWith('accept:') ? dispatchNode.get(e.ref.slice(7)) : null) ?? null;

  const costByNode = {};
  const costByRole = {};
  let costTotal = 0;
  for (const e of events.filter((x) => x.type === 'cost')) {
    const n = nodeOf(e) ?? '(其他)';
    costByNode[n] = (costByNode[n] ?? 0) + e.usd;
    costByRole[e.role ?? '?'] = (costByRole[e.role ?? '?'] ?? 0) + e.usd;
    costTotal += e.usd;
  }

  const nodes = dag.nodes.map((n) => {
    const s = state.nodes.get(n.id);
    const mine = events.filter((e) => nodeOf(e) === n.id);
    return {
      id: n.id,
      title: n.title,
      kind: n.kind,
      release: n.release ?? null,
      depends_on: n.depends_on ?? [],
      status: s.status,
      reason: s.reason,
      pipeline: pipelineFor(n, config),
      characterize: n.characterize?.skip ? null : n.characterize?.targets ?? null,
      legs_done: s.legsDone,
      dispatches: mine.filter((e) => e.type === 'dispatch').length,
      rejects: mine.filter((e) => e.type === 'reject').length,
      blocks: mine.filter((e) => e.type === 'block' || e.type === 'worker_blocked').length,
      cost_usd: round(costByNode[n.id] ?? 0),
      e2e: s.e2e ? (s.e2e.confirm ? (s.e2e.confirm.ok ? 'ok' : 'failed') : (s.e2e.requestedSeq ? 'pending' : null)) : null,
      first_ts: mine[0]?.ts ?? null,
      last_ts: mine.at(-1)?.ts ?? null,
    };
  });

  const timeline = events.map((e) => ({
    seq: e.seq,
    ts: e.ts,
    actor: e.actor,
    type: e.type,
    node: nodeOf(e),
    text: describe(e),
    detail: detailOf(e),
    raw: pick(e, RAW_FIELDS),
  }));

  // Per dispatch: the envelope (work order) and the worker's hand-in report. If a file is missing, keep only the fields from the ledger.
  const dispatches = events.filter((e) => e.type === 'dispatch').map((e) => {
    const dir = join(root, 'ledger', 'dispatch', e.dispatch_id);
    const env = readJsonSafe(join(dir, 'envelope.json'));
    const rep = readJsonSafe(join(dir, 'report.json'));
    return {
      id: e.dispatch_id,
      node: e.node_id,
      leg: e.leg,
      attempt: e.attempt,
      seq: e.seq,
      ts: e.ts,
      envelope: env && {
        objective: env.objective ?? null,
        allowed: env.allowed_paths ?? [],
        forbidden: env.forbidden_paths ?? [],
        done_when: env.done_when ?? null,
        acceptance: (env.acceptance ?? []).map((a) => a.cmd),
      },
      report: rep && {
        kind: rep.kind ?? null,
        summary: clip(rep.summary, 1200),
        claims: (rep.claims ?? []).map((c) => ({
          text: clip(c.text, 300),
          cmd: c.evidence?.cmd ?? null,
          exit: c.evidence?.exit ?? null,
          tail: clip(c.evidence?.stdout_tail, 400),
          unverified: !!c.unverified,
          why: clip(c.why, 300),
        })),
      },
    };
  });

  // v4.7.3 Is any software being developed: a node is being built, in acceptance, stuck, in backoff, or ready to dispatch, or a decision is open while building (merge, stuck, send back test leg, child node).
  // When none, the dashboard opens on the planning page (Front · intake): the next thing is to plan the next version with Front, and proposals and hand trials are on that same page.
  const building = snapshot.in_progress.length > 0 || snapshot.review.length > 0 || snapshot.blocked.length > 0
    || snapshot.backoff.length > 0 || snapshot.dispatchable.length > 0
    || openDecisions(state).some((d) => BUILD_REFS.test(d.ref));

  return {
    project: config.name ?? basename(resolve(root)),
    building,
    initial_view: building ? 'console' : 'planning',
    generated_at: new Date().toISOString(),
    ledger_seq: state.maxSeq,
    halted: state.halted,
    autonomy: snapshot.autonomy,
    // v4.5: greenfield / brownfield; an existing project also carries the test baseline and whether AS-IS is written
    mode: projectMode(root, config),
    counts: snapshot.counts,
    in_progress: snapshot.in_progress,
    review: snapshot.review,
    blocked: snapshot.blocked,
    budget: snapshot.budget,
    warnings: snapshot.warnings,
    decisions: openDecisions(state).map((d) => ({ ref: d.ref, question: d.question, options: d.options, recommendation: d.recommendation ?? null, reason: d.reason ?? null })),
    e2e: pendingE2e(state).map((n) => ({ id: n.id, scenarios: n.e2e.scenarios ?? [] })),
    nodes,
    cost: { total_usd: round(costTotal), by_role: mapRound(costByRole), by_node: mapRound(costByNode) },
    // v4.6: subscription account usage (reads only the ledger and this machine's account list; does not call the CLI)
    accounts: accountRows(config, events),
    account_config: accountConfig(config),
    timeline,
    dispatches,
    proposals: readProposals(root),
    roadmap: readRoadmap(root),
    caps: snapshot.caps,
    ...extra,
  };
}

/** What the accounts page needs: the accounts registered on this machine and each role's current setting. */
function accountConfig(config) {
  let registry = {};
  try { registry = loadAccounts(); } catch { /* a broken list is treated as empty */ }
  return {
    clis: Object.entries(CLIS).map(([key, c]) => ({ key, label: c.label })),
    registry: Object.entries(registry).map(([name, a]) => ({ name, cli: a.cli, plan: a.plan ?? null })),
    roles: Object.fromEntries(ROLES.map((r) => {
      const c = config.agents[r] ?? {};
      return [r, { accounts: c.accounts ?? [], model: c.model ?? null, custom_cmd: !!c.cmd, ...(r === 'verifier' ? { backend: c.backend } : {}) }];
    })),
  };
}

/** Account usage: dispatch count, cooldown, and concurrent runs are summed over all projects (v4.7); cost is for this project only. */
function accountRows(config, events) {
  const usage = globalUsage();
  const mine = accountUsage(events);
  let registry = {};
  try { registry = loadAccounts(); } catch { /* a broken list still shows what is in the ledger */ }
  const roles = {};
  for (const role of ROLES) for (const n of config.agents[role]?.accounts ?? []) (roles[n] ??= []).push(role);
  const now = Date.now();
  const names = [...new Set([...Object.keys(roles), ...Object.keys(mine)])];
  return names.map((n) => {
    const u = usage[n] ?? {};
    return {
      name: n, cli: registry[n]?.cli ?? null, plan: registry[n]?.plan ?? null, registered: !!registry[n], roles: roles[n] ?? [],
      max_parallel: registry[n]?.max_parallel ?? null, open: u.open ?? 0,
      dispatches_5h: u.dispatches_5h ?? 0, dispatches_7d: u.dispatches_7d ?? 0, usd_7d: u.usd_7d ?? 0, usd_total: mine[n]?.usd_total ?? 0,
      limited_until: u.limited_until && Date.parse(u.limited_until) > now ? u.limited_until : null, last_used: u.last_used ?? null,
    };
  });
}

/** Long text shown only when expanded: send-back reason, Critic note, verification result, gate result. */
function detailOf(e) {
  switch (e.type) {
    case 'reject': return (e.findings ?? []).map((f) => `[${f.check}] ${f.detail}`).join('\n') || null;
    case 'critic': return e.reason ?? null;
    case 'worker_blocked': case 'worker_failed': case 'unblock': return e.reason ?? e.note ?? null;
    case 'verify': return e.results.map((r) => `${r.outcome.padEnd(12)} ${r.check}${r.detail ? `:${r.detail}` : ''}`).join('\n');
    case 'gates': return (e.results ?? []).map((r) => `${r.exit === 0 ? '✓' : r.known_red ? '≈' : '✗'} ${r.name} (exit ${r.exit}${r.known_red ? `,${r.known_red} 個是基線裡本來就紅的` : ''}, ${r.ms}ms)`).join('\n');
    case 'decision': case 'e2e_confirm': case 'resume': return e.verbatim ? `原話:${e.verbatim}` : null;
    case 'decision_request': return (e.options ?? []).map((o) => `${o.key}:${o.label}`).join('\n') || null;
    default: return null;
  }
}

const RAW_FIELDS = ['dispatch_id', 'leg', 'attempt', 'results', 'verdict', 'usd', 'role', 'ok', 'reason', 'commit', 'merge_sha', 'ref', 'choice', 'findings', 'supersedes',
  'question', 'options', 'recommendation', 'verbatim', 'scenarios'];

/** Proposals (written by intake): the planning page uses them to show "what this version will build" and the gherkin. */
function readProposals(root) {
  const dir = join(root, 'ledger', 'proposals');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => readJsonSafe(join(dir, f))).filter(Boolean).map((p) => ({
    id: p.id,
    kind: p.kind ?? null,
    release: p.release ?? null,
    nodes: (p.nodes ?? (p.node ? [p.node] : [])).map((n) => ({
      id: n.id, title: n.title, kind: n.kind ?? 'phase', intent: clip(n.intent, 600), owns: n.owns ?? [], depends_on: n.depends_on ?? [],
      characterize: n.characterize?.skip ? { skip: clip(n.characterize.skip, 200) } : n.characterize?.targets ? { targets: n.characterize.targets } : null,
    })),
    gherkin: Object.entries(p.files ?? {}).filter(([f]) => f.endsWith('.feature')).map(([path, text]) => ({
      path, scenarios: (String(text).match(/^\s*Scenario( Outline)?:/gm) ?? []).length, text: clip(String(text), 6000),
    })),
  }));
}

function projectMode(root, config) {
  const mode = config.project?.mode ?? 'greenfield';
  if (mode !== 'brownfield') return { mode };
  const b = readBaseline(root);
  return {
    mode,
    language: config.project?.language ?? null,
    test_cmd: config.gates.commands?.test ?? null,
    asis: existsSync(join(root, ASIS)),
    baseline: b ? { main_sha: String(b.main_sha ?? '').slice(0, 8), ts: b.ts ?? null, gates: (b.gates ?? []).map((g) => ({ name: g.name, exit: g.exit, failing: g.failing ? g.failing.length : null })) } : null,
  };
}

/** The "- v1 …" lines of docs/ROADMAP.md; with no such file, return an empty array (the planning page then uses the versions in the dag). */
function readRoadmap(root) {
  const p = join(root, 'docs', 'ROADMAP.md');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').map((l) => l.match(/^\s*[-*]\s*(v\d+(?:\.\d+)*)\s*[:: ]\s*(.+)$/)).filter(Boolean).map((m) => ({ release: m[1], text: m[2].trim() }));
}
const pick = (e, keys) => Object.fromEntries(keys.filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));
const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s ?? null);
function readJsonSafe(p) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; }
}

const round = (x) => Math.round(x * 100) / 100;
const mapRound = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)]));

/** Put data into <script type="application/json">: escape < so no string can close the script tag. */
const embed = (data) => JSON.stringify(data).replace(/</g, '\\u003c');

export function renderDashboard(data, { live = false, intervalMs = 5000, token = '', hub = '' } = {}) {
  return PAGE
    .replace('"__HUB__"', () => JSON.stringify(hub))
    .replace('__TITLE__', () => escapeHtml(`${data.project} · dlm 主控台`))
    .replace('__DATA__', () => embed(data))
    .replace('__LIVE__', live ? String(intervalMs) : '0')
    .replace('"__TOKEN__"', () => JSON.stringify(token));
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const WORD = /^[\w.:@-]{1,60}$/;
const DLM = fileURLToPath(new URL('../dlm.mjs', import.meta.url));

/** Account page action -> argv for dlm account. Every value is checked first, and it does not go through a shell. */
export function accountArgv(body) {
  const bad = (m) => { throw new Error(m); };
  switch (body?.action) {
    case 'list': return ['account', 'list', '--json'];
    case 'add': {
      if (!NAME.test(body.name ?? '')) bad('帳號名稱只能用英數、- 和 _');
      if (!CLIS[body.cli]) bad(`CLI 要是 ${Object.keys(CLIS).join(' / ')}`);
      if (body.plan && !WORD.test(body.plan)) bad('方案名稱只能用英數與 . : @ - _');
      return ['account', 'add', body.name, '--cli', body.cli, ...(body.plan ? ['--plan', body.plan] : [])];
    }
    case 'rm':
      if (!NAME.test(body.name ?? '')) bad('帳號名稱不對');
      return ['account', 'rm', body.name];
    case 'use': {
      if (!ROLES.includes(body.role)) bad('角色不對');
      const list = Array.isArray(body.accounts) ? body.accounts : bad('accounts 要是陣列');
      if (!list.every((n) => NAME.test(n))) bad('帳號名稱不對');
      if (body.model && !WORD.test(body.model)) bad('模型名稱只能用英數與 . : @ - _');
      // Empty model = remove it (none); empty accounts = this role uses no account
      return ['account', 'use', body.role, list.length ? list.join(',') : 'none', '--model', body.model || 'none'];
    }
    default: return bad('不支援的動作');
  }
}

function sameToken(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** POST /api/account: accepts only pages from this machine and this launch (Host / Origin is 127.0.0.1, has x-dlm-token, JSON). */
function accountApi(root, req, res, { token, port }) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const send = (code, obj) => res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
  if (!hosts.includes(req.headers.host)) return send(403, { ok: false, out: 'Host 不對' });
  if (req.headers.origin && !hosts.map((h) => `http://${h}`).includes(req.headers.origin)) return send(403, { ok: false, out: 'Origin 不對' });
  if (!sameToken(req.headers['x-dlm-token'], token)) return send(403, { ok: false, out: 'token 不對(重新整理頁面)' });
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { ok: false, out: '要 JSON' });
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 16384) req.destroy(); });
  req.on('end', () => {
    let argv;
    try { argv = accountArgv(JSON.parse(raw)); } catch (e) { return send(400, { ok: false, out: e.message }); }
    const r = spawnSync(process.execPath, [DLM, ...argv], { cwd: root, encoding: 'utf8', timeout: 60000 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    return send(200, { ok: r.status === 0, out });
  });
}

/** --serve: bind only 127.0.0.1. GET is the read-only dashboard; POST is only for account settings. Every request replays the ledger again, so it always matches dlm status. */
export function serveDashboard(root, { port = 7171, intervalMs = 5000, log = console.log } = {}) {
  const token = randomBytes(24).toString('hex');
  let bound = port;
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (req.method === 'POST' && path === '/api/account') { accountApi(root, req, res, { token, port: bound }); return; }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    try {
      if (path === '/data.json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(dashboardData(root)));
      } else if (path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(renderDashboard(dashboardData(root), { live: true, intervalMs, token }));
      } else {
        res.writeHead(404).end();
      }
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(e.message ?? e));
    }
  });
  return new Promise((resolveP, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      bound = server.address().port;
      log(`主控台:http://127.0.0.1:${bound}/ (每 ${intervalMs / 1000} 秒更新;「帳號」頁可以設定訂閱帳號;Ctrl+C 結束)`);
      resolveP(server);
    });
  });
}

/** The page itself is in dashboard.html next to this file (inline CSS / JS, no external resources). */
const PAGE = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');

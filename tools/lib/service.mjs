// v4.7 Run one operation from api.mjs, whether it came in over HTTP (dlm hub) or MCP (dlm mcp).
// - Project operations: handed to "that project's own tools/dlm.mjs" (`dlm op <name>`, stdin JSON → stdout JSON), so differing versions do not misread the format.
// - Machine-level things (project list, accounts, create project, upgrade): done right here.
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { addAccount, configDir, removeAccount, updateAccount } from './accounts.mjs';
import { ROUTES } from './api.mjs';
import { FLOW, PROMPTS, RULES, toolName } from './flow.mjs';
import { init, upgrade } from './install.mjs';
import { VERSION, accountRows } from './ops.mjs';
import { isLegacyProject, projectCli, projectPaths } from './legacy.mjs';
import { addProject, isDlmProject, loadProjects, projectVersion, removeProject, resolveProject } from './projects.mjs';
import { DlmError } from './util.mjs';
import { fileURLToPath } from 'node:url';

const DLM = JSON.stringify(fileURLToPath(new URL('../dlm.mjs', import.meta.url)));

/** Name or path → project. If the path is a dlm project but not registered yet, register it on the way (no need to add first). */
export function findProject(nameOrPath) {
  if (!nameOrPath) throw new DlmError('要指定 project(名稱或路徑;dlm_list_projects 看有哪些)', 3);
  try {
    return resolveProject(nameOrPath);
  } catch (e) {
    const abs = resolve(String(nameOrPath));
    if (String(nameOrPath).includes('/') && isDlmProject(abs)) return addProject(abs);
    throw e;
  }
}

/** Run `dlm op <name>` inside the project. Returns { ok, result } or { ok:false, error, status }. */
export function projectOp(path, name, args = {}, { timeoutMs = 120000 } = {}) {
  return new Promise((resolveP) => {
    if (!isDlmProject(path)) { resolveP({ ok: false, error: `${path} 不見了或不是 dlm 專案`, status: 404 }); return; }
    // tools/dlm.mjs, or tools/dp.mjs in a project not upgraded since 4.8.0 (its own CLI reads its own layout)
    const child = spawn(process.execPath, [projectCli(path), 'op', name], { cwd: path, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const last = out.trim().split('\n').at(-1) ?? '';
      try {
        const r = JSON.parse(last);
        if (typeof r.ok === 'boolean') { resolveP(r); return; }
      } catch { /* 往下 */ }
      if (/不認識的指令 op/.test(err)) {
        resolveP({ ok: false, status: 501, error: `這個專案的 dlm 是 ${projectVersion(path) ?? '舊版'},要 4.7 以上才能這樣用。先升級:dlm_upgrade_project(或在專案裡跑 node <新版 dlm>/tools/dlm.mjs upgrade)` });
      } else {
        resolveP({ ok: false, status: 500, error: `dlm op ${name} 失敗(exit ${code}):${(err || out).trim().slice(-600)}` });
      }
    });
    child.stdin.end(JSON.stringify(args ?? {}));
  });
}

/** Cache read operations: if the ledger, config, dag, proposals, background loop and cross-project account records are unchanged, return the last result (at most 20 seconds). */
const READ_CACHE = new Map();
const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
function fingerprint(path) {
  const { config, stateDir } = projectPaths(path);
  return [
    mtime(join(path, 'ledger', 'events.jsonl')), mtime(config), mtime(join(path, 'dag.json')),
    mtime(join(path, 'ledger', 'proposals')), existsSync(join(stateDir, 'run.lock')), mtime(join(stateDir, 'run.stop')),
    mtime(join(configDir(), 'account-log.jsonl')), mtime(join(configDir(), 'accounts.json')),
  ].join(':');
}
export async function cachedOp(path, name, args) {
  const key = `${path}\0${name}\0${JSON.stringify(args)}`;
  const fp = fingerprint(path);
  const hit = READ_CACHE.get(key);
  if (hit && hit.fp === fp && Date.now() - hit.at < 20000) return hit.r;
  const r = await projectOp(path, name, args);
  if (r.ok) READ_CACHE.set(key, { fp, at: Date.now(), r });
  return r;
}
export const clearCache = () => READ_CACHE.clear();

// ------------------------------------------------------------------ overview

function summarize(name, path, r) {
  const legacy = isLegacyProject(path);
  if (!r.ok) return { name, path, version: projectVersion(path), legacy, error: r.error };
  const s = r.result;
  return {
    name, path, version: s.version, legacy, mode: s.mode, halted: s.halted ? s.halted.reason ?? true : null,
    loop: s.loop, counts: s.counts, budget: s.budget,
    in_progress: s.in_progress, review: s.review, blocked: s.blocked, dispatchable: s.dispatchable.length,
    awaiting_user: s.awaiting_user, warnings: s.warnings, ledger_seq: s.ledger_seq, last_event_ts: s.last_event_ts,
  };
}

export async function overview() {
  const projects = loadProjects();
  const list = await Promise.all(Object.entries(projects).map(async ([name, p]) => summarize(name, p.path, await cachedOp(p.path, 'status', {}))));
  const ok = list.filter((p) => !p.error);
  const sum = (f) => ok.reduce((n, p) => n + f(p), 0);
  return {
    generated_at: new Date().toISOString(),
    version: VERSION,
    totals: {
      projects: list.length, loops_running: sum((p) => (p.loop?.running ? 1 : 0)), workers: sum((p) => p.in_progress.length), review: sum((p) => p.review.length),
      awaiting_user: sum((p) => p.awaiting_user.decisions + p.awaiting_user.e2e + (p.awaiting_user.halted ? 1 : 0)),
      blocked: sum((p) => p.blocked.length), done: sum((p) => p.counts.done), nodes: sum((p) => p.counts.nodes),
      today_usd: Math.round(sum((p) => p.budget.today_usd) * 100) / 100, errors: list.length - ok.length,
    },
    projects: list,
    accounts: accountRows(null),
  };
}

// ------------------------------------------------------------------ machine-level operations

export function flowDoc() {
  const byId = Object.fromEntries(ROUTES.map((r) => [r.id, r]));
  return {
    stages: FLOW.map((st) => ({
      ...st,
      steps: st.steps.map((x) => (x.call ? { ...x, tool: toolName(x.call), http: `${byId[x.call].method} ${byId[x.call].path}` } : x)),
    })),
    rules: RULES,
    prompts: PROMPTS.map((p) => ({ name: p.name, title: p.title, description: p.description, stages: p.flow })),
  };
}

const MACHINE = {
  flow: () => flowDoc(),
  overview: () => overview(),
  listProjects: () => ({
    projects: Object.entries(loadProjects()).map(([name, p]) => {
      const exists = isDlmProject(p.path);
      return { name, path: p.path, added: p.added, exists, version: exists ? projectVersion(p.path) : null, legacy: exists && isLegacyProject(p.path) };
    }),
  }),
  addProject: (a) => addProject(a.path, { name: a.name ?? null }),
  initProject: (a) => {
    if (!String(a.path).startsWith('/') && !/^[A-Za-z]:[\\/]/.test(String(a.path))) throw new DlmError('path 要是絕對路徑');
    const r = init(a.path, { name: a.name, existing: !!a.existing, ...(a.stack ? { stack: a.stack } : {}) });
    const p = addProject(a.path, { name: a.name ?? null });
    return { project: p.name, path: p.path, created: r.created.length, kept: r.kept.length, git: r.git, next: `${toolName('setupProject')}(project: "${p.name}")` };
  },
  upgradeProject: (a, params) => {
    const p = findProject(params.project);
    const r = upgrade(p.path, { dryRun: !!a.dry_run });
    if (!a.dry_run) clearCache();
    return { project: p.name, ...r, dry_run: !!a.dry_run };
  },
  removeProject: (a, params) => removeProject(findProject(params.project).name),
  listAccounts: (a) => ({ accounts: accountRows(null, { login: !!a.login }) }),
  addAccount: (a) => ({ ...addAccount(a.name, { cli: a.cli, plan: a.plan ?? null, maxParallel: a.max_parallel ?? null }), next: `請使用者在自己的終端機跑:node ${DLM} account login ${a.name}` }),
  updateAccount: (a, params) => updateAccount(params.account, { ...('plan' in a ? { plan: a.plan } : {}), ...('max_parallel' in a ? { maxParallel: a.max_parallel } : {}) }),
  removeAccount: (a, params) => removeAccount(params.account),
};

/** Alive? Version and how many projects are registered (shared by hub GET /api/v1/health and MCP dlm_health). */
export const health = () => ({ ok: true, version: VERSION, projects: Object.keys(loadProjects()).length });

/**
 * Run one route (stream and openapi are handled by the transport layer itself). args were already checked (api.buildArgs).
 * Returns { status, body }; on failure body = { error: { message, status } }.
 */
export async function execRoute(route, params, args) {
  const err = (status, message) => ({ status, body: { error: { message, status } } });
  try {
    // v4.7.3: health is also listed as a tool over MCP (dlm_health); before, only the hub handled it, so every call from MCP failed
    if (route.id === 'health') return { status: 200, body: health() };
    if (route.kind === 'machine') {
      const body = await MACHINE[route.id](args, params);
      if (route.write) clearCache();
      return { status: route.ok ?? 200, body };
    }
    if (route.kind !== 'op') return err(400, `${route.id} 不能這樣呼叫`);
    const project = findProject(params.project);
    const r = route.write ? await projectOp(project.path, route.op, args, { timeoutMs: route.op === 'tick' || route.op === 'setup' || route.op === 'onboard' ? 60 * 60000 : 120000 })
      : await cachedOp(project.path, route.op, args);
    if (!r.ok) return err(r.status ?? 400, r.error);
    if (route.write) clearCache();
    return { status: route.ok ?? 200, body: r.result };
  } catch (e) {
    if (e instanceof DlmError) return err(e.code === 3 ? 404 : e.code === 2 ? 409 : 400, e.message);
    return err(500, String(e?.message ?? e));
  }
}

// v4.7 `dlm hub`: overview, monitoring and API for every dlm project on one machine (defined in api.mjs). Binds to 127.0.0.1 only.
//
// - Project operations are always handed to "that project's own tools/dlm.mjs" (`dlm op <name>`, JSON in on stdin, JSON out on stdout),
//   so a project with a different installed dlm version does not get its format misread; the hub itself only handles the project list, accounts, routing, cache and the event stream.
// - Every request must carry a token (~/.config/dlm/hub-token, mode 600; see it with `dlm hub token`): Authorization: Bearer <token>.
//   Reject it if Host / Origin is not 127.0.0.1 or localhost (blocks DNS rebinding and other websites). The page embeds the token itself, so other sites cannot read it.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { addAccount, configDir, removeAccount } from './accounts.mjs';
import { buildArgs, matchRoute, openapi } from './api.mjs';
import { renderDashboard } from './dashboard.mjs';
import { VERSION, accountRows } from './ops.mjs';
import { loadProjects } from './projects.mjs';
import { cachedOp, clearCache, execRoute, findProject, health, overview, projectOp } from './service.mjs';
import { DlmError } from './util.mjs';

export const hubTokenFile = () => join(configDir(), 'hub-token');

/** Read the token; if there is none, create one (readable only by you). */
export function hubToken({ create = true } = {}) {
  const p = hubTokenFile();
  if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  if (!create) return null;
  mkdirSync(configDir(), { recursive: true });
  const t = randomBytes(24).toString('hex');
  writeFileSync(p, `${t}\n`, { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* Windows */ }
  return t;
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

// ------------------------------------------------------------------ event stream (SSE)

/** Follow the tail of a ledger file: read only the newly added bytes. */
function ledgerTail(path) {
  const file = join(path, 'ledger', 'events.jsonl');
  let pos = (() => { try { return statSync(file).size; } catch { return 0; } })();
  let rest = '';
  return () => {
    let size;
    try { size = statSync(file).size; } catch { return []; }
    if (size < pos) { pos = 0; rest = ''; }
    if (size === pos) return [];
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(size - pos);
    try { readSync(fd, buf, 0, buf.length, pos); } finally { closeSync(fd); }
    pos = size;
    const lines = (rest + buf.toString('utf8')).split('\n');
    rest = lines.pop();
    const out = [];
    for (const l of lines) {
      try { out.push(strip(JSON.parse(l))); } catch { /* 跳過壞行 */ }
    }
    return out;
  };
}

const strip = ({ mac: _m, prev_hash: _p, chain_start: _c, ...e }) => e;

/** The last n entries of a ledger (reads only the last 512KB of the file). */
function lastEvents(path, n) {
  const file = join(path, 'ledger', 'events.jsonl');
  let size;
  try { size = statSync(file).size; } catch { return []; }
  const len = Math.min(size, 512 * 1024);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  const lines = buf.toString('utf8').split('\n').filter(Boolean);
  if (len < size) lines.shift(); // The first line may be cut in half
  const out = [];
  for (const l of lines.slice(-n)) { try { out.push(strip(JSON.parse(l))); } catch { /* 跳過壞行 */ } }
  return out;
}

const sse = (n, e, recent) => `id: ${n}:${e.seq}\nevent: ledger\ndata: ${JSON.stringify({ project: n, event: e, ...(recent ? { recent: true } : {}) })}\n\n`;

function stream(req, res, names, recent = 0) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(`: dlm hub ${VERSION}\n\n`);
  const tails = new Map();
  const sync = () => {
    const projects = loadProjects();
    for (const [n, p] of Object.entries(projects)) if ((!names || names.includes(n)) && !tails.has(n)) tails.set(n, ledgerTail(p.path));
    for (const n of [...tails.keys()]) if (!projects[n]) tails.delete(n);
  };
  sync();
  if (recent > 0) {
    // First backfill the latest `recent` entries (all projects ordered by time), with data carrying recent:true; new events come after that
    const projects = loadProjects();
    const back = [...tails.keys()].flatMap((n) => lastEvents(projects[n].path, recent).map((e) => [n, e]));
    back.sort((a, b) => String(a[1].ts).localeCompare(String(b[1].ts)));
    for (const [n, e] of back.slice(-recent)) res.write(sse(n, e, true));
  }
  let beat = 0;
  const timer = setInterval(() => {
    if (++beat % 10 === 0) sync();
    for (const [n, read] of tails) {
      for (const e of read()) res.write(sse(n, e, false));
    }
    if (beat % 15 === 0) res.write(': ping\n\n');
  }, 1000);
  req.on('close', () => clearInterval(timer));
}

// ------------------------------------------------------------------ HTTP

const HUB_PAGE = readFileSync(new URL('./hub.html', import.meta.url), 'utf8');
const embed = (data) => JSON.stringify(data).replace(/</g, '\\u003c');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readBody(req) {
  let raw = '';
  for await (const c of req) {
    raw += c;
    if (raw.length > 2 * 1024 * 1024) throw new HttpError(413, 'body 太大(上限 2MB)');
  }
  if (!raw.trim()) return null;
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'body 要是 application/json');
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'body 不是合法的 JSON'); }
}

const fail = (e) => {
  if (e instanceof HttpError) return { status: e.status, message: e.message };
  if (e instanceof DlmError) return { status: e.code === 3 ? 404 : e.code === 2 ? 409 : 400, message: e.message };
  return { status: 500, message: String(e?.message ?? e) };
};

export async function handleApi(req, res, url, { port }) {
  const send = (status, obj) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
  const error = (status, message) => send(status, { error: { message, status } });
  const m = matchRoute(req.method, url.pathname);
  if (!m) return error(404, `沒有這個端點:${req.method} ${url.pathname}(GET /api/v1/openapi.json 看全部)`);
  if (m.methodNotAllowed) { res.setHeader('allow', m.methodNotAllowed.join(', ')); return error(405, `${url.pathname} 只接受 ${m.methodNotAllowed.join(' / ')}`); }
  const { route, params } = m;
  if (route.id === 'health') return send(200, health());
  if (route.id === 'openapi') {
    const spec = openapi(VERSION);
    spec.servers = [{ url: `http://127.0.0.1:${port}` }];
    return send(200, spec);
  }
  let body = null;
  try { body = req.method === 'GET' ? null : await readBody(req); } catch (e) { const f = fail(e); return error(f.status, f.message); }
  const built = buildArgs(route, params, url.searchParams, body);
  if (built.error) return error(400, built.error);
  if (route.kind === 'stream') {
    try {
      const names = params.project ? [findProject(params.project).name] : built.args.projects ? String(built.args.projects).split(',') : null;
      return stream(req, res, names, Number(built.args.recent ?? 0));
    } catch (e) { const f = fail(e); return error(f.status, f.message); }
  }
  const r = await execRoute(route, params, built.args);
  return send(r.status, r.body);
}

/** Account API for the single-project console page (used by the v4.6 page; format unchanged: { ok, out }). */
async function legacyAccountApi(req, res, project) {
  const send = (obj) => res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
  let body;
  try { body = await readBody(req); } catch (e) { return send({ ok: false, out: e.message }); }
  try {
    switch (body?.action) {
      case 'list': return send({ ok: true, out: JSON.stringify({ accounts: accountRows(project.path, { login: true }) }) });
      case 'add': { const a = addAccount(body.name, { cli: body.cli, plan: body.plan || null }); return send({ ok: true, out: `✓ 帳號 ${a.name} 登記好了。下一步在終端機:node tools/dlm.mjs account login ${a.name}` }); }
      case 'rm': { removeAccount(body.name); return send({ ok: true, out: `已移除 ${body.name}` }); }
      case 'use': {
        const r = await projectOp(project.path, 'set_role', { role: body.role, accounts: body.accounts ?? [], model: body.model || null });
        clearCache();
        if (!r.ok) return send({ ok: false, out: r.error });
        const x = r.result;
        return send({ ok: true, out: `${x.accounts.length ? `✓ ${x.role} 輪流用 ${x.accounts.join('、')}${x.model ? `(模型 ${x.model})` : ''}` : `✓ ${x.role} 不用帳號了`}${x.not_logged_in.length ? `\n  還沒登入:${x.not_logged_in.map((n) => `dlm account login ${n}`).join(';')}` : ''}` });
      }
      default: return send({ ok: false, out: '不支援的動作' });
    }
  } catch (e) {
    return send({ ok: false, out: e.message });
  }
}

export function serveHub({ port = 7170, intervalMs = 5000, log = console.log } = {}) {
  const token = hubToken();
  let bound = port;
  const server = createServer(async (req, res) => {
    const hosts = [`127.0.0.1:${bound}`, `localhost:${bound}`];
    const deny = (status, message) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: { message, status } }));
    if (!hosts.includes(req.headers.host)) return deny(403, 'Host 不對(只接受 127.0.0.1 / localhost)');
    if (req.headers.origin && !hosts.map((h) => `http://${h}`).includes(req.headers.origin)) return deny(403, 'Origin 不對');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    try {
      if (path.startsWith('/api/')) {
        const open = path === '/api/v1/health' || path === '/api/v1/openapi.json';
        const auth = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const given = auth || req.headers['x-dlm-token'] || (path.endsWith('/stream') ? url.searchParams.get('token') : null);
        if (!open && !sameToken(given, token)) return deny(401, '沒有或錯誤的 token(Authorization: Bearer <token>;dlm hub token 看)');
        return await handleApi(req, res, url, { port: bound });
      }
      if (path === '/favicon.ico') return res.writeHead(204).end();
      if (req.method === 'GET' && path === '/') {
        const page = HUB_PAGE.replace('"__TOKEN__"', () => JSON.stringify(token)).replace('__LIVE__', String(intervalMs)).replace('__DATA__', () => embed(await0(overviewSafe)));
        return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page);
      }
      const pm = path.match(/^\/p\/([^/]+)(\/.*)?$/);
      if (pm) {
        const project = findProject(decodeURIComponent(pm[1]));
        const sub = pm[2] ?? '';
        if (sub === '') return res.writeHead(302, { location: `/p/${encodeURIComponent(project.name)}/` }).end();
        if (req.method === 'POST' && sub === '/api/account') {
          if (!sameToken(req.headers['x-dlm-token'], token)) return deny(403, 'token 不對(重新整理頁面)');
          return await legacyAccountApi(req, res, project);
        }
        if (req.method !== 'GET') return deny(405, '只接受 GET');
        if (sub === '/data.json') {
          const r = await cachedOp(project.path, 'dashboard', {});
          if (!r.ok) return deny(r.status ?? 500, r.error);
          return res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(r.result));
        }
        if (sub === '/') {
          const r = await cachedOp(project.path, 'dashboard', {});
          if (!r.ok) return res.writeHead(r.status ?? 500, { 'content-type': 'text/plain; charset=utf-8' }).end(r.error);
          return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(renderDashboard(r.result, { live: true, intervalMs, token, hub: '/' }));
        }
      }
      return deny(404, '找不到');
    } catch (e) {
      const f = fail(e);
      return deny(f.status, f.message);
    }
  });
  // The home page embeds an overview so it has data on open; after that the page hits /api/v1/overview every few seconds
  let lastOverview = null;
  const overviewSafe = () => lastOverview;
  const await0 = (f) => f() ?? { projects: [], accounts: [], totals: null, loading: true };
  const refresh = () => overview().then((o) => { lastOverview = o; }).catch(() => {});
  refresh();
  const timer = setInterval(refresh, Math.max(intervalMs, 3000));
  server.on('close', () => clearInterval(timer));
  return new Promise((resolveP, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      bound = server.address().port;
      log(`dlm hub:http://127.0.0.1:${bound}/ (所有專案的總覽;API 在 /api/v1,規格 /api/v1/openapi.json;Ctrl+C 結束)`);
      resolveP(server);
    });
  });
}

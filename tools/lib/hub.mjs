// v4.7 `dp hub`:一台電腦上所有 dp 專案的總覽、監控與 API(定義在 api.mjs)。只綁 127.0.0.1。
//
// - 專案的操作一律交給「那個專案自己的 tools/dp.mjs」執行(`dp op <名稱>`,stdin 進 JSON、stdout 出 JSON),
//   專案裝的 dp 版本不同也不會讀錯格式;hub 自己只管專案清單、帳號、路由、快取與事件串流。
// - 每個請求都要帶 token(~/.config/dp/hub-token,權限 600;`dp hub token` 看):Authorization: Bearer <token>。
//   Host / Origin 不是 127.0.0.1 或 localhost 就拒絕(擋 DNS rebinding 與別的網站)。頁面本身內嵌 token,別的網站讀不到它。
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
import { DpError } from './util.mjs';

export const hubTokenFile = () => join(configDir(), 'hub-token');

/** 讀 token;沒有就產生一個(只有你自己讀得到)。 */
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

// ------------------------------------------------------------------ 事件串流(SSE)

/** 盯一個帳本檔的尾巴:只讀新增的位元組。 */
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

/** 帳本最後 n 筆(只讀檔尾 512KB)。 */
function lastEvents(path, n) {
  const file = join(path, 'ledger', 'events.jsonl');
  let size;
  try { size = statSync(file).size; } catch { return []; }
  const len = Math.min(size, 512 * 1024);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  const lines = buf.toString('utf8').split('\n').filter(Boolean);
  if (len < size) lines.shift(); // 第一行可能被切一半
  const out = [];
  for (const l of lines.slice(-n)) { try { out.push(strip(JSON.parse(l))); } catch { /* 跳過壞行 */ } }
  return out;
}

const sse = (n, e, recent) => `id: ${n}:${e.seq}\nevent: ledger\ndata: ${JSON.stringify({ project: n, event: e, ...(recent ? { recent: true } : {}) })}\n\n`;

function stream(req, res, names, recent = 0) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(`: dp hub ${VERSION}\n\n`);
  const tails = new Map();
  const sync = () => {
    const projects = loadProjects();
    for (const [n, p] of Object.entries(projects)) if ((!names || names.includes(n)) && !tails.has(n)) tails.set(n, ledgerTail(p.path));
    for (const n of [...tails.keys()]) if (!projects[n]) tails.delete(n);
  };
  sync();
  if (recent > 0) {
    // 先補最近的 recent 筆(所有專案依時間排),data 帶 recent:true;之後才是新事件
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
  if (e instanceof DpError) return { status: e.code === 3 ? 404 : e.code === 2 ? 409 : 400, message: e.message };
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

/** 單一專案主控台頁面的帳號 API(v4.6 的頁面用,格式照舊:{ ok, out })。 */
async function legacyAccountApi(req, res, project) {
  const send = (obj) => res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
  let body;
  try { body = await readBody(req); } catch (e) { return send({ ok: false, out: e.message }); }
  try {
    switch (body?.action) {
      case 'list': return send({ ok: true, out: JSON.stringify({ accounts: accountRows(project.path, { login: true }) }) });
      case 'add': { const a = addAccount(body.name, { cli: body.cli, plan: body.plan || null }); return send({ ok: true, out: `✓ 帳號 ${a.name} 登記好了。下一步在終端機:node tools/dp.mjs account login ${a.name}` }); }
      case 'rm': { removeAccount(body.name); return send({ ok: true, out: `已移除 ${body.name}` }); }
      case 'use': {
        const r = await projectOp(project.path, 'set_role', { role: body.role, accounts: body.accounts ?? [], model: body.model || null });
        clearCache();
        if (!r.ok) return send({ ok: false, out: r.error });
        const x = r.result;
        return send({ ok: true, out: `${x.accounts.length ? `✓ ${x.role} 輪流用 ${x.accounts.join('、')}${x.model ? `(模型 ${x.model})` : ''}` : `✓ ${x.role} 不用帳號了`}${x.not_logged_in.length ? `\n  還沒登入:${x.not_logged_in.map((n) => `dp account login ${n}`).join(';')}` : ''}` });
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
        const given = auth || req.headers['x-dp-token'] || (path.endsWith('/stream') ? url.searchParams.get('token') : null);
        if (!open && !sameToken(given, token)) return deny(401, '沒有或錯誤的 token(Authorization: Bearer <token>;dp hub token 看)');
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
          if (!sameToken(req.headers['x-dp-token'], token)) return deny(403, 'token 不對(重新整理頁面)');
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
  // 首頁內嵌一份總覽,打開就有資料;之後頁面每幾秒打 /api/v1/overview
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
      log(`dp hub:http://127.0.0.1:${bound}/ (所有專案的總覽;API 在 /api/v1,規格 /api/v1/openapi.json;Ctrl+C 結束)`);
      resolveP(server);
    });
  });
}

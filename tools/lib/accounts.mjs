// v4.6 多帳號(訂閱方案)。做法跟 Orca 的帳號切換一樣:每個帳號一個獨立的設定目錄,
// Claude Code 用 CLAUDE_CONFIG_DIR、Codex 用 CODEX_HOME;在那個目錄登入一次,之後派工時帶上環境變數就是用那個帳號。
//
// 帳號清單是這台電腦的(~/.config/dlm/accounts.json,DLM_ACCOUNTS_FILE 可改),不進 repo:登入目錄的路徑跟憑證都是你個人的。
// 專案的 dlm.config.json 只寫「哪個角色用哪幾個帳號」(agents.worker.accounts = ["max-a", "max-b"])。
// 一個角色有好幾個帳號時,dlm 輪流用(最近用得最少的先),被限流的帳號冷卻到重置時間,期間跳過、改派下一個。
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { machineDir } from './legacy.mjs';
import { DlmError, readJson, run, writeJson } from './util.mjs';

/** 這台電腦的 dlm 設定目錄(帳號、專案清單、跨專案的帳號用量、hub token)。DLM_CONFIG_DIR 可改。 */
export function configDir() {
  if (process.env.DLM_CONFIG_DIR) return process.env.DLM_CONFIG_DIR;
  if (process.env.DLM_ACCOUNTS_FILE) return dirname(process.env.DLM_ACCOUNTS_FILE);
  return machineDir();
}

export function accountsFile() {
  return process.env.DLM_ACCOUNTS_FILE || join(configDir(), 'accounts.json');
}
const accountsDir = () => join(configDir(), 'accounts');

/**
 * 支援的 CLI。homeEnv = 帳號目錄用哪個環境變數指定;clearEnv = 會蓋過帳號目錄的環境變數(派工時清掉,
 * 否則你 shell 裡的 ANTHROPIC_API_KEY 會讓每個帳號都變成同一把金鑰)。
 * worker / critic / verifier 是沒有自己填 cmd 時用的預設指令;{model} 換成角色設定的 model(沒設就拿掉)。
 * claude 的指令實跑驗過;codex 的照它的文件寫,還沒實跑(見 README 的「狀態」)。
 */
export const CLIS = {
  claude: {
    label: 'Claude Code',
    homeEnv: 'CLAUDE_CONFIG_DIR',
    clearEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
    login: 'claude auth login',
    status: 'claude auth status --json',
    model: (m) => `--model ${m}`,
    worker: 'claude -p --output-format json {model} --permission-mode acceptEdits --allowedTools "Bash" --disallowedTools "Bash(rm -rf *)" "Bash(rm -fr *)" "Bash(sudo *)" < "$DLM_PROMPT"',
    critic: 'claude -p --output-format json {model} --allowedTools "Read" "Grep" "Glob" "Bash(npm test*)" "Bash(npm run *)" "Bash(npx vitest*)" "Bash(npx cucumber-js*)" "Bash(git diff*)" "Bash(git log*)" "Bash(git show*)" --disallowedTools "Edit" "Write" "NotebookEdit"',
    verifier: 'claude -p {model} --tools "" --no-session-persistence',
    defaultVerifierModel: 'haiku',
  },
  codex: {
    label: 'Codex CLI',
    homeEnv: 'CODEX_HOME',
    clearEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    login: 'codex login',
    status: 'codex login status',
    model: (m) => `-m ${m}`,
    // worker 的副本沒有 .git:要 --skip-git-repo-check;`-` = prompt 從 stdin 讀
    worker: 'codex exec --skip-git-repo-check --sandbox workspace-write {model} - < "$DLM_PROMPT"',
    critic: 'codex exec --skip-git-repo-check --sandbox read-only {model} -',
    verifier: 'codex exec --skip-git-repo-check --sandbox read-only {model} -',
  },
};

export function cliOf(name) {
  const c = CLIS[name];
  if (!c) throw new DlmError(`不支援的 CLI「${name}」(支援:${Object.keys(CLIS).join('、')})。其他工具照舊在 agents.<角色>.cmd 自己寫指令`);
  return c;
}

export function loadAccounts() {
  return readJson(accountsFile(), { accounts: {} }).accounts ?? {};
}
function saveAccounts(accounts) {
  mkdirSync(dirname(accountsFile()), { recursive: true });
  writeJson(accountsFile(), { accounts });
}

export function getAccount(name) {
  const a = loadAccounts()[name];
  if (!a) throw new DlmError(`沒有帳號「${name}」。先 dlm account add ${name} --cli claude`);
  return { name, ...a };
}

const posInt = (v, what) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new DlmError(`${what} 要是 1–50 的整數`);
  return n;
};

export function addAccount(name, { cli, plan = null, home = null, maxParallel = null } = {}) {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(name ?? '')) throw new DlmError('帳號名稱只能用英數、- 和 _(例:max-a、codex-plus)');
  cliOf(cli);
  const accounts = loadAccounts();
  if (accounts[name]) throw new DlmError(`帳號「${name}」已經有了`);
  const dir = home ?? join(accountsDir(), name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mp = posInt(maxParallel, '同時上限');
  accounts[name] = { cli, home: dir, ...(plan ? { plan } : {}), ...(mp ? { max_parallel: mp } : {}), added: new Date().toISOString() };
  saveAccounts(accounts);
  return { name, ...accounts[name] };
}

/** 改方案名稱或同時上限(null = 拿掉)。 */
export function updateAccount(name, { plan, maxParallel } = {}) {
  const accounts = loadAccounts();
  const a = accounts[name];
  if (!a) throw new DlmError(`沒有帳號「${name}」`);
  if (plan !== undefined) { if (plan) a.plan = plan; else delete a.plan; }
  if (maxParallel !== undefined) { const mp = posInt(maxParallel, '同時上限'); if (mp) a.max_parallel = mp; else delete a.max_parallel; }
  saveAccounts(accounts);
  return { name, ...a };
}

/** 只刪清單;dlm 自己建的登入目錄一起刪(裡面是那個帳號的憑證),你指定的目錄不動。 */
export function removeAccount(name) {
  const accounts = loadAccounts();
  const a = accounts[name];
  if (!a) throw new DlmError(`沒有帳號「${name}」`);
  delete accounts[name];
  saveAccounts(accounts);
  const owned = a.home === join(accountsDir(), name);
  if (owned && existsSync(a.home)) rmSync(a.home, { recursive: true, force: true });
  return { removed: name, home_deleted: owned };
}

/** 派工時加的環境變數:指到帳號目錄,並清掉會蓋過它的金鑰(值設成空字串,childEnv 之後刪掉)。 */
export function accountEnv(account) {
  const c = cliOf(account.cli);
  const env = { [c.homeEnv]: account.home, DLM_ACCOUNT: account.name };
  for (const k of c.clearEnv) env[k] = '';
  return env;
}

/** 登入狀態(呼叫 CLI 自己的 status 指令,不讀憑證檔)。 */
export function loginStatus(account) {
  const c = cliOf(account.cli);
  const r = run(c.status, { env: accountEnv(account), timeoutMs: 20000 });
  if (r.code === 127) return { ok: false, detail: `找不到 ${account.cli} 指令` };
  const out = `${r.stdout}${r.stderr}`;
  if (account.cli === 'claude') {
    try {
      const j = JSON.parse(r.stdout);
      return j.loggedIn ? { ok: true, detail: [j.email ?? j.account?.email, j.subscriptionType ?? j.authMethod].filter(Boolean).join(' · ') || '已登入' } : { ok: false, detail: '沒登入' };
    } catch { /* 往下 */ }
  }
  return r.code === 0 && !/not logged in/i.test(out) ? { ok: true, detail: out.trim().split('\n')[0]?.slice(0, 80) || '已登入' } : { ok: false, detail: '沒登入' };
}

// ------------------------------------------------------------------ 角色 → 指令與帳號

export const ROLES = ['worker', 'critic', 'verifier'];

/** 角色要跑的指令:自己寫了 cmd 就用它;沒寫但有帳號,就用帳號那個 CLI 的預設指令。 */
export function roleCmd(roleCfg, role, account) {
  if (roleCfg?.cmd) return roleCfg.cmd;
  if (!account) return null;
  const c = cliOf(account.cli);
  const model = roleCfg?.model ?? (role === 'verifier' ? c.defaultVerifierModel : null);
  return c[role].replace('{model}', model ? c.model(model) : '').replace(/\s{2,}/g, ' ');
}

/** 帳號被限流到什麼時候。從 worker log 抓重置時間;抓不到就冷卻 cooldown_minutes。 */
export function limitedUntil(logText, now = Date.now(), cooldownMinutes = 30) {
  const t = String(logText ?? '');
  // Claude Code:「Claude AI usage limit reached|1760000000」
  const unix = t.match(/limit reached\|(\d{10})/i);
  if (unix) return new Date(Number(unix[1]) * 1000).toISOString();
  // 「resets 3pm」「resets at 15:00」「resets 3:30pm」
  const m = t.match(/resets?(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (m) {
    let h = Number(m[1]) % 24;
    if (m[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
    if (m[3]?.toLowerCase() === 'am' && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, Number(m[2] ?? 0), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  return new Date(now + cooldownMinutes * 60000).toISOString();
}

/** 這段 log 是「帳號額度用完 / 被限流」(換個帳號就能繼續),不是服務端或網路的問題。 */
export function isAccountLimit(logText) {
  return /usage limit|limit reached|rate[ _-]?limit|\b429\b|too many requests|insufficient_quota|quota exceeded|weekly limit|5-hour limit/i.test(String(logText ?? ''));
}

/**
 * 這次用哪個帳號:pool 裡沒在冷卻的,最近 5 小時派得最少的先(一樣多就照 pool 的順序)。
 * 全部都在冷卻 → 回 { wait: 最早可用的時間 }。pool 是空的 → null(照舊用 cmd,不帶帳號)。
 */
export function pickAccount(pool, usage, now = Date.now(), { ignoreParallel = false } = {}) {
  if (!pool?.length) return null;
  const accounts = loadAccounts();
  const missing = pool.filter((n) => !accounts[n]);
  if (missing.length) throw new DlmError(`dlm.config.json 用到這台電腦沒有的帳號:${missing.join(', ')}(dlm account list 看有哪些;dlm account add 新增)`);
  const cooling = (n) => usage[n]?.limited_until && Date.parse(usage[n].limited_until) > now;
  // v4.7:帳號可以設同時上限(所有專案加起來);滿了這輪先不用它
  const full = (n) => !ignoreParallel && accounts[n].max_parallel && (usage[n]?.open ?? 0) >= accounts[n].max_parallel;
  const ready = pool.filter((n) => !cooling(n) && !full(n));
  if (!ready.length) {
    const cool = pool.filter(cooling);
    if (cool.length === pool.length) return { wait: cool.map((n) => usage[n].limited_until).sort()[0] };
    return { busy: pool.filter(full) };
  }
  const best = [...ready].sort((a, b) => (usage[a]?.dispatches_5h ?? 0) - (usage[b]?.dispatches_5h ?? 0))[0];
  return { name: best, ...accounts[best] };
}

/**
 * 從事件算每個帳號的用量與冷卻狀態。events 可以是一個專案的帳本,也可以是這台電腦跨專案的帳號紀錄(globalAccountEvents)。
 * open = 派出去還沒結束的(超過 OPEN_MAX_HOURS 當作已經結束,避免當掉的紀錄一直佔著名額)。
 */
const OPEN_MAX_HOURS = 6;
export function accountUsage(events, now = Date.now()) {
  const out = {};
  const get = (n) => (out[n] ??= { dispatches_5h: 0, dispatches_7d: 0, usd_5h: 0, usd_7d: 0, usd_total: 0, limited_until: null, last_used: null, open: 0 });
  const byDispatch = new Map();
  const open = new Map();
  const H5 = 5 * 3600e3;
  const D7 = 7 * 86400e3;
  for (const e of events) {
    const age = now - Date.parse(e.ts);
    if (e.type === 'dispatch' && e.account) {
      byDispatch.set(e.dispatch_id, e.account);
      const u = get(e.account);
      if (age <= H5) u.dispatches_5h++;
      if (age <= D7) u.dispatches_7d++;
      u.last_used = e.ts;
      if (age <= OPEN_MAX_HOURS * 3600e3) open.set(e.dispatch_id, e.account);
    } else if (e.type === 'cost') {
      const acct = e.account ?? (e.role === 'worker' || !e.role ? byDispatch.get(e.dispatch_id) : null);
      if (!acct) continue;
      const u = get(acct);
      u.usd_total += e.usd;
      if (age <= H5) u.usd_5h += e.usd;
      if (age <= D7) u.usd_7d += e.usd;
    }
    if (['worker_done', 'worker_blocked', 'worker_failed'].includes(e.type)) open.delete(e.dispatch_id);
    if (e.type === 'worker_failed' && e.limited_account) {
      get(e.limited_account).limited_until = e.limited_until ?? null;
    } else if (e.type === 'worker_done' || e.type === 'worker_blocked') {
      // 交件成功 = 那個帳號又能用了(提早解除冷卻)
      const acct = byDispatch.get(e.dispatch_id);
      if (acct && out[acct]?.limited_until && Date.parse(out[acct].limited_until) > Date.parse(e.ts)) out[acct].limited_until = null;
    }
  }
  for (const acct of open.values()) get(acct).open++;
  for (const u of Object.values(out)) for (const k of ['usd_5h', 'usd_7d', 'usd_total']) u[k] = Math.round(u[k] * 100) / 100;
  return out;
}

// ------------------------------------------------------------------ v4.7 跨專案的帳號紀錄
// 同一個訂閱帳號可能同時給好幾個專案用:額度、冷卻、同時上限都是整個帳號的事,所以派工、結束、限流、花費
// 另外記一份在這台電腦(~/.config/dlm/account-log.jsonl,只記帳號相關的欄位,不記程式內容)。選號看這一份。

export const accountLogFile = () => join(configDir(), 'account-log.jsonl');
const LOG_KEEP_DAYS = 7;

/** 記一筆。寫不進去(權限、磁碟)不影響派工,只是選號少了別的專案的資訊。 */
export function logAccountEvent(project, ev) {
  try {
    mkdirSync(configDir(), { recursive: true });
    const line = { ts: new Date().toISOString(), project, ...ev, ...(ev.dispatch_id ? { dispatch_id: `${project}#${ev.dispatch_id}` } : {}) };
    appendFileSync(accountLogFile(), `${JSON.stringify(line)}\n`);
    if (statSync(accountLogFile()).size > 2 * 1024 * 1024) pruneAccountLog();
  } catch { /* 見上 */ }
}

function pruneAccountLog(now = Date.now()) {
  const keep = globalAccountEvents(now);
  writeFileSync(accountLogFile(), keep.map((e) => `${JSON.stringify(e)}\n`).join(''));
}

export function globalAccountEvents(now = Date.now()) {
  if (!existsSync(accountLogFile())) return [];
  const out = [];
  for (const line of readFileSync(accountLogFile(), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (now - Date.parse(e.ts) <= LOG_KEEP_DAYS * 86400e3) out.push(e);
    } catch { /* 寫到一半的行 */ }
  }
  return out;
}

/** 所有專案加起來的帳號用量(選號、主控台、API 用)。 */
export const globalUsage = (now = Date.now()) => accountUsage(globalAccountEvents(now), now);


// v4.6 Multiple accounts (subscription plans). Works like Orca's account switching: one separate config directory per account,
// Claude Code uses CLAUDE_CONFIG_DIR and Codex uses CODEX_HOME; log in once in that directory, and later dispatches that set the env var use that account.
//
// The account list belongs to this machine (~/.config/dlm/accounts.json, override with DLM_ACCOUNTS_FILE) and does not go into the repo: the login directory paths and credentials are personal.
// A project's dlm.config.json only says which role uses which accounts (agents.worker.accounts = ["max-a", "max-b"]).
// When a role has several accounts, dlm rotates through them (least recently used first); a rate-limited account cools down until its reset time, is skipped meanwhile, and the next one is used.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { machineDir } from './legacy.mjs';
import { DlmError, readJson, run, writeJson } from './util.mjs';

/** The dlm config directory on this machine (accounts, project list, cross-project account usage, hub token). Override with DLM_CONFIG_DIR. */
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
 * Supported CLIs. homeEnv = the env var that points to the account directory; clearEnv = env vars that would override the account directory (cleared on dispatch,
 * otherwise the ANTHROPIC_API_KEY in your shell would make every account use the same key).
 * worker / critic / verifier are the default commands used when a role has no cmd of its own; {model} is replaced with the role's model (removed if unset).
 * The claude command has been verified in real runs; the codex one is written from its docs and has not been run yet (see "Status" in the README).
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
    // The worker's copy has no .git: --skip-git-repo-check is needed; `-` = read the prompt from stdin
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

/** Change the plan name or the parallel limit (null = remove it). */
export function updateAccount(name, { plan, maxParallel } = {}) {
  const accounts = loadAccounts();
  const a = accounts[name];
  if (!a) throw new DlmError(`沒有帳號「${name}」`);
  if (plan !== undefined) { if (plan) a.plan = plan; else delete a.plan; }
  if (maxParallel !== undefined) { const mp = posInt(maxParallel, '同時上限'); if (mp) a.max_parallel = mp; else delete a.max_parallel; }
  saveAccounts(accounts);
  return { name, ...a };
}

/** Only deletes the list entry; a login directory that dlm created itself is deleted too (it holds that account's credentials), a directory you specified is left alone. */
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

/** Env vars added on dispatch: point to the account directory and clear keys that would override it (value set to an empty string, removed later by childEnv). */
export function accountEnv(account) {
  const c = cliOf(account.cli);
  const env = { [c.homeEnv]: account.home, DLM_ACCOUNT: account.name };
  for (const k of c.clearEnv) env[k] = '';
  return env;
}

/** Login status (calls the CLI's own status command, does not read credential files). */
export function loginStatus(account) {
  const c = cliOf(account.cli);
  const r = run(c.status, { env: accountEnv(account), timeoutMs: 20000 });
  if (r.code === 127) return { ok: false, detail: `找不到 ${account.cli} 指令` };
  const out = `${r.stdout}${r.stderr}`;
  if (account.cli === 'claude') {
    try {
      const j = JSON.parse(r.stdout);
      return j.loggedIn ? { ok: true, detail: [j.email ?? j.account?.email, j.subscriptionType ?? j.authMethod].filter(Boolean).join(' · ') || '已登入' } : { ok: false, detail: '沒登入' };
    } catch { /* continue below */ }
  }
  return r.code === 0 && !/not logged in/i.test(out) ? { ok: true, detail: out.trim().split('\n')[0]?.slice(0, 80) || '已登入' } : { ok: false, detail: '沒登入' };
}

// ------------------------------------------------------------------ role -> command and account

export const ROLES = ['worker', 'critic', 'verifier'];

/** The command a role runs: use its own cmd if it has one; if not but it has accounts, use the default command of the account's CLI. */
export function roleCmd(roleCfg, role, account) {
  if (roleCfg?.cmd) return roleCfg.cmd;
  if (!account) return null;
  const c = cliOf(account.cli);
  const model = roleCfg?.model ?? (role === 'verifier' ? c.defaultVerifierModel : null);
  return c[role].replace('{model}', model ? c.model(model) : '').replace(/\s{2,}/g, ' ');
}

/** Until when an account is rate limited. Reads the reset time from the worker log; if it cannot, cool down for cooldown_minutes. */
export function limitedUntil(logText, now = Date.now(), cooldownMinutes = 30) {
  const t = String(logText ?? '');
  // Claude Code: "Claude AI usage limit reached|1760000000"
  const unix = t.match(/limit reached\|(\d{10})/i);
  if (unix) return new Date(Number(unix[1]) * 1000).toISOString();
  // "resets 3pm", "resets at 15:00", "resets 3:30pm"
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

/** This log means "the account quota is used up / rate limited" (switching to another account would work), not a server or network problem. */
export function isAccountLimit(logText) {
  return /usage limit|limit reached|rate[ _-]?limit|\b429\b|too many requests|insufficient_quota|quota exceeded|weekly limit|5-hour limit/i.test(String(logText ?? ''));
}

/**
 * Which account to use this time: among those in the pool not in cooldown, the one dispatched least in the last 5 hours goes first (ties follow the pool order).
 * All in cooldown -> returns { wait: earliest available time }. Empty pool -> null (use cmd as before, with no account).
 */
export function pickAccount(pool, usage, now = Date.now(), { ignoreParallel = false } = {}) {
  if (!pool?.length) return null;
  const accounts = loadAccounts();
  const missing = pool.filter((n) => !accounts[n]);
  if (missing.length) throw new DlmError(`dlm.config.json 用到這台電腦沒有的帳號:${missing.join(', ')}(dlm account list 看有哪些;dlm account add 新增)`);
  const cooling = (n) => usage[n]?.limited_until && Date.parse(usage[n].limited_until) > now;
  // v4.7: an account can have a parallel limit (across all projects combined); when it is full, skip it this round
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
 * Compute each account's usage and cooldown state from events. events can be one project's ledger, or this machine's cross-project account record (globalAccountEvents).
 * open = dispatched but not finished (past OPEN_MAX_HOURS counts as finished, so a crashed record does not hold a slot forever).
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
      // hand-in succeeded = that account is usable again (cooldown lifted early)
      const acct = byDispatch.get(e.dispatch_id);
      if (acct && out[acct]?.limited_until && Date.parse(out[acct].limited_until) > Date.parse(e.ts)) out[acct].limited_until = null;
    }
  }
  for (const acct of open.values()) get(acct).open++;
  for (const u of Object.values(out)) for (const k of ['usd_5h', 'usd_7d', 'usd_total']) u[k] = Math.round(u[k] * 100) / 100;
  return out;
}

// ------------------------------------------------------------------ v4.7 cross-project account record
// The same subscription account may be used by several projects at once: quota, cooldown and parallel limit are all per account, so dispatch, finish, rate limit and cost events
// are also recorded separately on this machine (~/.config/dlm/account-log.jsonl, only account-related fields, no code content). Account picking reads this one.

export const accountLogFile = () => join(configDir(), 'account-log.jsonl');
const LOG_KEEP_DAYS = 7;

/** Append one record. If it cannot be written (permissions, disk) dispatch is not affected; account picking just lacks the other projects' info. */
export function logAccountEvent(project, ev) {
  try {
    mkdirSync(configDir(), { recursive: true });
    const line = { ts: new Date().toISOString(), project, ...ev, ...(ev.dispatch_id ? { dispatch_id: `${project}#${ev.dispatch_id}` } : {}) };
    appendFileSync(accountLogFile(), `${JSON.stringify(line)}\n`);
    if (statSync(accountLogFile()).size > 2 * 1024 * 1024) pruneAccountLog();
  } catch { /* see above */ }
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
    } catch { /* a half-written line */ }
  }
  return out;
}

/** Account usage summed across all projects (for account picking, the console and the API). */
export const globalUsage = (now = Date.now()) => accountUsage(globalAccountEvents(now), now);


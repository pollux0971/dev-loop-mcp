// Call layer for the small model (agents.verifier.cmd: prompt in via stdin, JSON out via stdout). Any failure (timeout, non-JSON, wrong format) returns ABSTAIN, never "no problem".
import { validate } from '../schema.mjs';
import { verdictSchema } from '../schemas.mjs';
import { accountEnv, loadAccounts, roleCmd } from '../accounts.mjs';
import { run } from '../util.mjs';

export function extractJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch { /* keep looking */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// v4.6: when the Verifier has several accounts, rotate through them (many calls, each very cheap, so no cooldown tracking; a rate-limited call becomes ABSTAIN, which never lets anything pass)
let turn = 0;
function verifierAccount(v) {
  if (!v.accounts?.length) return null;
  const all = loadAccounts();
  const name = v.accounts[turn++ % v.accounts.length];
  return all[name] ? { name, ...all[name] } : null;
}

function callCmd(v, prompt) {
  const account = verifierAccount(v);
  const cmd = roleCmd(v, 'verifier', account);
  if (!cmd) return { error: 'agents.verifier 沒有 cmd 也沒有 accounts' };
  const r = run(cmd, { input: prompt, timeoutMs: v.timeout_seconds * 1000, ...(account ? { env: accountEnv(account) } : {}) });
  if (r.code !== 0) return { error: `verifier cmd exit ${r.code}: ${r.stderr.slice(0, 300)}` };
  return { text: r.stdout };
}

/** Returns { verdict, reason, model }. Returns SKIPPED when backend=none. */
export async function askVerifier(config, prompt) {
  const v = config.agents.verifier;
  if (v.backend === 'none') return { verdict: 'SKIPPED', reason: 'verifier backend 未設定' };
  const raw = callCmd(v, prompt);
  const model = 'cmd';
  if (raw.error) return { verdict: 'ABSTAIN', reason: `呼叫失敗:${raw.error}`, model };
  const json = extractJson(raw.text);
  const errors = json ? validate(verdictSchema, json) : ['不是 JSON'];
  if (errors.length) return { verdict: 'ABSTAIN', reason: `輸出格式不符:${errors[0]}`, model };
  return { ...json, model };
}

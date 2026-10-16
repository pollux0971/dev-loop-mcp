// 小模型的呼叫層(agents.verifier.cmd:prompt 從 stdin 進、JSON 從 stdout 出)。任何失敗(逾時、非 JSON、格式不符)都回 ABSTAIN,絕不回「沒問題」。
import { validate } from '../schema.mjs';
import { verdictSchema } from '../schemas.mjs';
import { accountEnv, loadAccounts, roleCmd } from '../accounts.mjs';
import { run } from '../util.mjs';

export function extractJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch { /* 往下找 */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// v4.6:Verifier 有好幾個帳號時輪流用(呼叫次數多、每次很便宜,不追蹤冷卻;被限流的那次是 ABSTAIN,不會放行)
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

/** 回傳 { verdict, reason, model }。backend=none 時回 SKIPPED。 */
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

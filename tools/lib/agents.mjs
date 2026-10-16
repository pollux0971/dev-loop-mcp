// 所有 LLM 都是 headless:一個 prompt 檔進去、一個 JSON 檔或 stdout 出來、跑完就結束。
// 沒有終端機、沒有常駐 session,所以不存在「送出去了但對方沒收到」這種狀態。
// worker 在沒有 .git 的沙箱副本裡跑、critic 在交件分支的 worktree 裡跑(見 sandbox.mjs)。
import { accountEnv, roleCmd } from './accounts.mjs';
import { validate } from './schema.mjs';
import { sandboxExec, sandboxSpawn } from './sandbox.mjs';
import { DpError } from './util.mjs';
import { extractJson } from './verify/backend.mjs';

/** v4.6:worker 能不能開——有 cmd,或有帳號(用帳號那個 CLI 的預設指令)。 */
export const workerConfigured = (config) => !!(config.agents.worker.cmd || config.agents.worker.accounts?.length);
export const criticConfigured = (config) => !!(config.agents.critic.cmd || config.agents.critic.accounts?.length);

export function launchWorker(config, { cwd, promptPath, reportPath, logPath, dispatchId, account = null }) {
  const cmd = roleCmd(config.agents.worker, 'worker', account);
  if (!cmd) throw new DpError('dp.config.json 的 agents.worker 沒有 cmd 也沒有 accounts,無法開 worker(範例見 docs/dp/AGENTS-SETUP.md)');
  return sandboxSpawn(config, 'worker', cmd, {
    cwd, logPath,
    env: { DP_PROMPT: promptPath, DP_REPORT: reportPath, DP_DISPATCH: dispatchId, DP_ROLE: 'worker', ...(account ? accountEnv(account) : {}) },
  });
}

/** 同步呼叫 critic。輸出不合 schema 就回 { error },呼叫端決定怎麼降級(一律往保守方向)。 */
export function callAgent(agentCfg, prompt, schema, { cwd, config, role = 'critic', account = null } = {}) {
  const cmd = roleCmd(agentCfg, role, account);
  if (!cmd) return { error: 'not-configured' };
  const r = sandboxExec(config, 'critic', cmd, {
    cwd, input: prompt, env: { DP_ROLE: role, ...(account ? accountEnv(account) : {}) },
    timeoutMs: (agentCfg.timeout_minutes ?? 10) * 60 * 1000,
  });
  if (r.code !== 0) return { error: `exit ${r.code}: ${(r.stderr || r.stdout).slice(0, 400)}` };
  let json = extractJson(r.stdout);
  // claude -p --output-format json 會包一層 { result: "..." }
  if (json && typeof json.result === 'string' && !('verdict' in json)) json = extractJson(json.result);
  if (!json) return { error: '輸出不是 JSON' };
  const errors = validate(schema, json);
  if (errors.length) return { error: `輸出格式不符:${errors.slice(0, 3).join('; ')}` };
  return { value: json, cost: parseCost(r.stdout) };
}

/**
 * 從 agent 輸出找花費。Claude Code(--output-format json)印 total_cost_usd;其他 CLI 若印 cost_usd 也收。
 * 取最後一個出現的值(串流輸出時最後一筆才是總額)。
 */
export function parseCost(text) {
  const all = [...String(text ?? '').matchAll(/"(?:total_cost_usd|cost_usd)"\s*:\s*([0-9.]+)/g)];
  return all.length ? Number(all.at(-1)[1]) : null;
}

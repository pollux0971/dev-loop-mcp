// Every LLM is headless: one prompt file in, one JSON file or stdout out, then it exits.
// There is no terminal and no resident session, so the state "sent but the other side never received it" cannot exist.
// The worker runs in a sandbox copy with no .git; the critic runs in the worktree of the handed-in branch (see sandbox.mjs).
import { accountEnv, roleCmd } from './accounts.mjs';
import { validate } from './schema.mjs';
import { sandboxExec, sandboxSpawn } from './sandbox.mjs';
import { DlmError } from './util.mjs';
import { extractJson } from './verify/backend.mjs';

/** v4.6: whether a worker can be started: it has a cmd, or it has accounts (use that account's CLI default command). */
export const workerConfigured = (config) => !!(config.agents.worker.cmd || config.agents.worker.accounts?.length);
export const criticConfigured = (config) => !!(config.agents.critic.cmd || config.agents.critic.accounts?.length);

export function launchWorker(config, { cwd, promptPath, reportPath, logPath, dispatchId, account = null }) {
  const cmd = roleCmd(config.agents.worker, 'worker', account);
  if (!cmd) throw new DlmError('dlm.config.json 的 agents.worker 沒有 cmd 也沒有 accounts,無法開 worker(範例見 docs/dlm/AGENTS-SETUP.md)');
  return sandboxSpawn(config, 'worker', cmd, {
    cwd, logPath,
    env: { DLM_PROMPT: promptPath, DLM_REPORT: reportPath, DLM_DISPATCH: dispatchId, DLM_ROLE: 'worker', ...(account ? accountEnv(account) : {}) },
  });
}

/** Call the critic synchronously. If the output does not match the schema, return { error } and let the caller decide how to degrade (always toward the conservative side). */
export function callAgent(agentCfg, prompt, schema, { cwd, config, role = 'critic', account = null } = {}) {
  const raw = roleCmd(agentCfg, role, account);
  if (!raw) return { error: 'not-configured' };
  const cmd = raw.replaceAll('{test_tools}', testTools(config));
  const r = sandboxExec(config, 'critic', cmd, {
    cwd, input: prompt, env: { DLM_ROLE: role, ...(account ? accountEnv(account) : {}) },
    timeoutMs: (agentCfg.timeout_minutes ?? 10) * 60 * 1000,
  });
  if (r.code !== 0) return { error: `exit ${r.code}: ${(r.stderr || r.stdout).slice(0, 400)}` };
  let json = extractJson(r.stdout);
  // claude -p --output-format json wraps the output in { result: "..." }
  if (json && typeof json.result === 'string' && !('verdict' in json)) json = extractJson(json.result);
  if (!json) return { error: '輸出不是 JSON' };
  const errors = validate(schema, json);
  if (errors.length) return { error: `輸出格式不符:${errors.slice(0, 3).join('; ')}` };
  return { value: json, cost: parseCost(r.stdout) };
}

/**
 * v4.11: the Critic may run the same commands dlm re-runs as evidence (verify.rerun_allow: core + stack + gates.commands),
 * as Claude Code permission rules. Only plain prefixes are used, so nothing in the config can break out of the quoting.
 */
export function testTools(config) {
  return (config?.verify?.rerun_allow ?? []).map((p) => p.trim()).filter((p) => /^[A-Za-z0-9 ._/:=@+-]+$/.test(p))
    .map((p) => `"Bash(${p}*)"`).join(' ');
}

/**
 * Find the cost in agent output. Claude Code (--output-format json) prints total_cost_usd; also accept cost_usd if another CLI prints it.
 * Take the last value seen (with streamed output, the last entry is the total).
 */
export function parseCost(text) {
  const all = [...String(text ?? '').matchAll(/"(?:total_cost_usd|cost_usd)"\s*:\s*([0-9.]+)/g)];
  return all.length ? Number(all.at(-1)[1]) : null;
}

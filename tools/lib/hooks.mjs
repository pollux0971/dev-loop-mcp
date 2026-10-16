// Claude Code hooks (payload/.claude/settings.json calls `node tools/dlm.mjs hook <name>`).
//
//   user-prompt  UserPromptSubmit: sign the text you actually sent this turn and store it in .dlm/utterances.jsonl;
//                when the --verbatim of decide / confirm / resume / unblock matches one of them, the event records the hash of that sentence.
//                When something is waiting for you, it also adds one line saying how many things are waiting.
//   pre-tool     PreToolUse: Front may read, edit files and run commands; it only blocks using file tools to write the ledger / dag.json / .dlm state / verbatim-words record directly,
//                and reading or writing the key directory outside the repo. Only dlm should write these; editing them by hand would break the signature chain or the state.
//                (v4.0's strict read-only mode was never used in real runs and was removed)
//
// The headless agents dlm starts itself (worker / critic) carry DLM_ROLE, and both hooks let them straight through:
// their prompt is not something you said and must not be signed as the user's verbatim words.
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { keyPath, recordUtterance, UTTERANCES_REL } from './auth.mjs';
import { existsSync } from 'node:fs';
import { loadDag } from './dag.mjs';
import { readEvents } from './ledger.mjs';
import { openDecisions, pendingE2e, replay } from './state.mjs';

/** dlm's hooks config (same as payload/.claude/settings.json; an installed project has no payload/, so setup takes it from here). */
export const DLM_CLAUDE_HOOKS = {
  UserPromptSubmit: [
    { hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/tools/dlm.mjs" hook user-prompt' }] },
  ],
  PreToolUse: [
    {
      matcher: 'Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob',
      hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/tools/dlm.mjs" hook pre-tool' }],
    },
  ],
};

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function isDlmAgent(env = process.env) {
  return Boolean(env.DLM_ROLE || env.DLM_DISPATCH || env.DLM_IN_SANDBOX);
}

const inside = (p, dir) => {
  const r = relative(dir, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

export function checkFileTool(tool, input, root) {
  const raw = input?.file_path ?? input?.notebook_path ?? input?.path;
  if (!raw) return null;
  const p = resolve(root, String(raw));
  const keyDir = dirname(keyPath());
  if (inside(p, keyDir)) return 'dlm 的金鑰目錄不能被讀寫';
  if (inside(p, join(root, UTTERANCES_REL)) && WRITE_TOOLS.has(tool)) return '使用者原話紀錄只由 hook 寫入,不能被改';
  if (WRITE_TOOLS.has(tool)) {
    if (inside(p, join(root, 'ledger')) || p === join(root, 'dag.json')) return '帳本與 dag.json 只由 dlm 寫入';
    if (inside(p, join(root, '.dlm')) && !inside(p, join(root, '.dlm', 'intake'))) return '.dlm/ 只有 .dlm/intake/ 可以寫(放 intake 的提案草稿)';
  }
  return null;
}

/** One line saying how many things are waiting; return an empty string if there are none or the ledger can't be read (a hook must never fail because of this). */
export function awaitingLine(root) {
  try {
    if (!existsSync(join(root, 'ledger', 'events.jsonl'))) return '';
    const dag = loadDag(root);
    const state = replay(readEvents(root), dag);
    const decisions = openDecisions(state);
    const e2e = pendingE2e(state);
    const n = decisions.length + e2e.length + (state.halted ? 1 : 0);
    if (!n) return '';
    const parts = [];
    if (decisions.length) parts.push(`${decisions.length} 件決定(${decisions.slice(0, 3).map((d) => d.ref).join('、')}${decisions.length > 3 ? '…' : ''})`);
    if (e2e.length) parts.push(`${e2e.length} 個整合點等試用`);
    if (state.halted) parts.push('系統停機中');
    return `【dlm】有 ${parts.join('、')}等使用者處理。回答使用者這一句之後,用 dlm inbox 告訴他。`;
  } catch {
    return '';
  }
}

/** Run one hook. Returns { code, stderr }: code 2 = block (Claude Code gives stderr to the model). */
export function runHook(name, input, { env = process.env, cwd = process.cwd() } = {}) {
  if (env.DLM_HOOKS === 'off' || isDlmAgent(env)) return { code: 0 };
  const root = env.CLAUDE_PROJECT_DIR || input?.cwd || cwd;
  if (name === 'user-prompt') {
    if (typeof input?.prompt === 'string' && input.prompt.trim()) recordUtterance(root, input.prompt, { session: input.session_id });
    // v4: when something is waiting for the user, add one reminder line in this turn's conversation (Claude Code takes the stdout of UserPromptSubmit as extra context).
    // v3 real run: the background was stuck waiting for a merge for several turns, and nobody knew unless Front looked at the inbox on its own.
    return { code: 0, stdout: awaitingLine(root) };
  }
  if (name === 'pre-tool') {
    const tool = input?.tool_name;
    const why = FILE_TOOLS.has(tool) ? checkFileTool(tool, input?.tool_input, root) : null;
    return why ? { code: 2, stderr: `dlm 擋下:${why}(要改狀態請用 dlm 指令)` } : { code: 0 };
  }
  return { code: 1, stderr: `不認識的 hook ${name}(user-prompt|pre-tool)` };
}

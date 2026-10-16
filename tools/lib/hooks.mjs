// Claude Code hooks(payload/.claude/settings.json 會呼叫 `node tools/dp.mjs hook <名字>`)。
//
//   user-prompt  UserPromptSubmit:把你這一輪真正送出的文字簽章存進 .dp/utterances.jsonl,
//                decide / confirm / resume / unblock 的 --verbatim 對得上其中某句時,事件記下那句話的 hash。
//                有事等你時順便附一行「有幾件事等你」。
//   pre-tool     PreToolUse:Front 可以讀、改檔、跑指令;只擋用檔案工具直接寫 ledger / dag.json / .dp 狀態 / 原話紀錄,
//                以及讀寫 repo 外的金鑰目錄。這些只該由 dp 寫,手改會弄壞簽章鏈或狀態。
//                (v4.0 的 strict 唯讀模式實跑沒用到,已移除)
//
// dp 自己開的 headless agent(worker / critic)帶 DP_ROLE,兩個 hook 都直接放行:
// 它們的 prompt 不是你說的話,不能被簽成「使用者原話」。
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { keyPath, recordUtterance, UTTERANCES_REL } from './auth.mjs';
import { existsSync } from 'node:fs';
import { loadDag } from './dag.mjs';
import { readEvents } from './ledger.mjs';
import { openDecisions, pendingE2e, replay } from './state.mjs';

/** dp 的 hooks 設定(跟 payload/.claude/settings.json 一致;裝好的專案裡沒有 payload/,所以 setup 從這裡拿)。 */
export const DP_CLAUDE_HOOKS = {
  UserPromptSubmit: [
    { hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/tools/dp.mjs" hook user-prompt' }] },
  ],
  PreToolUse: [
    {
      matcher: 'Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob',
      hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/tools/dp.mjs" hook pre-tool' }],
    },
  ],
};

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function isDpAgent(env = process.env) {
  return Boolean(env.DP_ROLE || env.DP_DISPATCH || env.DP_IN_SANDBOX);
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
  if (inside(p, keyDir)) return 'dp 的金鑰目錄不能被讀寫';
  if (inside(p, join(root, UTTERANCES_REL)) && WRITE_TOOLS.has(tool)) return '使用者原話紀錄只由 hook 寫入,不能被改';
  if (WRITE_TOOLS.has(tool)) {
    if (inside(p, join(root, 'ledger')) || p === join(root, 'dag.json')) return '帳本與 dag.json 只由 dp 寫入';
    if (inside(p, join(root, '.dp')) && !inside(p, join(root, '.dp', 'intake'))) return '.dp/ 只有 .dp/intake/ 可以寫(放 intake 的提案草稿)';
  }
  return null;
}

/** 一行「有幾件事等你」;沒有、或讀不到帳本就回空字串(hook 永遠不能因此失敗)。 */
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
    return `【dp】有 ${parts.join('、')}等使用者處理。回答使用者這一句之後,用 dp inbox 告訴他。`;
  } catch {
    return '';
  }
}

/** 執行一個 hook。回傳 { code, stderr }:code 2 = 擋下(Claude Code 會把 stderr 交給模型)。 */
export function runHook(name, input, { env = process.env, cwd = process.cwd() } = {}) {
  if (env.DP_HOOKS === 'off' || isDpAgent(env)) return { code: 0 };
  const root = env.CLAUDE_PROJECT_DIR || input?.cwd || cwd;
  if (name === 'user-prompt') {
    if (typeof input?.prompt === 'string' && input.prompt.trim()) recordUtterance(root, input.prompt, { session: input.session_id });
    // v4:有事等使用者時,在這一輪的對話裡附一行提醒(Claude Code 會把 UserPromptSubmit 的 stdout 當成額外脈絡)。
    // v3 實測:背景卡在等合併好幾輪,Front 不主動看收件匣就沒人知道。
    return { code: 0, stdout: awaitingLine(root) };
  }
  if (name === 'pre-tool') {
    const tool = input?.tool_name;
    const why = FILE_TOOLS.has(tool) ? checkFileTool(tool, input?.tool_input, root) : null;
    return why ? { code: 2, stderr: `dp 擋下:${why}(要改狀態請用 dp 指令)` } : { code: 0 };
  }
  return { code: 1, stderr: `不認識的 hook ${name}(user-prompt|pre-tool)` };
}

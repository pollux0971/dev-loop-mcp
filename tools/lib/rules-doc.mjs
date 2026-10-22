// docs/dlm/AGENT-RULES.md (v4.11): every rule each agent is given, in one place, with what enforces it.
// Generated from the rule files themselves (prompts/, prompts/principles/, the front skill, stacks/*/rules.md), never written by hand:
// a hand-written agent.md would drift from what the agents are actually sent. `dlm api rules` prints it; a test fails when the file is stale.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listStacks, loadStack, stackRules } from './stack.mjs';

/**
 * The machine checks, and which rule wording each one backs. A rule whose text matches `match` is labeled with that check;
 * a rule nothing matches is "prompt only": nothing stops an agent that ignores it, only a later check that happens to catch the result.
 * The matching is by wording, so the label says "something checks this kind of violation", not "this rule is fully enforced".
 */
export const MACHINE_CHECKS = [
  { id: 'paths', by: 'verify', when: '每棒', what: '改到 allowed_paths 以外或 forbidden_paths(測試棒不能寫實作、實作棒不能改測試與 gherkin、誰都不能改 gate 定義檔)', match: /allowed_paths|forbidden_paths|寫入範圍|範圍外|不改任何(測試|實作|原始碼)|不改 gherkin|不寫實作|只寫 .allowed_paths|不要改 .package\.json/ },
  { id: 'sandbox-escape', by: 'verify', when: '每棒', what: '在副本裡碰了 .git、.dlm/、依賴目錄、建 symlink', match: /\.git|symlink|依賴目錄|node_modules/ },
  { id: 'report', by: 'orchestrator', when: '每棒', what: '.dlm/report.json 照 output_schema 驗證;done 至少一條附證據的宣稱', match: /report\.json|output_schema|合法 JSON|附證據的宣稱/ },
  { id: 'evidence', by: 'verify', when: '每條宣稱', what: 'dlm 用同一條指令以 argv 重跑,退出碼要一樣;前綴不在 evidence_prefixes 就不重跑、交上一層', match: /evidence|證據|重跑|unverified/ },
  { id: 'acceptance', by: 'verify', when: '有 accept 時', what: '測試棒必須紅、紅的原因不能是載入或語法錯誤;其他棒必須綠', match: /\*\*紅\*\*|\*\*綠\*\*|紅的原因|變綠|全綠|維持綠|在現在的程式上要是/ },
  { id: 'dry-run', by: 'verify', when: '測試棒、test-fix 棒(技術棧有 dry_run_cmd)', what: 'gherkin 每個步驟都要綁得上、不能 ambiguous', match: /dry-run|綁得上|綁定/ },
  { id: 'mutation', by: 'verify', when: '最後一棒(技術棧有 mutation.cmd)', what: '改到的實作檔 mutation 分數低於門檻:strict FAIL、其他交上一層', match: /改壞|變異|mutation|兩個改法/ },
  { id: 'scenario-honesty', by: 'Verifier 小模型', when: '實作棒、整合棒', what: '實作是不是對 gherkin 裡的值特別處理(只能否決或棄權)', match: /寫死|特別處理|只對測試輸入|抄進測試/ },
  { id: 'standalone / stubs', by: 'verify', when: '實作棒、整合棒', what: '節點的 standalone 指令要 0;整合後正式碼不能 import __stubs__', match: /__stubs__|standalone 指令/ },
  { id: 'gates', by: 'orchestrator', when: '合併前', what: '在 main + 分支的臨時樹跑 gates.chain(專案全部測試),主線動過就重跑', match: /合併前|gate 一定會紅/ },
  { id: 'critic-schema', role: 'critic', by: 'orchestrator', when: 'Critic 每次', what: '輸出照 criticSchema 驗證(判決、finding 的欄位、長度),不合格就當成沒把握、問你', match: /只回 JSON|reason 1200|finding 要有|附 `question`/ },
  { id: 'ledger guard', role: 'front', by: 'hook + 簽章', when: 'Front 每次', what: 'Claude Code hook 擋 Front 直接寫 ledger/、dag.json;帳本有簽章鏈', match: /ledger\/|dag\.json/ },
  { id: 'typecheck', by: 'stack:node-ts', when: '測試類的棒', what: '這一棒寫的檔要過 tsc(找不到實作模組不算)', match: /\btsc\b|型別錯誤/ },
  { id: 'literal-import', by: 'stack:node-ts', when: '測試類的棒', what: '測試裡的 import() 要寫字面路徑', match: /字面字串|字面路徑/ },
];

/** List items of a markdown rule file: top-level and nested `- ` / `1. ` items with their continuation lines, outside code fences and HTML comments. */
export function ruleItems(text) {
  const items = [];
  let cur = null;
  let fenced = false;
  for (const raw of String(text).split('\n')) {
    if (/^\s*```/.test(raw)) { fenced = !fenced; cur = null; continue; }
    if (fenced || /^\s*<!--/.test(raw)) { cur = null; continue; }
    const m = raw.match(/^(\s*)(?:-|\d+\.)\s+(.*)$/);
    if (m) { cur = { depth: Math.floor(m[1].length / 2), text: m[2].trim() }; items.push(cur); continue; }
    if (cur && /^\s+\S/.test(raw) && !/^#/.test(raw.trim())) { cur.text += ` ${raw.trim()}`; continue; }
    cur = null;
  }
  return items.map((i) => ({ ...i, text: i.text.replace(/\s+/g, ' ') }));
}

/** Checks without a role are the worker's (verify and the merge gate only see what a worker leg produced). */
function enforcedBy(text, role) {
  return MACHINE_CHECKS.filter((c) => (c.role ?? 'worker') === role && c.match.test(text)).map((c) => c.id);
}

function section(title, source, text, out, role = 'worker') {
  const items = ruleItems(text);
  if (!items.length) return;
  out.push(`### ${title}`, '', `來源:\`${source}\``, '', '| 準則 | 機器把關 |', '|---|---|');
  for (const it of items) {
    const by = enforcedBy(it.text, role);
    const cell = it.text.replaceAll('|', '\\|');
    out.push(`| ${it.depth ? '↳ ' : ''}${cell} | ${by.length ? by.map((b) => `\`${b}\``).join('、') : '只靠 prompt'} |`);
  }
  out.push('');
}

const read = (root, rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : '');
const between = (text, start, end) => {
  const a = text.indexOf(start);
  if (a < 0) return '';
  const b = end ? text.indexOf(end, a + start.length) : -1;
  return text.slice(a, b < 0 ? undefined : b);
};

/** The document. root = a project (or the dlm repo's payload/); stacks come from the stacks folder next to these tools. */
export function agentRulesMarkdown(root, version) {
  const out = [
    '# 各角色的準則',
    '',
    `> 這份是 \`node tools/dlm.mjs api rules\` 從規則檔產生的(dlm ${version}),不要手改;要改準則就改來源檔(改規則層要使用者批准,見 AUTONOMY.md)。`,
    '> 「機器把關」是依字面對應到下面的檢查:標了代表有一個檢查在擋這類違規,不代表擋得完整;「只靠 prompt」代表沒有任何檢查會擋,只能靠模型照做。',
    '',
    '## 誰在做事',
    '',
    '| 角色 | 是什麼 | 準則從哪來 |',
    '|---|---|---|',
    '| Front | 跟你對話的互動模型 | `.claude/skills/front/SKILL.md`(還有它叫用的其他 skill) |',
    '| orchestrator | `dlm tick`,純 script,帳本唯一的寫入者 | 程式本身(沒有 prompt) |',
    '| Worker | headless,每一棒一次 | `prompts/worker.md` + 技術棧的 `rules.md` + `prompts/principles/<棒>.md` |',
    '| Verifier | script 檢查 + 小模型窄題,只能否決或棄權 | `tools/lib/verify/` + `prompts/verifier/*.md` |',
    '| Critic | 選配的大模型 | `prompts/critic.md` + `prompts/principles/critic-*.md` |',
    '',
    '## 機器檢查',
    '',
    '| 檢查 | 誰跑 | 什麼時候 | 擋什麼 |',
    '|---|---|---|---|',
    ...MACHINE_CHECKS.map((c) => `| \`${c.id}\` | ${c.by} | ${c.when} | ${c.what} |`),
    '',
    '## Worker',
    '',
  ];
  const worker = read(root, 'prompts/worker.md');
  section('所有棒(核心)', 'prompts/worker.md', worker.split('<!-- REMINDER -->')[0], out);
  section('交件前提醒', 'prompts/worker.md(REMINDER)', (worker.split('<!-- REMINDER -->')[1] ?? '').replace(/^\s*結束前檢查:/m, '').split(/\s*[①②③④]\s*/).filter((s) => s.trim()).map((s) => `- ${s.trim()}`).join('\n'), out);
  for (const [name, legs] of [['test', 'characterize、test、test-fix'], ['dev', 'dev'], ['integrate', 'integrate'], ['retry', '被退回重做時(加在上面那份之後)']]) {
    section(`原則:${legs}`, `prompts/principles/${name}.md`, read(root, `prompts/principles/${name}.md`), out);
  }
  out.push('## Worker:技術棧規則', '', '技術棧的規則接在核心規則後面,只給用那個技術棧的專案(`dlm.config.json` 的 `project.stack`)。', '');
  for (const name of listStacks()) {
    const stack = loadStack(name);
    section(`${name}(${stack.description ?? ''})`, `tools/stacks/${name}/rules.md`, stackRules(stack), out);
  }
  out.push('## Critic', '');
  const critic = read(root, 'prompts/critic.md');
  section('所有題目', 'prompts/critic.md', critic.split('<!-- REMINDER -->')[0], out, 'critic');
  section('原則:accept', 'prompts/principles/critic-accept.md', read(root, 'prompts/principles/critic-accept.md'), out, 'critic');
  section('原則:escalation', 'prompts/principles/critic-escalation.md', read(root, 'prompts/principles/critic-escalation.md'), out, 'critic');
  out.push('## Verifier 小模型', '', '每題用兩種問法各問一次,答案不一樣就棄權;只能回 FAIL / ABSTAIN / NO_OBJECTION(沒有 PASS)。', '');
  const vdir = join(root, 'prompts', 'verifier');
  const qs = existsSync(vdir) ? [...new Set(readdirSync(vdir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.[ab]\.md$/, '')))].sort() : [];
  out.push('| 題目 | 問法(a 版第一行) |', '|---|---|');
  for (const q of qs) out.push(`| \`${q}\` | ${read(root, `prompts/verifier/${q}.a.md`).split('\n')[0].replaceAll('|', '\\|')} |`);
  out.push('', '## Front', '');
  const front = read(root, '.claude/skills/front/SKILL.md');
  section('不可信文字', '.claude/skills/front/SKILL.md', `- ${between(front, '## 不可信文字', '\n## ').replace(/^## .*\n/, '').replace(/\s+/g, ' ').trim()}`, out, 'front');
  section('不做的事', '.claude/skills/front/SKILL.md', between(front, '## 不做的事', '\n## '), out, 'front');
  out.push('## orchestrator', '', '沒有 prompt:規則就是 `tools/lib/orchestrator.mjs` 本身(派工、驗收、合併、記帳)。它是帳本唯一的寫入者,不做判斷,只照規則執行。', '');
  return `${out.join('\n').trimEnd()}\n`;
}

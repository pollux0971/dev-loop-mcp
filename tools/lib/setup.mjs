// `dp setup`:互動引導。一題一題問,偵測得到的就當預設值;最後寫 dp.config.json、裝好 hooks、commit、跑 doctor。
// 也可以不互動:--yes(全部用預設)或 --answers file.json({ 題目 id: 答案 })。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_PATTERNS, brownfieldGates, detectProject } from './brownfield.mjs';
import { DEFAULTS, loadConfig } from './config.mjs';
import { hostHas } from './doctor.mjs';
import { DP_CLAUDE_HOOKS } from './hooks.mjs';
import { git } from './git.mjs';
import { DpError, atomicWrite, readJson, run, stableJson, tail, writeJson } from './util.mjs';

/**
 * 預設的 worker / critic 指令(Claude Code)。headless 下沒被允許的工具會直接被拒,所以明確放行 Bash;
 * worker 跟你是同一個使用者,擋 rm -rf / sudo(這兩類刪掉的東西救不回來)。
 * worker 在沒有 .git 的副本裡施工(見 sandbox.mjs)。
 */
export const CLAUDE_WORKER_DENY = ['Bash(rm -rf *)', 'Bash(rm -fr *)', 'Bash(sudo *)'];
export const CLAUDE_WORKER_CMD = `claude -p --output-format json --permission-mode acceptEdits --allowedTools "Bash" --disallowedTools ${CLAUDE_WORKER_DENY.map((r) => `"${r}"`).join(' ')} < "$DP_PROMPT"`;
export const CLAUDE_CRITIC_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(npm test*)', 'Bash(npm run *)', 'Bash(npx vitest*)', 'Bash(npx cucumber-js*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)'];
// v4:v3 的預設沒給任何工具權限,headless 下 Critic 連 Read 都會被拒,「實際確認」做不到;改成唯讀工具 + 跑測試
export const CLAUDE_CRITIC_CMD = `claude -p --output-format json --allowedTools ${CLAUDE_CRITIC_TOOLS.map((t) => `"${t}"`).join(' ')} --disallowedTools "Edit" "Write" "NotebookEdit"`;
export const CLAUDE_VERIFIER_CMD = 'claude -p --model haiku --tools "" --no-session-persistence';
/** worker_cmd 的這個答案 = 維持用帳號那個 CLI 的預設指令(worker 已經設了帳號時的預設)。 */
export const VIA_ACCOUNTS = '(用帳號)';

export function detectEnvironment() {
  return { claude: hostHas('claude') };
}

/** 問答小工具:ask(q) 回傳使用者輸入的字串(空字串 = 用預設)。 */
function asker(ask, log) {
  const choose = async (id, text, choices, def) => {
    // key 本身是數字時(自治等級 0/1/2)直接用 key 當編號:v3 顯示 1) L0 2) L1 3) L2,
    // 在 --answers 裡寫 "2" 會被當成第 2 個選項 L1(實測),畫面上的編號跟等級也對不起來
    const numeric = choices.every((c) => /^\d+$/.test(c.key));
    const label = (c, i) => (numeric ? c.key : String(i + 1));
    const lines = choices.map((c, i) => `  ${label(c, i)}) ${c.label}${c.key === def ? '(預設)' : ''}${c.note ? ` —— ${c.note}` : ''}`);
    for (;;) {
      const raw = String(await ask({ id, text: `${text}\n${lines.join('\n')}\n選擇 [${numeric ? def : choices.findIndex((c) => c.key === def) + 1}]: `, default: def })).trim();
      if (!raw) return def;
      const hit = numeric ? choices.find((c) => c.key === raw) : (choices[Number(raw) - 1] ?? choices.find((c) => c.key === raw));
      if (hit) return hit.key;
      log(`  看不懂「${raw}」,請輸入 ${numeric ? choices.map((c) => c.key).join('/') : `1–${choices.length}`}`);
    }
  };
  const input = async (id, text, def) => {
    const raw = String(await ask({ id, text: `${text}${def !== undefined && def !== '' ? ` [${def}]` : ''}: `, default: def })).trim();
    return raw || def;
  };
  const yesno = async (id, text, def = true) => {
    const raw = String(await ask({ id, text: `${text} [${def ? 'Y/n' : 'y/N'}]: `, default: def ? 'y' : 'n' })).trim().toLowerCase();
    if (!raw) return def;
    return ['y', 'yes', '是', '好', '要', 'ok'].includes(raw);
  };
  return { choose, input, yesno };
}

/** 把 dp 的 hooks 合併進專案既有的 .claude/settings.json(已經有就不重複加)。回傳是否有改。 */
export function mergeClaudeHooks(root) {
  return mergeHooks(join(root, '.claude', 'settings.json'), DP_CLAUDE_HOOKS);
}

/** v4.6:把 dp 的 MCP server 加進專案的 .mcp.json(Claude Code 的專案層 MCP 設定;已經有就不動)。 */
export function mergeMcpJson(root) {
  const p = join(root, '.mcp.json');
  const cur = existsSync(p) ? readJson(p) : {};
  cur.mcpServers ??= {};
  if (cur.mcpServers.dp) return false;
  cur.mcpServers.dp = { command: 'node', args: ['tools/dp.mjs', 'mcp'] };
  writeJson(p, cur);
  return true;
}

function mergeHooks(p, mine) {
  const cur = existsSync(p) ? readJson(p) : {};
  let changed = false;
  cur.hooks ??= {};
  for (const [event, entries] of Object.entries(mine)) {
    cur.hooks[event] ??= [];
    const already = JSON.stringify(cur.hooks[event]).includes('dp.mjs\\" hook') || JSON.stringify(cur.hooks[event]).includes('dp.mjs hook');
    if (!already) { cur.hooks[event].push(...entries); changed = true; }
  }
  if (changed) writeJson(p, cur);
  return changed;
}

export async function setup(root, { ask, detect, project: projectDetect, log = console.log } = {}) {
  if (!existsSync(join(root, 'tools', 'dp.mjs')) || !existsSync(join(root, '.dp-install.json'))) {
    throw new DpError(`${root} 還沒裝 dp。先跑:node <dev-paradigm-mcp>/tools/dp.mjs init <目錄>(既有專案加 --existing)`);
  }
  const env = detect ?? detectEnvironment();
  const { choose, input, yesno } = asker(ask, log);
  const raw = readJson(join(root, 'dp.config.json'), {});
  const cur = (() => { try { return loadConfig(root); } catch { return DEFAULTS; } })();
  const written = ['dp.config.json'];

  log('\n— dp setup —  按 Enter 用預設值。隨時可以重跑。\n');

  // 0. v4.5:greenfield / brownfield。偵測到既有程式就預設 brownfield
  const proj = projectDetect ?? detectProject(root);
  const modeDefault = raw.project?.mode ?? proj.suggested_mode;
  const mode = await choose('mode', '這是新專案還是既有專案?', [
    { key: 'greenfield', label: 'Greenfield:從零開始', note: '用範本的 TypeScript / vitest / cucumber' },
    { key: 'brownfield', label: 'Brownfield:既有專案', note: `${proj.code_files} 個程式檔、${proj.test_files} 個測試檔;gate 跑專案自己的測試` },
  ], modeDefault);
  let bfGates = null;
  if (mode === 'brownfield') {
    log(`  偵測到:${proj.language}${proj.test.how ? `,測試用 ${proj.test.how}` : ',沒找到測試指令'}`);
    const npmTest = proj.scripts.includes('test') && !proj.test.cmd;
    const def = raw.gates?.commands?.test ?? proj.test.cmd ?? (npmTest ? 'npm test' : '');
    let testCmd = await input('test_cmd', '專案的測試指令(gate 合併前會在臨時樹跑它)', def);
    while (!testCmd) testCmd = await input('test_cmd', '一定要有測試指令(沒有測試就先寫一個會跑的,例 npm test)', '');
    // 'npm test' 等於跑 npm script test,照舊走 npm run(不用另外對應)
    bfGates = brownfieldGates(proj, testCmd === 'npm test' && npmTest ? null : testCmd);
  }

  // 1. 施工 AI
  const platform = await choose('platform', '施工用哪個 AI 工具?', [
    { key: 'claude', label: 'Claude Code', note: env.claude ? '已安裝' : '沒找到 claude 指令' },
    { key: 'custom', label: '其他(自己填指令)' },
  ], cur.agents.worker.cmd && cur.platform !== 'claude' ? 'custom' : 'claude');
  // v2 的 Claude 預設(只有 acceptEdits)在 headless 下跑不了任何指令,視同沒設定,換成新的預設
  const v2ClaudeDefault = cur.agents.worker.cmd === 'claude -p --output-format json --permission-mode acceptEdits < "$DP_PROMPT"';
  if (v2ClaudeDefault) log('  你原本的 Claude 指令是 v2 預設(acceptEdits),headless 下 worker 跑不了測試,預設值已換成新的寫法。');
  const keepOld = cur.agents.worker.cmd && cur.platform === platform && !v2ClaudeDefault;
  // v4.7.3:worker 已經用帳號(沒有自己的 cmd,跑帳號那個 CLI 的預設指令)→ 預設維持。以前重跑 setup 一律寫進 Claude 的固定指令,
  // 蓋過帳號的預設(換不了 CLI、帶不進 model)。實測:只想改預算而重跑 setup,worker 就變成 custom_cmd
  const pool = cur.agents.worker.accounts ?? [];
  const viaAccounts = !cur.agents.worker.cmd && pool.length > 0;
  const workerDefault = viaAccounts ? VIA_ACCOUNTS
    : platform === 'custom' ? (cur.agents.worker.cmd ?? '') : (keepOld ? cur.agents.worker.cmd : CLAUDE_WORKER_CMD);
  let workerCmd = await input('worker_cmd', viaAccounts
    ? `施工 AI 的啟動指令(現在用帳號 ${pool.join('、')} 的預設指令,按 Enter 維持;要換帳號用 dp account use worker)`
    : '施工 AI 的啟動指令(不懂就按 Enter)', workerDefault);
  while (!workerCmd) workerCmd = await input('worker_cmd', '一定要有施工指令', '');
  const keepAccounts = viaAccounts && workerCmd === VIA_ACCOUNTS;
  log('  worker 在沒有 .git 的副本裡施工,程式以你的身分在這台電腦上執行(見 docs/dp/SECURITY.md)。');

  // 2. Verifier
  const verifier = { ...(raw.agents?.verifier ?? {}) };
  if (platform === 'claude') {
    // v4:用 Claude 的小模型、關掉所有工具,當「只能說不」的檢查員
    const curKey = cur.agents.verifier.backend === 'cmd' && cur.agents.verifier.cmd !== CLAUDE_VERIFIER_CMD ? 'keep' : 'haiku';
    const choices = [
      { key: 'haiku', label: '用 Claude Haiku(小模型、不給任何工具;每一棒多幾次很便宜的呼叫)' },
      { key: 'none', label: '不用(有 gherkin 的最後一棒會來問你)' },
      ...(curKey === 'keep' ? [{ key: 'keep', label: '保留現在的設定' }] : []),
    ];
    const pick = await choose('verifier', 'Verifier(小模型,只能說不)要用什麼?', choices, curKey);
    if (pick === 'haiku') Object.assign(verifier, { backend: 'cmd', cmd: CLAUDE_VERIFIER_CMD });
    else if (pick === 'none') Object.assign(verifier, { backend: 'none' });
  } else if (cur.agents.verifier.backend === 'none') {
    log('先不用 Verifier(有 gherkin 的最後一棒會來問你);要用的話在 agents.verifier.cmd 填一個讀 stdin、回 JSON 的指令。');
  }

  // 3. 自治、預算、平行
  const levels = [
    { key: '0', label: 'L0:每次合併都問我' },
    { key: '1', label: 'L1:機器全過就自動合併,沒把握才問我' },
    { key: '2', label: 'L2:沒把握的先交 Critic(另一個大模型),它也沒把握才問我' },
  ];
  const level = Number(await choose('autonomy', '自治等級?', levels, String(Math.min(cur.autonomy.level, 2))));
  const agents = { ...(raw.agents ?? {}), worker: { ...(raw.agents?.worker ?? {}), ...(keepAccounts ? {} : { cmd: workerCmd }) }, verifier };
  if (level >= 2 && platform !== 'custom') {
    const useCritic = await yesno('critic', '要開 Critic 嗎?(用 Claude 審,會多花一點錢)', true);
    const oldCritic = cur.platform === platform && cur.agents.critic.cmd && cur.agents.critic.cmd !== 'claude -p --output-format json' ? cur.agents.critic.cmd : null;
    agents.critic = { ...(raw.agents?.critic ?? {}), cmd: useCritic ? (oldCritic ?? CLAUDE_CRITIC_CMD) : null };
  }
  const budget = Number(await input('budget', '每天最多花多少美金?', String(cur.budget.daily_usd)));
  const parallel = Number(await input('parallel', '同時最多幾個 worker?', String(cur.caps.parallel)));

  // 寫設定(保留你其他的設定),驗證不過就還原
  const next = {
    ...raw,
    project: { ...(raw.project ?? {}), mode, ...(mode === 'brownfield' ? { language: proj.language } : {}) },
    platform: platform === 'custom' ? 'generic' : platform,
    agents,
    autonomy: { ...(raw.autonomy ?? {}), level },
    budget: { ...(raw.budget ?? {}), daily_usd: Number.isFinite(budget) ? budget : cur.budget.daily_usd },
    caps: { ...(raw.caps ?? {}), parallel: Number.isInteger(parallel) && parallel > 0 ? parallel : cur.caps.parallel },
  };
  if (bfGates) {
    // 既有專案:gate 跑專案自己的測試;範本專用的 dry-run(cucumber)與 mutation(stryker)沒裝就關掉
    next.gates = { ...(raw.gates ?? {}), chain: bfGates.chain, commands: bfGates.commands };
    const deps = (() => { const p = readJson(join(root, 'package.json'), {}); return { ...p.dependencies, ...p.devDependencies }; })();
    next.verify = {
      ...(raw.verify ?? {}),
      ...(proj.scripts.includes('accept:dry') ? {} : { dry_run_cmd: null }),
      mutation: { ...(raw.verify?.mutation ?? {}), ...(deps['@stryker-mutator/core'] ? {} : { cmd: null }) },
    };
    const tests = [...new Set([...(raw.paths?.tests ?? DEFAULTS.paths.tests), ...(TEST_PATTERNS[proj.language] ?? [])])];
    next.paths = { ...(raw.paths ?? {}), tests };
  }
  const before = existsSync(join(root, 'dp.config.json')) ? readFileSync(join(root, 'dp.config.json'), 'utf8') : null;
  writeJson(join(root, 'dp.config.json'), next);
  try {
    loadConfig(root);
  } catch (e) {
    if (before !== null) atomicWrite(join(root, 'dp.config.json'), before);
    throw new DpError(`產生的設定不合法,已還原:${e.message}`);
  }

  // 4. hooks
  if (next.platform === 'claude') {
    if (mergeClaudeHooks(root)) { written.push('.claude/settings.json'); log('✓ 已把 dp 的 hooks 加進 .claude/settings.json(你原本的設定都還在)'); }
    // v4.7:MCP 改成這台電腦裝一次(dp mcp install),不再寫進每個專案的 .mcp.json
    log('提示:要讓 Claude Code 直接呼叫 dp(所有專案共用一個 MCP),跑一次 node tools/dp.mjs mcp install');
  } else {
    log(`提醒:${next.platform} 沒有 hooks。Front 轉達的決定照樣記錄,只是不會附上你原話的簽章。`);
  }

  // 5. 依賴:合併 gate 要跑測試,沒有 node_modules 會全紅
  const pkg = readJson(join(root, 'package.json'), null);
  const hasDeps = pkg && Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
  if (hasDeps && !existsSync(join(root, 'node_modules')) && await yesno('npm_install', '還沒裝依賴(合併前的測試要用)。現在 npm install?(要下載,幾分鐘)', true)) {
    log('  npm install 中…');
    let r = run('npm install --no-audit --no-fund', { cwd: root, timeoutMs: 30 * 60000 });
    if (r.code !== 0) {
      // npm 10 遇到某些套件的選用 peer 依賴會當掉(Cannot read properties of null (reading 'edgesOut')),
      // 改用相容模式再試一次
      log(`  npm install 失敗(${tail(r.stderr || r.stdout, 200).trim().split('\n').pop()}),改用 --legacy-peer-deps 再試一次…`);
      r = run('npm install --no-audit --no-fund --legacy-peer-deps', { cwd: root, timeoutMs: 30 * 60000 });
    }
    log(r.code === 0 ? '  ✓ 依賴裝好了' : `  ✗ npm install 失敗(exit ${r.code}):${tail(r.stderr || r.stdout, 300)}\n    之後自己跑一次:npm install --legacy-peer-deps`);
    if (r.code === 0 && existsSync(join(root, 'package-lock.json'))) written.push('package-lock.json');
  }

  // 6. commit(根目錄有未 commit 的變更時 tick 會拒絕執行)
  let committed = false;
  if (await yesno('commit', `把設定 commit 起來?(${written.join('、')})`, true)) {
    git(root, `add -- ${written.map((f) => `'${f}'`).join(' ')}`);
    if (git(root, 'diff --cached --quiet', { allowFail: true }).code !== 0) {
      const r = git(root, 'commit --quiet -m "dp setup"', { allowFail: true });
      if (r.code !== 0) git(root, '-c user.name=dp -c user.email=dp@localhost commit --quiet -m "dp setup"');
      committed = true;
    }
  }
  if (mode === 'brownfield') log('\n既有專案的下一步:跑 `node tools/dp.mjs onboard`(記下測試基線、產生 docs/AS-IS.md 草稿與 ROADMAP v0),再請 Front 照 brownfield-onboard 補完現況。');
  log(`\n✓ 設定寫好了:${stableJson({ mode, platform: next.platform, verifier: verifier.backend === 'cmd' ? (verifier.cmd === CLAUDE_VERIFIER_CMD ? 'claude-haiku' : 'cmd') : 'none', autonomy: `L${level}` }).replace(/\n\s*/g, ' ')}`);
  return { config: next, written, committed };
}

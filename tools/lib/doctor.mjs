// `dlm doctor`:一鍵健康檢查。每一項給 ✓ / ⚠ / ✗,不對的附一行修法。
// 給人看的,也給 Front 看的(`dlm doctor --json`)。只讀,不改任何東西。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { keyPath } from './auth.mjs';
import { loadConfig, stripRemovedSettings } from './config.mjs';
import { loadDag } from './dag.mjs';
import { gateCommand, readBaseline } from './brownfield.mjs';
import { CLIS, ROLES, accountsFile, loadAccounts, loginStatus } from './accounts.mjs';
import { hasTestGate } from './gates.mjs';
import { isLegacyProject, legacyEnvVars } from './legacy.mjs';
import { checkLedger } from './ledger.mjs';
import { lockHolder, readJson, run } from './util.mjs';

const ok = (name, detail) => ({ name, status: 'ok', detail });
const warn = (name, detail, fix) => ({ name, status: 'warn', detail, fix });
const fail = (name, detail, fix) => ({ name, status: 'fail', detail, fix });

/** `FOO=1 BAR=2 claude -p ...` → `claude`。 */
export function executableOf(cmd) {
  const tokens = String(cmd ?? '').trim().split(/\s+/);
  const exe = tokens.find((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  return exe ? exe.replace(/^["']|["']$/g, '') : null;
}

export function hostHas(exe) {
  return !!exe && run(`command -v '${exe.replace(/'/g, '')}'`, { timeoutMs: 10000 }).code === 0;
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 20 ? ok('Node.js', `v${process.versions.node}`) : fail('Node.js', `v${process.versions.node}`, '安裝 Node 20 以上');
}

function checkGit(root, config) {
  const inRepo = run('git rev-parse --is-inside-work-tree', { cwd: root }).code === 0;
  if (!inRepo) return fail('git', '這個目錄不是 git repo', 'git init -b main,或在專案根目錄執行');
  const branch = run('git rev-parse --abbrev-ref HEAD', { cwd: root }).stdout.trim();
  if (branch !== config.main_branch) return warn('git', `目前在 ${branch},背景迴圈只在 ${config.main_branch} 上跑`, `git switch ${config.main_branch}`);
  const dirty = run('git status --porcelain --untracked-files=no', { cwd: root }).stdout.trim();
  if (dirty) return warn('git', '有未 commit 的變更,tick 會拒絕執行', 'git add -A && git commit -m "..."(或用 dlm setup 結尾的自動 commit)');
  return ok('git', `在 ${branch},乾淨`);
}

/**
 * v4.7.3 dlm 自己的檔有沒有進 git。合併前的全 gate 在 main + 分支 的臨時樹(從 git 來)跑 node tools/dlm.mjs check;
 * dlm 的檔沒 commit,臨時樹裡就沒有 dlm,實作棒每次都紅、三次後封鎖。4.7.3 以前 dlm init --existing 裝進已經有 git 的專案就是這樣(實測)。
 */
function checkDlmTracked(root) {
  if (run('git rev-parse --is-inside-work-tree', { cwd: root }).code !== 0) return [];
  const key = ['tools/dlm.mjs', '.dlm-install.json', 'dag.json', 'dlm.config.json', 'AGENTS.md'].filter((f) => existsSync(join(root, f)));
  const tracked = new Set(run(`git ls-files -- ${key.map((f) => `'${f}'`).join(' ')}`, { cwd: root }).stdout.split('\n').map((l) => l.trim()).filter(Boolean));
  const missing = key.filter((f) => !tracked.has(f));
  if (!missing.length) return [ok('dlm 的檔', '都在 git 裡')];
  return [fail('dlm 的檔', `還沒進 git:${missing.join('、')}(合併前的全 gate 在從 git 建的臨時樹裡跑,找不到 dlm 會每次都紅)`,
    'node tools/dlm.mjs upgrade(會把 dlm 的檔一起 commit;MCP 是 dlm_upgrade_project)')];
}

async function checkWorker(root, config) {
  const cmd = config.agents.worker.cmd;
  if (!cmd && config.agents.worker.accounts?.length) return ok('worker 指令', `用帳號的預設指令(${config.agents.worker.accounts.join(', ')})`);
  if (!cmd) return fail('worker 指令', 'agents.worker 沒有 cmd 也沒有 accounts:沒有人施工', '跑 dlm setup,或 dlm account use worker <帳號>');
  const exe = executableOf(cmd);
  return hostHas(exe) ? ok('worker 指令', exe) : fail('worker 指令', `找不到 ${exe}`, `先安裝 ${exe},或改 agents.worker.cmd`);
}

/** v4.6:每個角色用的帳號在這台電腦上有沒有、登入了沒。 */
function checkAccounts(config) {
  const out = [];
  let registry;
  try { registry = loadAccounts(); } catch (e) { return [fail('帳號', e.message, `檢查 ${accountsFile()}`)]; }
  const seen = new Map();
  for (const role of ROLES) {
    for (const name of config.agents[role]?.accounts ?? []) {
      if (!seen.has(name)) seen.set(name, []);
      seen.get(name).push(role);
    }
  }
  for (const [name, roles] of seen) {
    const a = registry[name];
    if (!a) { out.push(fail(`帳號 ${name}`, `${roles.join('、')} 用到它,但這台電腦沒有這個帳號`, `node tools/dlm.mjs account add ${name} --cli claude,再 account login ${name}`)); continue; }
    const exe = a.cli;
    if (!hostHas(exe)) { out.push(fail(`帳號 ${name}`, `找不到 ${exe} 指令`, `先安裝 ${CLIS[exe]?.label ?? exe}`)); continue; }
    const st = loginStatus({ name, ...a });
    out.push(st.ok ? ok(`帳號 ${name}`, `${a.cli}${a.plan ? ` · ${a.plan}` : ''} · ${st.detail} · 給 ${roles.join('、')}`)
      : fail(`帳號 ${name}`, `${a.cli} 沒登入(給 ${roles.join('、')})`, `node tools/dlm.mjs account login ${name}`));
  }
  return out;
}

function checkSandbox(config) {
  const auto = config.autonomy.level >= 2 ? `;自治等級 ${config.autonomy.level} 會自動合併在你主機上跑過的程式` : '';
  return warn('隔離', `worker 在沒有 .git 的副本裡施工,程式以你的身分在這台電腦上執行(Claude worker 會擋 rm -rf 與 sudo)${auto}`, '要更強的隔離時再加(見 docs/dlm/SECURITY.md)');
}

function checkAuth(root, config) {
  const out = [];
  if (config.platform === 'claude') {
    const p = join(root, '.claude', 'settings.json');
    const text = existsSync(p) ? readFileSync(p, 'utf8') : '';
    const has = /hook user-prompt/.test(text) && /hook pre-tool/.test(text);
    out.push(has
      ? ok('授權 hooks', '.claude/settings.json 已裝 dlm 的 hooks')
      : warn('授權 hooks', '.claude/settings.json 沒有 dlm 的 hooks:不會記原話,也沒有防手改帳本的保護', 'dlm setup 會幫你合併進去'));
  } else {
    out.push(ok('授權', `${config.platform} 沒有 hooks:Front 轉達的決定照樣記錄,不附原話簽章`));
  }
  const kp = keyPath();
  if (!existsSync(kp)) out.push(ok('金鑰', `還沒建立;第一次對話或第一筆帳本事件時會自動建在 ${kp}`));
  else {
    const mode = statSync(kp).mode & 0o777;
    out.push(mode & 0o077 ? warn('金鑰', `${kp} 權限是 ${mode.toString(8)},別人讀得到`, `chmod 600 ${kp}`) : ok('金鑰', `${kp}(600)`));
  }
  return out;
}

async function checkVerifier(config) {
  const v = config.agents.verifier;
  if (v.backend === 'none') {
    const relaxed = !!config.verify.mutation?.cmd;
    return warn('Verifier 小模型', `沒設定${relaxed ? '(有 mutation,最後一棒達標時仍可自動合併)' : ':有 gherkin 的最後一棒都會來問你'}`, '跑 dlm setup 選 Claude Haiku');
  }
  if (v.backend === 'cmd') {
    if (!v.cmd && v.accounts?.length) return ok('Verifier 小模型', `用帳號的預設指令(${v.accounts.join(', ')}${v.model ? ` · ${v.model}` : ''})`);
    if (!v.cmd) return fail('Verifier 小模型', 'backend 是 cmd 但沒有 cmd 也沒有 accounts', 'dlm account use verifier <帳號>,或跑 dlm setup');
    const exe = executableOf(v.cmd);
    return hostHas(exe) ? ok('Verifier 小模型', `cmd:${exe}`) : fail('Verifier 小模型', `找不到 ${exe}`, '修正 agents.verifier.cmd');
  }
  return fail('Verifier 小模型', `不認得的 backend ${v.backend}`, '改成 cmd 或 none');
}

function checkGates(root, config) {
  const out = [];
  const chain = config.gates.chain ?? [];
  if (config.autonomy.level >= 1 && !hasTestGate(chain)) out.push(fail('合併 gate', `gates.chain=${JSON.stringify(chain)} 沒有測試類 script,tick 會拒絕執行`, '把 test 加進 gates.chain'));
  const pkg = readJson(join(root, 'package.json'), null);
  const missing = chain.filter((n) => !gateCommand(n, config, pkg?.scripts ?? {}));
  if (missing.length) out.push(fail('合併 gate', `package.json 沒有這些 script、gates.commands 也沒有:${missing.join(', ')}`, '補上 script、在 gates.commands 寫對應的指令,或從 gates.chain 拿掉'));
  const gateProblems = out.length;
  // v4.5:既有專案沒記基線的話,主線上本來就紅的測試會讓每一次合併都被擋
  if (config.project?.mode === 'brownfield') {
    const b = readBaseline(root);
    if (!b) out.push(warn('測試基線', '既有專案還沒記測試基線:主線上本來就紅的測試會擋住每一次合併', 'node tools/dlm.mjs onboard'));
    else {
      const blind = b.gates.filter((g) => g.exit !== 0 && !g.failing?.length);
      const red = b.gates.filter((g) => g.exit !== 0 && g.failing?.length);
      if (blind.length) out.push(warn('測試基線', `${blind.map((g) => g.name).join(', ')} 在主線上就紅,而且看不出是哪些測試:修好之前每次合併都會擋`, '先修好(或讓測試指令輸出 pytest / unittest / go test 等標準格式),再 dlm baseline'));
      else out.push(ok('測試基線', red.length ? `${red.map((g) => `${g.name} 有 ${g.failing.length} 個本來就紅`).join('、')}(合併時不算到 worker 頭上)` : '主線上專案的測試全綠'));
    }
  }
  const hasDeps = pkg && Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
  if (hasDeps && !existsSync(join(root, 'node_modules'))) out.push(warn('依賴', 'package.json 有依賴但沒有 node_modules:gate 會失敗', 'npm install'));
  // v4:cucumber.js 是你的檔(dlm upgrade 不覆蓋)。v3 版會讓單一節點的驗收連別的節點一起跑,而且全 gate 會被還沒做完的節點卡死
  const cuc = join(root, 'cucumber.js');
  if (chain.some((n) => n.startsWith('accept')) && existsSync(cuc) && !readFileSync(cuc, 'utf8').includes('pending-features')) {
    out.push(warn('驗收設定', 'cucumber.js 是 v3 以前的版本:兩個以上節點同時在做時,全 gate 的 accept 會被彼此未完成的場景卡死',
      '照 MIGRATION.md 的「3 → 4」把 cucumber.js 換成新版(有改過的話把 paths 那段合併進去)'));
  }
  if (!gateProblems && !out.some((x) => x.status !== 'ok' && x.name !== '測試基線')) {
    const cmds = config.gates.commands ?? {};
    out.unshift(ok('合併 gate', chain.map((n) => (cmds[n] ? `${n}(${cmds[n]})` : n)).join(' → ')));
  }
  return out;
}

function checkState(root, config) {
  const out = [];
  const l = checkLedger(root);
  out.push(l.ok ? ok('帳本', `${l.count} 筆,簽章鏈完整${l.note ? `(${l.note})` : ''}`) : fail('帳本', l.problems.slice(0, 2).join(';'), 'dlm check ledger 看細節;不要手改 ledger'));
  const nodes = loadDag(root).nodes.length;
  out.push(nodes ? ok('DAG', `${nodes} 個節點`) : ok('DAG', '還沒有任何節點:在對話視窗說你想做什麼(Front 會用 intake 幫你寫提案)'));
  const loop = lockHolder(join(root, '.dlm', 'run.lock'));
  out.push(loop ? ok('背景迴圈', `執行中(pid ${loop})`) : ok('背景迴圈', '沒在跑;準備好後 node tools/dlm.mjs run --daemon'));
  out.push(ok('自治 / 預算', `L${config.autonomy.level} · 每日 $${config.budget.daily_usd} · 同時 ${config.caps.parallel} 個 worker`));
  return out;
}

export async function doctor(root) {
  const results = [checkNode()];
  const oldEnv = legacyEnvVars();
  if (oldEnv.length) {
    results.push(warn('環境變數', `${oldEnv.join('、')} 是 4.8.0 以前的名字,dlm 不讀了`, `改成 ${oldEnv.map((v) => v.replace(/^DP_/, 'DLM_')).join('、')}`));
  }
  if (isLegacyProject(root)) {
    // dp.config.json and tools/dp.mjs from before 4.8.0: nothing else can be checked until the files have their new names
    results.push(fail('dp → dlm', '這是 4.8.0 以前(dp)的專案,檔名還是舊的(dp.config.json、.dp/、tools/dp.mjs)',
      '先停迴圈,再升級:node <dev-loop-mcp>/tools/dlm.mjs upgrade(MCP:dlm_upgrade_project)。會改名並一次 commit'));
    return summarizeDoctor(results);
  }
  let config;
  try {
    config = loadConfig(root);
    results.push(ok('dlm.config.json', '格式正確'));
    for (const r of stripRemovedSettings(readJson(join(root, 'dlm.config.json'), {})).removed) {
      results.push(warn('dlm.config.json', `${r.key}:${r.note}`, '從 dlm.config.json 拿掉這一項(現在讀的時候會略過)'));
    }
  } catch (e) {
    results.push(fail('dlm.config.json', e.message.split('\n')[0], '跑 dlm setup 重新產生,或照錯誤訊息修'));
    return summarizeDoctor(results);
  }
  results.push(checkGit(root, config));
  results.push(...checkDlmTracked(root));
  results.push(await checkWorker(root, config));
  results.push(...checkAccounts(config));
  results.push(checkSandbox(config));
  results.push(...checkAuth(root, config));
  results.push(await checkVerifier(config));
  results.push(...checkGates(root, config));
  results.push(...checkState(root, config));
  return summarizeDoctor(results);
}

function summarizeDoctor(results) {
  const count = (s) => results.filter((r) => r.status === s).length;
  return { ok: count('fail') === 0, fails: count('fail'), warns: count('warn'), results };
}

export function renderDoctor(report) {
  const icon = { ok: '✓', warn: '⚠', fail: '✗' };
  const lines = report.results.map((r) => `${icon[r.status]} ${r.name}:${r.detail}${r.fix ? `\n    → ${r.fix}` : ''}`);
  lines.push('');
  lines.push(report.ok
    ? `可以開始了${report.warns ? `(有 ${report.warns} 個提醒,不擋路)` : ''}。在 Claude Code 打 /inbox,說你想做什麼。`
    : `有 ${report.fails} 個問題要先處理。最快的方法:node tools/dlm.mjs setup`);
  return lines.join('\n');
}

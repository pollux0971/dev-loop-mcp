import { join } from 'node:path';
import { assertValid } from './schema.mjs';
import { configSchema } from './schemas.mjs';
import { DpError, readJson } from './util.mjs';

/**
 * gate 定義檔與 agent 設定。worker 改得到它們,就能把 `test` 改成 `exit 0`、或換掉測試框架,
 * 讓最後一道 gate 失效。預設禁止;確實要改時走使用者批准、owns 明列該路徑的 shared/* 節點。
 */
export const BUILD_CONFIG_PATHS = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.json',
  'vitest*.config.*', 'cucumber.js', 'stryker.config.json', 'scripts/**',
  '.mcp.json', '.github/**', '.gitattributes', '.gitignore',
];

export const DEFAULTS = {
  main_branch: 'main',
  worktree_dir: '.dp/worktrees',
  platform: 'generic',
  // v4.5:greenfield / brownfield(dp setup 會問)。language 決定 characterize 與測試檔的預設路徑
  project: { mode: 'greenfield', language: 'node' },
  caps: {
    parallel: 3, unmerged: 3, drift: 20, attempts: 3, lease_minutes: 90,
    // 429 / 5xx / 連線逾時這類基礎設施失敗不算 worker 的嘗試次數;改成退避重派,連續太多次就停機
    infra_halt_after: 5, infra_backoff_seconds: 60, infra_backoff_max_minutes: 30,
    // v4:同一個節點最多自動退回測試棒幾次;超過就問使用者(規格本身可能有問題)
    test_reopens: 2,
    // v4.6:帳號被限流、log 裡又看不出重置時間時,冷卻幾分鐘
    account_cooldown_minutes: 30,
  },
  pipeline: {
    phase: ['test', 'dev'],
    // v4:整合點也先有測試棒。v3 只有 integrate 一棒,整合 gherkin 的步驟定義在 features/steps(測試路徑),
    // integrate 棒不准寫,沒有任何一棒會寫它,整合點永遠 undefined(實測)
    integration: ['test', 'integrate'],
    shared: ['dev'],
  },
  // 合併前在 main+分支 的臨時樹跑的 npm scripts。必須含專案測試:只跑 check:dp 等於只驗元資料,
  // 節點 B 弄壞節點 A 的測試不會被擋。
  // install:merge-tree 的依賴怎麼來。auto = 有 package-lock.json 就用本機快取 `npm ci --offline --ignore-scripts`
  // 裝一份乾淨的(不受根目錄 node_modules 被改的影響),沒有 lockfile 才 symlink 根目錄。
  // commands(v4.5):chain 名字對應的指令,給不是用 npm script 跑測試的既有專案(例 { test: 'python3 -m pytest -q' })。
  gates: { chain: ['check:dp', 'typecheck', 'test', 'accept'], timeout_minutes: 30, install: 'auto', commands: {} },
  autonomy: { level: 1 },
  // 使用者授權(decide / confirm / resume / unblock):信任 Front 轉達;--verbatim 可省略。
  // 有給且對得上 hook 簽章過的原話(最近 window_minutes 分鐘內)時,事件記下那句話的 hash
  auth: { window_minutes: 30 },
  budget: { daily_usd: 5 },
  // v4:版本整合關卡(見 AUTONOMY.md、WORKFLOW.md)。每個版本最後一個整合點 I<n>;下一版的節點依賴它,
  // gate_next_version = true 時,要等整合點合併而且你試用確認(dp confirm)過,下一版才開工。
  integration: { gate_next_version: true },
  // v4:有新的待決事項時執行(環境變數 DP_NOTIFY_TEXT)。例:macOS `osascript -e "display notification \"$DP_NOTIFY_TEXT\" with title \"dp\""`
  notify: { cmd: null },
  agents: {
    worker: { cmd: null, timeout_minutes: 90 },
    critic: { cmd: null, timeout_minutes: 20 },
    verifier: { backend: 'none', cmd: null, runs: 2, max_input_chars: 6000, timeout_seconds: 120 },
  },
  paths: {
    forbidden: [
      'ledger/**', 'dag.json', 'STATUS.md', 'DECISIONS.md', 'standalone.json',
      'AGENTS.md', 'CLAUDE.md', 'AUTONOMY.md', 'dp.config.json',
      '.claude/**', 'prompts/**', 'tools/**', 'contracts/**', '.dp-install.json',
      // v4.5:既有專案的測試基線(哪些測試在主線上本來就紅)。worker 改得到它,就能把自己弄壞的測試寫成「本來就壞」
      'docs/dp-baseline.json',
      ...BUILD_CONFIG_PATHS,
    ],
    tests: ['**/*.test.*', '**/*.spec.*', 'features/**/*.feature', 'features/steps/**', 'docs/integration/**/*.feature'],
    rules: ['AGENTS.md', 'AUTONOMY.md', 'prompts/*.md', '.claude/skills/*/SKILL.md'],
  },
  verify: {
    // 前綴比對;指令本身只能含英數與 ._/:=@+- 和空白,以 argv 執行、不經 shell。
    // 不放 cat / ls:worker 可以宣稱「cat ~/.aws/credentials 的 exit 是 1」,讓 dp 在主機上替它讀檔。
    // v4:加入 `node tools/dp.mjs check`(契約節點唯一能拿來當證據的指令;v3 實測沒放行,整筆變成問使用者)
    rerun_allow: ['npm run ', 'npm test', 'npx cucumber-js', 'npx vitest', 'node --test', 'node tools/dp.mjs check', 'git diff', 'git log', 'git status'],
    rerun_timeout_seconds: 600,
    // 測試棒:所有步驟都要綁定({gherkin} 換成節點的 gherkin 路徑)。null = 不跑
    dry_run_cmd: null,
    // 最後一棒:對這一棒改到的實作檔跑增量 mutation({files} 換成逗號分隔的檔案清單)。cmd null = 不跑
    mutation: {
      // v4:一般節點 50、tier strict 70(v3 實測 CLI 專案 52%、54%,60 的門檻讓每次都變成「沒把握」)
      cmd: null, report: 'reports/mutation/mutation.json', min: 50, min_strict: 70, timeout_minutes: 30,
      include: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
    },
  },
  checks: { placeholders: { exclude: [] } },
  limits: { rules_bytes: 6000, prompt_bytes: 60000 },
};

function merge(base, over) {
  if (over === undefined) return base;
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || base === null) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

/**
 * v4.1 拿掉的設定(實跑沒用到;要用時再加回來,程式在 git 歷史 v4.0.0)。
 * 舊設定檔裡有這些不報錯:讀的時候拿掉,`dp doctor` 會逐條提醒。回傳 [{ key, note }]。
 */
const REMOVED = [
  ['agents.manager', 'Manager 已移除,改用預設優先序(解鎖下游數)', (v) => !v?.cmd],
  ['sandbox', '容器沙箱(docker / podman / srt)已移除;worker 一律在沒有 .git 的副本裡施工', (v) => (v?.backend ?? 'none') === 'none'],
  ['front', 'Front 的 strict 唯讀模式已移除(只剩防寫帳本的 light)', (v) => (v?.guard ?? 'light') === 'light'],
  ['auth.mode', 'signed / off 模式已移除:一律信任 Front 轉達,對得上簽章原話時另外記 hash', (v) => v === 'trust'],
  ['agents.verifier.url', 'Verifier 的 http(Ollama)模式已移除,改用 cmd', (v) => !v],
  ['agents.verifier.model', 'Verifier 的 http(Ollama)模式已移除,改用 cmd', (v) => !v],
  ['verify.clean_room_max_overlap', '外部程式匯入(intake import)已移除', () => true],
  ['pipeline.backfill', '既有專案補 gherkin(brownfield)已移除', (v) => String(v) === 'backfill'],
  ['pipeline.import-hard', '外部程式匯入(intake import)已移除', (v) => String(v) === 'test,port'],
  ['pipeline.import-soft', '外部程式匯入(intake import)已移除', (v) => String(v) === 'analyze,test,rebuild'],
];

export function stripRemovedSettings(raw) {
  const out = structuredClone(raw ?? {});
  const removed = [];
  // silent(v) 為真 = 舊設定只是預設值,拿掉不用提醒
  for (const [key, note, silent] of REMOVED) {
    const parts = key.split('.');
    const parent = parts.slice(0, -1).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), out);
    const last = parts.at(-1);
    if (parent && typeof parent === 'object' && last in parent) {
      const v = parent[last];
      delete parent[last];
      if (!silent?.(v)) removed.push({ key, note });
    }
  }
  if (out.platform === 'codex') { out.platform = 'generic'; removed.push({ key: 'platform', note: 'Codex 專屬的支援已移除,codex 指令照 generic 執行(沒有 hooks)' }); }
  if (out.agents?.verifier?.backend === 'http') { out.agents.verifier.backend = 'none'; removed.push({ key: 'agents.verifier.backend', note: 'http(Ollama)已移除,Verifier 暫時停用;改成 cmd(dp setup 可選 Claude Haiku)' }); }
  if (out.autonomy?.level === 3) { out.autonomy.level = 2; removed.push({ key: 'autonomy.level', note: 'L3 已移除,當成 L2(Critic 不代你做決定)' }); }
  return { config: out, removed };
}

export function loadConfig(root) {
  const { config: raw } = stripRemovedSettings(readJson(join(root, 'dp.config.json'), {}));
  try {
    assertValid(configSchema, raw, 'dp.config.json');
  } catch (e) {
    throw new DpError(e.message);
  }
  const config = merge(DEFAULTS, raw);
  // v4.5:gate 對應的指令(例 python3 -m pytest -q)也是 worker 拿來當證據的指令,自動放進重跑白名單。
  // 放的是測試框架那一段(python3 -m pytest、go test、cargo test):worker 只跑自己的測試檔時參數不同
  const runner = (c) => { const w = c.split(' ').filter(Boolean); return w.slice(0, w[1] === '-m' ? 3 : 2).join(' '); };
  const extra = Object.values(config.gates.commands ?? {}).filter((c) => /^[A-Za-z0-9 ._/:=@+-]+$/.test(c)).map(runner);
  if (extra.length) config.verify = { ...config.verify, rerun_allow: [...new Set([...config.verify.rerun_allow, ...extra])] };
  return config;

}

/**
 * scripts/check-next-gates.ts 的單元測試(模板 1.4.0 S6)。
 *
 * 造一次性的臨時 git repo(commit sha 引用要靠真的 git 歷史才能驗證存在與否),裡面放
 * 最小的 docs/02-decision-map.md、contracts/types.md、docs/01-roadmap.md、
 * docs/integration/、features/<NN-name>/{FEATURE.md,NEXT.md},跟真的專案格式對齊
 * (見這支腳本檔頭的說明)。`--root` 明講根目錄,不碰真的 repo。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractGateLines, readFeaturePhaseRows } from './check-next-gates.js';

const CHECK_NEXT_GATES_TS = resolve(import.meta.dirname, 'check-next-gates.ts');
const SPAWN_TIMEOUT_MS = 60_000;
const NEW_PROJECT_MESSAGE =
  '新專案剛完成初始化,目前沒有任何 features/NN-name 資料夾;這不是掃描器錯誤,下一步請依 README 建立第一個 features/01-xxx/';

const tmpDirs: string[] = [];

function runGit(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lc-next-gates-'));
  tmpDirs.push(dir);
  runGit(dir, 'init', '-q');
  runGit(dir, 'config', 'user.email', 'next-gates-test@example.com');
  runGit(dir, 'config', 'user.name', 'next-gates-test');
  runGit(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function write(root: string, relPath: string, content: string): void {
  const p = join(root, relPath);
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

function commitAll(root: string, message: string): string {
  runGit(root, 'add', '-A');
  runGit(root, 'commit', '-q', '-m', message);
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return r.stdout.trim();
}

function writeDecisionMap(root: string, adrIds: string[]): void {
  const body = adrIds.map((id) => `## ADR-${id} · 測試用決策\n\n- **Decision**: 測試\n`).join('\n');
  write(root, 'docs/02-decision-map.md', `# 決策地圖\n\n${body}`);
}

function writeContracts(root: string, sections: string[]): void {
  const body = sections.map((s) => `## ${s}. 測試章節\n\n內容。\n`).join('\n');
  write(root, 'contracts/types.md', `# 契約\n\n${body}`);
}

function writeRoadmap(root: string, integrationIds: number[]): void {
  const body = integrationIds.map((n) => `## I${n} · 測試整合點\n\n內容。\n`).join('\n');
  write(root, 'docs/01-roadmap.md', `# Roadmap\n\n${body}`);
}

function writeFeature(root: string, folder: string, phases: { n: number; status: string }[]): void {
  const rows = phases.map((p) => `| ${p.n} | 標題 | Wave 0 | ${p.status} |  |`).join('\n');
  write(
    root,
    `features/${folder}/FEATURE.md`,
    `# ${folder}\n\n## Phase\n\n| Phase | 標題 | 階段 | 狀態 | 完成日 |\n|---|---|---|---|---|\n${rows}\n`,
  );
}

function writeNext(root: string, folder: string, body: string): void {
  write(root, `features/${folder}/NEXT.md`, `# ${folder} — 下一步\n\n${body}\n`);
}

function run(root: string, ...extra: string[]): { code: number; output: string } {
  const r = spawnSync('npx', ['tsx', CHECK_NEXT_GATES_TS, '--root', root, ...extra], {
    cwd: root,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, GATES_CONFIG_DIR: join(root, 'scripts') },
  });
  return { code: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// 逐字照抄 features/_template/NEXT.md 的 gate checklist；只把模板的 N、
// 「無」佔位符換成這個臨時 repo 能解析的 phase/I/ADR，保留實際出貨的句型與措辭。
const TEMPLATE_GATE_CHECKLIST_SOURCE = [
  '- [ ] 自身:phase-(N-1) 狀態為 `done`',
  '- [ ] 整合:`IN` 已通過(**I1 之前的 phase 這一格留空 = 無 gate**,不要寫「無」以外的話搪塞;',
  '      I1 之後才需要真的填一個整合點編號)',
  '- [ ] 契約:(某個待決事項已決定,或「無」;延後的功能寫成一個人的決定,例:「使用者決定裝本機模型」,見 docs/03「延後一個功能」)',
].join('\n');

const TEMPLATE_GATE_CHECKLIST = TEMPLATE_GATE_CHECKLIST_SOURCE
  .replace('phase-(N-1)', 'phase-1')
  .replace(
    '某個待決事項已決定,或「無」',
    '某個待決事項已決定,ADR-123',
  );

const HEADER_FIXTURES = [
  {
    name: '模板原句「需要全部滿足:」',
    header: '**phase-2** 需要全部滿足:',
  },
  {
    name: '全形冒號',
    header: '**phase-2** 需要：',
  },
  {
    name: 'phase 號後帶括號說明',
    header: '**phase-2(接進 apps/api composition root)** 需要全部滿足:',
  },
] as const;

// 逐字照抄 /data/python/AI_KM/features/05-ingestion/NEXT.md 的第 40–52 行:
// 這是 phase-2b 回歸 fixture；舊 header parser 會把整段靜默當成普通文字。
const AI_KM_INGESTION_PHASE_2B_GATE = [
  '## phase-2b 的 gate(2026-09-05 新增,顧問裁決)',
  '',
  '**phase-2b(`pnpm dev` 起來時 fixture 已在索引裡)** 需要:',
  '',
  '- [x] 自身:phase-2 `done`(2026-09-05)',
  '- [x] 方向已裁:**旗標 seeder**(`AI_KM_DEV_SEED_FIXTURE=1`,由 `apps/api` 的 `dev` script 帶)。',
  '      顧問否決了另外兩條:**HTTP 上傳是 I4 的交付**(`knowledge.yaml`、`08` phase-2),',
  '      拉進 I2 就是跳整合點;**sqlite-vec(`06-retrieval/phase-3`)拉前面**才是真的「一條 CLI」,',
  '      但它同時改變「第二個 server 是空的」的語意(檔案共享),**那是 06 phase-3 自己該重寫的場景**,',
  '      不在 I2 中途做。',
  '- [x] 實作約束(顧問指定):seeder **必須走與測試步驟同一條 `app.ingestion` 路徑**,',
  '      不另開程式碼路徑;啟動時 **log 印出索引了哪份文件、幾個 chunk**,讓使用者看得到 store 不是空的;',
  '      `NODE_ENV=production` 加旗標 → **拒絕啟動**,照 `apps/api/src/config.ts` 既有',
  '      `AI_KM_DEV_TRIGGERS`/`AI_KM_TEST_SANDBOX` 的形狀與措辭,理由寫',
  '      「**它把固定 fixture 塞進生產索引**」。',
].join('\n');

// 逐字複製 /data/python/AI_KM/features/11-app-shell/FEATURE.md 的 phase 表資料列
// (第 113 行起至第 327 行的最後一列),再接上同檔第 339–343 行的無關需求表。
// 兩張表故意放在同一份 FEATURE.md；舊 parser 會把需求表的 2、3 列當成 phase-2/3,
// 讓真正的 done 狀態被最後一列的空狀態蓋掉。
const AI_KM_APP_SHELL_PHASE_TABLE = [
  '| Phase | 標題 | 整合點 | 狀態 | 完成日 |',
  '|---|---|---|---|---|',
  '| 1 | (回填)導覽可見性、首頁捷徑與時間、M3 token 不漂移與可讀性 | I1 | done | 2026-09-05 |',
  '| 2 | **問完問題的人點一下答案裡的引用,就看得到它在原文的哪一段;答案沒有 `state` 時畫面保持中性、不假裝那是一個已回答的答案。** | I2 | done | 2026-09-05 |',
  '| 3 | **一個人在瀏覽器問問題,看到的答案與引用就是伺服器產生的那一則,不是罐頭。** | I2 | done | 2026-09-05 |',
  '| 3b | **瀏覽器端不再有任何能自己產生助理回覆的碼或型別。** | I2 | done | 2026-09-07 |',
  '| 4 | **一個人點一下引用,抽屜裡顯示的就是伺服器給的那段原文,不是佔位文字。** | I2 | done | 2026-09-08 |',
  '| 5 | **一個人把視窗縮到手機寬度,側欄先變成只有圖示的窄軌,再縮就收進要按漢堡鈕才打開的抽屜;而不管在哪個寬度,每一個畫面在沒有資料、載入中、出錯、沒有權限的時候,都用字說得出現在是哪一種,不是一片空白,也不會露出他不該看到的東西。** | 待定 | **done** | 2026-09-13 |',
  '| 5b | **CI 的瀏覽器層 job 是綠的,而且每個整合點至少一條場景在它裡面跑。** | I2 之後 | todo | |',
  '| 6 | **一個人看到的答案照它該有的樣子排版,而不是滿螢幕的星號。** | I2 之後 | **done** | 2026-09-12 |',
].join('\n');

const AI_KM_APP_SHELL_REQUIREMENTS_TABLE = [
  '| # | 要求 | 為什麼 |',
  '|---|---|---|',
  '| 1 | **只渲染助理訊息,不渲染使用者輸入** | 使用者打的 `**` 不該變粗體;**更重要的是把使用者輸入餵進渲染器是典型的注入面**。**這條寫進場景,不只寫進註解** |',
  '| 2 | **關閉 raw HTML**(不要 `rehype-raw`);相依版本**釘死** | 模型可以吐 `<script>`,而我們正要把它的輸出丟進渲染器 |',
  '| 3 | **與 `[N]` 引用記號的互動要有場景** | markdown 的 `[text]` 是**連結參考語法**,我們的 `[1]` 會不會被它吃掉、或反過來破壞引用的可點性 —— **這是最可能壞的一處,而且壞了之後答案看起來仍然正常**。場景要斷言:渲染後 `[1]` **仍然可點**,且**點下去打開的是對的那一段** |',
].join('\n');

const AI_KM_APP_SHELL_FEATURE = [
  '# 11-app-shell',
  '',
  '## Phase',
  '',
  AI_KM_APP_SHELL_PHASE_TABLE,
  '',
  AI_KM_APP_SHELL_REQUIREMENTS_TABLE,
  '',
].join('\n');

const DUPLICATE_PHASE_FEATURE = [
  '# duplicate-phase',
  '',
  '## Phase',
  '',
  '| Phase | 標題 | 階段 | 狀態 | 完成日 |',
  '|---|---|---|---|---|',
  '| 2 | 第一列 | Wave 0 | todo | |',
  '| 2 | 第二列 | Wave 0 | done | |',
  '',
].join('\n');

const UNKNOWN_STATUS_FEATURE = [
  '# unknown-status',
  '',
  '## Phase',
  '',
  '| Phase | 標題 | 階段 | 狀態 | 完成日 |',
  '|---|---|---|---|---|',
  '| 7 | 未知狀態 | Wave 0 | mystery | |',
  '',
].join('\n');

// 逐字取 /data/python/AI_KM/features/11-app-shell/FEATURE.md 的 phase-3b 與 phase-4
// 資料列，以及其間出現的守門表與後續 CSP/白名單表。兩張非 phase 表都放在 phase
// 列之間，專門鎖住「跳過多張表後仍恢復掃描」的行為。
const AI_KM_APP_SHELL_INTERLEAVED_PHASE_TABLE = [
  '# 11-app-shell',
  '',
  '## Phase',
  '',
  '| Phase | 標題 | 整合點 | 狀態 | 完成日 |',
  '|---|---|---|---|---|',
  '| 3b | **瀏覽器端不再有任何能自己產生助理回覆的碼或型別。** | I2 | done | 2026-09-07 |',
  '',
  '| 守門 | 守什麼 | 在哪個 phase |',
  '|---|---|---|',
  '| `git grep receiveAssistantReply` 零命中 | **死碼清乾淨**(坑 9:沒有場景用過的東西,壞了多久都沒人知道) | **本 phase(3b)** |',
  '| `role` enum = `[user]` + `pnpm typecheck` | **client 不能自己回答**(性質本身) | `03-conversation/phase-4` |',
  '',
  '| # | 要求 | 為什麼 |',
  '|---|---|---|',
  '| 1 | **只渲染助理訊息,不渲染使用者輸入** | 使用者打的 `**` 不該變粗體;**更重要的是把使用者輸入餵進渲染器是典型的注入面**。**這條寫進場景,不只寫進註解** |',
  '| 2 | **關閉 raw HTML**(不要 `rehype-raw`);相依版本**釘死** | 模型可以吐 `<script>`,而我們正要把它的輸出丟進渲染器 |',
  '| 3 | **與 `[N]` 引用記號的互動要有場景** | markdown 的 `[text]` 是**連結參考語法**,我們的 `[1]` 會不會被它吃掉、或反過來破壞引用的可點性 —— **這是最可能壞的一處,而且壞了之後答案看起來仍然正常**。場景要斷言:渲染後 `[1]` **仍然可點**,且**點下去打開的是對的那一段** |',
  '| 4 | **CSP**:我們有 nonce-based CSP(E01-S029),渲染器**不得需要 inline style/script** | 需要的話**回報,不要自己放寬 CSP** |',
  '| **5** | **元素用白名單,而且 `a` 與 `img` 一律禁掉**(2026-09-12 顧問追加) | 見下方 —— **這條比上面四條都重要** |',
  '',
  '| 4 | **一個人點一下引用,抽屜裡顯示的就是伺服器給的那段原文,不是佔位文字。** | I2 | done | 2026-09-08 |',
  '',
].join('\n');

afterEach(() => {
  vi.restoreAllMocks();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('check-next-gates:0 份 NEXT.md 一律 FAIL', () => {
  it('features/ 只有 _template、沒有 NN-name 資料夾 → exit 1 並印新專案訊息', () => {
    const root = makeRepo();
    write(root, 'features/_template/FEATURE.md', '# template\n');
    write(root, 'features/_template/NEXT.md', '# template next\n');
    commitAll(root, 'init');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain(NEW_PROJECT_MESSAGE);
    expect(output).toContain('gate=next-gates result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);
});

describe('check-next-gates:引用解析(各種形狀)', () => {
  it('AI_KM 11-app-shell 兩張表混合時仍保留 phase-2/3 的 done 狀態(先寫紅)', () => {
    const root = makeRepo();
    write(root, 'features/11-app-shell/FEATURE.md', AI_KM_APP_SHELL_FEATURE);

    const rows = readFeaturePhaseRows(root, '11-app-shell');

    expect(rows.filter((row) => row.phase === '2')).toEqual([
      { phase: '2', status: 'done' },
    ]);
    expect(rows.filter((row) => row.phase === '3')).toEqual([
      { phase: '3', status: 'done' },
    ]);
  }, SPAWN_TIMEOUT_MS);

  it('同一張 phase 表的重複編號印警告並取第一列狀態', () => {
    const root = makeRepo();
    write(root, 'features/duplicate-phase/FEATURE.md', DUPLICATE_PHASE_FEATURE);
    const logSpy = vi.spyOn(console, 'log');

    const rows = readFeaturePhaseRows(root, 'duplicate-phase');
    const phase2 = rows.find((row) => row.phase === '2');
    const logs = logSpy.mock.calls.map(([message]) => String(message));

    expect(phase2).toEqual({ phase: '2', status: 'todo' });
    expect(rows.filter((row) => row.phase === '2')).toHaveLength(1);
    expect(logs.some((message) => /features\/duplicate-phase\/FEATURE\.md: phase-2 重複,出現在第 \d+、\d+ 行;取第 \d+ 行/.test(message))).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it('未知狀態印警告且不被當成 done', () => {
    const root = makeRepo();
    write(root, 'features/unknown-status/FEATURE.md', UNKNOWN_STATUS_FEATURE);
    const logSpy = vi.spyOn(console, 'log');

    const rows = readFeaturePhaseRows(root, 'unknown-status');
    const phase7 = rows.find((row) => row.phase === '7');
    const logs = logSpy.mock.calls.map(([message]) => String(message));

    expect(phase7).toEqual({ phase: '7', status: 'mystery' });
    expect(phase7?.status).not.toBe('done');
    expect(logs.some((message) => message.includes('features/unknown-status/FEATURE.md: 第 7 行 phase-7 的狀態「mystery」不是已知值'))).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it('同一個未知狀態 phase 被三條 gate 引用時,舊程式碼會重複印警告(先寫紅)', () => {
    const root = makeRepo();
    writeFeature(root, '01-foo', [{ n: 7, status: 'mystery' }]);
    writeNext(
      root,
      '01-foo',
      [
        '## Gate',
        '',
        '**phase-2** 需要:phase-7',
        '**phase-3** 需要:phase-7',
        '**phase-4** 需要:phase-7',
      ].join('\n'),
    );
    commitAll(root, 'duplicate unknown phase warning fixture');

    const { code, output } = run(root);
    const warning = '⚠ 警告 features/01-foo/FEATURE.md: 第 7 行 phase-7 的狀態「mystery」不是已知值(done/todo/in-progress/blocked/ready)';
    const warningCount = output.split(warning).length - 1;

    expect(code).toBe(0);
    expect(output).toContain('next-gates: 掃到 3 條 gate 宣告');
    expect(warningCount).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it('phase 表中夾兩張無關表後仍讀到 phase-4 的 done 狀態', () => {
    const root = makeRepo();
    write(root, 'features/11-app-shell/FEATURE.md', AI_KM_APP_SHELL_INTERLEAVED_PHASE_TABLE);

    const rows = readFeaturePhaseRows(root, '11-app-shell');

    expect(rows).toEqual([
      { phase: '3b', status: 'done' },
      { phase: '4', status: 'done' },
    ]);
    expect(rows.find((row) => row.phase === '4')).toEqual({ phase: '4', status: 'done' });
  }, SPAWN_TIMEOUT_MS);

  it('AI_KM 05-ingestion phase-2b 真實 gate 的三條 checklist 會被收進來(先寫紅)', () => {
    const gates = extractGateLines(
      '05-ingestion',
      'features/05-ingestion/NEXT.md',
      AI_KM_INGESTION_PHASE_2B_GATE,
    );

    expect(gates).toHaveLength(3);
    expect(gates.map((gate) => gate.phaseNum)).toEqual(['2b', '2b', '2b']);
  }, SPAWN_TIMEOUT_MS);

  it('ADR 引用存在 → PASS', () => {
    const root = makeRepo();
    writeDecisionMap(root, ['037']);
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }]);
    writeNext(root, '01-foo', '## Gate\n\n**phase-2** 需要:ADR-037 解除\n');
    commitAll(root, 'init');

    const { code, output } = run(root);

    expect(code).toBe(0);
    expect(output).toContain('✓ 全部 gate 宣告都有能解析的引用');
    expect(output).toContain('gate=next-gates result=PASS scanned=1');
  }, SPAWN_TIMEOUT_MS);

  it('ADR 引用不存在 → FAIL,訊息說「引用不存在」', () => {
    const root = makeRepo();
    writeDecisionMap(root, ['037']);
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }]);
    writeNext(root, '01-foo', '## Gate\n\n**phase-2** 需要:ADR-999 解除\n');
    commitAll(root, 'init');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('引用不存在(ADR-999)');
    expect(output).toContain('gate=next-gates result=FAIL scanned=1');
  }, SPAWN_TIMEOUT_MS);

  it('完全沒有引用 → FAIL,訊息說「沒有引用」', () => {
    const root = makeRepo();
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }]);
    writeNext(root, '01-foo', '## Gate\n\n**phase-2** 需要:等主管口頭同意\n');
    commitAll(root, 'init');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('gate 沒有引用 ADR/commit/§/IN/phase');
  }, SPAWN_TIMEOUT_MS);

  it('契約章節 §N 存在 / 不存在', () => {
    const root = makeRepo();
    writeContracts(root, ['7', '11b']);
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }]);
    writeNext(
      root,
      '01-foo',
      '## Gate\n\n**phase-2** 需要:見契約 §7\n\n**phase-3** 需要:見契約 §99\n',
    );
    commitAll(root, 'init');

    const { code, output } = run(root);

    expect(code).toBe(1); // phase-3 那條的 §99 不存在
    expect(output).toContain('gate=next-gates result=FAIL scanned=1');
    expect(output).toContain('引用不存在(§99)');
  }, SPAWN_TIMEOUT_MS);

  it('契約章節帶字母後綴(§11b)也能解析', () => {
    const root = makeRepo();
    writeContracts(root, ['11b']);
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }]);
    writeNext(root, '01-foo', '## Gate\n\n**phase-2** 需要:見契約 §11b\n');
    commitAll(root, 'init');

    const { code } = run(root);

    expect(code).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  it('整合點 I<N>:roadmap 標題與 docs/integration 檔名前綴都算數', () => {
    const root = makeRepo();
    writeRoadmap(root, [1]);
    write(root, 'docs/integration/i2-something.feature', 'Feature: x\n');
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }]);
    writeNext(
      root,
      '01-foo',
      '## Gate\n\n**phase-2** 需要:**I1 通過**\n\n**phase-3** 需要:**I2 通過**\n\n**phase-4** 需要:**I9 通過**\n',
    );
    commitAll(root, 'init');

    const { code, output } = run(root);

    expect(code).toBe(1); // 只有 I9 那條找不到
    expect(output).toContain('引用不存在(I9)');
  }, SPAWN_TIMEOUT_MS);

  it('phase 參照三種寫法都算數:完整資料夾名 / 兩位數字 / 自身裸寫', () => {
    const root = makeRepo();
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }, { n: 2, status: 'todo' }]);
    writeFeature(root, '02-bar', [{ n: 3, status: 'done' }]);
    writeNext(
      root,
      '01-foo',
      [
        '## Gate',
        '',
        '**phase-2** 需要:',
        '- [ ] 自身:phase-1 `done`',
        '- [ ] 跨資料夾:02 phase-3 `done`',
        '- [ ] 完整寫法:02-bar/phase-3 `done`',
      ].join('\n'),
    );
    commitAll(root, 'init');

    const { code, output } = run(root);

    expect(code).toBe(0);
    expect(output).toContain('gate=next-gates result=PASS scanned=1');
  }, SPAWN_TIMEOUT_MS);

  it('phase 參照新增寫法:反引號包資料夾名後接 phase-N(先寫紅)', () => {
    const root = makeRepo();
    writeFeature(root, '01-foo', [{ n: 2, status: 'todo' }]);
    writeFeature(root, '02-bar', [{ n: 3, status: 'done' }]);
    writeNext(
      root,
      '01-foo',
      ['## 下一個 phase 的 gate', '', '**phase-2** 需要:', '- [ ] `02-bar` phase-3 `done`'].join('\n'),
    );
    commitAll(root, 'backtick folder phase reference');

    const { code, output } = run(root);

    expect(code).toBe(0);
    expect(output).not.toContain('引用不存在');
    expect(output).toContain('✓ 全部 gate 宣告都有能解析的引用');
    expect(output).toContain('gate=next-gates result=PASS scanned=1');
  }, SPAWN_TIMEOUT_MS);

  it('phase 參照解析失敗(資料夾存在,但沒有那個 phase 列)→ FAIL', () => {
    const root = makeRepo();
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }]);
    writeNext(root, '01-foo', '## Gate\n\n**phase-2** 需要:phase-9 `done`\n');
    commitAll(root, 'init');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('引用不存在');
    expect(output).toContain('phase-9');
  }, SPAWN_TIMEOUT_MS);

  it('commit sha 引用:真的存在的 commit 算數,亂寫的不算', () => {
    const root = makeRepo();
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }]);
    const sha = commitAll(root, 'init(還沒有 NEXT.md,先建一個基準 commit)');
    writeNext(
      root,
      '01-foo',
      [
        '## Gate',
        '',
        `**phase-2** 需要:見 commit ${sha.slice(0, 10)}`,
        '',
        '**phase-3** 需要:見 commit deadbeef00',
      ].join('\n'),
    );
    commitAll(root, 'add NEXT.md');

    const { code, output } = run(root);

    expect(code).toBe(1); // phase-3 那條的 deadbeef00 不是真的 commit
    expect(output).toContain('引用不存在(deadbeef00)');
  }, SPAWN_TIMEOUT_MS);

  it('已打勾(已解除/已滿足)的 gate 一樣要掃、一樣要有能解析的引用', () => {
    const root = makeRepo();
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }]);
    writeNext(
      root,
      '01-foo',
      ['## Gate', '', '**phase-2** 需要:', '- [x] 契約:**已解除**(反正就是解除了)'].join('\n'),
    );
    commitAll(root, 'init');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('gate 沒有引用');
  }, SPAWN_TIMEOUT_MS);

  it('「無 gate」的 phase 不產生 gate 宣告,不算錯誤', () => {
    const root = makeRepo();
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }]);
    writeNext(root, '01-foo', '## Gate\n\n**phase-1**:無 gate。純函式。\n');
    commitAll(root, 'init');

    const { code, output } = run(root);

    expect(code).toBe(0);
    expect(output).toContain('掃到 0 條 gate 宣告');
    expect(output).toContain('gate=next-gates result=PASS scanned=1');
  }, SPAWN_TIMEOUT_MS);
});

describe('check-next-gates:header 解析回歸 fixture(先寫紅)', () => {
  for (const fixture of HEADER_FIXTURES) {
    it(`${fixture.name} 收進模板 gate checklist 的三條宣告`, () => {
      const root = makeRepo();
      writeDecisionMap(root, ['123']);
      writeRoadmap(root, [1]);
      writeFeature(root, '01-foo', [
        { n: 1, status: 'done' },
        { n: 2, status: 'todo' },
      ]);
      writeNext(root, '01-foo', `${fixture.header}\n\n${TEMPLATE_GATE_CHECKLIST}`);
      commitAll(root, 'header fixture');

      const { code, output } = run(root);

      expect(code).toBe(0);
      expect(output).toContain('next-gates: 掃到 3 條 gate 宣告');
      expect(output).toContain('✓ 全部 gate 宣告都有能解析的引用');
      expect(output).toContain('gate=next-gates result=PASS scanned=1');
    }, SPAWN_TIMEOUT_MS);
  }
});

describe('check-next-gates:防靜默 checklist 警告範圍(先寫紅)', () => {
  it('下一個 phase 的 gate 節裡的 orphan checklist 印正確檔名行號,但不改變 exit', () => {
    const root = makeRepo();
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }, { n: 2, status: 'todo' }]);
    const body = [
      '## 下一個 phase 的 gate',
      '',
      '**phase-2** 需要:phase-1 `done`',
      '- [ ] 這條 checklist 沒有被任何 gate header 收進來',
    ].join('\n');
    writeNext(root, '01-foo', body);
    commitAll(root, 'orphan checklist warning');

    const { code, output } = run(root);
    const orphanLine = 2 + body.split('\n').findIndex((line) => line.startsWith('- [ ]')) + 1;

    expect(code).toBe(0);
    expect(output).toContain(
      `⚠ 警告 features/01-foo/NEXT.md: 第 ${orphanLine} 行的 checklist 沒有被任何 gate header 收進 gate`,
    );
    expect(output).toContain('gate=next-gates result=PASS scanned=1');
  }, SPAWN_TIMEOUT_MS);

  it('同一份 fixture 修好 gate 引用後,orphan 警告仍印但 result=PASS、exit=0', () => {
    const root = makeRepo();
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }, { n: 2, status: 'todo' }]);
    const invalidGate = [
      '## 下一個 phase 的 gate',
      '',
      '**phase-2** 需要:等待外部裁示',
      '- [ ] 這條 checklist 沒有被任何 gate header 收進來',
    ].join('\n');
    writeNext(root, '01-foo', invalidGate);
    commitAll(root, 'orphan checklist with invalid gate');

    const before = run(root);
    const orphanLine = 2 + invalidGate.split('\n').findIndex((line) => line.startsWith('- [ ]')) + 1;
    const warning = `⚠ 警告 features/01-foo/NEXT.md: 第 ${orphanLine} 行的 checklist 沒有被任何 gate header 收進 gate`;
    expect(before.code).toBe(1);
    expect(before.output).toContain(warning);
    expect(before.output).toContain('gate=next-gates result=FAIL scanned=1');

    const validGate = invalidGate.replace('等待外部裁示', 'phase-1 `done`');
    writeNext(root, '01-foo', validGate);
    const after = run(root);

    expect(after.code).toBe(0);
    expect(after.output).toContain(warning);
    expect(after.output).toContain('gate=next-gates result=PASS scanned=1');
  }, SPAWN_TIMEOUT_MS);

  it('目前/完成後節裡的 orphan checklist 不印警告(先寫紅)', () => {
    const root = makeRepo();
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }, { n: 2, status: 'todo' }]);
    const body = [
      '## 目前',
      '- [ ] 目前的 DoD 清單,不是 gate',
      '',
      '## 下一個 phase 的 gate',
      '',
      '**phase-2** 需要:phase-1 `done`',
      '',
      '## 完成後',
      '- [ ] 完成後的 DoD 清單,不是 gate',
    ].join('\n');
    writeNext(root, '01-foo', body);
    commitAll(root, 'ignore non-gate checklist warnings');

    const { code, output } = run(root);

    expect(code).toBe(0);
    expect(output).not.toContain('目前的 DoD 清單');
    expect(output).not.toContain('完成後的 DoD 清單');
    expect(output).not.toContain('⚠ 警告 features/01-foo/NEXT.md');
    expect(output).toContain('gate=next-gates result=PASS scanned=1');
  }, SPAWN_TIMEOUT_MS);
});

describe('check-next-gates:nextGates.mode', () => {
  it('report 模式:有失敗一樣印出來、marker 一樣 FAIL,但 exit 0', () => {
    const root = makeRepo();
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'gates.config.json'), JSON.stringify({ nextGates: { mode: 'report' } }), 'utf8');
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }]);
    writeNext(root, '01-foo', '## Gate\n\n**phase-2** 需要:等主管口頭同意\n');
    commitAll(root, 'init');

    const { code, output } = run(root);

    expect(code).toBe(0);
    expect(output).toContain('gate=next-gates result=FAIL scanned=1');
    expect(output).toContain('report');
  }, SPAWN_TIMEOUT_MS);

  it('預設(沒有 gates.config.json,或沒填 nextGates.mode)是 enforce:同樣的失敗要 exit 1', () => {
    const root = makeRepo();
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }]);
    writeNext(root, '01-foo', '## Gate\n\n**phase-2** 需要:等主管口頭同意\n');
    commitAll(root, 'init');

    const { code } = run(root);

    expect(code).toBe(1);
  }, SPAWN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// S9:設定檔壞掉要大聲失敗(不是未捕捉的堆疊,也不是悄悄套用預設值)。
// ---------------------------------------------------------------------------

describe('check-next-gates:S9 設定檔壞掉', () => {
  it('gates.config.json 是壞掉的 JSON → 印「設定檔壞掉」+ 標記,不是未捕捉的堆疊', () => {
    const root = makeRepo();
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'gates.config.json'), '{ broken json', 'utf8');
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }]);
    writeNext(root, '01-foo', '## Gate\n\n**phase-2** 需要:phase-1\n');
    commitAll(root, 'init');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('✗ 設定檔壞掉:');
    expect(output).toContain('gate=next-gates result=FAIL scanned=0');
    expect(output).not.toContain('at JSON.parse');
    expect(output).not.toContain('SyntaxError');
  }, SPAWN_TIMEOUT_MS);

  it('gates.config.json 有不認識的頂層鍵(打錯字)→ 印「設定檔有不認識的鍵」', () => {
    const root = makeRepo();
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'gates.config.json'), JSON.stringify({ nextGatess: { mode: 'report' } }), 'utf8');
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }]);
    writeNext(root, '01-foo', '## Gate\n\n**phase-2** 需要:phase-1\n');
    commitAll(root, 'init');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('✗ 設定檔有不認識的鍵:nextGatess');
    expect(output).toContain('gate=next-gates result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);

  it('合法設定不受影響(nextGates.mode 照常生效)', () => {
    const root = makeRepo();
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'gates.config.json'), JSON.stringify({ nextGates: { mode: 'report' } }), 'utf8');
    writeFeature(root, '01-foo', [{ n: 1, status: 'done' }]);
    writeNext(root, '01-foo', '## Gate\n\n**phase-2** 需要:等主管口頭同意\n');
    commitAll(root, 'init');

    const { code, output } = run(root);

    expect(code).toBe(0);
    expect(output).toContain('gate=next-gates result=FAIL scanned=1');
  }, SPAWN_TIMEOUT_MS);
});

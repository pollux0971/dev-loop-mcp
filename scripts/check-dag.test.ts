/**
 * `scripts/check-dag.ts` 的先行紅測試(ADR-019 第 3 點)。
 *
 * 這一棒只建立可執行的 acceptance fixtures；實作由下一棒接手。
 * 每個 fixture 都是一次性的 git repo，讓 phase 引用與 commit 引用都跟
 * 真實專案格式一致，而且 `--root` 明講後不會碰到目前工作樹。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeIsolatedTempDir } from './_root.js';

const CHECK_DAG_TS = resolve(import.meta.dirname, 'check-dag.ts');
const CHECK_NEXT_GATES_TS = resolve(import.meta.dirname, 'check-next-gates.ts');
const SPAWN_TIMEOUT_MS = 60_000;

const tmpDirs: string[] = [];

function runGit(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

function makeRepo(): string {
  const dir = makeIsolatedTempDir('lc-check-dag-');
  tmpDirs.push(dir);
  runGit(dir, 'init', '-q');
  runGit(dir, 'config', 'user.email', 'check-dag-test@example.com');
  runGit(dir, 'config', 'user.name', 'check-dag-test');
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
  if (r.status !== 0) throw new Error(`git rev-parse HEAD failed: ${r.stderr}`);
  return r.stdout.trim();
}

function writeFeature(root: string, folder: string, phases: { n: number | string; status: string }[]): void {
  const rows = phases
    .map((p) => `| ${p.n} | phase-${p.n} | 測試 phase-${p.n} | Wave 0 | ${p.status} |  |`)
    .join('\n');
  write(
    root,
    `features/${folder}/FEATURE.md`,
    `# ${folder}\n\n## Phase\n\n| Phase | 標題 | 意圖(讓人做到什麼) | 階段 | 狀態 | 完成日 |\n|---|---|---|---|---|---|\n${rows}\n`,
  );
}

function writeNext(root: string, folder: string, body: string): void {
  write(root, `features/${folder}/NEXT.md`, `# ${folder} — 下一步\n\n${body}\n`);
}

function writeDecisionMap(root: string, ids: string[]): void {
  const body = ids.map((id) => `## ADR-${id} · 測試用決策\n\n內容。\n`).join('\n');
  write(root, 'docs/02-decision-map.md', `# 決策地圖\n\n${body}`);
}

function writeDecisionMapWithStatuses(
  root: string,
  entries: { id: string; status: string }[],
): void {
  const body = entries
    .map(({ id, status }) => `## ADR-${id} · 測試用決策\n\n- **Status**: ${status}\n`)
    .join('\n');
  write(root, 'docs/02-decision-map.md', `# 決策地圖\n\n${body}`);
}

function writeContracts(root: string, sections: string[]): void {
  const body = sections.map((section) => `## ${section}. 測試章節\n\n內容。\n`).join('\n');
  write(root, 'contracts/types.md', `# 契約\n\n${body}`);
}

function writeRoadmap(root: string, integrationIds: number[]): void {
  const body = integrationIds.map((n) => `## I${n} · 測試整合點\n\n內容。\n`).join('\n');
  write(root, 'docs/01-roadmap.md', `# Roadmap\n\n${body}`);
}

function run(root: string): { code: number; output: string } {
  const r = spawnSync('npx', ['tsx', CHECK_DAG_TS, '--root', root], {
    cwd: root,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, GATES_CONFIG_DIR: join(root, 'scripts') },
  });
  return { code: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function runNextGates(root: string): { code: number; output: string } {
  const r = spawnSync('npx', ['tsx', CHECK_NEXT_GATES_TS, '--root', root], {
    cwd: root,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, GATES_CONFIG_DIR: join(root, 'scripts') },
  });
  return { code: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function outputSection(output: string, startMarker: string, endMarker?: string): string {
  const start = output.indexOf(startMarker);
  if (start < 0) return '';
  const end = endMarker === undefined ? -1 : output.indexOf(endMarker, start + startMarker.length);
  return output.slice(start, end < 0 ? undefined : end);
}

function sectionBefore(output: string, startMarker: string, endMarkers: string[]): string {
  const start = output.indexOf(startMarker);
  if (start < 0) return '';
  const end = endMarkers
    .map((marker) => output.indexOf(marker, start + startMarker.length))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  return output.slice(start, end === undefined ? undefined : end);
}

function layerSection(output: string, layer: number, nextLayer?: number): string {
  return outputSection(output, `第 ${layer} 層`, nextLayer === undefined ? '目前 ready 集合' : `第 ${nextLayer} 層`);
}

describe('check-dag:零輸入訊息(先寫紅)', () => {
  it('情況 1: features/ 不存在時指出路徑或初始化問題', () => {
    const root = makeRepo();

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('掃描器壞了');
    expect(output).toContain('features/');
    expect(output).toContain('--root');
    expect(output).not.toContain('新專案剛完成初始化');
    expect(output).toContain('gate=dag result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);

  it('情況 2: 只有 features/_template/ 時維持新專案訊息', () => {
    const root = makeRepo();
    write(root, 'features/_template/README.md', '# template\n');
    commitAll(root, 'empty feature template');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('新專案剛完成初始化');
    expect(output).not.toContain('掃描器壞了');
    expect(output).toContain('gate=dag result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);

  it('情況 3: 有 NN-name 資料夾但讀不到 phase 時指出資料夾與 phase 問題', () => {
    const root = makeRepo();
    write(root, 'features/01-foo/FEATURE.md', '# 01-foo\n\n尚未填寫 phase 表。\n');
    commitAll(root, 'feature folder without phase table');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('1 個功能資料夾');
    expect(output).toContain('讀不到任何 phase');
    expect(output).not.toContain('新專案剛完成初始化');
    expect(output).toContain('gate=dag result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);
});

const HEADER_FIXTURES = [
  {
    name: '模板原句「需要全部滿足:」',
    header: (phase: number) => `**phase-${phase}** 需要全部滿足:`,
  },
  {
    name: '全形冒號',
    header: (phase: number) => `**phase-${phase}** 需要：`,
  },
  {
    name: 'phase 號後帶括號說明',
    header: (phase: number) => `**phase-${phase}(接進 apps/api composition root)** 需要全部滿足:`,
  },
] as const;

function checklistGate(header: string, dependency: string): string {
  return `${header}\n\n- [ ] ${dependency}`;
}

// 逐字照抄 /data/python/AI_KM/features/02-authorization/NEXT.md 的第 17–73 行:
// 「## 下一個 phase 的 gate」到 phase-3 checklist 結束,包含會觸發假環的
// 「deny 來源留到 phase-3」續行與 phase-3 的真實 phase-2 依賴。這個 fixture
// 固定在測試裡,不依賴外部 repo。
const AI_KM_AUTHORIZATION_PHASE_2_GATE = [
  '## 下一個 phase 的 gate',
  '',
  '**phase-2(從 identity 的 session 產出 `RetrievalScope`)** 需要全部滿足:',
  '',
  '- [x] 自身:phase-1 `done`',
  '- [x] 整合:I2 通過(✓ 2026-09-13,使用者親手走查)(`06-retrieval` phase-2 把 `retrievalPlugin` 接進 `apps/api` composition root,',
  '      屆時那條「scope 固定給 `dept:eng`」的暫時限制才有東西可以取代)。',
  '      **2026-09-05 現況更正**:`06-retrieval` phase-2 **已 `done`(2026-09-04)**,',
  '      I2 本身**尚未收尾**——還差 `11-app-shell/phase-3`、`03-conversation/phase-4`、',
  '      `07-generation/phase-2b`、`11-app-shell/phase-4`(最後兩個是 2026-09-05 才發現的第四層,',
  '      見 PITFALLS 坑 19 第四次)。原文寫「這是唯一還沒解除的 gate」**也已過期**,見下一條。',
  '- [ ] 自身:**拿得出 `department.id`／`group.id`**。今天 `users` 表只有顯示名兩欄,',
  '      repo 內無任何 id 對照表——**它才是 2a 那 4 條紅的原因**。',
  '',
  '      ⚠️ **這一條不是在等別人**(2026-09-05,技術顧問 ai-km-1b 澄清)。它**就是** 2026-09-04',
  '      裁的 **2a** 本身:最小的 `scope_principals(id, kind, name, UNIQUE(kind, name))` 對照表、',
  '      `users` 加 FK、**trim 後精確比對**回填。所以狀態是 `blocked`,但理由是',
  '      **「等 I2 收尾後由 02 自己做」**,不是「等 `01-identity` 交東西」——',
  '      把它當外部阻塞會讓 I3 開工時沒有人動手。',
  '',
  '      **而且不是照 2a 原樣做,是升級版**:[ADR 0021](../../docs/adr/0021-scope-vocabulary-and-knowledge-set-tree.md)',
  '      之後這張表要長成**知識集樹的節點**——`kind` 擴成 `org` / `dept` / `project` / `user`,',
  '      並加 `parent_id`。',
  '',
  '      **擁有權(顧問裁)**:',
  '      - **節點表與成員關係 → `02-authorization`**(它是授權的**受體**)',
  '      - **文件掛到哪個節點 → `08-knowledge-management`**,隨 I4 的 knowledge 契約來',
  '      - **`01-identity` 只負責 session 回應多帶使用者所屬的節點 id**',
  '',
  '      **I3 的第一個 `/decide` 就是這張表的 schema**,由技術顧問裁。',
  '- [ ] 規格:前置是 **[ADR 0021](../../docs/adr/0021-scope-vocabulary-and-knowledge-set-tree.md)',
  '      D1–D3** 的資料結構(四種 scope key、知識集是樹、子樹 deny 沿樹展開且優先於祖先的 allow、',
  '      每次請求建構時展開不跨請求快取)。**2026-09-05 新增**——ADR 0013 #7 的兩種 key 字彙',
  '      已被它擴寫,照舊字彙寫的 phase-2 規格會少兩種分區。',
  '- [x] 契約:**E04-S009 已解除 blocked**(技術顧問依 ADR 0012,2026-09-04 裁定;',
  '      **不是使用者級,`/sprint` 不要再把它算成「等使用者拍板」**):',
  '      1. `scopeKey` 形狀:`dept:<department.id>` / `group:<group.id>`,顯示名永遠不當鑰匙。',
  '      2. 對應由 `01-identity` 單一維護,`02-authorization` 只讀,不建第二張表。',
  '      3. `allowedScopeKeys` = 部門 ∪ 群組(聯集)。',
  '      4. Deny-Wins 作用在顯式 ACL deny 上,不是「取交集」的窄化。',
  '      5. 一份文件只有單一 `scopeKey`;搬部門後原部門即不可見。',
  '      **但**:裁定 1 假設的 `department.id`/`group.id` 今天在 01-identity 完全不存在',
  '      (`users` 表只有顯示名稱兩欄,repo 內無任何 id 對照表)——**這點仍未解除,見下方',
  '      「待協調」**。裁定 4(顯式 deny)需要的型別維度上一輪只定了方向,技術顧問',
  '      2026-09-04 已補齊**完整形狀**(`deniedScopeKeys`、謂詞與 SQL 的合成規則、',
  '      deny 來源留到 phase-3)——見 `FEATURE.md`「phase-2b 提案」與「phase-2b 完成」段。',
  '      三輪接力已做完:測試 agent 把 deny 場景從 1 條拆成 4 條、開發 agent 實作',
  '      `scope.ts`、測試 agent 把 steps 接上真的 API,`phase-2.feature` 的 deny 場景',
  '      4/4 綠、`deny.test.ts` 4/4 綠、`pnpm turbo run test` 40/40。',
  '      這不代表 gate 已滿足:2a(identity 轉換,裁定 1 的 id 缺口)仍是紅,I2 仍是',
  '      todo,phase-2 IMPLEMENT 收尾要等兩者都解除。',
  '',
  '**phase-3(群組 → scopeKeys 的變更即時生效)** 需要:',
  '',
  '- [ ] 自身:phase-2 `done`',
  '- [ ] 整合:I6(admin 的部門／群組頁接真 API)',
].join('\n');

// 逐字照抄 /data/python/AI_KM/features/05-ingestion/NEXT.md 的第 40–52 行:
// 真實的 phase-2b gate。這個 fixture 的重點是 header 與 phase 表節點都帶小寫
// 字母後綴；舊程式會把整段 gate 靜默跳過，且不會建立 05 phase-2b 節點。
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
// 這兩張表混在一起是本工單要重現的既有 bug:需求表的 2、3 列會覆寫 phase-2/3,
// 使 check:dag 印出「11 phase-2 []」與「11 phase-3 []」。
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

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('check-dag:PASS 輸出', () => {
  it('AI_KM 11-app-shell 兩張表混合時 phase-2/3 狀態仍是 done(先寫紅)', () => {
    const root = makeRepo();
    write(root, 'features/11-app-shell/FEATURE.md', AI_KM_APP_SHELL_FEATURE);
    commitAll(root, 'AI_KM app-shell phase table disambiguation regression');

    const { code, output } = run(root);

    expect(code).toBe(0);
    expect(output).toContain('11 phase-2 [done]');
    expect(output).toContain('11 phase-3 [done]');
  }, SPAWN_TIMEOUT_MS);

  it('列出拓撲分層、平行寬度、ready 集合與外部阻擋', () => {
    const root = makeRepo();
    writeDecisionMap(root, ['123']);
    writeContracts(root, ['7']);
    writeRoadmap(root, [1]);

    writeFeature(root, '01-alpha', [
      { n: 1, status: 'done' },
      { n: 2, status: 'todo' },
    ]);
    writeFeature(root, '02-beta', [{ n: 1, status: 'todo' }]);
    writeFeature(root, '03-gamma', [{ n: 1, status: 'todo' }]);
    writeFeature(root, '04-adr-blocked', [{ n: 1, status: 'todo' }]);
    writeFeature(root, '05-contract-blocked', [{ n: 1, status: 'todo' }]);
    writeFeature(root, '06-commit-blocked', [{ n: 1, status: 'todo' }]);
    writeFeature(root, '07-externally-cleared', [{ n: 1, status: 'todo' }]);

    // 先建立一個可供 NEXT.md 引用的真實 commit sha。
    const baseSha = commitAll(root, 'base for external blocker citation');
    const shortSha = baseSha.slice(0, 10);

    writeNext(root, '01-alpha', '**phase-2** 需要:phase-1 `done`');
    writeNext(root, '02-beta', '**phase-1** 需要:\n- [ ] 01 phase-1 `done`');
    writeNext(root, '03-gamma', '**phase-1** 需要:\n- [ ] 01-alpha/phase-1 `done`');
    writeNext(root, '04-adr-blocked', '**phase-1** 需要:\n- [ ] ADR-123 等待裁示');
    writeNext(root, '05-contract-blocked', '**phase-1** 需要:\n- [ ] §7 等契約確認');
    writeNext(root, '06-commit-blocked', `**phase-1** 需要:\n- [ ] ${shortSha} 等待外部提交`);
    writeNext(root, '07-externally-cleared', '**phase-1** 需要:\n- [x] ADR-123 已解除');
    commitAll(root, 'add DAG gates');

    const { code, output } = run(root);

    expect(code).toBe(0);
    expect(output).toContain('拓撲分層');
    expect(output).toContain('第 1 層');
    expect(output).toContain('第 2 層');
    expect(output).toContain('I1');
    expect(output).toContain('gate=dag result=PASS scanned=9');

    const layer1 = layerSection(output, 1, 2);
    expect(layer1).toContain('節點數=6');
    for (const node of ['01 phase-1', '04 phase-1', '05 phase-1', '06 phase-1', '07 phase-1', 'I1']) {
      expect(layer1, `第 1 層應包含 ${node}`).toContain(node);
    }

    const layer2 = layerSection(output, 2);
    expect(layer2).toContain('節點數=3');
    for (const node of ['01 phase-2', '02 phase-1', '03 phase-1']) {
      expect(layer2, `第 2 層應包含 ${node}`).toContain(node);
    }

    const ready = outputSection(output, '目前 ready 集合', '被外部阻擋卡住的 phase');
    for (const node of ['01 phase-2', '02 phase-1', '03 phase-1', '07 phase-1']) {
      expect(ready, `ready 集合應包含 ${node}`).toContain(node);
    }
    for (const node of ['04 phase-1', '05 phase-1', '06 phase-1']) {
      expect(ready, `外部阻擋中的 ${node} 不應在 ready 集合`).not.toContain(node);
    }

    const blocked = outputSection(output, '被外部阻擋卡住的 phase');
    expect(blocked).toContain('04 phase-1');
    expect(blocked).toContain('ADR-123');
    expect(blocked).toContain('05 phase-1');
    expect(blocked).toContain('§7');
    expect(blocked).toContain('06 phase-1');
    expect(blocked).toContain(shortSha);
    expect(blocked, '已勾選解除的外部 gate 不應列在 blocked 集合').not.toContain('07 phase-1');
  }, SPAWN_TIMEOUT_MS);
});

describe('check-dag:ADR gate 分類(先寫紅)', () => {
  it('① unchecked bullet 提到 accepted ADR:列未打勾 gate,不列外部阻擋且仍不 ready', () => {
    const root = makeRepo();
    writeDecisionMapWithStatuses(root, [{ id: '101', status: 'accepted' }]);
    writeFeature(root, '01-accepted-adr', [{ n: 1, status: 'todo' }]);
    writeNext(
      root,
      '01-accepted-adr',
      [
        '## 下一個 phase 的 gate',
        '',
        '**phase-1** 需要全部滿足:',
        '',
        '- [ ] 規格沿用 ADR-101 的資料結構決定(純參考說明,不是在等這個 ADR 被裁定)',
      ].join('\n'),
    );
    commitAll(root, 'accepted ADR is an unchecked local gate');

    const { code, output } = run(root);
    const ready = sectionBefore(output, '目前 ready 集合', [
      '未打勾 gate',
      '被外部阻擋卡住的 phase',
    ]);
    const unchecked = outputSection(output, '未打勾 gate', '被外部阻擋卡住的 phase');
    const blocked = outputSection(output, '被外部阻擋卡住的 phase');

    expect(code).toBe(0);
    expect(ready).not.toContain('- 01 phase-1');
    expect(output).toContain('未打勾 gate 1 條');
    expect(unchecked).toContain('01 phase-1');
    expect(unchecked).toContain('ADR-101');
    expect(blocked).not.toContain('01 phase-1');
    expect(blocked).not.toContain('ADR-101');
  }, SPAWN_TIMEOUT_MS);

  it('② unchecked bullet 提到 proposed ADR:列外部阻擋且不 ready', () => {
    const root = makeRepo();
    writeDecisionMapWithStatuses(root, [{ id: '102', status: 'proposed' }]);
    writeFeature(root, '02-proposed-adr', [{ n: 1, status: 'todo' }]);
    writeNext(
      root,
      '02-proposed-adr',
      [
        '## 下一個 phase 的 gate',
        '',
        '**phase-1** 需要全部滿足:',
        '',
        '- [ ] ADR-102 等待使用者裁示',
      ].join('\n'),
    );
    commitAll(root, 'proposed ADR remains an external blocker');

    const { code, output } = run(root);
    const citations = runNextGates(root);
    const ready = sectionBefore(output, '目前 ready 集合', [
      '未打勾 gate',
      '被外部阻擋卡住的 phase',
    ]);
    const blocked = outputSection(output, '被外部阻擋卡住的 phase');

    expect(code).toBe(0);
    expect(citations.code).toBe(0);
    expect(citations.output).toContain('gate=next-gates result=PASS scanned=1');
    expect(ready).not.toContain('- 02 phase-1');
    expect(output).toContain('外部阻擋 1 個');
    expect(blocked).toContain('02 phase-1');
    expect(blocked).toContain('ADR-102');
  }, SPAWN_TIMEOUT_MS);

  it('③ unchecked bullet 提到不存在的 ADR:維持既有外部阻擋回歸行為', () => {
    const root = makeRepo();
    writeDecisionMap(root, []);
    writeFeature(root, '03-missing-adr', [{ n: 1, status: 'todo' }]);
    writeNext(
      root,
      '03-missing-adr',
      [
        '## 下一個 phase 的 gate',
        '',
        '**phase-1** 需要全部滿足:',
        '',
        '- [ ] ADR-999 等待裁示',
      ].join('\n'),
    );
    commitAll(root, 'missing ADR remains an external blocker regression');

    const { code, output } = run(root);
    const ready = sectionBefore(output, '目前 ready 集合', [
      '未打勾 gate',
      '被外部阻擋卡住的 phase',
    ]);
    const blocked = outputSection(output, '被外部阻擋卡住的 phase');

    expect(code).toBe(0);
    expect(ready).not.toContain('- 03 phase-1');
    expect(blocked).toContain('03 phase-1');
    expect(blocked).toContain('ADR-999');
  }, SPAWN_TIMEOUT_MS);

  it('④ checked bullet 提到 accepted/proposed ADR 都滿足,不列兩種分類且 phase 進 ready', () => {
    const root = makeRepo();
    writeDecisionMapWithStatuses(root, [
      { id: '104', status: 'accepted' },
      { id: '105', status: 'proposed' },
    ]);
    writeFeature(root, '04-checked-adr', [{ n: 1, status: 'todo' }]);
    writeNext(
      root,
      '04-checked-adr',
      [
        '## 下一個 phase 的 gate',
        '',
        '**phase-1** 需要全部滿足:',
        '',
        '- [x] ADR-104 已決定',
        '- [x] ADR-105 等待裁示但此 gate 已解除',
      ].join('\n'),
    );
    commitAll(root, 'checked ADR gates are satisfied');

    const { code, output } = run(root);
    const ready = sectionBefore(output, '目前 ready 集合', [
      '未打勾 gate',
      '被外部阻擋卡住的 phase',
    ]);
    const unchecked = outputSection(output, '未打勾 gate', '被外部阻擋卡住的 phase');
    const blocked = outputSection(output, '被外部阻擋卡住的 phase');

    expect(code).toBe(0);
    expect(ready).toContain('- 04 phase-1');
    expect(unchecked).not.toContain('04 phase-1');
    expect(blocked).not.toContain('04 phase-1');
  }, SPAWN_TIMEOUT_MS);
});

describe('check-dag:環路', () => {
  it('環路 exit 1 並印出完整的閉合路徑', () => {
    const root = makeRepo();
    writeFeature(root, '01-alpha', [{ n: 1, status: 'todo' }]);
    writeFeature(root, '02-beta', [{ n: 1, status: 'todo' }]);
    writeNext(root, '01-alpha', '**phase-1** 需要:02 phase-1');
    writeNext(root, '02-beta', '**phase-1** 需要:01 phase-1');
    commitAll(root, 'cycle');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('環');
    expect(output).toContain('01 phase-1 → 02 phase-1 → 01 phase-1');
    expect(output).toContain('gate=dag result=FAIL scanned=2');
  }, SPAWN_TIMEOUT_MS);

  for (const fixture of HEADER_FIXTURES) {
    it(`${fixture.name} 也必須抓到環路依賴`, () => {
      const root = makeRepo();
      writeFeature(root, '01-alpha', [{ n: 1, status: 'todo' }]);
      writeFeature(root, '02-beta', [{ n: 1, status: 'todo' }]);
      writeNext(root, '01-alpha', checklistGate(fixture.header(1), '02 phase-1'));
      writeNext(root, '02-beta', checklistGate(fixture.header(1), '01 phase-1'));
      commitAll(root, `cycle: ${fixture.name}`);

      const { code, output } = run(root);

      expect(code).toBe(1);
      expect(output).toContain('環');
      expect(output).toContain('01 phase-1 → 02 phase-1 → 01 phase-1');
      expect(output).toContain('gate=dag result=FAIL scanned=2');
    }, SPAWN_TIMEOUT_MS);
  }

  it('AI_KM 02-authorization phase-2 真實段落不應形成續行假環(先寫紅)', () => {
    const root = makeRepo();
    writeFeature(root, '02-authorization', [
      { n: 1, status: 'done' },
      { n: 2, status: 'todo' },
      { n: 3, status: 'todo' },
    ]);
    writeFeature(root, '03-conversation', [{ n: 4, status: 'done' }]);
    writeFeature(root, '06-retrieval', [{ n: 2, status: 'done' }]);
    writeFeature(root, '07-generation', [{ n: 2, status: 'done' }]);
    writeFeature(root, '11-app-shell', [
      { n: 3, status: 'done' },
      { n: 4, status: 'done' },
    ]);
    writeNext(root, '02-authorization', AI_KM_AUTHORIZATION_PHASE_2_GATE);
    commitAll(root, 'AI_KM authorization phase-2 false cycle');

    const { code, output } = run(root);

    expect(output).not.toContain('02 phase-2 → 02 phase-3 → 02 phase-2');
    expect(code).toBe(0);
    expect(output).not.toContain('gate 引用了自己');
    expect(layerSection(output, 2, 3)).toContain('02 phase-2');
    expect(layerSection(output, 3)).toContain('02 phase-3');
    expect(output).toContain('gate=dag result=PASS');
  }, SPAWN_TIMEOUT_MS);

  it('獨立人造 fixture 只把 bullet 第一行算成邊,但 next-gates 仍看續行引用(先寫紅)', () => {
    const root = makeRepo();
    writeFeature(root, '01-alpha', [
      { n: 1, status: 'done' },
      { n: 2, status: 'todo' },
      { n: 3, status: 'todo' },
    ]);
    const body = [
      '## 下一個 phase 的 gate',
      '',
      '**phase-3** 需要全部滿足:',
      '',
      '- [ ] 整合:phase-1 done',
      '      之後 phase-2 會處理這個。',
      '- [ ] 這條 gate 的第一行只是說明:',
      '      參照 phase-2 的完成結果。',
    ].join('\n');
    writeNext(root, '01-alpha', body);
    commitAll(root, 'continuation text is not a DAG edge');

    const nextGates = runNextGates(root);
    expect(nextGates.code).toBe(0);
    expect(nextGates.output).toContain('next-gates: 掃到 2 條 gate 宣告');
    expect(nextGates.output).toContain('✓ 全部 gate 宣告都有能解析的引用');
    expect(nextGates.output).toContain('gate=next-gates result=PASS scanned=1');

    const dag = run(root);
    expect(dag.code).toBe(0);
    expect(layerSection(dag.output, 2)).toContain('01 phase-3');
    const ready = outputSection(dag.output, '目前 ready 集合', '被外部阻擋卡住的 phase');
    expect(ready).toContain('01 phase-3');
    expect(dag.output).toContain('gate=dag result=PASS scanned=3');
  }, SPAWN_TIMEOUT_MS);

  it('獨立人造的自身:phase-2 也只印忽略警告,不形成自身假環(先寫紅)', () => {
    const root = makeRepo();
    writeFeature(root, '02-authorization', [{ n: 2, status: 'todo' }]);
    const body = [
      '## 下一個 phase 的 gate',
      '',
      '**phase-2** 需要全部滿足:',
      '',
      '- [ ] 自身:phase-2 done',
    ].join('\n');
    writeNext(root, '02-authorization', body);
    commitAll(root, 'independent self phase false cycle');

    const { code, output } = run(root);
    const selfLine = 2 + body.split('\n').findIndex((line) => line.startsWith('- [ ]')) + 1;

    expect(code).toBe(0);
    expect(output).not.toContain('02 phase-2 → 02 phase-2');
    expect(output).toContain(
      `features/02-authorization/NEXT.md: 第 ${selfLine} 行 gate 引用了自己(phase-2),已忽略`,
    );
    expect(output).toContain('gate=dag result=PASS scanned=1');
  }, SPAWN_TIMEOUT_MS);
});

describe('check-dag:phase 小寫字母後綴(先寫紅)', () => {
  it('AI_KM 05-ingestion phase-2b 真實 gate 會建立節點並接上 phase-2 依賴', () => {
    const root = makeRepo();
    writeRoadmap(root, [4]);
    writeFeature(root, '05-ingestion', [
      { n: 2, status: 'done' },
      { n: '2b', status: 'todo' },
    ]);
    writeNext(root, '05-ingestion', AI_KM_INGESTION_PHASE_2B_GATE);
    commitAll(root, 'AI_KM ingestion phase-2b regression fixture');

    const { code, output } = run(root);

    expect(code).toBe(0);
    expect(output).toContain('gate=dag result=PASS');
    const layer1 = layerSection(output, 1, 2);
    expect(layer1).toContain('05 phase-2');
    expect(layer1).not.toContain('05 phase-2b');
    const layer2 = layerSection(output, 2);
    expect(layer2).toContain('05 phase-2b');
    const ready = outputSection(output, '目前 ready 集合', '被外部阻擋卡住的 phase');
    expect(ready).toContain('- 05 phase-2b');
  }, SPAWN_TIMEOUT_MS);

  it('phase-2b ↔ phase-2c 人造環會報出完整閉合路徑', () => {
    const root = makeRepo();
    writeFeature(root, '01-suffix', [
      { n: '2b', status: 'todo' },
      { n: '2c', status: 'todo' },
    ]);
    writeNext(
      root,
      '01-suffix',
      ['## 下一個 phase 的 gate', '', '**phase-2b** 需要:phase-2c', '**phase-2c** 需要:phase-2b'].join('\n'),
    );
    commitAll(root, 'suffix phase cycle');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('✗ phase DAG 有環路:01 phase-2b → 01 phase-2c → 01 phase-2b');
    expect(output).toContain('gate=dag result=FAIL scanned=2');
  }, SPAWN_TIMEOUT_MS);
});

describe('check-dag:依賴反向驗證', () => {
  it('拿掉一條真依賴後，該 phase 從第 2 層移到第 1 層', () => {
    const root = makeRepo();
    writeFeature(root, '01-alpha', [{ n: 1, status: 'done' }]);
    writeFeature(root, '02-beta', [{ n: 1, status: 'todo' }]);
    writeFeature(root, '03-gamma', [{ n: 1, status: 'todo' }]);
    writeNext(root, '01-alpha', '**phase-1**:無 gate。');
    writeNext(root, '02-beta', '**phase-1** 需要:01 phase-1 `done`');
    writeNext(root, '03-gamma', '**phase-1** 需要:01 phase-1 `done`');
    commitAll(root, 'dependency present');

    const before = run(root);
    expect(before.code).toBe(0);
    expect(layerSection(before.output, 1, 2)).not.toContain('02 phase-1');
    expect(layerSection(before.output, 2)).toContain('02 phase-1');

    // 只移除 02-beta 的真依賴，03-gamma 仍保留，避免測試只驗「整張圖重算」。
    writeNext(root, '02-beta', '**phase-1** 需要:無');
    const after = run(root);

    expect(after.code).toBe(0);
    expect(layerSection(after.output, 1, 2)).toContain('02 phase-1');
    expect(layerSection(after.output, 2)).not.toContain('02 phase-1');
    expect(layerSection(after.output, 2)).toContain('03 phase-1');
    expect(after.output).toContain('gate=dag result=PASS scanned=3');
  }, SPAWN_TIMEOUT_MS);

  for (const fixture of HEADER_FIXTURES) {
    it(`${fixture.name} 拿掉一條真依賴後 phase 會換層`, () => {
      const root = makeRepo();
      writeFeature(root, '01-alpha', [{ n: 1, status: 'done' }]);
      writeFeature(root, '02-beta', [{ n: 1, status: 'todo' }]);
      writeFeature(root, '03-gamma', [{ n: 1, status: 'todo' }]);
      writeNext(root, '01-alpha', '**phase-1**:無 gate。');
      writeNext(root, '02-beta', checklistGate(fixture.header(1), '01 phase-1 `done`'));
      writeNext(root, '03-gamma', '**phase-1** 需要:01 phase-1 `done`');
      commitAll(root, `dependency present: ${fixture.name}`);

      const before = run(root);
      expect(before.code).toBe(0);
      expect(layerSection(before.output, 1, 2)).not.toContain('02 phase-1');
      expect(layerSection(before.output, 2)).toContain('02 phase-1');

      writeNext(root, '02-beta', checklistGate(fixture.header(1), '無'));
      const after = run(root);

      expect(after.code).toBe(0);
      expect(layerSection(after.output, 1, 2)).toContain('02 phase-1');
      expect(layerSection(after.output, 2)).not.toContain('02 phase-1');
      expect(layerSection(after.output, 2)).toContain('03 phase-1');
      expect(after.output).toContain('gate=dag result=PASS scanned=3');
    }, SPAWN_TIMEOUT_MS);
  }
});

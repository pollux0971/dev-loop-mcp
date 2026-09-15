/**
 * NEXT.md 的 gate 引用檢查(來源 AI_KM)。
 *
 * 規則:`features/<NN-name>/NEXT.md` 裡每一條 gate 宣告(形狀見下)都要引用至少一個
 * 下面之一,而且引用要能**解析**(不是隨便寫個長得像的字串就算數):
 *
 *   - `ADR-NNN`,要在 `docs/02-decision-map.md` 找得到對應的 `## ADR-NNN · ...` 標題。
 *   - 7 碼以上的 hex commit sha,要用 `git cat-file -e <sha>^{commit}` 確認這個 repo
 *     裡真的有這個 commit。
 *   - 契約章節 `§N` 或 `§N.M`(含字母後綴,例如 `§11b`),要在 `contracts/types.md`
 *     找得到對應的 `## N. ...` 標題。
 *   - 整合點 `I<N>`,要在 `docs/01-roadmap.md` 的 `## I<N> · ...` 標題出現,或
 *     `docs/integration/` 底下任何檔名前綴是 `i<N>`(大小寫不拘)的檔案。
 *   - phase 參照,三種寫法都算(取每個 features 資料夾底下 NEXT.md 實際觀察到的寫法,
 *     不是憑空只認一種):
 *       1. `<NN-name>/phase-N`(完整資料夾名,規格明講的形式)
 *       2. `NN phase-N`(只寫兩位數字,不寫完整資料夾名——這是實際最常見的寫法,
 *          例如「01 phase-2 與 phase-3 done」「跨資料夾:03 phase-2 done」)
 *       3. 單獨的 `phase-N`(前面沒有任何資料夾字首)——視為「自身」,指這份 NEXT.md
 *          所屬的那個資料夾自己的 phase(例如「自身:phase-1 done」)
 *     不管哪種寫法,都要求對到的 `features/<folder>/FEATURE.md` 存在,且它的 Phase
 *     表(唯一狀態來源)有那個 phase 的表格列。
 *
 * gate 的形狀:每份 NEXT.md 用 `**phase-N** 需要:` 開一個 gate 段落。段落開頭那一行
 * 後面可能緊接著內容(一整行就是一條 gate 宣告,例如「**phase-4** 需要:phase-3
 * `done`、05 phase-3 `done`、**I4 通過**」),也可能是空的、後面接一串 `- [ ]` /
 * `- [x]` checklist(checklist 每一項各自是一條 gate 宣告)。已經打勾(`[x]`)、已經寫
 * 「已解除」「已滿足」的 gate 一樣要掃、一樣要有能解析的引用——「這個 gate 已經解除
 * 了」本身也是一個需要交代依據的宣稱,不是免死金牌。沒有 `**phase-N** 需要` 段落的
 * phase(例如「**phase-1**:無 gate。」)不產生任何 gate 宣告,不算「0 個引用」的錯誤
 * ——那個 phase 根本沒有 gate 可以掛引用。
 *
 * Config(`gates.config.json` 的 `nextGates.mode`,預設 `"enforce"`):
 *   `"enforce"`(預設)——有失敗的 gate 宣告就 exit 1。
 *   `"report"`——一樣印出全部失敗、marker 行一樣印 `result=FAIL`(讓讀 log 的人看得
 *   出來),但 exit 0——給還沒把舊 NEXT.md 全部補好引用的專案一個「先看得到問題、不
 *   立刻擋住其他工作」的過渡模式。
 * `nextGates.mode` 不影響「0 份 NEXT.md」這個 0 目標守衛——那個永遠 exit 1,跟其餘
 * 守門的「掃到 0 個目標一律 FAIL」同一個道理,不受任何模式開關影響。
 *
 * `scanned=N` 算的是**掃到幾份 NEXT.md**,不是幾條 gate 宣告——一份 NEXT.md 合法地
 * 一條 gate 宣告都沒有(例如所有 phase 都無 gate)不代表掃描器壞了,但 0 份 NEXT.md
 * 就是。
 *
 * 用法(repo 根從 `git rev-parse --show-toplevel` 解析,不在 git repo 裡則退回 cwd):
 *   npx tsx scripts/check-next-gates.ts
 *   npx tsx scripts/check-next-gates.ts --root <dir>   # 明講根目錄(測試/對照用)
 *
 * 退出碼:0 全部通過,或有失敗但 `nextGates.mode` 是 `"report"`;
 *        1 有失敗且是預設的 `"enforce"` 模式,或掃到 0 份 NEXT.md。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT as GIT_ROOT, loadGatesConfig, lookupConfig, requireRootDir } from './_root.js';

/** 三支掃描器共用的那句話(這支也共用)。0 個目標的紅,方向永遠是「掃描器壞了」。 */
const SCANNER_BROKEN = '這不是很乾淨,是掃描器壞了';

/** 這支腳本在 gate 機器可讀標記裡的名字。 */
const GATE_NAME = 'next-gates';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROOT_EXPLICIT = argValue('--root') !== undefined;
const ROOT = resolve(argValue('--root') ?? GIT_ROOT);

// ---------------------------------------------------------------------------
// gates.config.json:nextGates.mode——委派給 `_root.ts` 的 `lookupConfig`(S14,
// 來源 AI_KM 2026-09-05,PITFALLS P-73):`--root` 明講時不退回這支腳本自己所在的目錄
// (那通常是模板自己的佔位設定)。這份設定對這支腳本是選填的(找不到就用預設
// `nextGates.mode = "enforce"`),所以這裡不需要理會 `hardErrorMessage`。
// ---------------------------------------------------------------------------

function findConfigFile(name: string): string | undefined {
  const result = lookupConfig(import.meta.dirname, name, { root: ROOT, rootExplicit: ROOT_EXPLICIT });
  console.log(`${name}: ${result.source}`);
  return result.path;
}

type NextGatesMode = 'report' | 'enforce';

function loadMode(): NextGatesMode {
  const p = findConfigFile('gates.config.json');
  if (!p) return 'enforce'; // 選填設定,沒有就用預設,不印訊息(跟其餘 gates.config.json 欄位同規則)
  // 解析錯誤、不認識的頂層鍵都在這裡大聲失敗(S9),不是未捕捉的堆疊。
  const raw = (loadGatesConfig(p, GATE_NAME) ?? {}) as { nextGates?: { mode?: unknown } };
  return raw.nextGates?.mode === 'report' ? 'report' : 'enforce';
}

// ---------------------------------------------------------------------------
// FEATURE.md 的 Phase 表(唯一狀態來源)——跟 check-standalone.ts 的 pending 解析
// 同一套基本格式；這裡也匯出給 check-dag 使用，避免兩支 gate 各自解析 phase 表。
// ---------------------------------------------------------------------------

export interface FeaturePhaseRow {
  phase: string;
  status: string;
}

/** 讀出 FEATURE.md 的 phase 表，供引用解析與 DAG 狀態判斷共用。 */
export function readFeaturePhaseRows(root: string, folder: string): FeaturePhaseRow[] {
  const featurePath = join(root, 'features', folder, 'FEATURE.md');
  if (!existsSync(featurePath)) return [];
  const content = readFileSync(featurePath, 'utf8');
  const rows: FeaturePhaseRow[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells[1] === undefined) continue;
    const status = cells.find((cell) => /^(?:todo|ready|in-progress|done|blocked)(?:\s|$)/i.test(cell.replace(/[`*_]/g, '').trim())) ?? cells[4] ?? '';
    rows.push({ phase: cells[1], status });
  }
  return rows;
}

function phaseRowExists(root: string, folder: string, phaseNum: string): boolean {
  return readFeaturePhaseRows(root, folder).some((row) => row.phase === phaseNum);
}

function findFolderByPrefix(root: string, prefix: string): string | undefined {
  const dir = join(root, 'features');
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir).find(
    (name) => name.startsWith(`${prefix}-`) && statSync(join(dir, name)).isDirectory(),
  );
}

// ---------------------------------------------------------------------------
// 引用來源的索引:ADR / 契約章節 / 整合點,一次讀好,後面每條 gate 宣告重複查表。
// ---------------------------------------------------------------------------

export interface Resolvers {
  adrIds: Set<string>;
  contractSections: Set<string>;
  integrationPoints: Set<string>;
}

export function loadAdrIds(root: string): Set<string> {
  const p = join(root, 'docs', '02-decision-map.md');
  const ids = new Set<string>();
  if (!existsSync(p)) return ids;
  const content = readFileSync(p, 'utf8');
  for (const m of content.matchAll(/^##\s+ADR-(\d+)\s*·/gm)) ids.add(m[1]!);
  return ids;
}

/** 標題形如 `## 1. 識別碼與基本型別` / `## 11b. 寫入保證(硬約定)`——抓 "." 前面那個 token。 */
export function loadContractSections(root: string): Set<string> {
  const p = join(root, 'contracts', 'types.md');
  const ids = new Set<string>();
  if (!existsSync(p)) return ids;
  const content = readFileSync(p, 'utf8');
  for (const m of content.matchAll(/^##\s+([0-9]+[a-zA-Z]?)\./gm)) ids.add(m[1]!.toLowerCase());
  return ids;
}

export function loadIntegrationPoints(root: string): Set<string> {
  const ids = new Set<string>();
  const roadmap = join(root, 'docs', '01-roadmap.md');
  if (existsSync(roadmap)) {
    const content = readFileSync(roadmap, 'utf8');
    for (const m of content.matchAll(/^##\s+I(\d+)\s*·/gm)) ids.add(m[1]!);
  }
  const integrationDir = join(root, 'docs', 'integration');
  if (existsSync(integrationDir)) {
    for (const name of readdirSync(integrationDir)) {
      const m = /^i(\d+)(?:[^0-9]|$)/i.exec(name);
      if (m) ids.add(m[1]!);
    }
  }
  return ids;
}

export function loadResolvers(root: string): Resolvers {
  return {
    adrIds: loadAdrIds(root),
    contractSections: loadContractSections(root),
    integrationPoints: loadIntegrationPoints(root),
  };
}

function commitExists(root: string, sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 掃 features/*/NEXT.md,抓出每一條 gate 宣告的行。
// ---------------------------------------------------------------------------

export interface GateLine {
  folder: string;
  file: string; // 相對 ROOT
  lineNo: number;
  phaseNum: string;
  text: string;
  /** checklist gate 是 `[x]` 還是 `[ ]`; header 直接帶內容時沒有這個欄位。 */
  checked?: boolean;
}

export function collectFeatureFolders(root: string): string[] {
  const dir = join(root, 'features');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    if (!/^\d{2}-.+$/.test(name)) return false; // 跳過 _template、steps、support 等非 NN-name 資料夾
    return statSync(join(dir, name)).isDirectory();
  });
}

const HEADER_RE = /^\*\*phase-(\d+)(?:\s*\([^\)\r\n]*\))?\*\*\s*需要(?:\s*全部滿足)?\s*[：:]?\s*(.*)$/;
const BULLET_RE = /^-\s*\[([ xX])\]\s*(.*)$/;
const CONTINUATION_RE = /^\s{2,}\S/;

interface GateExtraction {
  gateLines: GateLine[];
  /** 所有已被某個空 header 的 checklist 段落消費的 checklist 行(含「無」行)。 */
  capturedChecklistLineNos: Set<number>;
}

/**
 * 「這個維度沒有依賴」的宣告(例如「跨資料夾:無」「整合:無(它提供 LearningFs,
 * 不消費別人)」「契約:無」)不算一條需要引用的 gate 宣告——沒有依賴就沒有東西可以
 * 引用,不能反過來要求「證明沒有依賴」要附引用。判斷方式:去掉開頭最多 20 個字元的
 * 「標籤:」前綴(自身/跨資料夾/整合/契約……不寫死固定清單,寬鬆抓「冒號前的短字串」)
 * 之後,剩下的內容以「無」開頭。真的觀察到的專案資料(每個 features 資料夾底下的
 * NEXT.md)大量用這個寫法,不排除的話會把「合法地沒有依賴」跟「有依賴但沒寫引用」
 * 混成同一種紅,稀釋掉
 * 真正該擋的那種。
 */
// 注意:結尾刻意不加 `\b`——`\b` 是以 ASCII `\w` 定義單字邊界,「無」是 CJK 字元、
// 不算 `\w`,`\b` 接在它後面在非 Unicode-aware 模式下基本上永遠不成立(兩側都不是
// `\w` 的話邊界判定會失敗),曾經因為多加這個 `\b` 讓整條規則實測完全比對不到,
// 見這支腳本的單元測試。
const NO_DEPENDENCY_RE = /^(?:[^:：]{0,20}[:：]\s*)?無/;

function extractGateLinesWithCoverage(folder: string, relFile: string, content: string): GateExtraction {
  const lines = content.split('\n');
  const out: GateLine[] = [];
  const capturedChecklistLineNos = new Set<number>();
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    const header = HEADER_RE.exec(trimmed);
    if (!header) {
      i++;
      continue;
    }
    const tail = (header[2] ?? '').trim();
    if (tail) {
      // 段落開頭那一行自己就是一整條 gate 宣告(例如「**phase-4** 需要:phase-3 done」)。
      // 引用檢查只看 "需要:" 後面那段內容(tail),不要連 "**phase-4**" 這個宣告本身的
      // phase 號碼也一起塞進去比對——不然「單獨的 phase-N」規則會把宣告自己的編號
      // 誤判成一條(永遠會解析成功、沒有意義的)自身引用,稀釋掉真正該檢查的內容。
      if (!NO_DEPENDENCY_RE.test(tail)) {
        out.push({ folder, file: relFile, lineNo: i + 1, phaseNum: header[1]!, text: tail });
      }
      i++;
      continue;
    }
    // 空的 header(只有「**phase-N** 需要:」,沒有接內容):後面接 checklist,
    // 逐條收集連續的 `- [ ]` / `- [x]` 行,容許中間夾一行空白(只要空白之後緊接著
    // 還是 bullet,不然就當這個段落結束了)。模板的長 checklist 可能在下一行用縮排
    // 續寫;續行屬於前一個 bullet,不能因此讓後面的 checklist 靜默漏收。
    let j = i + 1;
    while (j < lines.length) {
      const jTrimmed = (lines[j] ?? '').trim();
      const bullet = BULLET_RE.exec(jTrimmed);
      if (bullet) {
        capturedChecklistLineNos.add(j + 1);
        const bulletText = (bullet[2] ?? '').trim();
        let gate: GateLine | undefined;
        if (!NO_DEPENDENCY_RE.test(bulletText)) {
          gate = {
            folder,
            file: relFile,
            lineNo: j + 1,
            phaseNum: header[1]!,
            text: bulletText,
            checked: (bullet[1] ?? '').toLowerCase() === 'x',
          };
          out.push(gate);
        }
        j++;
        while (j < lines.length && CONTINUATION_RE.test(lines[j] ?? '')) {
          if (gate) gate.text = `${gate.text} ${(lines[j] ?? '').trim()}`;
          j++;
        }
        continue;
      }
      if (jTrimmed === '') {
        const next = (lines[j + 1] ?? '').trim();
        if (BULLET_RE.test(next)) {
          j++;
          continue;
        }
      }
      break;
    }
    i = j;
  }
  return { gateLines: out, capturedChecklistLineNos };
}

export function extractGateLines(folder: string, relFile: string, content: string): GateLine[] {
  return extractGateLinesWithCoverage(folder, relFile, content).gateLines;
}

/** 找出 NEXT.md 中沒有被任何空 header 的 checklist 段落收進的 checklist 行。 */
function findOrphanChecklistLines(content: string, capturedChecklistLineNos: Set<number>): number[] {
  return content
    .split('\n')
    .flatMap((line, index) => {
      const lineNo = index + 1;
      return BULLET_RE.test(line.trim()) && !capturedChecklistLineNos.has(lineNo) ? [lineNo] : [];
    });
}

// ---------------------------------------------------------------------------
// 一條 gate 宣告的文字裡,找有沒有能解析的引用。
// ---------------------------------------------------------------------------

export type GateReferenceKind = 'adr' | 'contract' | 'integration' | 'phase' | 'commit';

/** NEXT.md 一條 gate 裡找到的引用；check-next-gates 與 check-dag 共用這個結果。 */
export interface GateReference {
  kind: GateReferenceKind;
  token: string;
  resolved: boolean;
  /** phase 引用的目標；phase 未解析成功時仍保留候選值，供診斷使用。 */
  folder?: string;
  phaseNum?: string;
  /** integration 引用的數字部分。 */
  integrationId?: string;
}

export interface CitationCheck {
  found: boolean; // 有沒有找到任何「長得像引用」的 token
  resolved: boolean; // 至少一個 token 真的解析成功
  badTokens: string[]; // 長得像引用、但解析失敗的 token(給「引用不存在」訊息用)
}

/**
 * 解析 NEXT.md gate 引用。
 *
 * 這是原本 check-next-gates 的唯一 parser；check-dag 只消費它的分類結果，
 * 不另外維護一套 phase / I<N> / 外部阻擋的正規表示式。
 */
export function parseGateReferences(
  root: string,
  folder: string,
  text: string,
  resolvers: Resolvers,
): GateReference[] {
  let working = text;
  const references: GateReference[] = [];

  // 每一輪比對到的片段用等長空白蓋掉,避免後面幾輪的正則不小心重複吃到同一段文字
  // (最典型的例子:抓完 `<NN-name>/phase-N` 之後,不能讓最後那條「單獨的 phase-N」
  // 規則又把同一個 phase-N 再算一次)。

  working = working.replace(/ADR-(\d+)/g, (m, id: string) => {
    references.push({ kind: 'adr', token: `ADR-${id}`, resolved: resolvers.adrIds.has(id) });
    return ' '.repeat(m.length);
  });

  working = working.replace(/§([0-9]+[a-zA-Z]?(?:\.[0-9]+)?)/g, (m, sec: string) => {
    const base = (/^[0-9]+[a-zA-Z]?/.exec(sec) ?? [''])[0].toLowerCase();
    references.push({ kind: 'contract', token: `§${sec}`, resolved: resolvers.contractSections.has(base) });
    return ' '.repeat(m.length);
  });

  working = working.replace(/\bI(\d+)\b/g, (m, n: string) => {
    references.push({
      kind: 'integration',
      token: `I${n}`,
      integrationId: n,
      resolved: resolvers.integrationPoints.has(n),
    });
    return ' '.repeat(m.length);
  });

  working = working.replace(/\b(\d{2}-[A-Za-z0-9-]+)\/phase-(\d+)\b/g, (m, folderName: string, phaseNum: string) => {
    references.push({
      kind: 'phase',
      token: `${folderName}/phase-${phaseNum}`,
      folder: folderName,
      phaseNum,
      resolved: phaseRowExists(root, folderName, phaseNum),
    });
    return ' '.repeat(m.length);
  });

  working = working.replace(/\b(\d{2})\s+phase-(\d+)\b/g, (m, prefix: string, phaseNum: string) => {
    const target = findFolderByPrefix(root, prefix);
    references.push({
      kind: 'phase',
      token: `${prefix} phase-${phaseNum}`,
      folder: target ?? prefix,
      phaseNum,
      resolved: target !== undefined && phaseRowExists(root, target, phaseNum),
    });
    return ' '.repeat(m.length);
  });

  // 剩下沒被上面兩條吃掉的、單獨的 phase-N:視為「自身」,指這份 NEXT.md 所屬的資料夾。
  working = working.replace(/\bphase-(\d+)\b/g, (m, phaseNum: string) => {
    references.push({
      kind: 'phase',
      token: `phase-${phaseNum}(自身:${folder})`,
      folder,
      phaseNum,
      resolved: phaseRowExists(root, folder, phaseNum),
    });
    return ' '.repeat(m.length);
  });

  // commit sha 放最後比對:上面幾輪已經把 ADR-NNN、§N 這些「看起來像 hex 但其實不是
  // commit sha」的片段蓋成空白,減少誤判(ADR 編號、章節數字本來就可能是純數字,
  // 純數字也是合法的 hex 字元)。
  working = working.replace(/(?<![0-9a-fA-F])([0-9a-f]{7,40})(?![0-9a-fA-F])/g, (m, sha: string) => {
    references.push({ kind: 'commit', token: sha, resolved: commitExists(root, sha) });
    return ' '.repeat(m.length);
  });
  void working; // 已經沒有後續規則要讀 working 了,保留賦值只是為了風格一致(每輪都蓋掉已讀過的片段)。

  return references;
}

function checkCitations(root: string, folder: string, text: string, resolvers: Resolvers): CitationCheck {
  const references = parseGateReferences(root, folder, text, resolvers);
  return {
    found: references.length > 0,
    resolved: references.some((reference) => reference.resolved),
    badTokens: [...new Set(references.filter((reference) => !reference.resolved).map((reference) => reference.token))],
  };
}

// ---------------------------------------------------------------------------

function main(): void {
  requireRootDir(ROOT, ROOT_EXPLICIT, GATE_NAME);
  const mode = loadMode();
  const folders = collectFeatureFolders(ROOT);
  const nextFiles = folders
    .map((folder) => ({
      folder,
      relFile: `features/${folder}/NEXT.md`,
      absFile: join(ROOT, 'features', folder, 'NEXT.md'),
    }))
    .filter((f) => existsSync(f.absFile));

  console.log(`next-gates: features/ 底下掃到 ${nextFiles.length} 份 NEXT.md(nextGates.mode=${mode})`);

  if (nextFiles.length === 0) {
    console.log(`\n✗ next-gates: 掃到 0 份 NEXT.md`);
    console.log(`${SCANNER_BROKEN}。features/ 底下沒有任何 NN-name 資料夾有 NEXT.md,或 --root 指錯路徑時就長這樣。`);
    console.log(`gate=${GATE_NAME} result=FAIL scanned=0`);
    process.exit(1);
  }

  const resolvers = loadResolvers(ROOT);

  const allGateLines: GateLine[] = [];
  const orphanChecklistWarnings: Array<{ file: string; lineNos: number[] }> = [];
  for (const f of nextFiles) {
    const content = readFileSync(f.absFile, 'utf8');
    const extraction = extractGateLinesWithCoverage(f.folder, f.relFile, content);
    allGateLines.push(...extraction.gateLines);
    const orphanLineNos = findOrphanChecklistLines(content, extraction.capturedChecklistLineNos);
    if (orphanLineNos.length > 0) orphanChecklistWarnings.push({ file: f.relFile, lineNos: orphanLineNos });
  }

  console.log(`next-gates: 掃到 ${allGateLines.length} 條 gate 宣告`);
  for (const warning of orphanChecklistWarnings) {
    console.log(
      `⚠ 警告 ${warning.file}: 第 ${warning.lineNos.join('、')} 行的 checklist 沒有被任何 gate header 收進 gate`,
    );
  }

  let failures = 0;
  for (const g of allGateLines) {
    const check = checkCitations(ROOT, g.folder, g.text, resolvers);
    if (!check.found) {
      failures++;
      console.log(`✗ ${g.file}:${g.lineNo}  gate 沒有引用 ADR/commit/§/IN/phase:${g.text}`);
    } else if (!check.resolved) {
      failures++;
      console.log(`✗ ${g.file}:${g.lineNo}  引用不存在(${check.badTokens.join('、')}):${g.text}`);
    }
  }

  if (failures) console.log(`\n${failures} 條 gate 宣告的引用有問題`);
  else console.log('\n✓ 全部 gate 宣告都有能解析的引用');

  const result = failures ? 'FAIL' : 'PASS';
  console.log(`gate=${GATE_NAME} result=${result} scanned=${nextFiles.length}`);

  if (!failures) process.exit(0);
  if (mode === 'report') {
    console.log('(nextGates.mode = "report":只回報,不擋 exit code)');
    process.exit(0);
  }
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();

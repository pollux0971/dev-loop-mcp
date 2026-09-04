/**
 * 文件腐爛黑名單掃描(S7,來源 nightmare-assault)。
 *
 * 背景:有些字串是「已知會過時、已知會出事,不管出現在哪裡都算壞」——一個寫死的顧問
 * session 名字(換了顧問或換了專案編號就是假的)、一個繞過鎖的指令(有人抄了範例
 * 直接貼進腳本,鎖就形同虛設)、一個把具體數字寫死進固定量詞的措辭(核心項目數量
 * 改了,文字沒跟著改,講的話就是錯的)。這些不是「連結斷了」(check-doc-links.ts 管的)
 * 也不是「場景重複」(check-gherkin-dup.ts 管的),是「內容本身已知有毒」——`doc-rot`
 * 是一份黑名單(regex),命中就報,不管命中的檔案是什麼類型。
 *
 * `doc-rot.blacklist.json` 的 schema(陣列,每一筆都要有下面四個欄位,**都不能是空字串**):
 *   [{ "pattern": "<regex>", "reason": "...", "since": "YYYY-MM-DD", "incident": "P-59" }]
 * 一筆格式壞掉(缺欄位、欄位是空字串、`pattern` 不是合法正規表達式)就讓整個 gate 失敗
 * (S9 的設定壞掉大聲失敗原則——不是「這一筆跳過,其他照跑」,壞掉的黑名單本身就不可信)。
 *
 * 掃描範圍:consumer 根目錄底下,副檔名屬於 `SCAN_EXTS`(md、txt、json、yaml、yml、toml、
 * sh、ts、js、py、feature、svelte、rs、html、css)的檔案,套用共用略過清單(S10,
 * `_root.ts` 的 `DEFAULT_SKIP_DIRS` + `gates.config.json` 的 `skipDirs`)。**排除**:
 *   1. ADR 檔(`docs/02-decision-map.md` 與 `docs/adr/` 底下任何檔案)——決策記錄合理地會
 *      逐字引用那個過時/危險的東西(「我們決定不要再用 X」本來就要寫出 X 是什麼),
 *      不該被自己記錄的決策打自己的臉。
 *   2. 黑名單設定檔自己(`doc-rot.blacklist.json`)——它的內容就是這些危險字串的
 *      literal pattern,不排除的話會自我命中。
 *
 * 任何一行命中任何一條黑名單規則 → 印
 *   `✗ <file>:<line> 命中黑名單「<pattern>」(<incident>: <reason>)`
 * 並算失敗。
 *
 * 用法(repo 根從 `git rev-parse --show-toplevel` 解析,不在 git repo 裡則退回 cwd;
 * `--root <dir>` 明講的話優先):
 *   npx tsx scripts/check-doc-rot.ts
 *   npx tsx <template>/scripts/check-doc-rot.ts --root <dir>
 *
 * 退出碼:0 沒有命中;1 有命中,或黑名單是空陣列,或掃到 0 個檔案(這不是很乾淨,
 * 是掃描器壞了——跟其餘掃描器同一個道理:0 目標不是「沒事可做」)。
 *
 * 反向驗證(改完要還原,不要留下改動):
 *   (a) 造一個臨時目錄,放一份含一條規則的 blacklist 跟一個命中該規則的 .md 檔,
 *       重跑這支腳本 → 應該紅,訊息含 file:line。
 *   (b) 同一個臨時目錄,把命中的那個字串搬進 `docs/02-decision-map.md` → 重跑 →
 *       不該被報(ADR 檔排除)。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  DEFAULT_SKIP_DIRS,
  ROOT as GIT_ROOT,
  loadGatesConfig,
  readConfigJson,
  requireConfigType,
  splitSkipDirs,
} from './_root.js';

/** 這支腳本在 gate 機器可讀標記裡的名字。 */
const GATE_NAME = 'doc-rot';

/** 三支掃描器共用的那句話。0 個目標的紅,方向永遠是「掃描器壞了」。 */
const SCANNER_BROKEN = '這不是很乾淨,是掃描器壞了';

/** 要掃描的副檔名(含點)。 */
const SCAN_EXTS = [
  '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.sh',
  '.ts', '.js', '.py', '.feature', '.svelte', '.rs', '.html', '.css',
];

const BLACKLIST_FILENAME = 'doc-rot.blacklist.json';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROOT = resolve(argValue('--root') ?? GIT_ROOT);

/** 印一則設定錯誤、印 gate 標記(0 目標)、exit 1——跟其餘掃描器同一套(見
 *  check-boundaries.ts 的 `configError`,每支腳本各自一份,不共用 helper 是刻意的:
 *  `sync-gates.sh` 把每支 check-*.ts 當獨立檔案複製)。 */
function configError(msg: string): never {
  console.error(`✗ ${msg}`);
  console.log(`gate=${GATE_NAME} result=FAIL scanned=0`);
  process.exit(1);
}

/**
 * 找一份設定檔的順序(env 優先權見 `_root.ts` 的 `resolveConfig` 文件):
 *   0. 環境變數 `GATES_CONFIG_DIR`(若設且該目錄存在)
 *   1. 這支腳本自己所在的目錄(sync 後就是 consumer 的安裝目錄)
 *   2. `<ROOT>/scripts/`
 */
function configSearchPathsList(name: string): string[] {
  const paths: string[] = [];
  const envDir = process.env.GATES_CONFIG_DIR;
  if (envDir && existsSync(envDir)) paths.push(join(envDir, name));
  paths.push(join(import.meta.dirname, name), join(ROOT, 'scripts', name));
  return paths;
}

function findConfigFile(name: string): string | undefined {
  return configSearchPathsList(name).find(existsSync);
}

export interface BlacklistEntry {
  pattern: string;
  reason: string;
  since: string;
  incident: string;
}

/** 非空字串(trim 之後還有內容)。 */
function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * 讀 `doc-rot.blacklist.json`。找不到檔案本身是設定錯誤(這份黑名單是必要設定,
 * 不是選填——沒有黑名單,這支 gate 沒有存在的意義);解析錯誤、每一筆的形狀由
 * `readConfigJson`(S9)跟這裡的欄位檢查共同把關,壞掉一律大聲失敗、不放行。
 */
function loadBlacklist(): { entries: BlacklistEntry[]; path: string } {
  const p = findConfigFile(BLACKLIST_FILENAME);
  if (!p) {
    configError(
      `找不到 ${BLACKLIST_FILENAME}(搜尋過:${configSearchPathsList(BLACKLIST_FILENAME).join('、')})。` +
        '這份黑名單是必要設定,範例見 template/scripts/doc-rot.blacklist.json。',
    );
  }
  const raw = readConfigJson(p, GATE_NAME);
  if (!Array.isArray(raw)) configError(`${p} 必須是陣列(每一項是 { pattern, reason, since, incident })`);

  const entries: BlacklistEntry[] = [];
  raw.forEach((item, i) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      configError(`${p} 第 ${i + 1} 筆不是物件:${JSON.stringify(item)}`);
    }
    const obj = item as Record<string, unknown>;
    for (const field of ['pattern', 'reason', 'since', 'incident'] as const) {
      requireConfigType(obj[field], `${BLACKLIST_FILENAME}[${i}].${field}`, 'string', GATE_NAME);
      if (!nonEmptyString(obj[field])) {
        configError(`${p} 第 ${i + 1} 筆的 "${field}" 不可為空字串`);
      }
    }
    const pattern = obj.pattern as string;
    try {
      // eslint-disable-next-line no-new
      new RegExp(pattern);
    } catch (e) {
      configError(`${p} 第 ${i + 1} 筆的 "pattern" 不是合法正規表達式:${pattern}(${(e as Error).message})`);
    }
    entries.push({
      pattern,
      reason: obj.reason as string,
      since: obj.since as string,
      incident: obj.incident as string,
    });
  });
  return { entries, path: p };
}

/** S10:共用略過清單 + `gates.config.json` 的 `skipDirs` 追加。回傳值已經拆成「單層
 *  目錄名」(逐層比對,例如 `node_modules`)跟「多層路徑前綴」(例如 `.claude/worktrees`)
 *  兩組(`_root.ts` 的 `splitSkipDirs`)——`DEFAULT_SKIP_DIRS` 裡有 `.claude/worktrees`
 *  這種帶斜線的項目,單純逐層比對目錄名永遠比不到它(`.claude` 跟 `worktrees` 是
 *  兩層,任何單一層的名字都不會剛好等於 `.claude/worktrees` 這個字串),這支腳本掃的是
 *  **整個 ROOT**(不像 boundaries/gherkin-dup 只掃固定的少數子樹),不做前綴比對的話
 *  會遞迴進 `.claude/worktrees/<其他 worktree>` 把整個 repo 重新掃一次。 */
function resolveSkipDirsForDocRot(): { segments: Set<string>; prefixes: string[] } {
  const cfgPath = findConfigFile('gates.config.json');
  const cfg = loadGatesConfig(cfgPath, GATE_NAME);
  const extra = cfg?.skipDirs;
  if (extra !== undefined) requireConfigType(extra, 'skipDirs', 'array', GATE_NAME);
  const extraStrings = Array.isArray(extra) ? extra.filter((s): s is string => typeof s === 'string') : [];
  return splitSkipDirs(new Set([...DEFAULT_SKIP_DIRS, ...extraStrings]));
}

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

/** ADR 檔排除:`docs/02-decision-map.md` 本身,或 `docs/adr/` 底下任何檔案。 */
function isAdrFile(relPath: string): boolean {
  const posix = toPosix(relPath);
  if (posix === 'docs/02-decision-map.md') return true;
  return posix === 'docs/adr' || posix.startsWith('docs/adr/');
}

/** 這個相對於 ROOT 的路徑(posix)要不要整個跳過(整段子樹排除)——跟
 *  `check-doc-links.ts` 的 `isSkipped` 同一套規則:單層目錄名逐層比對 `segments`,
 *  或整段路徑以某個 `prefixes` 開頭。 */
function isSkippedPath(relPath: string, skip: { segments: Set<string>; prefixes: string[] }): boolean {
  const posix = toPosix(relPath);
  if (posix.split('/').some((seg) => skip.segments.has(seg))) return true;
  return skip.prefixes.some((prefix) => posix === prefix || posix.startsWith(`${prefix}/`));
}

function* walk(root: string, dir: string, relDir: string, skip: { segments: Set<string>; prefixes: string[] }): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relDir ? `${relDir}/${name}` : name;
    if (isSkippedPath(rel, skip)) continue;
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(root, full, rel, skip);
    else if (SCAN_EXTS.some((e) => name.endsWith(e))) yield full;
  }
}

interface Hit {
  file: string;
  line: number;
  pattern: string;
  reason: string;
  incident: string;
}

function main(): void {
  const { entries, path: blacklistPath } = loadBlacklist();

  if (entries.length === 0) {
    console.log(`doc-rot: ${blacklistPath} 是空陣列`);
    console.log(`✗ ${SCANNER_BROKEN}。黑名單一條規則都沒有,不是「文件很乾淨」,是設定沒填。`);
    console.log(`gate=${GATE_NAME} result=FAIL scanned=0`);
    process.exit(1);
  }

  const compiled = entries.map((e) => ({ ...e, re: new RegExp(e.pattern) }));
  const skipDirs = resolveSkipDirsForDocRot();

  const blacklistAbs = resolve(blacklistPath);
  // 這支腳本自己的測試檔(check-doc-rot.test.ts)刻意在字串常數裡放黑名單命中的樣本
  // (例如寫死的顧問 session 名字),那是拿來當 fixture 用的文字,不是真的文件腐爛——
  // 排除掉,不然這支 gate 對著自己的測試檔案自我命中。
  const ownTestFileAbs = resolve(import.meta.dirname, 'check-doc-rot.test.ts');
  const files: string[] = [];
  for (const file of walk(ROOT, ROOT, '', skipDirs)) {
    const rel = toPosix(relative(ROOT, file));
    if (isAdrFile(rel)) continue;
    const fileAbs = resolve(file);
    if (fileAbs === blacklistAbs) continue;
    if (fileAbs === ownTestFileAbs) continue;
    files.push(file);
  }

  console.log(`doc-rot: ${entries.length} 條黑名單規則,掃描 ${files.length} 個檔案`);

  if (files.length === 0) {
    console.log(`✗ ${SCANNER_BROKEN}。掃描範圍、副檔名清單,或略過清單壞掉時就長這樣。`);
    console.log(`gate=${GATE_NAME} result=FAIL scanned=0`);
    process.exit(1);
  }

  const hits: Hit[] = [];
  for (const file of files) {
    const rel = toPosix(relative(ROOT, file));
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const entry of compiled) {
        entry.re.lastIndex = 0;
        if (entry.re.test(line)) {
          hits.push({ file: rel, line: i + 1, pattern: entry.pattern, reason: entry.reason, incident: entry.incident });
        }
      }
    });
  }

  if (hits.length) {
    console.log(`\n✗ ${hits.length} 處命中黑名單:`);
    for (const h of hits) {
      console.log(`✗ ${h.file}:${h.line} 命中黑名單「${h.pattern}」(${h.incident}: ${h.reason})`);
    }
    console.log(`gate=${GATE_NAME} result=FAIL scanned=${files.length}`);
    process.exit(1);
  }

  console.log('✓ 無命中');
  console.log(`gate=${GATE_NAME} result=PASS scanned=${files.length}`);
  process.exit(0);
}

main();

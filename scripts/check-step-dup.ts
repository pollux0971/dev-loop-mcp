/**
 * 步驟重複檢查(見 docs/03-agile-workflow.md「便宜的模型做機械工作」與 PITFALLS.md P-02)。
 *
 * 背景:cucumber 對「同一句話撞名的兩個定義」不會報錯——除非那兩個定義剛好都被載入且
 * 語意衝突(ambiguous step),否則常見的失敗模式是「同一句話在兩個資料夾各自定義一次,
 * 誰先載入誰生效」,測試看起來綠,但其實測的是另一個功能的邏輯。這支腳本抓的是
 * 前置條件:一句話在 ≥2 個資料夾出現,就規定它必須收斂進 features/steps/common.steps.ts,
 * 不准留在各自的步驟檔裡重複定義。
 *
 * 規則:
 *   1. 掃 features/<NN-name>/**\/*.feature 與 docs/integration/**\/*.feature
 *   2. 每個 Given/When/Then/And/But 步驟句正規化:去掉開頭關鍵字、引號內容 → {string}、
 *      獨立數字 → {int}、<param> → {param}、去頭尾空白
 *   3. 統計每個正規化後的句子出現在哪些「資料夾」(features/<NN-name>/ 算一個,
 *      docs/integration 算一個)
 *   4. 出現在 ≥2 個資料夾的句子,必須能對上 features/steps/common.steps.ts 裡的一個定義
 *      (用正規表達式抓 Given(/When(/Then( 開頭、緊接引號或 / 的定義;cucumber expression 的
 *      {string} {int} {} 與 regex 定義都嘗試對應)。對不上就算「未定義」,列出並失敗。
 *
 * 用法:
 *   npx tsx scripts/check-step-dup.ts          # 檢查,未收斂的跨資料夾句子退出 1
 *   npx tsx scripts/check-step-dup.ts --list   # 只列出每句出現的資料夾與是否已收斂,不判斷退出碼
 *
 * 退出碼:
 *   0  沒有「跨 ≥2 個資料夾但未收斂進 common.steps.ts」的句子
 *   1  有未收斂的句子;或掃到 0 個 .feature 檔 / 0 個步驟句(這不是很乾淨,是掃描器壞了)
 *
 * 反向驗證(改完要還原,不要留下改動):
 *   (a) 打開 features/steps/common.steps.ts,把 `Then('it exits with status {int}', ...)`
 *       那行的 `Then(` 改成 `// Then(`(註解掉整個定義)。重跑這支腳本 → 應該紅,
 *       列出「it exits with status {int}」未收斂(它出現在多個 features/<NN-name>/ 資料夾)。
 *   (b) 改回來(拿掉 `// `)→ 重跑 → 應該綠。
 *   (c) 找一句只在單一資料夾出現的步驟(例如某個功能獨有的斷言),確認它不會被要求進
 *       common.steps.ts(不在輸出的「未收斂」清單裡)→ 綠,不用改任何檔案。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LIST_ONLY = process.argv.includes('--list');
const COMMON_STEPS_PATH = join(ROOT, 'features/steps/common.steps.ts');

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (name.endsWith('.feature')) yield full;
  }
}

/** features/<NN-name>/... → "features/<NN-name>";docs/integration/... → "docs/integration";其餘 undefined(不算目標,例如 features/_template)。 */
function folderOf(relPath: string): string | undefined {
  const posix = toPosix(relPath);
  const m = posix.match(/^features\/(\d{2}-[^/]+)\//);
  if (m) return `features/${m[1]}`;
  if (posix.startsWith('docs/integration/')) return 'docs/integration';
  return undefined;
}

function collectFeatureFiles(): string[] {
  const all = [...walk(join(ROOT, 'features')), ...walk(join(ROOT, 'docs/integration'))];
  return all.filter((f) => folderOf(toPosix(relative(ROOT, f))) !== undefined);
}

interface StepOccurrence { folder: string; file: string; line: number; raw: string }

const STEP_LINE_RE = /^\s*(?:Given|When|Then|And|But)\s+(.*\S)\s*$/;

function extractSteps(file: string): { line: number; raw: string }[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const out: { line: number; raw: string }[] = [];
  lines.forEach((line, i) => {
    const m = line.match(STEP_LINE_RE);
    if (m) out.push({ line: i + 1, raw: m[1]! });
  });
  return out;
}

function normalize(raw: string): string {
  return raw
    .replace(/"[^"]*"/g, '{string}')
    .replace(/<[^>]+>/g, '{param}')
    .replace(/\b\d+\b/g, '{int}')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** cucumber expression(字串定義)→ 能拿正規化後的步驟句去測試的 RegExp。{} 是任意型別的萬用字。 */
function literalToMatcher(lit: string): RegExp {
  const parts = lit.split(/(\{string\}|\{int\}|\{\})/);
  const pattern = parts
    .map((p) => {
      if (p === '{string}') return '\\{string\\}';
      if (p === '{int}') return '\\{int\\}';
      if (p === '{}') return '\\{(?:string|int|param)\\}';
      return escapeRegExp(p);
    })
    .join('');
  return new RegExp(`^${pattern}$`);
}

/** regex 定義 → 盡量對應正規化後的步驟句:去掉 ^ $ 錨點,把捕獲群(不處理巢狀)換成萬用字。 */
function regexToMatcher(source: string): RegExp {
  let body = source;
  if (body.startsWith('^')) body = body.slice(1);
  if (body.endsWith('$')) body = body.slice(0, -1);
  body = body.replace(/\((?:\?:)?[^()]*\)/g, '\\{(?:string|int|param)\\}');
  try {
    return new RegExp(`^${body}$`);
  } catch {
    // 對應失敗(例如原 regex 用了這裡沒處理的巢狀群):當作永遠不對應,视为未定義。
    return /(?!)/;
  }
}

interface Definition { matcher: RegExp; sourceText: string }

/** 解析字串字面值(從 quoteChar 後一個字元開始),回傳值與結尾索引(quote 之後那個位置)。 */
function parseStringLiteral(src: string, start: number, quoteChar: string): { value: string; end: number } | undefined {
  let i = start;
  let value = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) {
      value += src[i + 1];
      i += 2;
      continue;
    }
    if (c === quoteChar) return { value, end: i + 1 };
    value += c;
    i++;
  }
  return undefined;
}

/** 解析 regex 字面值(從第一個 / 之後開始),回傳 source 與結尾索引(flags 之後那個位置)。 */
function parseRegexLiteral(src: string, start: number): { source: string; end: number } | undefined {
  let i = start;
  let source = '';
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) {
      source += c + src[i + 1];
      i += 2;
      continue;
    }
    if (c === '[') inClass = true;
    if (c === ']') inClass = false;
    if (c === '/' && !inClass) {
      let j = i + 1;
      while (j < src.length && /[a-z]/i.test(src[j]!)) j++;
      return { source, end: j };
    }
    source += c;
    i++;
  }
  return undefined;
}

/** 去掉註解,避免註解掉的定義(例如反向驗證時 `// Then(...)`)被誤判成還活著。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (_m, pre: string) => pre);
}

function extractDefinitions(rawCommonSrc: string): Definition[] {
  const commonSrc = stripComments(rawCommonSrc);
  const defs: Definition[] = [];
  const callRe = /\b(?:Given|When|Then)\s*\(\s*/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(commonSrc)) !== null) {
    const after = m.index + m[0].length;
    const next = commonSrc[after];
    if (next === '"' || next === "'" || next === '`') {
      const parsed = parseStringLiteral(commonSrc, after + 1, next);
      if (parsed) defs.push({ matcher: literalToMatcher(parsed.value), sourceText: parsed.value });
    } else if (next === '/') {
      const parsed = parseRegexLiteral(commonSrc, after + 1);
      if (parsed) defs.push({ matcher: regexToMatcher(parsed.source), sourceText: `/${parsed.source}/` });
    }
    // 其餘(例如 Then(phrase, ...) 這種變數形式)不是「直接以引號或 / 開頭」的定義,略過——
    // 這是這支腳本刻意的限制,見檔頭註解。
  }
  return defs;
}

function isDefinedInCommon(normalized: string, defs: Definition[]): boolean {
  return defs.some((d) => d.matcher.test(normalized));
}

function main(): void {
  const files = collectFeatureFiles();
  if (files.length === 0) {
    console.log('✗ 掃到 0 個 .feature 檔(features/**/*.feature 或 docs/integration/**/*.feature)。這不是很乾淨,是掃描器壞了。');
    process.exit(1);
  }

  const groups = new Map<string, { folders: Set<string>; occurrences: StepOccurrence[] }>();
  for (const file of files) {
    const rel = toPosix(relative(ROOT, file));
    const folder = folderOf(rel)!;
    for (const { line, raw } of extractSteps(file)) {
      const norm = normalize(raw);
      let g = groups.get(norm);
      if (!g) { g = { folders: new Set(), occurrences: [] }; groups.set(norm, g); }
      g.folders.add(folder);
      g.occurrences.push({ folder, file: rel, line, raw });
    }
  }

  let totalSteps = 0;
  for (const g of groups.values()) totalSteps += g.occurrences.length;
  if (totalSteps === 0) {
    console.log('✗ 掃到 0 個步驟句。這不是很乾淨,是掃描器壞了。');
    process.exit(1);
  }

  const commonSrc = existsSync(COMMON_STEPS_PATH) ? readFileSync(COMMON_STEPS_PATH, 'utf8') : '';
  const defs = extractDefinitions(commonSrc);

  const crossFolder = [...groups.entries()].filter(([, g]) => g.folders.size >= 2);
  console.log(`step-dup: 掃描 ${files.length} 個 .feature 檔,${totalSteps} 個步驟句,${groups.size} 種正規化句型,common.steps.ts 有 ${defs.length} 個可解析定義`);

  if (LIST_ONLY) {
    for (const [norm, g] of [...groups.entries()].sort((a, b) => b[1].folders.size - a[1].folders.size)) {
      const defined = isDefinedInCommon(norm, defs);
      console.log(`  [${g.folders.size} 資料夾]${defined ? ' (common)' : ''}  ${norm}`);
      for (const f of [...g.folders].sort()) console.log(`      - ${f}`);
    }
    process.exit(0);
  }

  const undefinedGroups = crossFolder.filter(([norm]) => !isDefinedInCommon(norm, defs));
  if (undefinedGroups.length) {
    console.log(`\n✗ ${undefinedGroups.length} 句跨 ≥2 個資料夾但沒有收斂進 features/steps/common.steps.ts:`);
    for (const [norm, g] of undefinedGroups) {
      console.log(`  "${norm}"  出現在:${[...g.folders].sort().join(', ')}`);
      for (const o of g.occurrences) console.log(`      ${o.file}:${o.line}`);
    }
    process.exit(1);
  }

  console.log(`✓ 無違規(跨資料夾句子 ${crossFolder.length} 種,全部已收斂進 common.steps.ts)`);
  process.exit(0);
}

main();

/**
 * Module-namespace cast gate (P-88, source: AI_KM consultant 2026-09-08).
 *
 * Background: calling the implementation like this in a steps file --
 *
 *   import * as core from '../../packages/core/src/index.js';
 *   const api = core as unknown as { computeDue: (x: Input) => Output };
 *   api.computeDue(input);
 *
 * -- makes two gates blind at the same time to "someone deleted (or renamed) `computeDue`": what `tsc`
 * sees is `unknown` cast to a hand-written object type, and it does not care whether the
 * implementation has that function; grep for `core.computeDue` finds nothing either (the call is
 * `api.computeDue`, and the type of `api` is hand-written). When the function really disappears,
 * only actually running that scenario blows up with `api.computeDue is not a function`, and that
 * scenario may sit under someone else's tag.
 *
 * It blocks only **the module-namespace** kind of cast: `<namespace> as unknown as …`, where
 * `<namespace>` is a name brought in by `import * as X from` or `import X = require(...)` in the
 * same file; it also blocks casting the result of a dynamic load directly, such as
 * `import('…') as unknown as` / `require('…') as unknown as`.
 * It does **not** scan every `as unknown as`: AI_KM's real run of a full scan caught 2 out of 23,
 * and the other 21 were normal casts of values (test data, third-party return values). Blocking
 * them all would force people to loosen the gate, and once loosened the 2 real ones would pass
 * too. The gate aims only at the kind that blinds other gates, not at the syntax itself.
 *
 * Scan range: `moduleCast.scanDirs` in `gates.config.json` (an array of dirs relative to ROOT);
 * if not set, `["features/steps"]`. All `.ts` / `.tsx` / `.mts` / `.cts` files below it (not
 * `.d.ts`), skipping DEFAULT_SKIP_DIRS of `_root.ts` + `skipDirs` of `gates.config.json`. The
 * content of comments is stripped before matching (in the reverse check, `// const api = core as unknown as …` does not count).
 *
 * Usage (the repo root is resolved from `git rev-parse --show-toplevel`; `--root <dir>` wins if given):
 *   npx tsx scripts/check-module-cast.ts
 *   npx tsx scripts/check-module-cast.ts --root <dir>
 *
 * Exit codes: 0 scanned >=1 file and 0 hits; 1 there are hits, scanned 0 files (the scanner is broken), or the config file is broken.
 * Gate marker: `gate=module-cast result=PASS|FAIL scanned=<file count>`.
 *
 * Reverse checks:
 *   (a) Add `import * as m from './_world.js'; const x = m as unknown as { f: () => void };` to any steps file
 *       -> should be red, printing file:line and that line.
 *   (b) Change the same line to `const x = someValue as unknown as { f: () => void };` (`someValue` is not
 *       a namespace) -> should be green. This proves "it blocks only that one kind".
 *   (c) Comment out the whole line from (a) -> should be green.
 *   `check-module-cast.test.ts` turns (a)-(c) into automated tests.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  ROOT as GIT_ROOT,
  loadGatesConfig,
  lookupConfig,
  requireConfigType,
  requireRootDir,
  resolveSkipDirs,
} from './_root.js';

/** The one sentence shared by all scanners. A red with 0 targets always means "the scanner is broken". */
const SCANNER_BROKEN = '這不是很乾淨,是掃描器壞了';

/** The name of this script in the machine-readable gate marker. */
const GATE_NAME = 'module-cast';

const DEFAULT_SCAN_DIRS = ['features/steps'];

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROOT_EXPLICIT = argValue('--root') !== undefined;
const ROOT = resolve(argValue('--root') ?? GIT_ROOT);
requireRootDir(ROOT, ROOT_EXPLICIT, GATE_NAME);

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

/** Delegates to `lookupConfig` of `_root.ts` (S14, PITFALLS P-73): when `--root` is given, do not
 *  fall back to the directory this script itself sits in. gates.config.json is optional for this
 *  script (`moduleCast.scanDirs`, `skipDirs`); if not found, use the defaults and ignore hardErrorMessage. */
function findConfigFile(name: string): string | undefined {
  const result = lookupConfig(import.meta.dirname, name, { root: ROOT, rootExplicit: ROOT_EXPLICIT });
  console.log(`${name}: ${result.source}`);
  return result.path;
}

interface Settings { scanDirs: string[]; skipDirs: Set<string> }

function loadSettings(): Settings {
  const p = findConfigFile('gates.config.json');
  // Parse errors and unknown top-level keys fail loudly here (S9), not as an uncaught stack.
  const raw = loadGatesConfig(p, GATE_NAME);
  const skipDirs = resolveSkipDirs(raw, GATE_NAME);
  const section = raw?.moduleCast;
  if (section === undefined) return { scanDirs: DEFAULT_SCAN_DIRS, skipDirs };
  requireConfigType(section, 'moduleCast', 'object', GATE_NAME);
  const scanDirs = (section as { scanDirs?: unknown }).scanDirs;
  if (scanDirs === undefined) return { scanDirs: DEFAULT_SCAN_DIRS, skipDirs };
  requireConfigType(scanDirs, 'moduleCast.scanDirs', 'array', GATE_NAME);
  const list = (scanDirs as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (list.length === 0) {
    console.error(`✗ ${p} 的 "moduleCast.scanDirs" 是空陣列(要掃哪些目錄?沒填就刪掉這個欄位用預設 ${JSON.stringify(DEFAULT_SCAN_DIRS)})`);
    console.log(`gate=${GATE_NAME} result=FAIL scanned=0`);
    process.exit(1);
  }
  return { scanDirs: list, skipDirs };
}

const SOURCE_EXT_RE = /\.(?:ts|tsx|mts|cts)$/;

function* walk(dir: string, skipDirs: Set<string>): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full, skipDirs);
    else if (SOURCE_EXT_RE.test(name) && !name.endsWith('.d.ts')) yield full;
  }
}

/** Strip comments but keep newlines (line numbers unchanged), so a commented-out cast is not mistaken for a live one. */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (_m, pre: string) => pre);
}

/** Module names brought in as a namespace in this file: `import * as X from` and `import X = require(`. */
export function namespaceImports(src: string): string[] {
  const names = new Set<string>();
  const star = /\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\b/g;
  const eqRequire = /\bimport\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = star.exec(src)) !== null) names.add(m[1]!);
  while ((m = eqRequire.exec(src)) !== null) names.add(m[1]!);
  return [...names];
}

export interface CastHit { line: number; text: string; reason: string }

/** Find "module-namespace casts" in one file's source. Returns the line number, original text and reason of each hit. */
export function findModuleCasts(rawSrc: string): CastHit[] {
  const src = stripComments(rawSrc);
  const names = namespaceImports(src);
  const hits: CastHit[] = [];
  const lines = src.split('\n');
  const rawLines = rawSrc.split('\n');
  const nsRe = names.length ? new RegExp(`\\b(${names.map((n) => n.replace(/\$/g, '\\$')).join('|')})\\s+as\\s+unknown\\s+as\\b`) : undefined;
  // `(await import('./x.js')) as unknown as` / `require('./x.js') as unknown as`: casting the result of a dynamic load directly.
  const dynRe = /\b(?:import|require)\s*\([^)]*\)\s*\)?\s*as\s+unknown\s+as\b/;
  lines.forEach((line, i) => {
    if (nsRe) {
      const m = line.match(nsRe);
      if (m) {
        hits.push({ line: i + 1, text: rawLines[i]!.trim(), reason: `命名空間 \`${m[1]}\`(import * as ${m[1]})被 as unknown as 轉型` });
        return;
      }
    }
    if (dynRe.test(line)) {
      hits.push({ line: i + 1, text: rawLines[i]!.trim(), reason: '動態 import()/require() 的結果被 as unknown as 轉型' });
    }
  });
  return hits;
}

function main(): void {
  const { scanDirs, skipDirs } = loadSettings();
  const files: string[] = [];
  for (const d of scanDirs) files.push(...walk(resolve(ROOT, d), skipDirs));
  files.sort();

  console.log(`module-cast: 掃描 ${scanDirs.join(', ')} 底下 ${files.length} 個 .ts 檔`);
  if (files.length === 0) {
    console.log(
      `✗ 掃到 0 個 .ts 檔(找過 ${scanDirs.map((d) => resolve(ROOT, d)).join('、')})。${SCANNER_BROKEN}` +
        ' steps 目錄不在預設位置的話,在 gates.config.json 填 "moduleCast": { "scanDirs": ["<目錄>"] }。',
    );
    console.log(`gate=${GATE_NAME} result=FAIL scanned=0`);
    process.exit(1);
  }

  const allHits: { file: string; hit: CastHit }[] = [];
  for (const f of files) {
    const rel = toPosix(relative(ROOT, f));
    for (const hit of findModuleCasts(readFileSync(f, 'utf8'))) allHits.push({ file: rel, hit });
  }

  if (allHits.length) {
    console.log(`\n✗ ${allHits.length} 處模組命名空間轉型(P-88):`);
    for (const { file, hit } of allHits) {
      console.log(`  ${file}:${hit.line}  ${hit.text}`);
      console.log(`      ${hit.reason}`);
    }
    console.log(
      '\n  這種轉型讓 typecheck 跟 grep 都看不見「那個函式被刪了/改名了」——實作真的少了那個函式,只有真跑到那個場景才會炸,' +
        '而那個場景可能在別人的 tag 底下。改成具名 import(`import { computeDue } from …`)讓 tsc 守住;' +
        '型別真的對不上就修契約或加 adapter,不要用 as unknown as 蓋過去。',
    );
    console.log(`gate=${GATE_NAME} result=FAIL scanned=${files.length}`);
    process.exit(1);
  }

  console.log(`✓ 0 處模組命名空間轉型(${files.length} 個檔案)`);
  console.log(`gate=${GATE_NAME} result=PASS scanned=${files.length}`);
  process.exit(0);
}

main();

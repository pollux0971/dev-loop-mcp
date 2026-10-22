/**
 * Step duplicate check (see docs/03-agile-workflow.md "cheap models do mechanical work" and PITFALLS.md P-02).
 *
 * Background: cucumber has zero tolerance for "one sentence, two definitions". If two
 * definitions can both match the same Gherkin text, cucumber blows up with an ambiguous
 * step when it reaches that sentence. This is the only invariant that really crashes
 * cucumber: **one step shape has exactly one definition in the whole project**, no matter
 * which *.steps.ts file that definition lives in.
 *
 * This script deliberately does **not** check "is it in common.steps.ts". That is a proxy
 * metric, and it gives wrong answers in both directions:
 *   - False green: a sentence is defined 3 times, and one of them happens to be in
 *     common.steps.ts. The "is it in common" question lets it pass, but cucumber still
 *     blows up because of the other two duplicate definitions.
 *   - False red: a sentence that describes a single capability (e.g. "the current question
 *     is an apply question") is reused directly by an integration scenario in docs/integration,
 *     and its definition lives in that capability's own steps file. This is perfectly normal
 *     (integration scenarios should reuse the capability-level vocabulary), but "is it in
 *     common" would misjudge it as a defect.
 * The gate checks only the invariant "exactly one definition", not the proxy "which file it lives in".
 *
 * Rules:
 *   1. Scan features/<NN-name>/**\/*.feature and docs/integration/**\/*.feature.
 *      Normalize every Given/When/Then/And/But step sentence: drop the leading keyword,
 *      quoted content -> {string}, standalone numbers -> {int}, <param> -> {param}, trim
 *   2. Scan **all** of features/steps/*.steps.ts (not only common.steps.ts). Use a regex to
 *      find definitions that start with Given(/When(/Then( and are followed directly by a
 *      quote or /. Build a Map of "normalized shape -> list of files that define it".
 *      All cucumber expression parameter types ({string}/{int}/{}/{word}/...) and regex
 *      capture groups are normalized into the same wildcard {}. The {string}/{int}/{param}
 *      on the step sentence side are also collapsed into {} before comparing shapes
 *   3. For every shape on the **definition side** (whether or not any feature file uses it):
 *        defined once -> OK, no matter which *.steps.ts file the definition lives in
 *        defined >=2 times -> list the sentence, the file and original text of each definition,
 *                     and which folders use it now (if no feature uses it, say
 *                     "no feature uses it right now"), exit 1
 *      A step that appears in a feature but has 0 definitions -> not this script's job
 *      (`check-dry-run.ts` reads the undefined bucket of the dry-run summary line; that is
 *      a different check)
 *
 *   Before 1.6.0, rule 3 was "for every step shape that appears in a feature file". Only
 *   sentences that a feature already used had their definition count compared, so definitions
 *   that were **word-for-word identical across files but not yet used by any feature** were
 *   invisible (P-87, from AI_KM 2026-09-08): a test agent opened a new steps file and copied
 *   another phase's English wording as its own definition. Running only its own tag was all
 *   green (its own scenarios had not reached that sentence yet), but when someone else ran
 *   their tag it blew up as ambiguous, and the message pointed at **someone else's**
 *   scenario. This is another form of "green on my side, red for others after the merge".
 *   There was one more blind corner: a definition that uses cucumber expression optional/alternative
 *   syntax (`the log line(s) contain(s) {string}`, `a/an item`) never matches the shape of any
 *   feature sentence after normalization, so duplicate definitions slipped through. The check
 *   now looks for duplicates in the definition list itself, which covers both corners.
 *
 * Usage (the repo root is resolved from `git rev-parse --show-toplevel`, falling back to cwd outside a git repo):
 *   npx tsx scripts/check-step-dup.ts               # run after copying into the repo
 *   npx tsx <template>/scripts/check-step-dup.ts    # run straight from the template path; cwd must be in the target repo
 *   npx tsx scripts/check-step-dup.ts --list        # list every sentence that spans >=2 folders with its definition files
 *                                                    # (0 definitions prints "(undefined)"); the exit code is not judged
 *
 * Exit codes:
 *   0  no step shape is defined >=2 times
 *   1  some step shape is defined >=2 times (whether or not a feature uses it); or 0 .feature files /
 *      0 step sentences / 0 parsable step definitions were scanned (this is not "clean", the scanner is broken)
 *
 * Reverse check (run the script against real data by putting it temporarily in the root
 * scripts/, delete the temp files afterwards, and confirm `git status` is clean, leaving no changes):
 *   (a) Pick a sentence already defined in features/steps/common.steps.ts (for example
 *       `it exits with status {int}`) and copy the whole line as-is into another capability's
 *       *.steps.ts (for example features/steps/scheduler.steps.ts). Run this script again ->
 *       it should be red, listing the sentence and both definition files (common.steps.ts and
 *       scheduler.steps.ts).
 *   (b) Delete the definition you just pasted and restore the file -> run again -> it should be green.
 *   (c) Find a sentence that is defined only in one capability's own *.steps.ts but reused by a
 *       docs/integration scenario (common case: an integration scenario uses the assertion
 *       vocabulary that the capability's phase 1 already uses). Confirm it is not in the failure
 *       list (spans folders but has exactly 1 definition -> OK) -> green, no file needs changing.
 *   (d) Pick a definition that **no feature uses** (or write a new `Then('nobody uses this yet', ...)`
 *       and put one copy in each of two steps files) -> it should be red, listing both files and
 *       noting "no feature uses it right now". This is the corner added in 1.6.0;
 *       `check-step-dup.test.ts` has a matching automated test.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, loadGatesConfig, resolveConfig, resolveSkipDirs } from './_root.js';

/** This script's name in the gate's machine-readable marker (see CHANGELOG 1.3.2 (C)). */
const GATE_NAME = 'step-dup';

const LIST_ONLY = process.argv.includes('--list');
const STEPS_DIR = join(ROOT, 'features/steps');

const FAILURE_MESSAGE =
  "Keep exactly ONE definition: a sentence about one capability lives in that capability's steps file " +
  '(integration features reuse it); a sentence genuinely shared by several capabilities lives in ' +
  'features/steps/common.steps.ts (coordinator-owned).';

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

/** S10: share the same skip list with the other gates that walk the directory tree. */
function resolveSkipDirsForStepDup(): Set<string> {
  // 1.7.0 (caught by roster #13, the fifth/sixth instance of P-91): this used to rewrite "type check + merge
  // DEFAULT_SKIP_DIRS" by itself, so the glob hard error added to the shared layer in 1.6.3 did not apply here.
  // **The comment above kept saying "do not write a separate copy in this script",
  // and the very next line wrote one**. A comment describes intent, not the implementation,
  // and nothing checks that the two agree.
  // The per-script audits in 1.6.3~1.6.10 never caught it, because the audit used `grep resolveSkipDirs`,
  // and this function's name `resolveSkipDirsFor...` happens to start with that string, so a literal
  // scan cannot read the context (P-89). The roster uses `\bresolveSkipDirs\s*\(` to tell them apart.
  const p = resolveConfig(import.meta.dirname, 'gates.config.json');
  return resolveSkipDirs(loadGatesConfig(p, GATE_NAME), GATE_NAME);
}

function* walk(dir: string, skipDirs: Set<string>): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full, skipDirs);
    else if (name.endsWith('.feature')) yield full;
  }
}

/** features/<NN-name>/... -> "features/<NN-name>"; docs/integration/... -> "docs/integration"; anything else is undefined (not a target, e.g. features/_template). */
function folderOf(relPath: string): string | undefined {
  const posix = toPosix(relPath);
  const m = posix.match(/^features\/(\d{2}-[^/]+)\//);
  if (m) return `features/${m[1]}`;
  if (posix.startsWith('docs/integration/')) return 'docs/integration';
  return undefined;
}

function collectFeatureFiles(): string[] {
  const skipDirs = resolveSkipDirsForStepDup();
  const all = [...walk(join(ROOT, 'features'), skipDirs), ...walk(join(ROOT, 'docs/integration'), skipDirs)];
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

/** Step sentence normalization: drop the leading keyword (the caller already did), quoted content -> {string}, standalone numbers -> {int}, <param> -> {param}. */
function normalize(raw: string): string {
  return raw
    .replace(/"[^"]*"/g, '{string}')
    .replace(/<[^>]+>/g, '{param}')
    .replace(/\b\d+\b/g, '{int}')
    .trim();
}

/** Collapse the normalized step sentence one more level: {string}/{int}/{param} all become the same wildcard {}, to compare with the shape on the definition side. */
function genericize(normalized: string): string {
  return normalized.replace(/\{string\}|\{int\}|\{param\}/g, '{}');
}

/** Parse a string literal (starting at the character after quoteChar); return the value and the end index (the position after the closing quote). */
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

/** Parse a regex literal (starting after the first /); return the source and the end index (the position after the flags). */
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

/** Strip comments, so a commented-out definition (e.g. `// Then(...)` during the reverse check) is not misjudged as still alive. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (_m, pre: string) => pre);
}

/** cucumber expression string definition -> shape key: any {word} parameter (whatever its type) collapses to {}. */
function literalToKey(lit: string): string {
  return lit.replace(/\{[A-Za-z0-9_]*\}/g, '{}');
}

/** regex definition -> shape key: drop the ^ $ anchors and replace capture groups (nesting not handled) with {}. The rest of the regex syntax stays as-is.
 * It is only used for literal comparison with other definitions' keys (to detect a real name clash such as
 * "the same definition copy-pasted"), not as a full regex semantic comparison. */
function regexToKey(source: string): string {
  let body = source;
  if (body.startsWith('^')) body = body.slice(1);
  if (body.endsWith('$')) body = body.slice(0, -1);
  return body.replace(/\((?:\?:)?[^()]*\)/g, '{}');
}

function collectStepDefinitionFiles(): string[] {
  if (!existsSync(STEPS_DIR)) return [];
  return readdirSync(STEPS_DIR)
    .filter((name) => name.endsWith('.steps.ts'))
    .map((name) => join(STEPS_DIR, name));
}

/** One step definition: which file it lives in, its original text (string literal or regex source), and which kind it is. */
interface StepDefinition { file: string; literal: string; kind: 'expression' | 'regex' }

function extractDefinitions(rawSrc: string): { key: string; literal: string; kind: 'expression' | 'regex' }[] {
  const src = stripComments(rawSrc);
  const out: { key: string; literal: string; kind: 'expression' | 'regex' }[] = [];
  const callRe = /\b(?:Given|When|Then)\s*\(\s*/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(src)) !== null) {
    const after = m.index + m[0].length;
    const next = src[after];
    if (next === '"' || next === "'" || next === '`') {
      const parsed = parseStringLiteral(src, after + 1, next);
      if (parsed) out.push({ key: literalToKey(parsed.value), literal: parsed.value, kind: 'expression' });
    } else if (next === '/') {
      const parsed = parseRegexLiteral(src, after + 1);
      if (parsed) out.push({ key: regexToKey(parsed.source), literal: `/${parsed.source}/`, kind: 'regex' });
    }
    // Anything else (e.g. the variable form `for (const phrase of [...]) { Then(phrase, ...) }`) is not
    // a definition that "starts directly with a quote or /", so skip it. This is a deliberate limit of this script, see the header comment.
  }
  return out;
}

function buildDefinitionsByKey(): Map<string, StepDefinition[]> {
  const map = new Map<string, StepDefinition[]>();
  for (const file of collectStepDefinitionFiles()) {
    const rel = toPosix(relative(ROOT, file));
    const src = readFileSync(file, 'utf8');
    for (const d of extractDefinitions(src)) {
      const list = map.get(d.key) ?? [];
      list.push({ file: rel, literal: d.literal, kind: d.kind });
      map.set(d.key, list);
    }
  }
  return map;
}

interface Group { folders: Set<string>; occurrences: StepOccurrence[]; displayTexts: Set<string> }

function main(): void {
  const files = collectFeatureFiles();
  if (files.length === 0) {
    console.log('✗ 掃到 0 個 .feature 檔(features/**/*.feature 或 docs/integration/**/*.feature)。這不是很乾淨,是掃描器壞了。');
    console.log(`gate=${GATE_NAME} result=FAIL scanned=0`);
    process.exit(1);
  }

  const groups = new Map<string, Group>();
  for (const file of files) {
    const rel = toPosix(relative(ROOT, file));
    const folder = folderOf(rel)!;
    for (const { line, raw } of extractSteps(file)) {
      const normalized = normalize(raw);
      const key = genericize(normalized);
      let g = groups.get(key);
      if (!g) { g = { folders: new Set(), occurrences: [], displayTexts: new Set() }; groups.set(key, g); }
      g.folders.add(folder);
      g.occurrences.push({ folder, file: rel, line, raw });
      g.displayTexts.add(normalized);
    }
  }

  let totalSteps = 0;
  for (const g of groups.values()) totalSteps += g.occurrences.length;
  if (totalSteps === 0) {
    console.log('✗ 掃到 0 個步驟句。這不是很乾淨,是掃描器壞了。');
    console.log(`gate=${GATE_NAME} result=FAIL scanned=0`);
    process.exit(1);
  }

  const defsByKey = buildDefinitionsByKey();
  const defCount = [...defsByKey.values()].reduce((n, l) => n + l.length, 0);
  const stepFiles = collectStepDefinitionFiles();

  console.log(
    `step-dup: 掃描 ${files.length} 個 .feature 檔,${totalSteps} 個步驟句,${groups.size} 種正規化形狀;` +
      `features/steps/*.steps.ts 共 ${stepFiles.length} 個檔案,${defCount} 個可解析定義`,
  );

  if (defCount === 0) {
    // The features have sentences but not one definition could be parsed: the steps directory is in the wrong place,
    // the file name is not *.steps.ts, or all definitions use the variable form. Whichever it is, this gate
    // cannot check anything about "duplicate definitions", so it must not claim a pass.
    console.log(`✗ ${STEPS_DIR} 底下解析到 0 個步驟定義(*.steps.ts 裡 Given/When/Then 直接接引號或 / 的呼叫)。這不是很乾淨,是掃描器壞了。`);
    console.log(`gate=${GATE_NAME} result=FAIL scanned=0`);
    process.exit(1);
  }

  const crossFolder = [...groups.entries()].filter(([, g]) => g.folders.size >= 2);

  if (LIST_ONLY) {
    for (const [key, g] of crossFolder.sort((a, b) => b[1].folders.size - a[1].folders.size)) {
      const defFiles = (defsByKey.get(key) ?? []).map((d) => d.file);
      const label = [...g.displayTexts].join(' | ');
      console.log(`  [${g.folders.size} 資料夾]  ${label}`);
      console.log(`      定義於:${defFiles.length ? defFiles.join(', ') : '(undefined)'}`);
    }
    console.log(`gate=${GATE_NAME} result=PASS scanned=${totalSteps}`);
    process.exit(0);
  }

  // 1.6.0: look for duplicates in the **definition list itself**, no longer only the sentences a feature already uses (P-87).
  const duplicated = [...defsByKey.entries()].filter(([, defs]) => defs.length >= 2);
  if (duplicated.length) {
    console.log(`\n✗ ${FAILURE_MESSAGE}`);
    console.log(`\n${duplicated.length} 句被定義了 ≥2 次:`);
    let unusedCount = 0;
    for (const [key, defs] of duplicated) {
      const g = groups.get(key);
      const label = g ? [...g.displayTexts].join(' | ') : key;
      console.log(`  "${label}"`);
      for (const d of defs) console.log(`      定義於:${d.file}  ${d.kind === 'regex' ? d.literal : `'${d.literal}'`}`);
      if (g) {
        console.log(`      用於:${[...g.folders].sort().join(', ')}`);
      } else {
        unusedCount++;
        console.log('      用於:(目前沒有任何 .feature 用到——只跑自己的 tag 看不到,一旦有人寫了這句就 ambiguous,而且訊息會指向別人的場景;P-87)');
      }
    }
    if (unusedCount) {
      console.log(`\n  其中 ${unusedCount} 句目前沒有 feature 用到:這種重複 \`cucumber --dry-run\` 也印不出來(dry-run 只走 feature 裡有的句子),只有這支守門看得到。`);
    }
    console.log(`gate=${GATE_NAME} result=FAIL scanned=${totalSteps}`);
    process.exit(1);
  }

  console.log(`✓ 無重複定義(${defCount} 個定義每種形狀恰好 1 個;跨資料夾的句子 ${crossFolder.length} 種)`);
  console.log(`gate=${GATE_NAME} result=PASS scanned=${totalSteps}`);
  process.exit(0);
}

main();

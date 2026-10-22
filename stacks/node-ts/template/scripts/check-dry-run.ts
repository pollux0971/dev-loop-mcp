/**
 * cucumber dry-run guard: read the summary line, do not trust the exit code (P-86, source AI_KM advisor 2026-09-08).
 *
 * Background: `cucumber-js --dry-run` prints both ambiguous (one sentence matching two definitions) and undefined (no
 * definition at all) in the summary line, e.g. `822 steps (1 ambiguous, …)`, but **exits 0, and with `--strict`
 * it is still 0** (seen in a real run with @cucumber/cucumber 11.3.0, see CHANGELOG 1.6.0; `--strict` only covers pending,
 * not ambiguous/undefined under dry-run). Wiring `npm run accept:dry` straight into CI or the `chain` of
 * `gates.config.json` gives a guard that is "connected, can print errors, and never goes red" — exactly the P-32 /
 * P-43 type: the green light comes from "nobody looks at the result", not from "the result is right".
 *
 * This script does exactly one thing: run a dry-run itself, read the summary line back, and **decide red/green from the summary line**:
 *   - If the summary line `N scenarios (...)` / `N steps (...)` shows any of the undefined / ambiguous / failed
 *     buckets with a number >= 1 → exit 1, and print the number of each bucket.
 *   - If `N scenarios` is 0 → exit 1, print "scanned 0 scenarios ... the scanner is broken" — the same rule as P-32:
 *     a tag filter, the paths setting, or feature files all being excluded can each make the dry-run "check nothing"
 *     yet claim a pass; 0 targets always means the scanner is broken, not that things are clean.
 *   - If no summary line is found in the output, cucumber cannot start, or cucumber's own exit code is non-zero (e.g. Parse
 *     error, P-16) → exit 1. **Only the direction "exit code non-zero" trusts cucumber**: when it says broken, it is broken;
 *     when it says fine (exit 0) that does not count, the summary line must also be clean.
 *   - Otherwise → exit 0.
 *
 * The full cucumber output (including the `Failures:` list, which shows which two definitions collide) is passed through to the terminal as is,
 * and the summary-line verdict is printed last — the person at the terminal sees cucumber's own messages, not a paraphrase.
 *
 * **Two sections, two kinds of buckets (AI_KM 2026-09-08 second round)**: per the spec the consumer deliberately leaves "not yet done" scenarios undefined
 * (todo integration points, `@model` scenarios — those are "not done yet", not "broken"), and the acceptance job excludes them with `--tags`.
 * A bare dry-run would count these by-design undefined as errors, so after an upgrade the first red would not be the P-32 list but the todos. Therefore:
 *   Section A (acceptance set): run with the **same** tag expression as the acceptance job; undefined / ambiguous / failed are all red.
 *     Tag source priority: `--tags <expr>` flag > `dryRun.tags` in `gates.config.json` > none
 *     (leave it to the `tags` in cucumber's own config file).
 *   Section B (full set): run again **without** `--tags` (the `tags` in the cucumber config file still apply) and look only at ambiguous —
 *     two definitions colliding has nothing to do with tags; a scenario excluded by tag blows up once it gets included, so the full set must be checked; undefined
 *     is never counted in this section (that is exactly the deliberate todo). If section A has no tag, section B is the same run as section A and is skipped.
 *   `scanned` is the scenario count of section A.
 *
 * The cucumber working directory (cwd) is decided in three layers, the same scheme as `check-phase-coverage.ts` / `check-known-defects.ts`
 * (each has its own copy, no shared helper — `sync-gates.sh` copies every check-*.ts as an independent file):
 *   `--cwd` flag > `"cucumberCwd"` in `gates.config.json` > auto-detect (whether ROOT or its direct
 *   subdirectories contain a config file such as cucumber.js). If none of the three has it → exit 1, print "cucumber config not found".
 *
 * Usage (the repo root is resolved from `git rev-parse --show-toplevel`; an explicit `--root <dir>` takes priority):
 *   npx tsx scripts/check-dry-run.ts                          # tags come from dryRun.tags in gates.config.json; if absent, leave it to the cucumber config file
 *   npx tsx scripts/check-dry-run.ts --tags 'not @manual'     # give the tag expression explicitly (this is how accept:dry in package.json calls it)
 *   npx tsx scripts/check-dry-run.ts --root <dir> --cwd <cucumber working dir>
 *   npx tsx scripts/check-dry-run.ts -- --name 'Scenario X'   # arguments after `--` are passed to cucumber-js as is (appended in both sections)
 *
 * gates.config.json:
 *   { "dryRun": { "tags": "not @manual and not @todo" } }     # the one the acceptance job uses; put it here so you need not keep two copies in sync with package.json
 *
 * Exit code: 0 when section A's summary line is clean and the scenario count is >= 1 and section B has 0 ambiguous; 1 when any bucket is non-zero, 0 scenarios, no summary line found,
 * cucumber cannot start, cucumber's own exit code is non-zero, no cucumber config found, or a broken config file.
 *
 * Gate marker: `gate=dry-run result=PASS|FAIL scanned=<section A scenario count>` (0 targets and execution failure both give scanned=0).
 *
 * Reverse verification (pitfall 23, source AI_KM: **a guard proposal must be made to go red once before it is wired into CI**, the same rule as "deliberately break the config file first",
 * except what is broken here is the input):
 *   (a) Pick a Cucumber Expression that already has a definition, copy the whole line verbatim into another *.steps.ts →
 *       run this script → it should go red, the summary line shows `ambiguous`, and `Failures:` lists the file:line of both definitions.
 *       Running `npx cucumber-js --dry-run --strict` directly on the same fixture → exit 0 (this is why
 *       this script is needed).
 *   (b) Delete the definition just pasted → rerun → it should be green.
 *   (c) Add a step with no definition to some feature file → it should be red, the summary line shows `undefined`.
 *   (d) `--tags '@this-tag-does-not-exist'` → it should be red, printing the "scanned 0 scenarios" message.
 *   (e) Put the undefined step from (c) into a `@todo` scenario with `--tags 'not @todo'` → it should be green (a by-design
 *       todo does not count); put the colliding sentence from (a) into the same `@todo` scenario with the same tags → it should be red (section B catches it).
 *   `check-dry-run.test.ts` makes (a)–(e) into automated tests that run real cucumber against a fixture repo.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import {
  DEFAULT_SKIP_DIRS,
  ROOT as GIT_ROOT,
  loadGatesConfig,
  lookupConfig,
  requireConfigType,
  requireRootDir,
} from './_root.js';

/** The one sentence shared by all scanners. A red from 0 targets always points to "the scanner is broken". */
const SCANNER_BROKEN = '這不是很乾淨,是掃描器壞了';

/** The name of this script in the gate's machine-readable marker. */
const GATE_NAME = 'dry-run';

/** dry-run does not execute steps; even a big repo (800+ steps) takes only a few seconds. This timeout guards against hangs, it is not a performance budget. */
const DRY_RUN_TIMEOUT_MS = 120_000;

/** If any of these buckets in the summary line is >= 1, it is red. Under dry-run cucumber reports undefined and ambiguous;
 *  failed should in theory never appear (no step is executed); it is listed defensively — if it does appear it should not be green either. */
const BAD_BUCKETS = ['undefined', 'ambiguous', 'failed'] as const;

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROOT_EXPLICIT = argValue('--root') !== undefined;
const ROOT = resolve(argValue('--root') ?? GIT_ROOT);
requireRootDir(ROOT, ROOT_EXPLICIT, GATE_NAME);

/** Arguments after `--` are passed to cucumber-js as is. */
function passthroughArgs(): string[] {
  const i = process.argv.indexOf('--');
  return i >= 0 ? process.argv.slice(i + 1) : [];
}

function configError(msg: string): never {
  console.error(`✗ ${msg}`);
  console.log(`gate=${GATE_NAME} result=FAIL scanned=0`);
  process.exit(1);
}

/** Delegates to `lookupConfig` in `_root.ts` (S14, PITFALLS P-73): when `--root` is explicit, do not fall back to the directory this
 *  script lives in. gates.config.json is optional for this script (only `cucumberCwd` is read); if not found,
 *  auto-detection is used and hardErrorMessage is ignored. */
function findConfigFile(name: string): string | undefined {
  const result = lookupConfig(import.meta.dirname, name, { root: ROOT, rootExplicit: ROOT_EXPLICIT });
  console.log(`${name}: ${result.source}`);
  return result.path;
}

// ---- cucumber working directory (cwd): decided in three layers ----

const CUCUMBER_CONFIG_FILES = ['cucumber.js', 'cucumber.cjs', 'cucumber.mjs', 'cucumber.json', 'cucumber.yaml', 'cucumber.yml'];
/** S10: the shared skip list + `archive` (the template's convention for archive directories, not in the generic list). */
const CWD_SCAN_SKIP = new Set([...DEFAULT_SKIP_DIRS, 'archive']);

function hasCucumberConfig(dir: string): boolean {
  return CUCUMBER_CONFIG_FILES.some((f) => existsSync(join(dir, f)));
}

function autodetectCucumberCwd(): string | undefined {
  if (hasCucumberConfig(ROOT)) return ROOT;
  let entries: string[];
  try {
    entries = readdirSync(ROOT);
  } catch {
    return undefined;
  }
  const dirs = entries
    .filter((e) => !CWD_SCAN_SKIP.has(e))
    .filter((e) => {
      try {
        return statSync(join(ROOT, e)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  for (const d of dirs) {
    const full = join(ROOT, d);
    if (hasCucumberConfig(full)) return full;
  }
  return undefined;
}

interface GatesConfig { cucumberCwd?: string; tags?: string }

/** Read gates.config.json once (optional): `cucumberCwd` and `dryRun.tags`. Parse errors, unknown top-level keys,
 *  and wrong types all fail loudly here (S9), not as an uncaught stack trace. */
function loadConfig(): GatesConfig {
  const cfgPath = findConfigFile('gates.config.json');
  const cfg = loadGatesConfig(cfgPath, GATE_NAME);
  const out: GatesConfig = {};
  if (cfg?.cucumberCwd !== undefined) {
    requireConfigType(cfg.cucumberCwd, 'cucumberCwd', 'string', GATE_NAME);
    out.cucumberCwd = cfg.cucumberCwd as string;
  }
  if (cfg?.dryRun !== undefined) {
    requireConfigType(cfg.dryRun, 'dryRun', 'object', GATE_NAME);
    const tags = (cfg.dryRun as { tags?: unknown }).tags;
    if (tags !== undefined) {
      requireConfigType(tags, 'dryRun.tags', 'string', GATE_NAME);
      if ((tags as string).trim() === '') configError('"dryRun.tags" 是空字串(要不帶 tag 就刪掉這個欄位)');
      out.tags = tags as string;
    }
  }
  return out;
}

const CONFIG = loadConfig();

function resolveCucumberCwd(): string {
  const cwdFlag = argValue('--cwd');
  if (cwdFlag) {
    const resolved = resolve(ROOT, cwdFlag);
    if (!existsSync(resolved)) configError(`--cwd 指定的目錄不存在:${resolved}`);
    return resolved;
  }
  const cucumberCwd = CONFIG.cucumberCwd;
  if (cucumberCwd !== undefined) {
    const resolved = resolve(ROOT, cucumberCwd);
    // Set but pointing to the wrong path; auto-detection must not silently rescue it (CHANGELOG 1.3.2 (A)).
    if (!existsSync(resolved)) configError(`"cucumberCwd" 指定的目錄不存在:${resolved}`);
    return resolved;
  }
  const detected = autodetectCucumberCwd();
  if (detected) return detected;
  configError(
    `找不到 cucumber 設定(cucumber.js|.cjs|.mjs|.json|.yaml|.yml;找過 ${ROOT} 與它的直接子目錄),` +
      '用 --cwd 或 gates.config.json 的 "cucumberCwd" 指定。',
  );
}

function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  env.NODE_OPTIONS = '--import=tsx';
  return env;
}

// ---- summary line parsing ----

export interface SummaryLine {
  total: number;
  /** The number for each bucket in the parentheses, e.g. { ambiguous: 1, skipped: 3 }. */
  buckets: Record<string, number>;
}

/** Grab `N scenarios (...)` or `N steps (...)` from the output of cucumber `--format summary`.
 *  The parentheses hold `<number> <bucket name>` separated by commas; forms without parentheses such as `0 scenarios` must also be recognized (for 0
 *  scenarios cucumber prints `0 scenarios` plus `0 steps`, with no parentheses). */
export function parseSummaryLine(output: string, noun: 'scenarios' | 'steps'): SummaryLine | undefined {
  const re = new RegExp(`(\\d+)\\s+${noun.replace(/s$/, '')}s?\\b\\s*(?:\\(([^)]*)\\))?`);
  const m = output.match(re);
  if (!m) return undefined;
  const total = Number(m[1]);
  const buckets: Record<string, number> = {};
  const detail = m[2] ?? '';
  for (const part of detail.split(',')) {
    const pm = part.trim().match(/^(\d+)\s+([a-z]+)$/i);
    if (pm) buckets[pm[2]!.toLowerCase()] = Number(pm[1]);
  }
  return { total, buckets };
}

/** The broken buckets in the summary line (undefined / ambiguous / failed with number >= 1), returned as a list of `bucket=number`. */
export function badBuckets(summary: SummaryLine): string[] {
  const out: string[] = [];
  for (const b of BAD_BUCKETS) {
    const n = summary.buckets[b] ?? 0;
    if (n >= 1) out.push(`${b}=${n}`);
  }
  return out;
}

interface DryRunOutcome { scenarios: SummaryLine; steps: SummaryLine; status: number | null; output: string }

/** Run the dry-run once, pass the output through as is, and return the two parsed summary lines. Cannot start / timeout / no summary line found → configError. */
function runDryRun(cwd: string, label: string, args: string[]): DryRunOutcome {
  console.log(`dry-run: ${label}:npx ${args.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(' ')}`);
  const r = spawnSync('npx', args, { cwd, encoding: 'utf8', env: baseEnv(), timeout: DRY_RUN_TIMEOUT_MS });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (output.trim()) console.log(output.trimEnd());
  const isTimeout = (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') || !!r.signal;
  if (isTimeout) configError(`cucumber dry-run 逾時(超過 ${DRY_RUN_TIMEOUT_MS}ms 未完成${r.signal ? `,收到訊號 ${r.signal}` : ''})`);
  if (r.error) configError(`cucumber 執行失敗:${r.error.message}`);
  const scenarios = parseSummaryLine(output, 'scenarios');
  const steps = parseSummaryLine(output, 'steps');
  if (!scenarios || !steps) {
    // No summary line found: most likely cucumber could not start (broken config, module load failure, a Parse error aborting before the summary is printed).
    // If the exit code is non-zero, print it too — in that direction we trust cucumber.
    configError(
      `${label}:輸出裡找不到 "N scenarios (...)" / "N steps (...)" 摘要行` +
        `${r.status !== null && r.status !== 0 ? `(cucumber 退出碼 ${r.status})` : ''}`,
    );
  }
  return { scenarios, steps, status: r.status, output };
}

function main(): void {
  const cucumberCwd = resolveCucumberCwd();
  const cwdDisplay = relative(ROOT, cucumberCwd) || '.';
  const tagsFlag = argValue('--tags');
  const tags = tagsFlag ?? CONFIG.tags;
  const tagSource = tagsFlag !== undefined ? '--tags 旗標' : CONFIG.tags !== undefined ? 'gates.config.json 的 dryRun.tags' : '無(交給 cucumber 設定檔)';
  const extra = passthroughArgs();
  const base = ['cucumber-js', '--dry-run', '--format', 'summary'];

  console.log(`dry-run: cucumber cwd = ${cwdDisplay};tag 來源:${tagSource}${tags !== undefined ? `('${tags}')` : ''}`);

  // ---- Section A: acceptance set (same tag as the acceptance job), undefined / ambiguous / failed are all red ----
  const argsA = [...base];
  if (tags !== undefined) argsA.push('--tags', tags);
  argsA.push(...extra);
  const a = runDryRun(cucumberCwd, '段 A(驗收集合)', argsA);

  if (a.scenarios.total === 0) {
    console.log(`\n✗ 段 A 掃到 0 個場景(cucumber cwd = ${cwdDisplay}${tags !== undefined ? `,--tags '${tags}'` : ''})。${SCANNER_BROKEN}`);
    console.log('  tag 表達式、cucumber 設定檔的 paths、或 feature 檔的位置,至少有一個讓 dry-run 什麼都沒檢查到(P-32)。');
    console.log(`gate=${GATE_NAME} result=FAIL scanned=0`);
    process.exit(1);
  }

  const failures: string[] = [];
  const badA = [...new Set([...badBuckets(a.steps), ...badBuckets(a.scenarios)])];
  if (badA.length) {
    failures.push(`段 A(驗收集合)摘要行不乾淨:${badA.join(', ')}(${a.scenarios.total} 個場景、${a.steps.total} 個 step)`);
    if (badA.some((b) => b.startsWith('undefined'))) {
      failures.push('  undefined:驗收集合裡有步驟句沒有任何定義——照 P-32 的清單修 tag / 定義;如果那是設計上的 todo,tag 運算式要跟驗收 job 一致(--tags 或 gates.config.json 的 dryRun.tags)。');
    }
  }
  if (a.status !== 0 && !badA.length) {
    // Summary line is clean but cucumber itself says broken (e.g. a Parse error in some feature file). In this direction we trust cucumber.
    failures.push(`段 A:cucumber 退出碼 ${a.status ?? 'unknown'}(摘要行乾淨,但 cucumber 自己回報了錯誤,看上面的輸出)`);
  }

  // ---- Section B: full set (without --tags), look only at ambiguous ----
  let bNote = '';
  if (tags !== undefined) {
    const b = runDryRun(cucumberCwd, '段 B(全集,只看 ambiguous)', [...base, ...extra]);
    const amb = b.steps.buckets.ambiguous ?? b.scenarios.buckets.ambiguous ?? 0;
    if (amb >= 1) {
      failures.push(`段 B(全集)有 ${amb} 個 ambiguous step——撞名的定義跟 tag 無關,被 tag 排除的場景一旦排進來就炸(${b.scenarios.total} 個場景)`);
    }
    const und = b.steps.buckets.undefined ?? 0;
    bNote = `;段 B 全集 ${b.scenarios.total} 個場景,${amb} ambiguous${und ? `(${und} undefined 在驗收集合外,視為設計上的 todo,不算)` : ''}`;
  }

  if (failures.length) {
    console.log('\n✗ dry-run 守門紅:');
    for (const f of failures) console.log(`  ${f}`);
    console.log('  cucumber 對 dry-run 的這些狀態退出碼仍是 0(--strict 也是),所以這裡看的是摘要行,不是退出碼(P-86)。');
    if (failures.some((f) => f.includes('ambiguous'))) {
      console.log('  ambiguous:同一句話對到 ≥2 個定義——上面 Failures: 列出了撞在一起的檔案:行號;`npm run check:steps` 會列出全部重複定義(含還沒被 feature 用到的)。');
    }
    console.log(`gate=${GATE_NAME} result=FAIL scanned=${a.scenarios.total}`);
    process.exit(1);
  }

  console.log(`\n✓ dry-run 摘要行乾淨:段 A ${a.scenarios.total} 個場景、${a.steps.total} 個 step,0 undefined、0 ambiguous${bNote}`);
  console.log(`gate=${GATE_NAME} result=PASS scanned=${a.scenarios.total}`);
  process.exit(0);
}

main();

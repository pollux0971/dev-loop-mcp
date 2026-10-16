/**
 * Repo root resolution shared by all gate scripts.
 *
 * The old version used `resolve(import.meta.dirname, '..')`, i.e. the parent of the script's own
 * directory. That required the script to be copied into the target repo's scripts/ first. Now we
 * ask git for the top level of the repo that contains the current cwd, so the script can stay in
 * the template and run directly with `npx tsx <template>/scripts/x.ts` against the repo of the
 * cwd at run time, with no copying.
 *
 * Approach: ask git first (`git rev-parse --show-toplevel`, based on process.cwd());
 * if we are not in a git repo (or there is no git executable), fall back to process.cwd() itself.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function resolveRoot(): string {
  try {
    // Set stdio explicitly so git does not print "fatal: not a git repository" to the
    // terminal when we are outside a git repo. This fallback is deliberate, not an error
    // the user needs to see.
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.cwd();
  }
}

export const ROOT: string = resolveRoot();

const ISOLATED_TEMP_PACKAGE_JSON = '{"name":"dev-loop-test-fixture","private":true,"type":"commonjs"}';

/** Create an isolated, observable test fixture root dir, and pin the module type with its own package.json. */
export function makeIsolatedTempDir(prefix: string, base: string = tmpdir()): string {
  const tempBase = resolve(base);
  mkdirSync(tempBase, { recursive: true });
  const tempDir = mkdtempSync(join(tempBase, prefix));
  writeFileSync(join(tempDir, 'package.json'), ISOLATED_TEMP_PACKAGE_JSON, 'utf8');
  console.log(`[makeIsolatedTempDir] ${tempDir}`);
  return tempDir;
}

/**
 * P-84 (source: project A coordinator, 2026-09-05): when `--root` names a directory that does
 * not exist, `check-next-gates.ts` and `check-phase-status.ts` kept running until the generic
 * empty-target message "scanned 0 xxx". That message says nothing about what `--root` was given,
 * nor that the directory does not exist at all. Compared with the other gates that touch the
 * config file first (`check-boundaries.ts`, `check-doc-rot.ts` and the like, via the S14
 * hard-error in `lookupConfig`), it leaves out the most important sentence.
 *
 * Fix: when `--root` is given, check before any config lookup that the directory really exists
 * and really is a directory. If not, print "✗ --root 指到不存在的目錄:<absolute path>" plus the
 * gate marker (scanned=0) and exit 1. Do not keep running to the generic "scanned 0 things"
 * message (that one is for "the directory exists but is empty"; the two causes should not
 * share one sentence).
 *
 * `rootDirError` only returns the message string. It does not print and does not exit.
 * `main()` in `check-doc-links.ts` is a pure function (it returns `{ code, output }` and never
 * calls `process.exit`; see the note at the top of that file), so it uses this version and builds
 * its own output. The other gates that call `process.exit` directly use `requireRootDir` below.
 */
export function rootDirError(root: string): string | undefined {
  let ok: boolean;
  try {
    ok = statSync(root).isDirectory();
  } catch {
    ok = false;
  }
  if (ok) return undefined;
  return `✗ --root 指到不存在的目錄:${root}`;
}

/**
 * The "print it, print the gate marker, exit 1" version of `rootDirError`, for gates that call
 * `process.exit` themselves (most `check-*.ts` are of this kind). `rootExplicit` says whether
 * this run was given `--root`. If it was not given, we do not check (the module-level `ROOT`
 * inferred from git always exists, so there is no need to block here and we should not). The
 * caller must call this function **before any config lookup** (the S14 hard-error is the next
 * gate, not this one).
 */
/**
 * 1.7.0 (#18): the gate marker printed on an early failure must be able to carry a trailing field
 * that is "specific to this gate".
 * Cause: the summary line of `check-all.ts` gained `ran=` (how many actually ran this time), but
 * two failure paths print the marker through here (`requireRootDir`, `failConfig`). If only the
 * lines in check-all itself were changed, `ran=` would be **sometimes there, sometimes not**, and
 * a consumer that parses `ran=` would get no value in the run where the config file is broken.
 * That is exactly the shape of P-93 (a summary that omits one state is worse than no summary).
 * So the shared layer does not special-case gate names. Instead, a gate that needs a trailing
 * field registers it itself at startup; the marker of a gate that did not register is unchanged.
 */
let markerSuffix = '';
export function setMarkerSuffix(suffix: string): void {
  markerSuffix = suffix;
}
function earlyFailMarker(gateName: string): string {
  return `gate=${gateName} result=FAIL scanned=0${markerSuffix}`;
}

export function requireRootDir(root: string, rootExplicit: boolean, gateName: string): void {
  if (!rootExplicit) return;
  const message = rootDirError(root);
  if (message === undefined) return;
  console.error(message);
  console.log(earlyFailMarker(gateName));
  process.exit(1);
}

/**
 * Config file location resolution (CHANGELOG 1.3.2 (A); env precedence see CHANGELOG 1.3.4 (3)).
 *
 * `sync-gates.sh` copies the gate scripts into the consumer's **install directory**. The default
 * is `scripts/`, but projects whose cucumber config is not at the root often install it
 * elsewhere (for example `features/scripts/`), and the config files (`gates.config.json`,
 * `boundaries.*.json`) are installed there too. In the past every script only looked at
 * `ROOT/scripts/<name>`, so a config installed elsewhere was never read. No error: defaults were
 * silently applied or auto-detection kicked in, as if the config were dead (a regression seen in
 * a real run in project B).
 *
 * Order in which the config file is searched:
 *   0. env var `GATES_CONFIG_DIR` (if set and the directory exists)
 *   1. the directory of the calling script itself (`import.meta.dirname`; after sync this is the consumer's install directory)
 *   2. `ROOT/scripts/`
 * Not in any of the three -> return `undefined`. The caller prints "config file not found in
 * <searched paths>" (required config) or silently applies the built-in defaults (optional
 * config, behavior unchanged).
 *
 * Why there is a position 0: `verify-against.sh` runs the `.ts` under the template path directly
 * (without copying via `sync-gates.sh`). Then "the directory of the calling script itself"
 * (position 1) is **the template's own `scripts/` directory**, which holds placeholder configs
 * meant to be copied into new projects. For a hard config like boundaries, it would always read
 * the template's placeholder owners.json, and always find a "difference" against the consumer's
 * real landing table (CHANGELOG 1.3.4 (3)). `GATES_CONFIG_DIR` lets `verify-against.sh` say
 * explicitly "where to find the config for this run of the template version", regardless of
 * which directory the script actually sits in.
 */
export function resolveConfig(scriptDir: string, name: string): string | undefined {
  for (const candidate of configSearchPaths(scriptDir, name)) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The paths `resolveConfig` actually tries, in order (3 when the env var applies, otherwise 2), for the error message when nothing is found. */
export function configSearchPaths(scriptDir: string, name: string): string[] {
  const paths: string[] = [];
  const envDir = process.env.GATES_CONFIG_DIR;
  if (envDir && existsSync(envDir)) {
    paths.push(join(envDir, name));
  }
  paths.push(join(scriptDir, name), join(ROOT, 'scripts', name));
  return paths;
}

/**
 * S14 (source AI_KM, 2026-09-05; PITFALLS P-73): config file resolution when `--root` names
 * another repo to run the gates on. It is the other half of the same problem as `resolveConfig` /
 * `configSearchPaths` above. Those two are tied to the module-level `ROOT` (the git repo of the
 * current cwd) and do not know that the caller may have used `--root <dir>` to name a
 * **different** target repo (scripts that support `--root`, such as `check-boundaries.ts` and
 * `check-doc-rot.ts`, each keep their own `configSearchPathsList` for exactly this reason).
 *
 * Incident (P-73): a consumer ran `check-boundaries.ts --root /data/python/AI_KM` against another
 * repo from the **template path**, without setting `GATES_CONFIG_DIR`. The old search order was
 * "the script's own directory -> `<root>/scripts/`", the same whether or not `--root` was given,
 * so position 1 always hit first. It silently applied the **template's own** placeholder
 * `boundaries.owners.json` (FAIL scanned=0 / 248 unmapped) instead of the consumer's installed
 * one; it only worked once `GATES_CONFIG_DIR` was added. Same type as P-43: the template side
 * "looks green" and hides that the config that should have been read was not read.
 *
 * Fix (the rule lives here; the caller sets `rootExplicit` to "whether this run was given `--root`"):
 *   - `--root` was **not** given (the consumer runs normally in its own repo after install) ->
 *     order unchanged: `GATES_CONFIG_DIR` -> the script's own directory (after sync, the
 *     consumer's install directory) -> `<root>/scripts/`.
 *   - `--root` **was** given -> the candidate "the script's own directory" is dropped entirely,
 *     leaving only `GATES_CONFIG_DIR` -> `<root>/scripts/`. If not found, that is an **absence to
 *     complain about, not to degrade**: the returned `hardErrorMessage` makes the caller print it,
 *     print the gate marker and `exit 1`. It must not quietly fall back to the example config in
 *     the template's own directory as if it were "found" (that was the cause of this incident).
 *   `GATES_CONFIG_DIR` wins in both cases, regardless of `rootExplicit`. It is the explicit
 *     channel for "where to find the config for this run of the template version" (it is what
 *     `verify-against.sh` uses).
 *
 * It also returns `source` (for the "config: <resolved path>" transparency line each gate prints.
 * If nothing is found it is "設定:無,使用預設", so whoever reads the log sees on the first line
 * which config was actually read, and does not have to doubt the config file only after the scan
 * result looks wrong).
 */
export interface ConfigLookup {
  /** The resolved path; `undefined` if not found. */
  path: string | undefined;
  /** The description text to print on the "設定:..." line. */
  source: string;
  /** Filled in only for the combination "`--root` given, `GATES_CONFIG_DIR` does not override, and
   *  `<root>/scripts/<name>` is missing too". If the caller sees a value, it must fail loudly, not skip silently. */
  hardErrorMessage?: string;
  /** The paths tried, in order, for callers that build their own "not found" message
   *  (same purpose as the old `configSearchPaths`; this is the `rootExplicit` version). */
  triedPaths: string[];
}

export function lookupConfig(
  scriptDir: string,
  name: string,
  opts?: { root?: string; rootExplicit?: boolean },
): ConfigLookup {
  const root = opts?.root ?? ROOT;
  const rootExplicit = opts?.rootExplicit ?? false;
  const envDir = process.env.GATES_CONFIG_DIR;
  const triedPaths: string[] = [];
  if (envDir && existsSync(envDir)) {
    const p = join(envDir, name);
    triedPaths.push(p);
    if (existsSync(p)) return { path: p, source: `設定:${p}(GATES_CONFIG_DIR)`, triedPaths };
  }
  if (rootExplicit) {
    const p = join(root, 'scripts', name);
    triedPaths.push(p);
    if (existsSync(p)) return { path: p, source: `設定:${p}`, triedPaths };
    return {
      path: undefined,
      source: '設定:無,使用預設',
      hardErrorMessage:
        `設定檔未找到於 ${p}(--root 明講時不退回腳本自身目錄;要指定別處請設 GATES_CONFIG_DIR)`,
      triedPaths,
    };
  }
  const scriptDirPath = join(scriptDir, name);
  triedPaths.push(scriptDirPath);
  if (existsSync(scriptDirPath)) return { path: scriptDirPath, source: `設定:${scriptDirPath}`, triedPaths };
  const rootScriptsPath = join(root, 'scripts', name);
  triedPaths.push(rootScriptsPath);
  if (existsSync(rootScriptsPath)) return { path: rootScriptsPath, source: `設定:${rootScriptsPath}`, triedPaths };
  return { path: undefined, source: '設定:無,使用預設', triedPaths };
}

/**
 * A broken config file must fail loudly (S9, source: project A coordinator).
 *
 * Motivation: one consumer saw that after `gates.config.json` was broken (hand-edited broken
 * JSON, a mistyped key, a wrong value type), some gates threw an uncaught exception (the stack
 * spilled to the terminal, without the machine-readable marker line
 * `gate=<name> result=FAIL scanned=0`, so CI looked as if the script itself was broken, not the
 * config). Other gates used `try { JSON.parse(...) } catch { return {} }` and quietly applied the
 * built-in defaults. The latter is more dangerous: the gate prints "PASS", but the whole config
 * is effectively empty, so it "looks like it ran" while the user's config was never applied at
 * all. Both are wrong.
 *
 * Uniform rule: every gate that reads a config file goes through these three shared functions:
 *   1. Parse error (file unreadable, JSON.parse blows up) -> `readConfigJson()` prints
 *      `✗ 設定檔壞掉:<path>: <message>`, prints the gate marker (scanned=0), exit 1.
 *      Not an uncaught stack, and not a quiet fallback to defaults.
 *   2. A known key has the wrong type (for example `chain` is not an array, `runTimeoutMs` is not
 *      a number) -> `requireConfigType()` prints `✗ 設定檔鍵型別錯:<key> 應為 <type>`, also
 *      prints the marker, exit 1.
 *   3. `gates.config.json` has a top-level key nobody knows (the most common symptom of a typo)
 *      -> `requireKnownTopLevelKeys()` prints
 *      `✗ 設定檔有不認識的鍵:<key>(打錯字?)已知鍵:<list>`, also prints the marker, exit 1.
 *      This only makes sense for `gates.config.json` (it is the only config file read and written
 *      by many gates together, so it is prone to "this gate does not know it but that gate does";
 *      for single-gate config files such as `boundaries.owners.json`, a structure error can just
 *      be handled with that gate's own existing message).
 *
 * `readConfigJson` / `requireConfigType` / `requireKnownTopLevelKeys` are all failure paths of
 * type `never` (exit 1). The caller does not need to, and should not, catch again: "config file
 * broken" is always the same sentence and the same way of exiting, and each gate should not
 * decide for itself whether to handle it.
 */
function failConfig(gateName: string, message: string): never {
  console.error(`✗ ${message}`);
  console.log(earlyFailMarker(gateName));
  process.exit(1);
}

/** Read a JSON config file that is **known to exist** (the caller usually already confirmed the path
 *  exists with `resolveConfig` / `configSearchPaths`). A read failure or a `JSON.parse` failure
 *  prints "設定檔壞掉" and exits 1. It does not throw an uncaught exception and does not quietly
 *  fall back to `{}`. */
export function readConfigJson(path: string, gateName: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return failConfig(gateName, `設定檔壞掉:${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return failConfig(gateName, `設定檔壞掉:${path}: ${(e as Error).message}`);
  }
}

/** The type names `requireConfigType` understands. `'array'` is checked with `Array.isArray`
 *  (in JS `typeof [] === 'object'`, so `typeof` cannot be used directly). */
export type ConfigValueKind = 'array' | 'number' | 'string' | 'boolean' | 'object';

function actualKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** If the type of `value` does not match `kind`, print `✗ 設定檔鍵型別錯:<key> 應為 <kind>`, print the marker, exit 1.
 *  The caller only calls this when `value !== undefined`. "This key was not filled in" is a
 *  different matter (it usually has its own default or a "not configured yet" flow) and must
 *  not be treated as a type error here. */
export function requireConfigType(value: unknown, key: string, kind: ConfigValueKind, gateName: string): void {
  const ok = kind === 'array' ? Array.isArray(value) : !Array.isArray(value) && value !== null && typeof value === kind;
  if (!ok) failConfig(gateName, `設定檔鍵型別錯:${key} 應為 ${kind}(實際:${actualKind(value)})`);
}

/**
 * The list of known top-level keys of `gates.config.json` (S9). **Whenever a gate adds a
 * top-level key, it must be added here**, no matter which gate reads it: this list is the union
 * of "keys any gate knows", not the subset of "keys this one gate uses". Otherwise a key added by
 * gate A would always be an "unknown key" in the eyes of gate B.
 *   cucumberCwd / phaseCoverage — check-phase-coverage.ts
 *   docLinks                    — check-doc-links.ts
 *   gherkinDup                  — check-gherkin-dup.ts
 *   sync                        — sync-gates.sh (language selection)
 *   chain                       — check-all.ts
 *   unwired                     — sync-gates.sh (wiring check allowlist)
 *   nextGates                   — check-next-gates.ts
 *   skipDirs                    — skip-directory list shared by all scanners (S10, see SKIP_DIRS)
 *   docRot                      — check-doc-rot.ts (S7)
 *   knownDefects                — check-known-defects.ts (S8)
 *   phaseStatus                 — check-phase-status.ts (S15)
 *   moduleCast                  — check-module-cast.ts (1.6.0, P-88)
 *   dryRun                      — check-dry-run.ts (1.6.0, P-86): tags
 */
export const KNOWN_GATES_CONFIG_KEYS = [
  'cucumberCwd',
  'phaseCoverage',
  'docLinks',
  'gherkinDup',
  'sync',
  'chain',
  'unwired',
  'nextGates',
  'skipDirs',
  'docRot',
  'knownDefects',
  'phaseStatus',
  'moduleCast',
  'dryRun',
] as const;

/** Whether the top-level keys of `obj` include any that are not in `knownKeys`, usually a typo (something like `"chian"`).
 *  On a hit, print `✗ 設定檔有不認識的鍵:<key>(打錯字?)已知鍵:<list>`, print the marker, exit 1. */
export function requireKnownTopLevelKeys(
  obj: Record<string, unknown>,
  knownKeys: readonly string[],
  path: string,
  gateName: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!knownKeys.includes(key)) {
      failConfig(
        gateName,
        // 1.6.6 (P-94): the message must say which way to go when it is not a typo. It used to
        // say only "打錯字?", so when a consumer's worker wanted to add config for its own gate,
        // the first instinct was to hand-edit the template's `KNOWN_GATES_CONFIG_KEYS` (and leave
        // a HOTFIX). But the right way (ship your own config file) already has a precedent in the
        // template (`doc-rot.blacklist.json` of `check-doc-rot.ts`); it just **existed but was
        // not pointed out**. The difference is that the former depends on someone thinking of it,
        // the latter does not.
        `設定檔有不認識的鍵:${key}(打錯字?)已知鍵:${knownKeys.join(', ')}(${path})\n` +
          `  如果這不是打錯字、而是你自己的 gate 需要設定:**不要改模板的 KNOWN_GATES_CONFIG_KEYS**,` +
          `讓那支 gate 自帶一份設定檔(先例:check-doc-rot.ts 的 doc-rot.blacklist.json)。` +
          `gates.config.json 的頂層鍵是模板管的,加在這裡每次升版都會被討論一次。`,
      );
    }
  }
}

/**
 * Read one `gates.config.json` and do the two things S9 requires: fail loudly on a parse error
 * (`readConfigJson`), and fail loudly on an unknown top-level key (`requireKnownTopLevelKeys`).
 * If the file is not found, return `undefined` (`gates.config.json` is optional config for most
 * gates, so not finding it is not an error; the caller decides whether to treat it as "required
 * config absent"). The return value is deliberately `Record<string, unknown>` (not narrowed):
 * each gate picks the keys it wants and checks the type of that key itself with `requireConfigType`.
 */
export function loadGatesConfig(path: string | undefined, gateName: string): Record<string, unknown> | undefined {
  if (!path) return undefined;
  const raw = readConfigJson(path, gateName);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    failConfig(gateName, `設定檔壞掉:${path}: 頂層必須是物件`);
  }
  const obj = raw as Record<string, unknown>;
  requireKnownTopLevelKeys(obj, KNOWN_GATES_CONFIG_KEYS, path, gateName);
  return obj;
}

/**
 * The skip-directory list shared by every gate that scans a directory tree (S10, source AI_KM).
 *
 * Background: `SKIP_DIRS` in `check-boundaries.ts` originally had no `.next`, so a consumer using
 * Next.js got 511 noise violations (the `.next` build output of every sub-project under apps was
 * scanned as source code). If each scanner keeps its own skip list, missing the build output
 * directory name of one new framework makes the same incident happen again in another gate.
 *
 * Moved here as the single list. **Every gate that walks a directory tree must import this
 * constant** and must not declare its own `SKIP_DIRS` (a test enforces this; see the grep test
 * in check-boundaries.test.ts).
 *
 * `skipDirs` (a string array) in `gates.config.json` is **appended** after the default list, not
 * a replacement. A project with its own build output directory names does not have to change any
 * gate itself. It deliberately does not read `.gitignore`: the rules in that file (globs,
 * negation patterns) are far more complex than needed here, and what `.gitignore` excludes is not
 * necessarily "not source code". The two mean different things, and forcing one onto the other
 * makes both inaccurate.
 */
export const DEFAULT_SKIP_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  '.claude/worktrees',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'dist',
  'build',
  'out',
  'coverage',
  '.turbo',
  '.cache',
  'target',
  '.stryker-tmp',   // The mutation-testing sandbox is a **copy of the whole repo**; any scanner that walks the file tree and steps into it
                    // would count its own fixtures and the whole template of old worktrees as real hits, and `scanned=N`
                    // would jump with "whether a sandbox happens to be on disk at that moment", breaking the yardstick too (1.6.2, P-90)
  '__pycache__',
  '.venv',
  'venv',
  'reports',
];

/** `DEFAULT_SKIP_DIRS` + `skipDirs` of `gates.config.json` (appended, de-duplicated).
 *  `gatesConfig` is usually the return value of `loadGatesConfig(...)`; with no config file or no
 *  `skipDirs`, only the built-in defaults are used. If `skipDirs` exists but is not an array ->
 *  fail loudly with `requireConfigType` (consistent with the other known-key type errors, not
 *  silently ignored). */
export function resolveSkipDirs(gatesConfig: Record<string, unknown> | undefined, gateName: string): Set<string> {
  const extra = gatesConfig?.skipDirs;
  if (extra === undefined) return new Set(DEFAULT_SKIP_DIRS);
  requireConfigType(extra, 'skipDirs', 'array', gateName);
  const extraStrings = (extra as unknown[]).filter((s): s is string => typeof s === 'string');
  // A glob is a hard error, not silently ignored (1.6.3, P-91): this set is matched **verbatim**, so something like `learning-*`
  // excludes not a single directory, and does not report an error either. The consumer would think the problem was solved and stop chasing it.
  // The worst kind of the "return value looks like a receipt" family. A typo and an unsupported glob look exactly the same, so we prefer to fail loudly.
  const globbed = extraStrings.filter((d) => /[*?[\]]/.test(d));
  if (globbed.length > 0) {
    failConfig(
      gateName,
      `設定檔鍵 skipDirs 不支援 glob,請逐字列出目錄名:${globbed.join(', ')}` +
        `(這個集合是逐字比對的,含萬用字元的項目一個目錄都排除不到)`,
    );
  }
  return new Set([...DEFAULT_SKIP_DIRS, ...extraStrings]);
}

/**
 * Exclusion of a whole multi-level prefix such as `.claude/worktrees/<name>`. The
 * `.claude/worktrees` entry in `DEFAULT_SKIP_DIRS` is written as a "path fragment". A scanner
 * that just skips a whole subtree when "the directory name equals this string" (for example
 * `walk()` in `check-boundaries.ts`) cannot use it to skip anything other than `.claude/worktrees`
 * itself, because `.claude` and `worktrees` are two levels, and no single level has a directory
 * name equal to the string `.claude/worktrees` with a slash in it. This function splits the
 * `skipDirs` set into two groups: "single-level directory names" (compared level by level, for
 * example `node_modules`) and "multi-level path prefixes" (for example `.claude/worktrees`), for
 * scanners that must match a relative path prefix exactly (`check-doc-links.ts` uses the logic
 * "path prefix relative to ROOT", not level-by-level directory names).
 */
export function splitSkipDirs(skipDirs: Set<string>): { segments: Set<string>; prefixes: string[] } {
  const segments = new Set<string>();
  const prefixes: string[] = [];
  for (const entry of skipDirs) {
    if (entry.includes('/')) prefixes.push(entry);
    else segments.add(entry);
  }
  return { segments, prefixes };
}

/**
 * Whether the Phase table of `features/<folder>/FEATURE.md` (the only source of status) has a row
 * for `phaseNum` (`phaseRowExists` in `check-next-gates.ts` is not exported; this is the shared
 * version of the same logic. See S8: the `fix_in` reference in `check-known-defects.ts` must
 * verify that the phase table row really exists, without inventing a new parser). Returns `false`
 * if the file does not exist or the row is not found.
 */
export function featurePhaseRowExists(root: string, folder: string, phaseNum: string): boolean {
  const featurePath = join(root, 'features', folder, 'FEATURE.md');
  if (!existsSync(featurePath)) return false;
  const content = readFileSync(featurePath, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells[1] === phaseNum) return true;
  }
  return false;
}

/** Whether `docs/02-decision-map.md` has a heading `## ADR-<id> · ...`. */
export function adrExists(root: string, id: string): boolean {
  const p = join(root, 'docs', '02-decision-map.md');
  if (!existsSync(p)) return false;
  const content = readFileSync(p, 'utf8');
  return new RegExp(`^##\\s+ADR-${id}\\s*·`, 'm').test(content);
}

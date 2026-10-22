/**
 * Boundary check (see docs/02-decision-map.md ADR-004 / ADR-014).
 *
 * Rule: the code of each feature may only import
 *   1. its own landing zone (see the owners table in `scripts/boundaries.owners.json`)
 *   2. contracts/ and packages/contracts/ (the owner named by contractsOwner in owners.json)
 *   3. node built-in modules and node_modules
 *   4. the exception edges listed in scripts/boundaries.allow.json (added one by one after integration, each with a reason)
 *
 * **The landing-zone table, the glue set, the alias map and the scan scope are not hard-coded in this program.** It reads
 * `scripts/boundaries.owners.json` (under ROOT, not the one inside the template). This is the project's own config,
 * and like `boundaries.allow.json` it is not overwritten by `sync-gates.sh`. The program (this .ts) and the config
 * (owners.json) are kept apart, so upgrading the template version does not wipe the landing-zone table the project filled in. Format:
 *
 *   {
 *     "owners": [["packages/contracts/", "contracts"], ...],   // order matters; longer prefixes are matched first
 *     "glue": ["infra", "steps", { "owner": "generated", "role": "glue" }],
 *     "aliases": [["@contracts/", "packages/contracts/src/"], ...],
 *     "scanDirs": ["packages", "apps", "scripts"],
 *     "contractsOwner": "contracts"                             // imports that resolve to this owner are always allowed
 *   }
 *
 * Each item of the `glue` array is either a string (an owner name; this owner may import anything and
 * is not checked as a source; old format, behavior unchanged), or `{ owner, role: "glue" }` (CHANGELOG 1.4.0):
 * besides "not checked as a source", it also gets a rule "must not be an import target": any import of a file
 * under this owner is a violation (the reason printed says glue must not be imported). Used when "this folder is an artifact /
 * only reads and writes itself, and no feature should depend on it".
 *
 * If `owners.json` is not found, or is found but `owners` is an empty array, both count as "not configured": exit 1
 * and print one actionable message ("draft it from the owner column of each features folder's FEATURE.md") plus the example above.
 * It is not "runs fine when left empty" and not "empty = PASS": a gate that claims "no violations" when it has no landing-zone table
 * to compare against is more dangerous than no gate, because someone seeing a green light assumes the boundaries were really checked.
 *
 * Usage (the repo root is resolved from `git rev-parse --show-toplevel`, falling back to cwd if not in a git repo;
 * an explicit `--root <dir>` takes priority):
 *   npx tsx scripts/check-boundaries.ts                        # run after copying into the repo
 *   npx tsx <template>/scripts/check-boundaries.ts             # run directly from the template path; cwd must be in the target repo
 *   npx tsx scripts/check-boundaries.ts --verbose               # also print the owner of every file
 *   npx tsx scripts/check-boundaries.ts --root <dir>            # give the root dir explicitly (for tests / comparison)
 *
 * Exit code: 0 no violations; 1 violations, files outside any landing zone, or **not a single file scanned** (see below).
 *
 * "Scanning 0 files is always FAIL" is deliberate: a typo in the landing-zone table, one extra SKIP_DIRS entry,
 * or one missing extension makes the scanner go blind quietly, and the next person sees a green light and thinks the repo is clean.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  ROOT as GIT_ROOT,
  loadGatesConfig,
  lookupConfig,
  readConfigJson,
  requireConfigType,
  requireRootDir,
  resolveSkipDirs,
} from './_root.js';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROOT_EXPLICIT = argValue('--root') !== undefined;
const ROOT = resolve(argValue('--root') ?? GIT_ROOT);
const VERBOSE = process.argv.includes('--verbose');

/** The one sentence shared by the three scanners. Seeing it means the direction is "the scanner is broken", not "the code is clean". */
const SCANNER_BROKEN = '這不是很乾淨,是掃描器壞了';

/** The name of this script in the gate's machine-readable marker (see CHANGELOG 1.3.2 (C)). */
const GATE_NAME = 'boundaries';

requireRootDir(ROOT, ROOT_EXPLICIT, GATE_NAME);

/**
 * Find a config file (`boundaries.owners.json` / `boundaries.allow.json`). Delegates to `lookupConfig` in `_root.ts`
 * (S14, source AI_KM 2026-09-05, PITFALLS P-73): whether `--root` is given explicitly
 * decides whether falling back to the directory this script lives in is allowed (that is usually the template's own placeholder config; when `--root` is explicit,
 * falling back there is the P-73 incident itself). Each call prints one line "<name>: config: ..." (when nothing is found it prints
 * "config: none, using defaults"), so whoever reads the log sees on the first line which config was read this time, and does not have to wait for scan results
 * to look wrong before suspecting the config file.
 */
function findConfigFile(name: string): { path: string | undefined; hardErrorMessage: string | undefined; triedPaths: string[] } {
  const result = lookupConfig(import.meta.dirname, name, { root: ROOT, rootExplicit: ROOT_EXPLICIT });
  console.log(`${name}: ${result.source}`);
  return { path: result.path, hardErrorMessage: result.hardErrorMessage, triedPaths: result.triedPaths };
}

/**
 * A `glue` item is either a plain string (an owner name, old format, behavior unchanged: this owner may
 * import anything and is not checked as a source), or `{ owner, role: "glue" }` (CHANGELOG 1.4.0):
 * besides "not checked as a source", **it also gets a rule "must not be an import target"**: any import of a file under
 * this owner is a violation, and the reason printed says glue must not be imported. Used when "this folder is an
 * artifact / may only be read and written by itself, and no feature should depend on it" (e.g. a throwaway scratch area left by generation).
 */
type GlueEntry = string | { owner: string; role: 'glue' };

function glueOwnerName(e: GlueEntry): string {
  return typeof e === 'string' ? e : e.owner;
}

function isGlueTargetForbidden(e: GlueEntry): boolean {
  return typeof e !== 'string' && e.role === 'glue';
}

interface OwnersConfig {
  /** Landing zone → the feature that owns it. Order matters: longer prefixes are matched first. */
  owners: [prefix: string, owner: string][];
  /** These owners are "glue": they may import anything and are not checked as a source; see GlueEntry. */
  glue: GlueEntry[];
  /** import alias → the repo-relative path prefix it maps to. */
  aliases: [alias: string, target: string][];
  /** Root directories to scan (relative to ROOT). */
  scanDirs: string[];
  /** Imports that resolve to this owner are always allowed (not counted as crossing a boundary), usually contracts. */
  contractsOwner: string;
  /** S11 (source nightmare-assault): baseline for the coverage ratchet, optional. When present, the
   *  "managed/scanned" ratio of this run must be >= the ratio recorded here, or the run fails (may only go up, never down). */
  coverageBaseline?: { managed: number; scanned: number };
}

const OWNERS_JSON_PATH = 'scripts/boundaries.owners.json';

const OWNERS_EXAMPLE = `{
  "owners": [
    ["packages/contracts/", "contracts"],
    ["contracts/", "contracts"],
    ["packages/core/src/todo/", "01-todo"],
    ["features/steps/", "steps"]
  ],
  "glue": ["infra", "steps", { "owner": "generated", "role": "glue" }],
  "aliases": [
    ["@contracts/", "packages/contracts/src/"],
    ["@core/", "packages/core/src/"]
  ],
  "scanDirs": ["packages", "apps", "scripts"],
  "contractsOwner": "contracts"
}`;

/** Print a config error, print the gate marker (0 targets), exit 1. Every kind of broken config must take this path;
 *  it must not be an uncaught exception that aborts without printing the marker line (the old bug: see this script's 1.4.0 reverse verification). */
function configError(msg: string): never {
  console.error(`✗ ${msg}`);
  console.log(`gate=${GATE_NAME} result=FAIL scanned=0`);
  process.exit(1);
}

/** owners.json not found, or found but the landing-zone table is empty: both mean "not configured yet", not two different ailments,
 *  so they share one actionable message (consumer feedback: just saying "config file not found" is not enough, it must say what to do next). */
function ownersNotConfigured(pathDisplay: string): never {
  console.error(
    `✗ 尚未設定:找不到 ${pathDisplay} 或落點表是空的;從 features/*/FEATURE.md 的 owner 欄起草,` +
      '範例見 template/scripts/boundaries.owners.json',
  );
  console.error(OWNERS_EXAMPLE);
  console.log(`gate=${GATE_NAME} result=FAIL scanned=0`);
  process.exit(1);
}

function loadOwnersConfig(): OwnersConfig {
  const found = findConfigFile('boundaries.owners.json');
  if (found.hardErrorMessage) configError(found.hardErrorMessage);
  const p = found.path;
  if (!p) ownersNotConfigured(found.triedPaths.join('、'));
  // A parse error (broken JSON) fails loudly here (S9), not as an uncaught stack trace.
  const raw = readConfigJson(p, GATE_NAME) as Partial<OwnersConfig>;
  if (!Array.isArray(raw.owners) || raw.owners.length === 0) ownersNotConfigured(p);
  if (!Array.isArray(raw.glue)) configError(`${OWNERS_JSON_PATH} 缺 "glue"(陣列,可以是空的)`);
  for (const g of raw.glue) {
    const isPlainString = typeof g === 'string';
    const isRoleObject =
      !isPlainString && g !== null && typeof g === 'object' &&
      typeof (g as { owner?: unknown }).owner === 'string' &&
      (g as { role?: unknown }).role === 'glue';
    if (!isPlainString && !isRoleObject) {
      configError(
        `${OWNERS_JSON_PATH} 的 "glue" 每一項要嘛是字串(擁有者名稱),要嘛是 { "owner": "...", "role": "glue" };實際:${JSON.stringify(g)}`,
      );
    }
  }
  if (!Array.isArray(raw.aliases)) configError(`${OWNERS_JSON_PATH} 缺 "aliases"(陣列,可以是空的)`);
  if (!Array.isArray(raw.scanDirs) || raw.scanDirs.length === 0) {
    configError(`${OWNERS_JSON_PATH} 的 "scanDirs" 必須是非空陣列`);
  }
  if (!raw.contractsOwner || typeof raw.contractsOwner !== 'string') {
    configError(`${OWNERS_JSON_PATH} 缺 "contractsOwner"(字串)`);
  }
  // S11: coverageBaseline is optional; if present, validate its shape. A broken baseline is more dangerous than none (the ratchet
  // comparison would compare against an unreasonable number; same S9 principle of "broken config fails loudly").
  if (raw.coverageBaseline !== undefined) {
    const cb = raw.coverageBaseline as unknown;
    if (cb === null || typeof cb !== 'object' || Array.isArray(cb)) {
      configError(`${OWNERS_JSON_PATH} 的 "coverageBaseline" 必須是物件 { "managed": N, "scanned": M }`);
    }
    const obj = cb as Record<string, unknown>;
    requireConfigType(obj.managed, 'coverageBaseline.managed', 'number', GATE_NAME);
    requireConfigType(obj.scanned, 'coverageBaseline.scanned', 'number', GATE_NAME);
    const managed = obj.managed as number;
    const scannedBaseline = obj.scanned as number;
    if (!Number.isInteger(managed) || managed < 0) {
      configError(`${OWNERS_JSON_PATH} 的 "coverageBaseline.managed" 必須是非負整數(實際:${JSON.stringify(managed)})`);
    }
    if (!Number.isInteger(scannedBaseline) || scannedBaseline <= 0) {
      configError(`${OWNERS_JSON_PATH} 的 "coverageBaseline.scanned" 必須是正整數(實際:${JSON.stringify(scannedBaseline)})`);
    }
    if (managed > scannedBaseline) {
      configError(`${OWNERS_JSON_PATH} 的 "coverageBaseline" 不合理:managed(${managed}) > scanned(${scannedBaseline})`);
    }
  }
  return raw as OwnersConfig;
}

/** File extensions to scan. This rarely needs to vary per project, so it stays in the code. */
const EXTS = ['.ts', '.mts', '.js', '.mjs', '.svelte'];

/**
 * Directories to skip (S10, see `DEFAULT_SKIP_DIRS` in `_root.ts`). All gates that walk the directory tree share one
 * list + the `skipDirs` additions from `gates.config.json`; none may declare its own `SKIP_DIRS`
 * (a grep test in check-boundaries.test.ts enforces this: no `check-*.ts` may define
 * another array/set that looks like a standalone skip list). `src-tauri` is an extra entry this script originally added, not in the generic
 * `DEFAULT_SKIP_DIRS` list (it is a Tauri-specific directory name, not used by every project) —
 * it is added on top and does not affect the shared list itself. If gates.config.json cannot be read, that just means "there is no such optional config";
 * only the built-in defaults are used and no message is printed (same rule as the other optional configs).
 */
function resolveSkipDirsForBoundaries(): Set<string> {
  // gates.config.json is optional config (see the same remark in loadAllow below): when `--root` is explicit, not finding it just means
  // "there is no such optional config", and is not escalated to the loud failure of hardErrorMessage — that message is reserved for
  // required config such as owners.json.
  const cfgPath = findConfigFile('gates.config.json').path;
  const cfg = loadGatesConfig(cfgPath, GATE_NAME);
  const skip = resolveSkipDirs(cfg, GATE_NAME);
  skip.add('src-tauri');
  return skip;
}

interface AllowEdge { from: string; to: string; reason: string }
interface Violation { file: string; line: number; spec: string; from: string; to: string; kind: 'cross' | 'absolute' | 'unmapped-target' | 'glue-target' }

function loadAllow(): AllowEdge[] {
  const p = findConfigFile('boundaries.allow.json').path;
  if (!p) return []; // optional config: if neither place has it, treat it as no exception edges and print nothing (hardErrorMessage is ignored)
  // A parse error fails loudly here (S9), not as an uncaught stack trace.
  const raw = readConfigJson(p, GATE_NAME) as unknown;
  if (!Array.isArray(raw)) configError('boundaries.allow.json 必須是陣列');
  for (const e of raw as AllowEdge[]) {
    if (!e.from || !e.to || !e.reason) configError(`boundaries.allow.json 每一筆都要有 from / to / reason:${JSON.stringify(e)}`);
  }
  return raw as AllowEdge[];
}

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

function ownerOf(owners: OwnersConfig['owners'], relPath: string): string | undefined {
  const posix = toPosix(relPath);
  for (const [prefix, owner] of owners) {
    if (posix === prefix || posix.startsWith(prefix)) return owner;
  }
  return undefined;
}

function* walk(dir: string, skipDirs: Set<string>): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full, skipDirs);
    else if (EXTS.some((e) => name.endsWith(e))) yield full;
  }
}

/** Strip comments, so a "from '...'" inside a comment is not misread */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (_m, pre: string) => pre);
}

const IMPORT_RES: RegExp[] = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function findImports(src: string): { spec: string; line: number }[] {
  const out: { spec: string; line: number }[] = [];
  const clean = stripComments(src);
  for (const re of IMPORT_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) {
      const spec = m[1]!;
      const line = clean.slice(0, m.index).split('\n').length;
      if (!out.some((o) => o.spec === spec && o.line === line)) out.push({ spec, line });
    }
  }
  return out;
}

/**
 * Turn an import specifier into a repo-relative path. Returns undefined for external packages or built-in modules (not checked).
 */
function resolveSpec(
  aliases: OwnersConfig['aliases'],
  fromFile: string,
  spec: string,
): { rel: string } | { external: true } | { absolute: true } {
  if (spec.startsWith('node:')) return { external: true };
  if (spec.startsWith('/')) return { absolute: true };
  if (spec.startsWith('.')) {
    return { rel: toPosix(relative(ROOT, resolve(dirname(fromFile), spec))) };
  }
  for (const [alias, target] of aliases) {
    if (alias.endsWith('/') && spec.startsWith(alias)) return { rel: target + spec.slice(alias.length) };
    if (!alias.endsWith('/') && spec === alias) return { rel: target };
  }
  return { external: true };
}

/**
 * S11 (source nightmare-assault): assign an unmapped file to "the first-level subdirectory relative to the scan root"
 * — e.g. `scanDirs` has `"packages"` and the file is `packages/newthing/x.ts`, it goes to
 * `packages/newthing` (not the whole `packages`, which would not show which subfolder was left out; and not the full
 * file path, which would not show whether "a whole directory is unmanaged" or "just one file was missed"). In theory it never
 * reaches the fallback (an unmapped file always comes from walking under some scanDir); this is defensive code.
 */
function topLevelUnmanagedDir(relPath: string, scanDirs: string[]): string {
  const posix = toPosix(relPath);
  for (const dir of scanDirs) {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    if (posix === dir || posix.startsWith(prefix)) {
      const rest = posix.slice(prefix.length);
      const firstSeg = rest.split('/')[0];
      return firstSeg ? `${dir}/${firstSeg}` : dir;
    }
  }
  return posix.split('/')[0] ?? posix;
}

function formatRatio(managed: number, total: number): string {
  const pct = total > 0 ? ((managed / total) * 100).toFixed(1) : '0.0';
  return `${managed}/${total}(${pct}%)`;
}

/** S11: always print coverage, not only when there are unmapped files (PITFALLS P-72 — "looks green but is not watching
 *  that part": the landing-zone table was filled only halfway, the other half of the folders were never managed, and the old version never mentioned it). */
function printCoverage(managed: number, total: number, unmapped: string[], scanDirs: string[]): void {
  const pct = total > 0 ? ((managed / total) * 100).toFixed(1) : '0.0';
  console.log(`涵蓋:納管 ${managed} / 掃描 ${total} 檔(${pct}%),未納管目錄:`);
  if (unmapped.length === 0) {
    console.log('  (無)');
    return;
  }
  const byDir = new Map<string, number>();
  for (const u of unmapped) {
    const key = topLevelUnmanagedDir(u, scanDirs);
    byDir.set(key, (byDir.get(key) ?? 0) + 1);
  }
  for (const [dir, count] of [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${dir}(${count} 個檔案未納管)`);
  }
}

/** S11: coverage ratchet — when `owners.json` has `coverageBaseline`, this run's managed ratio must be >= the baseline,
 *  it may only go up, never down. Returns `true` if the ratchet itself fails (the caller must fold this into the overall exit code). */
function checkCoverageRatchet(
  managed: number,
  total: number,
  baseline: OwnersConfig['coverageBaseline'],
): boolean {
  if (!baseline) return false;
  // Compare by cross-multiplying, not floating-point division — so the ratchet is not stuck on floating-point error at the boundary (e.g. 1/3 vs 33/99).
  const nowCross = managed * baseline.scanned;
  const baseCross = baseline.managed * total;
  if (nowCross < baseCross) {
    console.log(
      `✗ 涵蓋率下降:${formatRatio(managed, total)} < 基準 ${formatRatio(baseline.managed, baseline.scanned)}(只准升)`,
    );
    return true;
  }
  if (nowCross > baseCross) {
    console.log(`○ 涵蓋率上升,可把基準改成 ${managed}/${total}`);
  }
  return false;
}

function main(): void {
  const config = loadOwnersConfig();
  const allow = loadAllow();
  const skipDirs = resolveSkipDirsForBoundaries();
  const glue = new Set(config.glue.map(glueOwnerName));
  const glueTargetForbidden = new Set(config.glue.filter(isGlueTargetForbidden).map(glueOwnerName));
  const violations: Violation[] = [];
  const unmapped: string[] = [];
  let scanned = 0;
  // found = number of source files walk() really found on disk; scanned = number that have a landing zone, are not glue, and really had their imports looked at.
  // When both are 0 the scanner is blind; it does not mean the repo is clean.
  let found = 0;

  for (const dir of config.scanDirs) {
    for (const file of walk(join(ROOT, dir), skipDirs)) {
      found++;
      const rel = toPosix(relative(ROOT, file));
      const from = ownerOf(config.owners, rel);
      if (!from) { unmapped.push(rel); continue; }
      if (VERBOSE) console.log(`  ${rel}  →  ${from}`);
      if (glue.has(from)) continue;
      scanned++;
      const src = readFileSync(file, 'utf8');
      for (const { spec, line } of findImports(src)) {
        const r = resolveSpec(config.aliases, file, spec);
        if ('external' in r) continue;
        if ('absolute' in r) { violations.push({ file: rel, line, spec, from, to: '(absolute)', kind: 'absolute' }); continue; }
        if (r.rel.startsWith('..')) { violations.push({ file: rel, line, spec, from, to: '(outside repo)', kind: 'absolute' }); continue; }
        const to = ownerOf(config.owners, r.rel);
        if (!to) { violations.push({ file: rel, line, spec, from, to: '(unmapped)', kind: 'unmapped-target' }); continue; }
        // glue's "must not be imported" has higher priority than contractsOwner's always-allow — an explicitly stated role setting
        // should win over the default leniency, or this rule would never take effect (`from` has already been excluded above,
        // so `to` here cannot equal `from` itself, and imports inside the glue owner itself are not hit by mistake).
        if (glueTargetForbidden.has(to)) { violations.push({ file: rel, line, spec, from, to, kind: 'glue-target' }); continue; }
        if (to === from || to === config.contractsOwner) continue;
        if (allow.some((e) => e.from === from && e.to === to)) continue;
        violations.push({ file: rel, line, spec, from, to, kind: 'cross' });
      }
    }
  }

  console.log(`boundaries: 掃描 ${scanned} 個檔案,允許例外 ${allow.length} 條`);

  // S11 (source nightmare-assault): always print coverage, not only when there are unmapped files — the old version "only when
  // checked==0 claimed it was not clean, and otherwise never mentioned how much was covered"; a landing-zone table that was **deliberately** filled only halfway
  // (e.g. only packages/ filled in, the whole apps/ folder never managed) looked exactly like "the table is fully filled" in the old version: a green light, PITFALLS P-72.
  const coverageManaged = found - unmapped.length;
  printCoverage(coverageManaged, found, unmapped, config.scanDirs);
  const ratchetFailed = checkCoverageRatchet(coverageManaged, found, config.coverageBaseline);

  if (unmapped.length) {
    console.log(`\n✗ ${unmapped.length} 個檔案不在任何功能的落點內(見 ${OWNERS_JSON_PATH} 的 owners 表):`);
    for (const u of unmapped) console.log(`  ${u}`);
  }
  if (violations.length) {
    console.log(`\n✗ ${violations.length} 個違規 import:`);
    for (const v of violations) {
      const why =
        v.kind === 'cross' ? `${v.from} → ${v.to}`
        : v.kind === 'absolute' ? '絕對路徑或跳出 repo'
        : v.kind === 'glue-target' ? `glue 不准被 import(${v.to})`
        : `目標 ${v.spec} 不在任何落點內`;
      console.log(`  ${v.file}:${v.line}  import '${v.spec}'  (${why})`);
    }
    console.log(`\nWave 0 只能 import contracts/ 與自己的目錄。整合後要跨功能,把邊加進 scripts/boundaries.allow.json 並附理由。`);
  }
  if (found === 0 || scanned === 0) {
    console.log(`\n✗ boundaries: 掃描到 0 個檔案(walk 找到 ${found} 個原始檔,實際檢查 ${scanned} 個)`);
    console.log(`${SCANNER_BROKEN}。owners.json 的 owners 表、scanDirs,或程式裡的 SKIP_DIRS / EXTS 壞掉時就長這樣。`);
    console.log(`gate=${GATE_NAME} result=FAIL scanned=${scanned}`);
    process.exit(1);
  }

  if (!unmapped.length && !violations.length && !ratchetFailed) console.log('✓ 無違規');
  const fail = unmapped.length > 0 || violations.length > 0 || ratchetFailed;
  console.log(`gate=${GATE_NAME} result=${fail ? 'FAIL' : 'PASS'} scanned=${scanned}`);
  process.exit(fail ? 1 : 0);
}

main();

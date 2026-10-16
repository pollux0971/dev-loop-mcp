/**
 * Standalone run check (see docs/02-decision-map.md ADR-005). Runs every non-interactive command in standalone.json
 * and requires the exit code to match what is expected and the output to contain the expect keyword.
 *
 * Temp directory cleanup is **config-driven**: each entry can optionally set `"cleanup": ["./tmp-learning", ...]`,
 * and the paths are cleaned once before and once after the run (rm -rf, no error if they do not exist). The code
 * itself hard-codes no directory name. The old version hard-coded `tmp-learning` / `tmp-output`, which stopped
 * working once a project used different temp directory names,
 * and it could also wipe an unrelated folder that happened to have the same name.
 *
 * **metadata fields (the `_doc` convention)**: the top level of the manifest may hold keys that start with an underscore
 * as descriptive metadata (for example `"_doc": "This manifest is for /phase-done, see FEATURE.md"`).
 * The value can be of any type and need not be an entry object. Such keys are always skipped: not counted in scanned and never run.
 * The old version had no such exemption and treated the string value of `_doc` as an entry object, so `entry.cmd` was `undefined`,
 * and reaching `spawnSync(entry.cmd, ...)` crashed with `ERR_INVALID_ARG_TYPE`. This was a real incident
 * reported by a consumer (AI_KM, commit d3e0b80). A key that **does not start with an underscore and whose value is not an object**
 * is not let through as metadata: it is usually a typo or a broken format, so it prints a "<key> is not an entry object" line and FAILs.
 * Do not skip silently here and disguise "the format is broken" as "everything passed".
 *
 * **`pending` semantics** (from nightmare-assault): an entry can optionally set
 * `"pending": "<NN-folder>/phase-N"`, meaning "this command is expected to be red right now, because it is still waiting
 * for that phase". Parse the Phase table of `features/<NN-folder>/FEATURE.md`, find the row for `phase-N`,
 * and look at its status:
 *   - Status is `done` -> the pending has expired. This entry **must** pass, and it FAILs as usual if it does not
 *     (the message says "pending has expired" outright, not an ordinary failure message. An expired pending deserves
 *     more attention than a normal failure: it means "a wait that should have been lifted has actually not been lifted").
 *   - Status is not `done` -> still runs, but does **not** turn the gate red; it only reports the actual exit code
 *     (a `○ ... pending (waiting for .../phase-N) actual exit=N` line), which is good for observing but does not block the merge.
 *   - `features/<NN-folder>/FEATURE.md` does not exist, or the `phase-N` row cannot be found in it
 *     -> this is a problem in the config itself (a typo in the reference), so FAIL; do not let it through as "not done yet".
 * A pending entry still counts toward `scanned=N`.
 *
 * Usage (the repo root is resolved from `git rev-parse --show-toplevel`, falling back to cwd outside a git repo):
 *   npx tsx scripts/check-standalone.ts                 # run after copying into the repo, all non-interactive
 *   npx tsx <template>/scripts/check-standalone.ts      # run straight from the template path; cwd must be in the target repo
 *   npx tsx scripts/check-standalone.ts --only <key>
 *   npx tsx scripts/check-standalone.ts --list          # list only, do not run
 *   npx tsx scripts/check-standalone.ts --timeout 60000 # per-command limit in milliseconds (default 120000)
 *   npx tsx scripts/check-standalone.ts --manifest <path> # read a different manifest (a fixture for tests)
 *
 * Exit codes: 0 all passed; 1 any failure (including an expired pending, an invalid pending reference, a malformed entry),
 * or the manifest has **not one real entry** (metadata keys do not count as entries).
 * Interactive ones (dev server) are always skipped and confirmed by hand in /phase-done.
 *
 * "Reading 0 entries is always FAIL" is deliberate: when the manifest path is wrong, the file was emptied, or the format changed,
 * exit code 0 for "all passed" would be a lie. Nothing passed; nothing was read at all.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT as GIT_ROOT, readConfigJson, requireRootDir } from './_root.js';

/** The sentence shared by the three scanners. A red caused by 0 items always points to "the scanner is broken". */
const SCANNER_BROKEN = '這不是很乾淨,是掃描器壞了';

/** This script's name in the gate's machine-readable marker (see CHANGELOG 1.3.2 (C)). */
const GATE_NAME = 'standalone';

interface ManifestEntry {
  cmd: string;
  interactive: boolean;
  expect?: string;
  expectExit?: number;
  /** Relative paths (relative to ROOT) cleaned once before and once after the run. If not set, nothing is cleaned. */
  cleanup?: string[];
  /** See "pending semantics" in the file header: the format is `<NN-folder>/phase-N`. */
  pending?: string;
}

type Manifest = Record<string, unknown>;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROOT_EXPLICIT = arg('--root') !== undefined;
const ROOT = resolve(arg('--root') ?? GIT_ROOT);
requireRootDir(ROOT, ROOT_EXPLICIT, GATE_NAME);
const only = arg('--only');
const timeout = Number(arg('--timeout') ?? 120_000);
const listOnly = process.argv.includes('--list');
const manifestPath = resolve(ROOT, arg('--manifest') ?? join(ROOT, 'standalone.json'));

// A file that cannot be read, or one that is read but is not valid JSON, fails loudly here (S9): print
// the "config file broken: <path>: <message>" line + the gate marker + exit 1, not an uncaught stack trace.
const manifest = readConfigJson(manifestPath, GATE_NAME) as Manifest;
const rawEntries = Object.entries(manifest);

// _doc convention: a key that starts with an underscore is metadata; it is not treated as an entry and its shape is not even validated.
const metaEntries = rawEntries.filter(([name]) => name.startsWith('_'));
const candidateEntries = rawEntries.filter(([name]) => !name.startsWith('_'));

// A key that does not start with an underscore and whose value is not an object: the format is broken, so FAIL right away; do not let it through.
const malformed = candidateEntries.filter(
  ([, value]) => typeof value !== 'object' || value === null || Array.isArray(value),
);
if (malformed.length) {
  for (const [name] of malformed) console.error(`✗ ${name} 不是條目物件`);
  console.log(`gate=${GATE_NAME} result=FAIL scanned=0`);
  process.exit(1);
}

const all = candidateEntries as [string, ManifestEntry][];

console.log(
  `standalone: 從 ${manifestPath} 讀到 ${all.length} 個條目` +
    (metaEntries.length ? `(略過 ${metaEntries.length} 個 metadata 欄位:${metaEntries.map(([k]) => k).join(', ')})` : ''),
);

// 0 entries would give the same exit code 0 as "all passed", so block it here first. This check must come before the --only filter:
// "the manifest is empty" and "--only points at a name that does not exist" are two completely different reds.
if (all.length === 0) {
  console.error(`\n✗ 讀到 0 個條目`);
  console.error(`${SCANNER_BROKEN}。manifest 路徑指錯、檔案被清空、或格式改掉時就長這樣。`);
  console.log(`gate=${GATE_NAME} result=FAIL scanned=0`);
  process.exit(1);
}

const entries = all.filter(([name]) => !only || name === only);
if (!entries.length) {
  console.error(`${manifestPath} 裡沒有 ${only}`);
  console.log(`gate=${GATE_NAME} result=FAIL scanned=0`);
  process.exit(1);
}

function cleanUp(entry: ManifestEntry): void {
  for (const rel of entry.cleanup ?? []) {
    const abs = join(ROOT, rel);
    if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
  }
}

/** Known phase status values, see the Phase table in FEATURE.md (the only source of status). */
const PHASE_STATUSES = ['done', 'in-progress', 'ready', 'blocked', 'todo'] as const;

interface PendingResolution {
  status?: (typeof PHASE_STATUSES)[number];
  error?: string;
}

/**
 * Resolve a `pending: "<NN-folder>/phase-N"` reference: read `features/<NN-folder>/FEATURE.md`
 * and look for that row's status in the Phase table. A missing file or a missing row both count as an "invalid reference" and return an error;
 * the caller must judge this entry FAIL and must not quietly let it through as "not done yet".
 */
function resolvePendingStatus(root: string, ref: string): PendingResolution {
  const m = /^(.+)\/phase-(\d+)$/.exec(ref);
  if (!m) return { error: `pending 格式應為 "<NN-folder>/phase-N",實際 "${ref}"` };
  const [, folder, phaseNum] = m;
  const featurePath = join(root, 'features', folder!, 'FEATURE.md');
  if (!existsSync(featurePath)) return { error: `找不到 ${featurePath}` };
  const content = readFileSync(featurePath, 'utf8');
  let phaseColumn = -1;
  let statusColumn = -1;
  for (const line of content.split('\n')) {
    if (!line.trim().startsWith('|')) {
      phaseColumn = statusColumn = -1;
      continue;
    }
    const cells = line.split('|').map((c) => c.trim());
    const headerPhaseColumn = cells.findIndex((cell) => cell.toLowerCase() === 'phase');
    if (headerPhaseColumn >= 0) {
      // Locate by column name, so it works with old tables and with tables that add an "intent" column; a numeric row of another table must not be taken as a phase.
      phaseColumn = headerPhaseColumn;
      statusColumn = cells.findIndex((cell) => cell === '狀態' || cell.toLowerCase() === 'status');
      continue;
    }
    if (phaseColumn < 0 || cells[phaseColumn] !== phaseNum) continue;
    if (statusColumn < 0) return { error: `${featurePath} 的 Phase 表缺少狀態(Status)欄` };
    const statusCell = cells[statusColumn] ?? '';
    const status = PHASE_STATUSES.find((s) => statusCell.startsWith(s));
    if (status) return { status };
    return { error: `${featurePath} 的 phase-${phaseNum} 那一列狀態格式看不懂:"${statusCell}"` };
  }
  return { error: `${featurePath} 沒有 phase-${phaseNum} 的表格列` };
}

let failed = 0;
for (const [name, entry] of entries) {
  if (entry.interactive) {
    console.log(`⏭  ${name}  (interactive,跳過)  ${entry.cmd}`);
    continue;
  }
  if (listOnly) {
    console.log(
      `•  ${name}  ${entry.cmd}  expect=${entry.expect ?? '(none)'}` +
        `${entry.cleanup ? `  cleanup=${entry.cleanup.join(',')}` : ''}` +
        `${entry.pending ? `  pending=${entry.pending}` : ''}`,
    );
    continue;
  }

  let pendingStatus: (typeof PHASE_STATUSES)[number] | undefined;
  if (entry.pending) {
    const resolved = resolvePendingStatus(ROOT, entry.pending);
    if (resolved.error) {
      failed++;
      console.log(`✗  ${name}  pending 參照無效(${entry.pending}):${resolved.error}`);
      continue;
    }
    pendingStatus = resolved.status;
  }

  cleanUp(entry); // Clean before the run, to make sure the run starts clean

  const t0 = Date.now();
  const r = spawnSync(entry.cmd, { cwd: ROOT, shell: true, encoding: 'utf8', timeout, env: process.env });
  const ms = Date.now() - t0;
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const timedOut = r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const wantExit = entry.expectExit ?? 0;
  const exitOk = r.status === wantExit && !timedOut;
  const expectOk = !entry.expect || output.includes(entry.expect);
  const passed = exitOk && expectOk;

  cleanUp(entry); // Clean after the run too, so no dirty state spills over into the next run or the next entry

  const why = timedOut
    ? `逾時 ${timeout} ms`
    : !exitOk
      ? `退出碼 ${r.status ?? r.signal},預期 ${wantExit}`
      : `輸出不含 "${entry.expect}"`;
  const tail = output.trim().split('\n').slice(-20).join('\n   | ');

  if (entry.pending && pendingStatus !== 'done') {
    // A pending that is still waiting: report the actual result but do not count it in failed. This is the "expected red" the design allows.
    console.log(`○  ${name}  pending(等 ${entry.pending})實際 exit=${r.status ?? r.signal ?? 'unknown'}(${ms} ms)`);
    continue;
  }

  if (passed) {
    console.log(entry.pending ? `✓  ${name}  (${ms} ms)  [pending ${entry.pending} 已 done,視為一般項目]` : `✓  ${name}  (${ms} ms)`);
  } else {
    failed++;
    if (entry.pending) {
      console.log(`✗  ${name}  pending 已過期(${entry.pending} 已 done)仍然紅:${why}\n   $ ${entry.cmd}`);
    } else {
      console.log(`✗  ${name}  ${why}\n   $ ${entry.cmd}`);
    }
    if (tail) console.log(`   | ${tail}`);
  }
}

if (!listOnly) console.log(failed ? `\n${failed} 個失敗` : '\n全部通過');
console.log(`gate=${GATE_NAME} result=${failed ? 'FAIL' : 'PASS'} scanned=${entries.length}`);
process.exit(failed ? 1 : 0);

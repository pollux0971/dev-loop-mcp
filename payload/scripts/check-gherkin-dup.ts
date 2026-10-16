/**
 * Scenario duplicate check (see docs/03-agile-workflow.md "contract before parallel, spec before code").
 *
 * It catches "a scenario copy-pasted into another file (or the same file) with the name changed
 * but the step body word-for-word identical". Such a duplicate usually means: it should be merged
 * with a Scenario Outline, it should share one Background, or the spec was copied by accident
 * instead of being redesigned. It counts whenever the step bodies are the same, whether or not
 * the name was changed.
 *
 * Rules:
 *   1. Scan features/**\/*.feature and docs/integration/**\/*.feature (duplicates within one file and across files both count)
 *   2. A scenario's "body" = all step lines after the Scenario / Scenario Outline name line,
 *      up to the next Scenario / Scenario Outline / Examples keyword,
 *      each line trimmed and joined with newlines
 *   3. Two or more scenarios with word-for-word identical bodies (scenario names are ignored) -> list the file:line pairs, exit 1
 *   4. **allowlist** (CHANGELOG 1.3.2 (2)): `gherkinDup.allow` in `gates.config.json` can
 *      list duplicate groups that are allowed on purpose, in the form `{ scenario, onlyUnder?, reason }`.
 *      A duplicate group is not red only if it matches an allow entry, and three conditions must all hold:
 *      (a) the name of **every** scenario in the group equals `scenario`
 *      (scenarios with different names are not one deliberate duplicate group, even if their step
 *      bodies are word-for-word identical); (b) when `onlyUnder` is given, the file path of every
 *      scenario in the group must start with it (relative to ROOT, e.g. `docs/integration/`);
 *      (c) `reason` is a non-empty string. All three hold -> print a `○` line with the scenario and the reason (the "allowed" notice)
 *      and do not count it as a failure; `reason` empty or missing -> that allow entry is **invalid**,
 *      a warning is printed when it matches, and the group is still judged red as usual
 *      (a badly written allow entry must not quietly let a real duplicate group through). Example:
 *      ```json
 *      { "gherkinDup": { "allow": [
 *        { "scenario": "Every standalone entry point still runs",
 *          "onlyUnder": "docs/integration/",
 *          "reason": "Each integration point reruns the standalone regression on its own (ADR-024)" }
 *      ] } }
 *      ```
 *      The config lookup order is in `resolveConfig` in `_root.ts`: first the directory this script
 *      lives in, then `ROOT/scripts/`; if that file does not exist there are no allow entries, and all duplicates are judged red as usual.
 *
 * Usage (the repo root is resolved from `git rev-parse --show-toplevel`, falling back to cwd outside a git repo):
 *   npx tsx scripts/check-gherkin-dup.ts               # run after copying into the repo
 *   npx tsx <template>/scripts/check-gherkin-dup.ts    # run straight from the template path; cwd must be in the target repo
 *
 * Exit codes:
 *   0  no scenarios with word-for-word identical bodies (duplicate groups allowed by the allowlist do not count)
 *   1  there are duplicate scenarios (not allowed by the allowlist); or 0 .feature files / 0 scenarios were scanned
 *      (this is not "clean", the scanner is broken)
 *
 * Reverse check (restore after changing, leave no changes):
 *   (a) Pick an existing scenario (e.g. the "what happens when it runs alone" scenario in some feature's phase-1.feature),
 *       copy its whole step body, paste it below in the same file, and give it a new Scenario name.
 *       Run this script again -> it should be red, listing the file:line of those two scenarios.
 *   (b) Delete the copied scenario you just pasted and restore the file -> run again -> it should be green.
 *   (c) allowlist (do this in a fake repo, do not touch this worktree's own data): create two
 *       `docs/integration/*.feature` files, each with one scenario whose Scenario name and step body
 *       are word-for-word identical (e.g. "Every standalone entry point still runs") -> run again, it should be red.
 *       Add the example allow entry above to the fake repo's `scripts/gates.config.json` -> run again,
 *       it should be green and print the `○` "allowed" notice. Clear that allow entry's `reason` (or delete the entry and
 *       put back one without a reason) -> run again, it should be red and print the "allow entry invalid"
 *       warning. Move one of the feature files under `features/` (it no longer satisfies
 *       `onlyUnder: "docs/integration/"`) -> run again, it should be red
 *       (onlyUnder does not match, so the allow does not apply).
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, loadGatesConfig, requireConfigType, resolveConfig, resolveSkipDirs } from './_root.js';

/** This script's name in the gate's machine-readable marker (see CHANGELOG 1.3.2 (C)). */
const GATE_NAME = 'gherkin-dup';

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

// ---- allowlist (CHANGELOG 1.3.2 (2)) ----
//
// Some duplicates are deliberate: each integration point reruns the same standalone regression
// on its own (ADR-024), so the scenario name and step body are meant to be word-for-word
// identical, not a copy-paste mistake. These exceptions are written in `gherkinDup.allow` of
// `gates.config.json`, not by editing this script. Code (the rules) and config (which duplicates
// are allowed) are kept apart, so upgrading this script does not wipe the exception list a project filled in.

interface AllowEntry { scenario: string; onlyUnder?: string; reason: string }
interface InvalidAllowEntry { scenario: string; onlyUnder?: string }

/** Read `gherkinDup.allow` and split it into two batches: "valid" (reason non-empty) and "invalid" (reason empty or missing).
 *  An invalid entry does not take effect (its group is still judged red), but a warning must be printed when it matches; it must not be ignored quietly.
 *  An entry with no `scenario` field is ignored entirely (there is no basis to compare, so it is not "invalid", just broken data). */
function loadAllowEntries(): { valid: AllowEntry[]; invalid: InvalidAllowEntry[] } {
  const p = resolveConfig(import.meta.dirname, 'gates.config.json');
  // Parse errors and unknown top-level keys fail loudly here (S9). The old `try { JSON.parse(...) } catch
  // { return { valid: [], invalid: [] } }` quietly turned a broken gates.config.json into
  // "no allow entries at all"; the gate could still print PASS or FAIL, but the config was not applied at all.
  const raw = loadGatesConfig(p, GATE_NAME);
  if (!raw) return { valid: [], invalid: [] };
  if (raw.gherkinDup !== undefined) requireConfigType(raw.gherkinDup, 'gherkinDup', 'object', GATE_NAME);
  const list = (raw as { gherkinDup?: { allow?: unknown } }).gherkinDup?.allow;
  if (!Array.isArray(list)) return { valid: [], invalid: [] };
  const valid: AllowEntry[] = [];
  const invalid: InvalidAllowEntry[] = [];
  for (const entryRaw of list as { scenario?: unknown; onlyUnder?: unknown; reason?: unknown }[]) {
    const scenario = typeof entryRaw.scenario === 'string' ? entryRaw.scenario : undefined;
    if (!scenario) continue;
    const onlyUnder = typeof entryRaw.onlyUnder === 'string' ? entryRaw.onlyUnder : undefined;
    const reason = typeof entryRaw.reason === 'string' ? entryRaw.reason.trim() : '';
    if (reason) {
      valid.push({ scenario, ...(onlyUnder !== undefined ? { onlyUnder } : {}), reason });
    } else {
      invalid.push({ scenario, ...(onlyUnder !== undefined ? { onlyUnder } : {}) });
    }
  }
  return { valid, invalid };
}

/** Whether a duplicate group should use a given allow entry: the name of **every** scenario in the group must equal `entry.scenario`
 *  (not "at least one": scenarios with different names are not "the same deliberately duplicated scenario", even if their step bodies are word-for-word identical);
 *  when `onlyUnder` is given, the file path of every scenario in the group must start with it. */
function groupMatchesAllow(group: Scenario[], scenario: string, onlyUnder: string | undefined): boolean {
  if (!group.every((s) => s.name === scenario)) return false;
  if (onlyUnder) {
    return group.every((s) => toPosix(relative(ROOT, s.file)).startsWith(onlyUnder));
  }
  return true;
}

/** S10: share the same skip list with the other gates that walk the directory tree (`DEFAULT_SKIP_DIRS` in `_root.ts`
 *  plus the `skipDirs` additions in `gates.config.json`); do not write a separate copy in this script. */
function resolveSkipDirsForGherkinDup(): Set<string> {
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

function collectFeatureFiles(): string[] {
  const skipDirs = resolveSkipDirsForGherkinDup();
  return [...walk(join(ROOT, 'features'), skipDirs), ...walk(join(ROOT, 'docs/integration'), skipDirs)];
}

interface Scenario { file: string; line: number; name: string; body: string }

const SCENARIO_START_RE = /^\s*(Scenario|Scenario Outline)\s*:\s*(.*)$/;
const SECTION_BREAK_RE = /^\s*(Scenario|Scenario Outline|Examples)\s*:/;

function extractScenarios(file: string): Scenario[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const out: Scenario[] = [];
  let current: { line: number; name: string; bodyLines: string[] } | undefined;

  const flush = () => {
    if (current) {
      out.push({ file, line: current.line, name: current.name, body: current.bodyLines.join('\n') });
      current = undefined;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const startMatch = line.match(SCENARIO_START_RE);
    if (startMatch) {
      flush();
      current = { line: i + 1, name: startMatch[2]!.trim(), bodyLines: [] };
      continue;
    }
    if (current) {
      const isBreak = SECTION_BREAK_RE.test(line);
      if (isBreak) {
        // The next Scenario is already handled by the branch above; here we only need to finish up when we meet Examples.
        flush();
        continue;
      }
      const trimmed = line.trim();
      if (trimmed) current.bodyLines.push(trimmed);
    }
  }
  flush();
  return out;
}

function main(): void {
  const files = collectFeatureFiles();
  if (files.length === 0) {
    console.log('✗ 掃到 0 個 .feature 檔(features/**/*.feature 或 docs/integration/**/*.feature)。這不是很乾淨,是掃描器壞了。');
    console.log(`gate=${GATE_NAME} result=FAIL scanned=0`);
    process.exit(1);
  }

  const scenarios: Scenario[] = [];
  for (const file of files) scenarios.push(...extractScenarios(file));

  if (scenarios.length === 0) {
    console.log('✗ 掃到 0 個場景(Scenario / Scenario Outline)。這不是很乾淨,是掃描器壞了。');
    console.log(`gate=${GATE_NAME} result=FAIL scanned=0`);
    process.exit(1);
  }

  const byBody = new Map<string, Scenario[]>();
  for (const s of scenarios) {
    if (!s.body) continue; // Do not compare empty bodies (e.g. a pure Background or a malformed one), to avoid false alarms
    const list = byBody.get(s.body) ?? [];
    list.push(s);
    byBody.set(s.body, list);
  }

  console.log(`gherkin-dup: 掃描 ${files.length} 個 .feature 檔,${scenarios.length} 個場景`);

  const { valid: allowValid, invalid: allowInvalid } = loadAllowEntries();
  const dupGroups = [...byBody.entries()].filter(([, list]) => list.length >= 2);

  const redGroups: [string, Scenario[]][] = [];
  const allowedNotices: string[] = [];
  const warnings: string[] = [];

  for (const entry of dupGroups) {
    const [, list] = entry;
    const matchedValid = allowValid.find((e) => groupMatchesAllow(list, e.scenario, e.onlyUnder));
    if (matchedValid) {
      allowedNotices.push(`○ 允許:${matchedValid.scenario}(${matchedValid.reason})`);
      continue;
    }
    const matchedInvalid = allowInvalid.find((e) => groupMatchesAllow(list, e.scenario, e.onlyUnder));
    if (matchedInvalid) {
      warnings.push(
        `⚠ allow 條目無效(reason 空或缺):"${matchedInvalid.scenario}"${matchedInvalid.onlyUnder ? ` (onlyUnder: ${matchedInvalid.onlyUnder})` : ''} 這條規則不生效,該組照常判紅`,
      );
    }
    redGroups.push(entry);
  }

  for (const w of warnings) console.log(w);
  for (const a of allowedNotices) console.log(a);

  if (redGroups.length) {
    console.log(`\n✗ ${redGroups.length} 組場景本體逐字相同:`);
    for (const [, list] of redGroups) {
      console.log('  ---');
      for (const s of list) {
        const rel = toPosix(relative(ROOT, s.file));
        console.log(`  ${rel}:${s.line}  Scenario: ${s.name}`);
      }
    }
    console.log(`gate=${GATE_NAME} result=FAIL scanned=${scenarios.length}`);
    process.exit(1);
  }

  console.log(dupGroups.length ? `✓ 無重複場景(${dupGroups.length} 組經 allowlist 允許)` : '✓ 無重複場景');
  console.log(`gate=${GATE_NAME} result=PASS scanned=${scenarios.length}`);
  process.exit(0);
}

main();

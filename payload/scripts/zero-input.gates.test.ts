/**
 * The template's own zero-input guard test (P-84, source: project A coordinator, 2026-09-05; PITFALLS' second
 * occurrence of "the template violates its own rule"; the first was P-83).
 *
 * Background: a consumer ran into `check-next-gates.ts --root /nonexistent` and
 * `check-phase-status.ts --root /nonexistent`. Both exit 1, but the output never mentions the
 * path passed in. Compared with the other gates that touch the config file first (`check-boundaries.ts`, `check-doc-rot.ts`
 * and the like, which go through `lookupConfig` in `_root.ts` with the S14 hard-error), they were missing the most important sentence.
 * The fix adds `requireRootDir()` / `rootDirError()` to `_root.ts`, and every gate that accepts `--root`
 * calls it before any config lookup.
 *
 * This test file itself is the lesson of that incident: fixing just two gates is not enough. There must be a zero-input test that
 * **covers all of the template's own gates**, so that when a new gate is added it is **structurally** impossible to miss this check. `listGateFiles()`
 * enumerates the directory (not a hand-copied list) to find every `check-*.ts` under `scripts/` (`check-all.ts` already
 * matches this pattern). A gate without a `--root` flag must say so in `NO_ROOT_FLAG` with a reason.
 * Neither → the test goes red, with the message "new guard is not in the zero-input list".
 *
 * ## Probe table (every gate that supports `--root` runs these three probes)
 *
 * | gate                  | (a) --root points to a missing dir  | (b) --root points to an empty dir                  | (c) config under --root is broken (malformed JSON)         |
 * |------------------------|-----------------------------------|----------------------------------------------------|-----------------------------------------------------------|
 * | check-all.ts           | ✗ --root points to a missing dir: <path> | config not found at .../gates.config.json  | config is broken: .../gates.config.json                   |
 * | check-boundaries.ts    | same as above                     | config not found at .../boundaries.owners.json     | first add a valid boundaries.owners.json, then break gates.config.json |
 * | check-next-gates.ts    | same as above                     | scanned 0 NEXT.md (0 targets, scanned=0)           | break gates.config.json                                    |
 * | check-phase-status.ts  | same as above                     | scanned 0 FEATURE.md (0 targets, scanned=0)       | break gates.config.json                                    |
 * | check-standalone.ts    | same as above                     | config is broken: .../standalone.json (ENOENT, see the exception notes) | break standalone.json itself (see the exception notes below) |
 *
 * Rules shared by all three probes: exit code 1, a machine-readable `gate=<name> result=FAIL
 * scanned=0` marker in the output, and no bare stack trace (the look of an uncaught Node exception such as `\n  at ...`, or
 * the words `TypeError`/`ReferenceError`).
 *
 * **Exceptions (different from the literal wording of the original requirement; the reasons are recorded here)**:
 *   - The original probe (c) says "malformed gates.config.json", but `check-known-defects.ts`
 *     and `check-standalone.ts` never read `gates.config.json` (each file header already says that the only
 *     required config file of each is `known-defects.json` / `standalone.json`). Breaking
 *     `gates.config.json` for them tests nothing (those two never read that file), and what it verifies would
 *     be the same as probe (b). Instead, break the only required config file of their own; it still verifies the same thing (S9:
 *     a broken config must fail loudly, print the file name, and not be an uncaught stack trace), just with the file that actually
 *     matters for these two scripts.
 *   - Probe (b) (empty dir) of `check-standalone.ts` directly triggers "config is broken"
 *     (`readConfigJson` throws ENOENT on the missing `standalone.json`, and the message itself
 *     carries the full path), not "0 targets" or "config not found". This script does not go through
 *     `lookupConfig` in `_root.ts` (it reads directly with `readConfigJson`, where broken and
 *     missing mean the same sentence). The three cases lead to the same place, and the same checks (exit 1, names the path,
 *     has the marker, no bare stack) apply equally, so no separate rule is opened for it.
 *
 * `check-gherkin-dup.ts` / `check-phase-coverage.ts` / `check-step-dup.ts` have no
 * `--root` flag at all (they always use the git top-level `ROOT` inferred by `_root.ts`); see the reasons in `NO_ROOT_FLAG`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeIsolatedTempDir } from './_root.js';

const SCRIPTS_DIR = import.meta.dirname;
const SPAWN_TIMEOUT_MS = 60_000;
const NEW_PROJECT_MESSAGE =
  '新專案剛完成初始化,目前沒有任何 features/NN-name 資料夾;這不是掃描器錯誤,下一步請依 README 建立第一個 features/01-xxx/';

/** Gates without a `--root` flag, together with "why not". Every entry needs a reason; it can't be just a list. */
const NO_ROOT_FLAG: Record<string, string> = {
  'check-gherkin-dup.ts':
    '沒有 --root 旗標;一律用 _root.ts 推定的 git 頂層 ROOT,不支援對別的 repo 跑(檔頭用法只列不帶 --root 的呼叫方式)。',
  'check-step-dup.ts':
    '沒有 --root 旗標;一律用 _root.ts 推定的 git 頂層 ROOT,腳本裡完全沒有 argv 解析 --root 的邏輯。',
};

/** `check-dag.ts` does not use the shared probe table of the existing gates below and gets its own describe. Not because its exit code semantics differ
 * (since 1.11.0 it behaves like the other scanners: zero input is always FAIL), but because it **does not read `gates.config.json`**, so probe (c)
 * (malformed config) naturally does not apply to it, and applying it would verify something fake. */
// v2: check-dag / check-skills-mirror were replaced by `dlm check dag` / `dlm check mirror` (zero dependencies, with a positive control).
const SPECIAL_ZERO_INPUT_GATE_FILES: string[] = [];

/** Every `check-*.ts` under `scripts/` (excluding `.test.ts`). It enumerates the directory, not a hand-copied list,
 *  so a newly added gate file is picked up here automatically. */
function listGateFiles(): string[] {
  return readdirSync(SCRIPTS_DIR)
    .filter((f) => /^check-.*\.ts$/.test(f) && !f.endsWith('.test.ts'))
    .sort();
}

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = makeIsolatedTempDir(prefix);
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeJson(root: string, relPath: string, data: unknown): void {
  const p = join(root, relPath);
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

function writeRaw(root: string, relPath: string, content: string): void {
  const p = join(root, relPath);
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

/** A string guaranteed to make `JSON.parse` blow up (a truncated object); it breaks the same way in any script's parser. */
const MALFORMED_JSON = '{ "broken":  ';

function run(gateFile: string, root: string): { code: number; output: string } {
  const scriptPath = join(SCRIPTS_DIR, gateFile);
  const r = spawnSync('npx', ['tsx', scriptPath, '--root', root], {
    // Probe (a) deliberately passes a nonexistent `root`. spawnSync's `cwd` cannot be a missing dir
    // (the child process itself would fail to start, with exit code -1, not the 1 the script decided on its own), and the two are
    // different things: `--root` is the target the script checks, `cwd` is just where the child process starts. If it exists, reuse
    // `root` (so any logic in the script that finds things by relative path behaves as if really installed in that dir); if not,
    // fall back to `SCRIPTS_DIR` (the template's own scripts/, which always exists).
    cwd: existsSync(root) ? root : SCRIPTS_DIR,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    // Same pitfall as check-boundaries.test.ts: without this, the "directory the script itself lives in" among the candidate paths
    // (the template's own scripts/) matches first and reads the template's own real config file, not the fixture built here.
    env: { ...process.env, GATES_CONFIG_DIR: join(root, 'scripts') },
  });
  return { code: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function assertNoBareStack(output: string): void {
  expect(output, `不該有裸露的堆疊:\n${output}`).not.toMatch(/\n\s*at\s+\S+:\d+:\d+/);
  expect(output, `不該有未捕捉例外的類名:\n${output}`).not.toMatch(
    /\b(TypeError|ReferenceError|SyntaxError: Unexpected|is not a function|Cannot read propert)/,
  );
}

function assertMarker(output: string, gate: string): void {
  expect(output).toContain(`gate=${gate} result=FAIL scanned=0`);
}

interface ProbeCase {
  /** Extra files to prepare first (so the script gets past the earlier required-config checks and reaches the stage actually under test). */
  setup?: (root: string) => void;
  /** Fragments that must all appear in the output. */
  includes: string[];
}

interface GateSpec {
  file: string;
  gate: string;
  probeB: ProbeCase;
  /** The file probe (c) breaks, relative to `root`. */
  probeC: ProbeCase & { relPath: string };
}

const BOUNDARIES_OWNERS_VALID = {
  owners: [['src/', 'core']],
  glue: [],
  aliases: [],
  scanDirs: ['src'],
  contractsOwner: 'core',
};

const GATE_SPECS: GateSpec[] = [
  {
    file: 'check-boundaries.ts',
    gate: 'boundaries',
    probeB: { includes: ['設定檔未找到', 'boundaries.owners.json'] },
    probeC: {
      relPath: 'scripts/gates.config.json',
      setup: (root) => writeJson(root, 'scripts/boundaries.owners.json', BOUNDARIES_OWNERS_VALID),
      includes: ['設定檔壞掉', 'gates.config.json'],
    },
  },
  {
    file: 'check-dry-run.ts',
    gate: 'dry-run',
    // Empty dir: gates.config.json is not found (optional, silent) → auto-detection finds no cucumber config → names the root dir it searched.
    probeB: { includes: ['找不到 cucumber 設定', 'gate=dry-run result=FAIL scanned=0'] },
    probeC: { relPath: 'scripts/gates.config.json', includes: ['設定檔壞掉', 'gates.config.json'] },
  },
  {
    file: 'check-module-cast.ts',
    gate: 'module-cast',
    probeB: { includes: ['掃到 0 個 .ts 檔', 'gate=module-cast result=FAIL scanned=0'] },
    probeC: { relPath: 'scripts/gates.config.json', includes: ['設定檔壞掉', 'gates.config.json'] },
  },
  {
    file: 'check-standalone.ts',
    gate: 'standalone',
    // See the exception notes in the file header: an empty dir directly triggers the ENOENT "config is broken", not "0 targets" or
    // "config not found". The message itself carries the full path just the same, so it counts as "named the path".
    probeB: { includes: ['設定檔壞掉', 'standalone.json'] },
    probeC: { relPath: 'standalone.json', includes: ['設定檔壞掉', 'standalone.json'] },
  },
];

describe('模板自己的零輸入清單:新增的 check-*.ts 一定要進這份清單(P-84)', () => {
  it('scripts/ 底下每一支 check-*.ts / check-all.ts 都在 GATE_SPECS 或 NO_ROOT_FLAG 裡', () => {
    const known = new Set([
      ...GATE_SPECS.map((s) => s.file),
      ...Object.keys(NO_ROOT_FLAG),
      ...SPECIAL_ZERO_INPUT_GATE_FILES,
    ]);
    const actual = listGateFiles();
    const missing = actual.filter((f) => !known.has(f));
    expect(missing, `新守門沒進零輸入清單:${missing.join(', ')}——把它加進這支測試的 GATE_SPECS、SPECIAL_ZERO_INPUT_GATE_FILES 或 NO_ROOT_FLAG(不支援,附理由)`).toEqual([]);
  });

  it('GATE_SPECS 跟 NO_ROOT_FLAG 沒有重疊,也沒有列出不存在的檔案', () => {
    const specFiles = new Set(GATE_SPECS.map((s) => s.file));
    const noRootFiles = Object.keys(NO_ROOT_FLAG);
    for (const f of noRootFiles) {
      expect(specFiles.has(f), `${f} 同時出現在 GATE_SPECS 跟 NO_ROOT_FLAG`).toBe(false);
      expect(existsSync(join(SCRIPTS_DIR, f)), `NO_ROOT_FLAG 列了不存在的檔案:${f}`).toBe(true);
    }
    for (const s of GATE_SPECS) {
      expect(existsSync(join(SCRIPTS_DIR, s.file)), `GATE_SPECS 列了不存在的檔案:${s.file}`).toBe(true);
    }
  });

  it('NO_ROOT_FLAG 裡的檔案真的沒有 --root 旗標(避免清單本身騙人)', () => {
    for (const file of Object.keys(NO_ROOT_FLAG)) {
      const src = readFileSync(join(SCRIPTS_DIR, file), 'utf8');
      expect(src.includes("'--root'"), `${file} 原始碼裡有 '--root' 字樣,看起來其實支援 --root,不該在 NO_ROOT_FLAG`).toBe(false);
    }
  });
});

describe.each(GATE_SPECS)('$file 的零輸入探針', ({ file, gate, probeB, probeC }) => {
  it('(a) --root 指到不存在的目錄:exit 1、名出那個路徑、印標記、沒有裸堆疊', () => {
    const missing = join(tmpdir(), `lc-zero-input-missing-${process.pid}-${Math.random().toString(36).slice(2)}`);
    expect(existsSync(missing)).toBe(false); // confirm this dir was really never created
    const { code, output } = run(file, missing);
    expect(code).toBe(1);
    expect(output).toContain('✗ --root 指到不存在的目錄:');
    expect(output).toContain(missing);
    assertMarker(output, gate);
    assertNoBareStack(output);
  });

  it('(b) --root 指到空目錄:exit 1、訊息名出路徑或講清楚 0 目標、印標記、沒有裸堆疊', () => {
    const root = makeTempDir('lc-zero-input-empty-');
    probeB.setup?.(root);
    const { code, output } = run(file, root);
    expect(code).toBe(1);
    for (const fragment of probeB.includes) expect(output).toContain(fragment);
    assertMarker(output, gate);
    assertNoBareStack(output);
  });

  it('(c) --root 底下的設定檔壞掉(malformed JSON):exit 1、名出那個檔案、印標記、沒有裸堆疊', () => {
    const root = makeTempDir('lc-zero-input-malformed-');
    probeC.setup?.(root);
    writeRaw(root, probeC.relPath, MALFORMED_JSON);
    const { code, output } = run(file, root);
    expect(code).toBe(1);
    for (const fragment of probeC.includes) expect(output).toContain(fragment);
    assertMarker(output, gate);
    assertNoBareStack(output);
  });
});

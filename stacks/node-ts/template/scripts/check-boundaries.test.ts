/**
 * Unit tests for scripts/check-boundaries.ts (template 1.4.0 S4: an empty landing-zone table must FAIL + glue role).
 *
 * `GATES_CONFIG_DIR` must be set to `<fixture>/scripts`: the first place check-boundaries.ts looks for config
 * is "the directory the script itself lives in", which for these tests is the template's own `scripts/` (the
 * `boundaries.owners.json` there is a real landing-zone table, not empty). Without the env var the tests would always read the template's
 * config and never see the fixture — this is a trap documented in the header of check-boundaries.ts itself.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeIsolatedTempDir } from './_root.js';

const CHECK_BOUNDARIES_TS = resolve(import.meta.dirname, 'check-boundaries.ts');
const ROOT_TS = resolve(import.meta.dirname, '_root.ts');
const SPAWN_TIMEOUT_MS = 60_000;
const SCANNER_BROKEN = '這不是很乾淨,是掃描器壞了';

const tmpDirs: string[] = [];

function makeFixture(): string {
  const dir = makeIsolatedTempDir('lc-boundaries-');
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  return dir;
}

function writeOwners(root: string, owners: unknown): void {
  writeFileSync(join(root, 'scripts', 'boundaries.owners.json'), JSON.stringify(owners, null, 2), 'utf8');
}

function writeAllow(root: string, allow: unknown): void {
  writeFileSync(join(root, 'scripts', 'boundaries.allow.json'), JSON.stringify(allow, null, 2), 'utf8');
}

function writeSrc(root: string, relPath: string, content: string): void {
  const p = join(root, relPath);
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

function run(root: string, ...extra: string[]): { code: number; output: string } {
  const r = spawnSync('npx', ['tsx', CHECK_BOUNDARIES_TS, '--root', root, ...extra], {
    cwd: root,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, GATES_CONFIG_DIR: join(root, 'scripts') },
  });
  return { code: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const BASE_OWNERS = {
  owners: [
    ['packages/a/', 'owner-a'],
    ['packages/b/', 'owner-b'],
    ['contracts/', 'contracts'],
  ],
  glue: [],
  aliases: [],
  scanDirs: ['packages'],
  contractsOwner: 'contracts',
};

describe('check-boundaries:空/缺 owners 表一律 FAIL(消費者回報)', () => {
  it('boundaries.owners.json 完全不存在,不帶 --root(一般已裝好之後正常執行的情境)→ exit 1,訊息是可執行的「尚未設定」', () => {
    const dir = makeFixture();
    // "Not exist at all" must really simulate the install directory after a sync (the directory the script lives in = the fixture's
    // scripts/, with no owners.json inside). Pointing --root at an empty directory is not enough — then "the directory the script
    // lives in" (config lookup priority 1) is still the template's real scripts/, which always has a real
    // owners.json that would override the scenario this test wants to simulate. So here check-boundaries.ts and the _root.ts it depends on
    // are copied into the fixture's scripts/ and the copy itself is run — without GATES_CONFIG_DIR and
    // without --root (after S14, with an explicit --root this scenario prints a new hard error message instead, see the
    // "S14" describe block below; what is verified here is the most common case: "after installing, the consumer runs
    // `npx tsx scripts/check-boundaries.ts` normally and has not filled in the landing-zone table yet"). cwd is set under the fixture
    // directory and the fixture is not a git repo, so `resolveRoot()` in _root.ts falls back to `process.cwd()`
    // itself, ROOT is therefore the fixture directory, and priorities 1 and 2 both point to the same directory with no owners.json.
    copyFileSync(CHECK_BOUNDARIES_TS, join(dir, 'scripts', 'check-boundaries.ts'));
    copyFileSync(ROOT_TS, join(dir, 'scripts', '_root.ts'));

    const r = spawnSync('npx', ['tsx', join(dir, 'scripts', 'check-boundaries.ts')], {
      cwd: dir,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });
    const code = r.status ?? -1;
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;

    expect(code).toBe(1);
    expect(output).toContain('✗ 尚未設定:找不到');
    expect(output).toContain('或落點表是空的');
    expect(output).toContain('FEATURE.md 的 owner 欄起草');
    expect(output).toContain('template/scripts/boundaries.owners.json');
    expect(output).toContain('gate=boundaries result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);

  it('boundaries.owners.json 存在,但 "owners" 是空陣列 → exit 1,同一句可執行訊息,且不是未捕捉例外', () => {
    const dir = makeFixture();
    writeOwners(dir, { ...BASE_OWNERS, owners: [] });
    writeSrc(dir, 'packages/a/index.ts', 'export const x = 1;\n');

    const { code, output } = run(dir);

    expect(code).toBe(1);
    expect(output).toContain('✗ 尚未設定:找不到');
    expect(output).toContain('或落點表是空的');
    expect(output).toContain('gate=boundaries result=FAIL scanned=0');
    // The old version threw uncaught here, printing a stack trace with no gate= marker line — this assertion locks in the fixed behavior.
    expect(output).not.toContain('at loadOwnersConfig');
    expect(output).not.toContain('Error: scripts/boundaries.owners.json');
  }, SPAWN_TIMEOUT_MS);
});

describe('check-boundaries:glue 角色(role: glue)', () => {
  it('被標 role:glue 的擁有者,被別人 import 時算違規,原因印「glue 不准被 import」', () => {
    const dir = makeFixture();
    writeOwners(dir, {
      ...BASE_OWNERS,
      owners: [...BASE_OWNERS.owners, ['packages/gen/', 'generated']],
      glue: [{ owner: 'generated', role: 'glue' }],
    });
    writeAllow(dir, []);
    writeSrc(dir, 'packages/gen/output.ts', 'export const g = 1;\n');
    writeSrc(dir, 'packages/a/index.ts', "import { g } from '../gen/output';\nexport const x = g;\n");

    const { code, output } = run(dir);

    expect(code).toBe(1);
    expect(output).toContain('glue 不准被 import');
    expect(output).toContain('packages/a/index.ts');
    expect(output).toContain("import '../gen/output'");
  }, SPAWN_TIMEOUT_MS);

  it('role:glue 的擁有者自己內部的 import 仍然放行(不當來源檢查,跟舊版字串式 glue 行為一致)', () => {
    const dir = makeFixture();
    writeOwners(dir, {
      ...BASE_OWNERS,
      owners: [...BASE_OWNERS.owners, ['packages/gen/', 'generated']],
      glue: [{ owner: 'generated', role: 'glue' }],
    });
    writeAllow(dir, []);
    writeSrc(dir, 'packages/gen/base.ts', 'export const base = 1;\n');
    // The generated owner's own imports are not checked (not a source), even if the target is another owner.
    writeSrc(dir, 'packages/gen/derived.ts', "import { x } from '../a/index';\nexport const d = x;\n");
    writeSrc(dir, 'packages/a/index.ts', 'export const x = 1;\n');

    const { code, output } = run(dir);

    expect(code).toBe(0);
    expect(output).not.toContain('packages/gen/derived.ts');
  }, SPAWN_TIMEOUT_MS);
});

describe('check-boundaries:既有規則不受影響(回歸)', () => {
  it('舊格式的純字串 glue 項目:行為不變(自己的 import 不當來源檢查;被別人 import 時走一般 cross 規則,不是新加的「不准被 import」)', () => {
    const dir = makeFixture();
    writeOwners(dir, {
      ...BASE_OWNERS,
      owners: [...BASE_OWNERS.owners, ['scripts/', 'infra']],
      glue: ['infra'],
      scanDirs: ['packages', 'scripts'],
    });
    writeAllow(dir, []);
    // infra's own imports (source check) are not looked at at all; even if the target is another owner, nothing is checked and nothing is reported.
    writeSrc(dir, 'scripts/tool.ts', "import { x } from '../packages/a/index';\nexport const y = x;\n");
    writeSrc(dir, 'packages/a/index.ts', 'export const x = 1;\n');
    // Others importing into infra (old-format string glue, no role:glue): the same rules as a normal cross-owner import
    // — with no allow.json exception it still counts as a cross violation, but the reason is "owner-b → infra", not "glue must not be imported"
    // (that new message is reserved for items that explicitly say role:glue).
    writeSrc(dir, 'packages/b/index.ts', "import { y } from '../../scripts/tool';\nexport const z = y;\n");

    const { code, output } = run(dir);

    expect(code).toBe(1);
    expect(output).toContain('owner-b → infra');
    expect(output).not.toContain('glue 不准被 import');
  }, SPAWN_TIMEOUT_MS);

  it('一般跨擁有者 import(非 glue)仍然判違規,原因是 cross', () => {
    const dir = makeFixture();
    writeOwners(dir, BASE_OWNERS);
    writeAllow(dir, []);
    writeSrc(dir, 'packages/a/index.ts', 'export const x = 1;\n');
    writeSrc(dir, 'packages/b/index.ts', "import { x } from '../a/index';\nexport const y = x;\n");

    const { code, output } = run(dir);

    expect(code).toBe(1);
    expect(output).toContain('owner-b → owner-a');
  }, SPAWN_TIMEOUT_MS);

  it('import contractsOwner 一律放行', () => {
    const dir = makeFixture();
    writeOwners(dir, BASE_OWNERS);
    writeAllow(dir, []);
    writeSrc(dir, 'contracts/types.ts', 'export type T = number;\n');
    writeSrc(dir, 'packages/a/index.ts', "import type { T } from '../../contracts/types';\nexport const x: T = 1;\n");

    const { code, output } = run(dir);

    expect(code).toBe(0);
    expect(output).toContain('✓ 無違規');
  }, SPAWN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// S9: broken config must fail loudly (not an uncaught stack trace, and not quietly applying defaults).
// ---------------------------------------------------------------------------

describe('check-boundaries:S9 設定檔壞掉', () => {
  it('boundaries.owners.json 是壞掉的 JSON → 印「設定檔壞掉」,不是未捕捉的堆疊', () => {
    const dir = makeFixture();
    writeFileSync(join(dir, 'scripts', 'boundaries.owners.json'), '{ this is not json', 'utf8');

    const { code, output } = run(dir);

    expect(code).toBe(1);
    expect(output).toContain('✗ 設定檔壞掉:');
    expect(output).toContain('gate=boundaries result=FAIL scanned=0');
    expect(output).not.toContain('at JSON.parse');
    expect(output).not.toContain('SyntaxError');
  }, SPAWN_TIMEOUT_MS);

  it('boundaries.allow.json 是壞掉的 JSON → 印「設定檔壞掉」,不是未捕捉的堆疊', () => {
    const dir = makeFixture();
    writeOwners(dir, BASE_OWNERS);
    writeFileSync(join(dir, 'scripts', 'boundaries.allow.json'), '[ not json either', 'utf8');
    writeSrc(dir, 'packages/a/index.ts', 'export const x = 1;\n');

    const { code, output } = run(dir);

    expect(code).toBe(1);
    expect(output).toContain('✗ 設定檔壞掉:');
    expect(output).toContain('gate=boundaries result=FAIL scanned=0');
    expect(output).not.toContain('at JSON.parse');
  }, SPAWN_TIMEOUT_MS);

  it('gates.config.json(skipDirs)是壞掉的 JSON → 一樣大聲失敗', () => {
    const dir = makeFixture();
    writeOwners(dir, BASE_OWNERS);
    writeFileSync(join(dir, 'scripts', 'gates.config.json'), '{ broken', 'utf8');
    writeSrc(dir, 'packages/a/index.ts', 'export const x = 1;\n');

    const { code, output } = run(dir);

    expect(code).toBe(1);
    expect(output).toContain('✗ 設定檔壞掉:');
    expect(output).toContain('gate=boundaries result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);

  it('gates.config.json 有不認識的頂層鍵(打錯字)→ 印「設定檔有不認識的鍵」', () => {
    const dir = makeFixture();
    writeOwners(dir, BASE_OWNERS);
    writeFileSync(join(dir, 'scripts', 'gates.config.json'), JSON.stringify({ skipDirz: ['oops'] }), 'utf8');
    writeSrc(dir, 'packages/a/index.ts', 'export const x = 1;\n');

    const { code, output } = run(dir);

    expect(code).toBe(1);
    expect(output).toContain('✗ 設定檔有不認識的鍵:skipDirz');
    expect(output).toContain('gate=boundaries result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);

  it('gates.config.json 的 "skipDirs" 型別錯(不是陣列)→ 印「設定檔鍵型別錯」', () => {
    const dir = makeFixture();
    writeOwners(dir, BASE_OWNERS);
    writeFileSync(join(dir, 'scripts', 'gates.config.json'), JSON.stringify({ skipDirs: 'nope' }), 'utf8');
    writeSrc(dir, 'packages/a/index.ts', 'export const x = 1;\n');

    const { code, output } = run(dir);

    expect(code).toBe(1);
    expect(output).toContain('✗ 設定檔鍵型別錯:skipDirs 應為 array');
    expect(output).toContain('gate=boundaries result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);

  it('合法設定不受影響(照常判違規,不受這次改動影響)', () => {
    const dir = makeFixture();
    writeOwners(dir, BASE_OWNERS);
    writeAllow(dir, []);
    writeSrc(dir, 'packages/a/index.ts', 'export const x = 1;\n');
    writeSrc(dir, 'packages/b/index.ts', "import { x } from '../a/index';\nexport const y = x;\n");

    const { code, output } = run(dir);

    expect(code).toBe(1);
    expect(output).toContain('owner-b → owner-a');
  }, SPAWN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// S10: every gate that walks the directory tree shares the same skip list (DEFAULT_SKIP_DIRS in _root.ts).
// ---------------------------------------------------------------------------

describe('check-boundaries:S10 共用略過清單', () => {
  it('.next 建置產物底下的檔案不被掃到(消費者實測:511 筆雜訊違規)', () => {
    const dir = makeFixture();
    writeOwners(dir, {
      owners: [
        ['apps/x/', 'app-x'],
        ['contracts/', 'contracts'],
      ],
      glue: [],
      aliases: [],
      scanDirs: ['apps'],
      contractsOwner: 'contracts',
    });
    writeAllow(dir, []);
    // Put an import that obviously violates (an absolute path) under .next; if it is not excluded, the scanner will certainly report it.
    writeSrc(dir, 'apps/x/.next/foo.ts', "import x from '/etc/passwd';\nexport default x;\n");
    writeSrc(dir, 'apps/x/index.ts', 'export const ok = 1;\n');

    const { code, output } = run(dir);

    expect(code).toBe(0);
    expect(output).not.toContain('.next/foo.ts');
    expect(output).toContain('✓ 無違規');
  }, SPAWN_TIMEOUT_MS);

  it('gates.config.json 的 "skipDirs" 追加(不取代)內建清單', () => {
    const dir = makeFixture();
    writeOwners(dir, {
      owners: [
        ['apps/x/', 'app-x'],
        ['contracts/', 'contracts'],
      ],
      glue: [],
      aliases: [],
      scanDirs: ['apps'],
      contractsOwner: 'contracts',
    });
    writeAllow(dir, []);
    writeFileSync(join(dir, 'scripts', 'gates.config.json'), JSON.stringify({ skipDirs: ['vendor-custom'] }), 'utf8');
    // Put a violating import in the custom skip directory → it should be excluded, not reported.
    writeSrc(dir, 'apps/x/vendor-custom/bad.ts', "import x from '/etc/passwd';\nexport default x;\n");
    // Put the same violating import in a normal directory → it should still be caught (additive: it neither replaces the built-in list nor replaces the scan itself).
    writeSrc(dir, 'apps/x/bad.ts', "import x from '/etc/passwd';\nexport default x;\n");

    const { code, output } = run(dir);

    expect(code).toBe(1);
    expect(output).not.toContain('vendor-custom/bad.ts');
    expect(output).toContain('apps/x/bad.ts');
  }, SPAWN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// S10: every check-*.ts that walks the directory tree must use the shared skip list in _root.ts, and must not declare
// its own SKIP_DIRS-like array (so that the next gate does not repeat the .next incident).
// ---------------------------------------------------------------------------

describe('check-boundaries:S10 共用清單的 grep 迴歸測試', () => {
  it('沒有任何 check-*.ts(_root.ts 除外)自己寫死 "node_modules" 字面值', async () => {
    const { readdirSync, readFileSync: readFile } = await import('node:fs');
    const scriptsDir = import.meta.dirname;
    const files = readdirSync(scriptsDir).filter(
      (f) => f.startsWith('check-') && f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) => readFile(join(scriptsDir, f), 'utf8').includes("'node_modules'"));
    expect(offenders).toEqual([]);
  });

  it('每一支定義了遞迴 walk() 的 check-*.ts 都要 import _root.ts 的共用略過清單', async () => {
    const { readdirSync, readFileSync: readFile } = await import('node:fs');
    const scriptsDir = import.meta.dirname;
    const files = readdirSync(scriptsDir).filter(
      (f) => f.startsWith('check-') && f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    const walkers = files.filter((f) => /function\*\s+walk\s*\(/.test(readFile(join(scriptsDir, f), 'utf8')));
    expect(walkers.length).toBeGreaterThan(0);
    for (const f of walkers) {
      const src = readFile(join(scriptsDir, f), 'utf8');
      const importsShared = /from ['"]\.\/_root\.js['"]/.test(src) &&
        (src.includes('DEFAULT_SKIP_DIRS') || src.includes('resolveSkipDirs') || src.includes('splitSkipDirs'));
      expect(importsShared, `${f} 應該 import _root.ts 的共用略過清單`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// S14 (template 1.4.1, source AI_KM 2026-09-05, PITFALLS P-73): config search order when --root is explicit,
// must not fall back to the directory the script itself lives in (that is usually the template's own placeholder config).
// ---------------------------------------------------------------------------

describe('check-boundaries:S14 --root 明講時的設定檔解析(P-73)', () => {
  it('--root 明講、沒設 GATES_CONFIG_DIR、<root>/scripts 沒有 owners.json → 印新的硬錯誤訊息,不退回腳本自身目錄,不是「尚未設定」', () => {
    const dir = makeFixture();
    copyFileSync(CHECK_BOUNDARIES_TS, join(dir, 'scripts', 'check-boundaries.ts'));
    copyFileSync(ROOT_TS, join(dir, 'scripts', '_root.ts'));

    const r = spawnSync('npx', ['tsx', join(dir, 'scripts', 'check-boundaries.ts'), '--root', dir], {
      cwd: dir,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });
    const code = r.status ?? -1;
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;

    expect(code).toBe(1);
    expect(output).toContain(
      `✗ 設定檔未找到於 ${join(dir, 'scripts', 'boundaries.owners.json')}(--root 明講時不退回腳本自身目錄;要指定別處請設 GATES_CONFIG_DIR)`,
    );
    expect(output).not.toContain('✗ 尚未設定:找不到');
    expect(output).toContain('gate=boundaries result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);

  it('模板路徑跟 consumer 路徑不同時,--root 明講會用 consumer 自己的 owners.json,不是腳本自身(模板)目錄那份', () => {
    // Simulates the shape of the incident: there is a placeholder owners.json under the "template path"; the "consumer path" is another
    // completely different repo with its own filled-in owners.json. Run directly from the template path, with --root given
    // explicitly for the consumer path and GATES_CONFIG_DIR unset — it should use the consumer's copy, not the one in the template script's own
    // directory.
    const templateDir = makeFixture();
    copyFileSync(CHECK_BOUNDARIES_TS, join(templateDir, 'scripts', 'check-boundaries.ts'));
    copyFileSync(ROOT_TS, join(templateDir, 'scripts', '_root.ts'));
    // The template's own placeholder landing-zone table: it only knows one landing zone the consumer never uses; if this copy were used by mistake,
    // all of the consumer's source would become unmapped.
    writeOwners(templateDir, {
      owners: [['only-in-template/', 'template-owner'], ['contracts/', 'contracts']],
      glue: [],
      aliases: [],
      scanDirs: ['packages'],
      contractsOwner: 'contracts',
    });

    const consumerDir = makeFixture();
    writeOwners(consumerDir, BASE_OWNERS);
    writeAllow(consumerDir, []);
    writeSrc(consumerDir, 'packages/a/index.ts', 'export const x = 1;\n');
    writeSrc(consumerDir, 'packages/b/index.ts', 'export const y = 1;\n');

    const r = spawnSync(
      'npx',
      ['tsx', join(templateDir, 'scripts', 'check-boundaries.ts'), '--root', consumerDir],
      { cwd: templateDir, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS },
    );
    const code = r.status ?? -1;
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;

    // The consumer's landing-zone table is used (packages/a and packages/b both map to a landing zone) → no violations, no unmapped.
    expect(code).toBe(0);
    expect(output).toContain(`設定:${join(consumerDir, 'scripts', 'boundaries.owners.json')}`);
    expect(output).not.toContain(join(templateDir, 'scripts', 'boundaries.owners.json'));
    expect(output).not.toContain('不在任何功能的落點內');
  }, SPAWN_TIMEOUT_MS);

  it('GATES_CONFIG_DIR 仍然贏過 --root 與腳本自身目錄兩者(明講的覆蓋管道不受這次修改影響)', () => {
    const dir = makeFixture();
    const overrideDir = makeIsolatedTempDir('lc-boundaries-override-');
    tmpDirs.push(overrideDir);
    writeFileSync(
      join(overrideDir, 'boundaries.owners.json'),
      JSON.stringify({ ...BASE_OWNERS }),
      'utf8',
    );
    writeSrc(dir, 'packages/a/index.ts', 'export const x = 1;\n');

    const r = spawnSync('npx', ['tsx', CHECK_BOUNDARIES_TS, '--root', dir], {
      cwd: dir,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      env: { ...process.env, GATES_CONFIG_DIR: overrideDir },
    });
    const code = r.status ?? -1;
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;

    expect(code).toBe(0);
    expect(output).toContain(`設定:${join(overrideDir, 'boundaries.owners.json')}(GATES_CONFIG_DIR)`);
  }, SPAWN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// S11 (template 1.4.1, source nightmare-assault): always print coverage + ratchet baseline (may only go up, never down).
// ---------------------------------------------------------------------------

describe('check-boundaries:S11 涵蓋率永遠印 + 棘輪', () => {
  it('0 個違規時也印涵蓋率那一行(舊版只在 checked==0 才提涵蓋,其餘情況完全不提——回歸鎖)', () => {
    const dir = makeFixture();
    writeOwners(dir, BASE_OWNERS);
    writeAllow(dir, []);
    writeSrc(dir, 'packages/a/index.ts', 'export const x = 1;\n');

    const { code, output } = run(dir);

    expect(code).toBe(0);
    expect(output).toMatch(/涵蓋:納管 1 \/ 掃描 1 檔\(100\.0%\)/);
    expect(output).toContain('(無)');
  }, SPAWN_TIMEOUT_MS);

  it('有 unmapped 檔案時,涵蓋率行列出未納管的第一層子目錄與檔案數', () => {
    const dir = makeFixture();
    writeOwners(dir, BASE_OWNERS);
    writeAllow(dir, []);
    writeSrc(dir, 'packages/a/index.ts', 'export const x = 1;\n');
    // packages/newthing/ is not in the owners table, so both files fall into the same "unmanaged directory".
    writeSrc(dir, 'packages/newthing/one.ts', 'export const a = 1;\n');
    writeSrc(dir, 'packages/newthing/two.ts', 'export const b = 1;\n');

    const { code, output } = run(dir);

    expect(code).toBe(1);
    expect(output).toMatch(/涵蓋:納管 1 \/ 掃描 3 檔\(33\.3%\)/);
    expect(output).toContain('packages/newthing(2 個檔案未納管)');
  }, SPAWN_TIMEOUT_MS);

  it('coverageBaseline 存在、這次涵蓋率比基準低 → 棘輪判失敗,印「涵蓋率下降」,不准降', () => {
    const dir = makeFixture();
    writeOwners(dir, { ...BASE_OWNERS, coverageBaseline: { managed: 2, scanned: 2 } });
    writeAllow(dir, []);
    writeSrc(dir, 'packages/a/index.ts', 'export const x = 1;\n');
    writeSrc(dir, 'packages/newthing/one.ts', 'export const a = 1;\n'); // this run has only 1/2 managed, the baseline is 2/2

    const { code, output } = run(dir);

    expect(code).toBe(1);
    expect(output).toContain('✗ 涵蓋率下降:1/2(50.0%) < 基準 2/2(100.0%)(只准升)');
  }, SPAWN_TIMEOUT_MS);

  it('coverageBaseline 存在、這次涵蓋率比基準高 → 通過,並提示可以把基準改高', () => {
    const dir = makeFixture();
    writeOwners(dir, { ...BASE_OWNERS, coverageBaseline: { managed: 1, scanned: 2 } });
    writeAllow(dir, []);
    writeSrc(dir, 'packages/a/index.ts', 'export const x = 1;\n');
    writeSrc(dir, 'packages/b/index.ts', 'export const y = 1;\n'); // this run has 2/2 managed, the baseline only requires 1/2

    const { code, output } = run(dir);

    expect(code).toBe(0);
    expect(output).toContain('○ 涵蓋率上升,可把基準改成 2/2');
  }, SPAWN_TIMEOUT_MS);

  it('coverageBaseline 型別錯(managed 不是數字)→ 設定壞掉大聲失敗(S9 同一套)', () => {
    const dir = makeFixture();
    writeOwners(dir, { ...BASE_OWNERS, coverageBaseline: { managed: 'two', scanned: 2 } });
    writeSrc(dir, 'packages/a/index.ts', 'export const x = 1;\n');

    const { code, output } = run(dir);

    expect(code).toBe(1);
    expect(output).toContain('設定檔鍵型別錯:coverageBaseline.managed 應為 number');
    expect(output).toContain('gate=boundaries result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);

  it('既有行為不受影響(回歸):一般跨擁有者違規仍然照舊判失敗、訊息不變', () => {
    const dir = makeFixture();
    writeOwners(dir, BASE_OWNERS);
    writeAllow(dir, []);
    writeSrc(dir, 'packages/a/index.ts', 'export const x = 1;\n');
    writeSrc(dir, 'packages/b/index.ts', "import { x } from '../a/index';\nexport const y = x;\n");

    const { code, output } = run(dir);

    expect(code).toBe(1);
    expect(output).toContain('owner-b → owner-a');
    expect(output).toMatch(/涵蓋:納管 2 \/ 掃描 2 檔\(100\.0%\)/);
  }, SPAWN_TIMEOUT_MS);
});

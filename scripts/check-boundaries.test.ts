/**
 * scripts/check-boundaries.ts 的單元測試(模板 1.4.0 S4:空落點表要 FAIL + glue 角色)。
 *
 * `GATES_CONFIG_DIR` 一定要設成 `<fixture>/scripts`:check-boundaries.ts 找設定檔的
 * 順位 1 是「腳本自己所在的目錄」,對這裡的測試來說那是模板自己的 `scripts/`(裡面那份
 * `boundaries.owners.json` 是真的落點表,不是空的),不設 env 的話測試永遠讀到模板的
 * 設定,讀不到 fixture——這是 check-boundaries.ts 檔頭自己文件化過的坑。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHECK_BOUNDARIES_TS = resolve(import.meta.dirname, 'check-boundaries.ts');
const ROOT_TS = resolve(import.meta.dirname, '_root.ts');
const SPAWN_TIMEOUT_MS = 60_000;
const SCANNER_BROKEN = '這不是很乾淨,是掃描器壞了';

const tmpDirs: string[] = [];

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lc-boundaries-'));
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
  it('boundaries.owners.json 完全不存在 → exit 1,訊息是可執行的「尚未設定」', () => {
    const dir = makeFixture();
    // 「完全不存在」要真的模擬 sync 之後的安裝目錄(script 自己所在的目錄 = fixture 的
    // scripts/,裡面沒有 owners.json),不能只靠 --root 指開一個空目錄——那樣「腳本自己
    // 所在的目錄」(找設定檔的順位 1)仍然是模板真正的 scripts/,那裡永遠有一份真的
    // owners.json,會蓋掉這個測試想模擬的情境。所以這裡把 check-boundaries.ts 跟它依賴
    // 的 _root.ts 複製進 fixture 的 scripts/,對這份複製本身執行——不設 GATES_CONFIG_DIR
    // (順位 0),順位 1、2 都指到同一個沒有 owners.json 的目錄。
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
    // 舊版這裡是未捕捉的 throw,印一段 stack trace、沒有 gate= 標記行——這條斷言鎖住修好之後的行為。
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
    // generated 擁有者自己 import 任何東西都不檢查(不當來源),即使目標是別的擁有者也一樣。
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
    // infra 自己的 import(來源檢查)完全不看,即使目標是別的擁有者也不檢查、不報錯。
    writeSrc(dir, 'scripts/tool.ts', "import { x } from '../packages/a/index';\nexport const y = x;\n");
    writeSrc(dir, 'packages/a/index.ts', 'export const x = 1;\n');
    // 別人 import 到 infra(舊格式字串 glue,沒有 role:glue):跟一般跨擁有者 import 同一套規則
    // ——沒有 allow.json 例外就照樣算 cross 違規,但原因是「owner-b → infra」,不是「glue 不准被 import」
    // (那句新訊息只留給明講 role:glue 的項目)。
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
// S9:設定檔壞掉要大聲失敗(不是未捕捉的堆疊,也不是悄悄套用預設值)。
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
// S10:所有走目錄樹的 gate 共用同一份略過清單(_root.ts 的 DEFAULT_SKIP_DIRS)。
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
    // .next 底下放一個明顯會違規的 import(絕對路徑),如果沒被排除,掃描器一定會報。
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
    // 自訂略過目錄裡放一個違規 import → 應該被排除,不報。
    writeSrc(dir, 'apps/x/vendor-custom/bad.ts', "import x from '/etc/passwd';\nexport default x;\n");
    // 一般目錄裡放同樣的違規 import → 應該照樣被抓到(追加,不是取代內建清單也不是取代掃描本身)。
    writeSrc(dir, 'apps/x/bad.ts', "import x from '/etc/passwd';\nexport default x;\n");

    const { code, output } = run(dir);

    expect(code).toBe(1);
    expect(output).not.toContain('vendor-custom/bad.ts');
    expect(output).toContain('apps/x/bad.ts');
  }, SPAWN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// S10:每一支會走目錄樹的 check-*.ts 都要用 _root.ts 的共用略過清單,不准自己另外
// 宣告一份 SKIP_DIRS-like 的陣列(這樣才不會有下一支 gate 重蹈 .next 事故的覆轍)。
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

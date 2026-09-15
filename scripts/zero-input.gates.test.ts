/**
 * 模板自己的零輸入守門測試(P-84,來源 專案 A 協調者,2026-09-05;PITFALLS 第二次
 * 出現「模板違反自己訂的規則」——第一次是 P-83)。
 *
 * 背景:consumer 用 `check-next-gates.ts --root /nonexistent` 跟
 * `check-phase-status.ts --root /nonexistent` 撞到——兩支都 exit 1,但輸出完全沒提
 * 傳進去的路徑,跟其餘會先摸設定檔的 gate(`check-boundaries.ts`、`check-doc-rot.ts`
 * 那一類,經 `_root.ts` 的 `lookupConfig` S14 hard-error)比,少講了最關鍵的一句話。
 * 修法是 `_root.ts` 新增 `requireRootDir()` / `rootDirError()`,每支接受 `--root` 的
 * gate 在任何設定檔查找之前先呼叫。
 *
 * 這支測試檔本身就是那次事故的教訓:光修兩支不夠,要有一份**涵蓋模板自己全部 gate**
 * 的零輸入測試,新 gate 加進來時**結構上**不可能漏掉這一項檢查——`listGateFiles()`
 * 用目錄列舉(不是手抄清單)找出 `scripts/` 底下所有 `check-*.ts`(`check-all.ts` 本來
 * 就符合這個樣式),沒有 `--root` 旗標的 gate 必須明講在 `NO_ROOT_FLAG` 並附理由,
 * 兩邊都沒有 → 測試直接紅,訊息是「新守門沒進零輸入清單」。
 *
 * ## 探針表(每支支援 `--root` 的 gate 都跑這三個探針)
 *
 * | gate                  | (a) --root 指到不存在的目錄        | (b) --root 指到空目錄                              | (c) --root 底下的設定檔壞掉(malformed JSON)              |
 * |------------------------|-----------------------------------|----------------------------------------------------|-----------------------------------------------------------|
 * | check-all.ts           | ✗ --root 指到不存在的目錄:<path>  | 設定檔未找到於 .../gates.config.json               | 設定檔壞掉:.../gates.config.json                          |
 * | check-boundaries.ts    | 同上                                | 設定檔未找到於 .../boundaries.owners.json          | 先補一份合法 boundaries.owners.json,弄壞 gates.config.json |
 * | check-doc-links.ts     | 同上                                | 掃描到 0 條相對連結(0 目標,scanned=0)             | 弄壞 gates.config.json(這支腳本唯一會讀的設定檔)          |
 * | check-doc-rot.ts       | 同上                                | 設定檔未找到於 .../doc-rot.blacklist.json          | 先補一份合法 doc-rot.blacklist.json,弄壞 gates.config.json |
 * | check-known-defects.ts | 同上                                | 設定檔未找到於 .../known-defects.json              | 弄壞 known-defects.json 本身(見下方例外說明)              |
 * | check-next-gates.ts    | 同上                                | 掃到 0 份 NEXT.md(0 目標,scanned=0)               | 弄壞 gates.config.json                                     |
 * | check-phase-status.ts  | 同上                                | 掃到 0 份 FEATURE.md(0 目標,scanned=0)            | 弄壞 gates.config.json                                     |
 * | check-standalone.ts    | 同上                                | 設定檔壞掉:.../standalone.json(ENOENT,見例外說明) | 弄壞 standalone.json 本身(見下方例外說明)                 |
 *
 * 三個探針共同的規則:exit code 1、輸出裡有機器可讀的 `gate=<name> result=FAIL
 * scanned=0` 標記、沒有裸露的堆疊(`\n  at ...` 那種 Node 未捕捉例外的樣子,或
 * `TypeError`/`ReferenceError` 字樣)。
 *
 * **例外(跟原始需求的字面描述不同,這裡記理由)**:
 *   - 原始探針 (c) 講的是「malformed gates.config.json」,但 `check-known-defects.ts`
 *     跟 `check-standalone.ts` 根本不讀 `gates.config.json`(檔頭已經講清楚各自唯一
 *     的必要設定檔是 `known-defects.json` / `standalone.json`)——對著它們弄壞
 *     `gates.config.json` 什麼都測不到(這兩支根本不會去讀那份檔案),驗的東西會
 *     跟探針 (b) 一樣。改成弄壞它們自己唯一的必要設定檔,驗的還是同一件事(S9:
 *     設定檔壞掉要大聲失敗、印出檔名、不是未捕捉的堆疊),只是換成對這兩支腳本真正
 *     有意義的檔案。
 *   - `check-standalone.ts` 的探針 (b)(空目錄)直接觸發「設定檔壞掉」
 *     (`readConfigJson` 對著不存在的 `standalone.json` 丟 ENOENT,訊息本身就
 *     帶著完整路徑),不是「0 目標」或「設定檔未找到」——這支腳本沒有走
 *     `_root.ts` 的 `lookupConfig`(它用 `readConfigJson` 直接讀,壞掉的意義
 *     跟找不到是同一句話),三種情況殊途同歸,一樣的檢查標準(exit 1、名路徑、
 *     有標記、沒有裸堆疊)一樣適用,所以不特別為它另開規則。
 *
 * `check-gherkin-dup.ts` / `check-phase-coverage.ts` / `check-step-dup.ts` 完全沒有
 * `--root` 旗標(一律用 `_root.ts` 推定的 git 頂層 `ROOT`),見 `NO_ROOT_FLAG` 的理由。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPTS_DIR = import.meta.dirname;
const SPAWN_TIMEOUT_MS = 60_000;

/** 沒有 `--root` 旗標的 gate,連同「為什麼沒有」——每一項都要有理由,不能只是清單。 */
const NO_ROOT_FLAG: Record<string, string> = {
  'check-gherkin-dup.ts':
    '沒有 --root 旗標;一律用 _root.ts 推定的 git 頂層 ROOT,不支援對別的 repo 跑(檔頭用法只列不帶 --root 的呼叫方式)。',
  'check-phase-coverage.ts':
    '只有 --cwd 可調整 cucumber 執行目錄;掃 feature 檔、找 gates.config.json 一律用模組層級的 ROOT,沒有 --root 旗標(檔頭用法同樣只列 --cwd / --list / --run)。',
  'check-step-dup.ts':
    '沒有 --root 旗標;一律用 _root.ts 推定的 git 頂層 ROOT,腳本裡完全沒有 argv 解析 --root 的邏輯。',
};

/** `check-dag.ts` 的零輸入語意不同於既有掃描器:只有 `_template`-only repo PASS。
 * 它放在專屬 describe，不硬套下面既有 gate 的「空目錄必 FAIL + malformed config」探針。 */
const SPECIAL_ZERO_INPUT_GATE_FILES = ['check-dag.ts'];

/** `scripts/` 底下所有 `check-*.ts`(不含 `.test.ts`)——目錄列舉,不是手抄清單,
 *  新增一支 gate 檔案這裡自動看得到。 */
function listGateFiles(): string[] {
  return readdirSync(SCRIPTS_DIR)
    .filter((f) => /^check-.*\.ts$/.test(f) && !f.endsWith('.test.ts'))
    .sort();
}

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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

/** 保證 `JSON.parse` 會炸的字串(截斷的物件),不管哪支腳本的 parser 都一樣壞。 */
const MALFORMED_JSON = '{ "broken":  ';

function run(gateFile: string, root: string): { code: number; output: string } {
  const scriptPath = join(SCRIPTS_DIR, gateFile);
  const r = spawnSync('npx', ['tsx', scriptPath, '--root', root], {
    // 探針 (a) 故意傳一個不存在的 `root`——spawnSync 的 `cwd` 不能是不存在的目錄
    // (那會讓子行程本身起不來,exit code 是 -1,不是腳本自己判斷出來的 1),兩者是
    // 不同的東西:`--root` 是腳本要檢查的目標,`cwd` 只是子行程從哪裡起。存在就沿用
    // `root`(方便腳本裡任何用相對路徑找東西的邏輯跟真的裝進那個目錄一樣),不存在就
    // 退回 `SCRIPTS_DIR`(模板自己的 scripts/,一定存在)。
    cwd: existsSync(root) ? root : SCRIPTS_DIR,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    // 跟 check-boundaries.test.ts 同一個坑:不設這個,候選路徑裡「腳本自己所在目錄」
    // (模板自己的 scripts/)會先中,讀到模板自己的真實設定檔,不是這裡造的 fixture。
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
  /** 額外要先備好的檔案(讓腳本能跑過更早的必要設定檢查,抵達真正要測的那一關)。 */
  setup?: (root: string) => void;
  /** 輸出裡都要出現的片段。 */
  includes: string[];
}

interface GateSpec {
  file: string;
  gate: string;
  probeB: ProbeCase;
  /** 探針 (c) 要弄壞的那個檔案,相對 `root`。 */
  probeC: ProbeCase & { relPath: string };
}

const BOUNDARIES_OWNERS_VALID = {
  owners: [['src/', 'core']],
  glue: [],
  aliases: [],
  scanDirs: ['src'],
  contractsOwner: 'core',
};

const DOC_ROT_BLACKLIST_VALID = [
  { pattern: 'THIS_NEVER_MATCHES_ANYTHING_ZZQQ', reason: '零輸入測試用的假規則', since: '2026-01-01', incident: '零輸入測試' },
];

const GATE_SPECS: GateSpec[] = [
  {
    file: 'check-all.ts',
    gate: 'all',
    probeB: { includes: ['設定檔未找到', 'gates.config.json'] },
    probeC: { relPath: 'scripts/gates.config.json', includes: ['設定檔壞掉', 'gates.config.json'] },
  },
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
    file: 'check-doc-links.ts',
    gate: 'doc-links',
    probeB: { includes: ['掃描到 0 條相對連結', 'gate=doc-links result=FAIL scanned=0'] },
    probeC: { relPath: 'scripts/gates.config.json', includes: ['設定檔壞掉', 'gates.config.json'] },
  },
  {
    file: 'check-dry-run.ts',
    gate: 'dry-run',
    // 空目錄:gates.config.json 找不到(選填,靜默)→ 自動偵測找不到 cucumber 設定 → 名出找過的根目錄。
    probeB: { includes: ['找不到 cucumber 設定', 'gate=dry-run result=FAIL scanned=0'] },
    probeC: { relPath: 'scripts/gates.config.json', includes: ['設定檔壞掉', 'gates.config.json'] },
  },
  {
    file: 'check-doc-rot.ts',
    gate: 'doc-rot',
    probeB: { includes: ['設定檔未找到', 'doc-rot.blacklist.json'] },
    probeC: {
      relPath: 'scripts/gates.config.json',
      setup: (root) => writeJson(root, 'scripts/doc-rot.blacklist.json', DOC_ROT_BLACKLIST_VALID),
      includes: ['設定檔壞掉', 'gates.config.json'],
    },
  },
  {
    file: 'check-known-defects.ts',
    gate: 'known-defects',
    probeB: { includes: ['設定檔未找到', 'known-defects.json'] },
    probeC: { relPath: 'scripts/known-defects.json', includes: ['設定檔壞掉', 'known-defects.json'] },
  },
  {
    file: 'check-module-cast.ts',
    gate: 'module-cast',
    probeB: { includes: ['掃到 0 個 .ts 檔', 'gate=module-cast result=FAIL scanned=0'] },
    probeC: { relPath: 'scripts/gates.config.json', includes: ['設定檔壞掉', 'gates.config.json'] },
  },
  {
    file: 'check-next-gates.ts',
    gate: 'next-gates',
    probeB: { includes: ['掃到 0 份 NEXT.md', 'gate=next-gates result=FAIL scanned=0'] },
    probeC: { relPath: 'scripts/gates.config.json', includes: ['設定檔壞掉', 'gates.config.json'] },
  },
  {
    file: 'check-phase-status.ts',
    gate: 'phase-status',
    probeB: { includes: ['掃到 0 份 FEATURE.md', 'gate=phase-status result=FAIL scanned=0'] },
    probeC: { relPath: 'scripts/gates.config.json', includes: ['設定檔壞掉', 'gates.config.json'] },
  },
  {
    file: 'check-standalone.ts',
    gate: 'standalone',
    // 見檔頭例外說明:空目錄直接觸發 ENOENT 的「設定檔壞掉」,不是「0 目標」或
    // 「設定檔未找到」——訊息本身一樣帶著完整路徑,一樣算「名了路徑」。
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

describe('check-dag 的零輸入語意', () => {
  it('專屬 zero-input 清單中的檔案存在', () => {
    for (const file of SPECIAL_ZERO_INPUT_GATE_FILES) {
      expect(existsSync(join(SCRIPTS_DIR, file)), `SPECIAL_ZERO_INPUT_GATE_FILES 列了不存在的檔案:${file}`).toBe(true);
    }
  });

  it('只有 features/_template/ 的全新 repo → 印「沒有 phase」、exit 0', () => {
    const root = makeTempDir('lc-zero-input-dag-template-');
    writeRaw(root, 'features/_template/FEATURE.md', '# template\n');
    writeRaw(root, 'features/_template/NEXT.md', '# template next\n');

    const { code, output } = run('check-dag.ts', root);

    expect(code).toBe(0);
    expect(output).toContain('沒有 phase');
    expect(output).toContain('gate=dag result=PASS scanned=0');
    assertNoBareStack(output);
  });
});

describe.each(GATE_SPECS)('$file 的零輸入探針', ({ file, gate, probeB, probeC }) => {
  it('(a) --root 指到不存在的目錄:exit 1、名出那個路徑、印標記、沒有裸堆疊', () => {
    const missing = join(tmpdir(), `lc-zero-input-missing-${process.pid}-${Math.random().toString(36).slice(2)}`);
    expect(existsSync(missing)).toBe(false); // 確認真的沒建過這個目錄
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

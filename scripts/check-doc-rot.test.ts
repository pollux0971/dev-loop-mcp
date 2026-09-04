/**
 * scripts/check-doc-rot.ts 的單元測試(模板 1.4.0 S7)。
 *
 * 跟其餘掃描器的測試同一個形狀:造一次性的臨時目錄當假 consumer 根,`--root` +
 * `GATES_CONFIG_DIR`(指到 `<fixture>/scripts`)明講,不碰真的 repo。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHECK_DOC_ROT_TS = resolve(import.meta.dirname, 'check-doc-rot.ts');
const ROOT_TS = resolve(import.meta.dirname, '_root.ts');
const SPAWN_TIMEOUT_MS = 60_000;
const SCANNER_BROKEN = '這不是很乾淨,是掃描器壞了';

const tmpDirs: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lc-doc-rot-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  return dir;
}

function writeBlacklist(root: string, entries: unknown): void {
  writeFileSync(join(root, 'scripts', 'doc-rot.blacklist.json'), JSON.stringify(entries, null, 2), 'utf8');
}

function write(root: string, relPath: string, content: string): void {
  const p = join(root, relPath);
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

function run(root: string, ...extra: string[]): { code: number; output: string } {
  const r = spawnSync('npx', ['tsx', CHECK_DOC_ROT_TS, '--root', root, ...extra], {
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

const ONE_RULE = [
  { pattern: 'llm-learning-cards-\\d+', reason: '寫死的顧問 session 名字', since: '2026-09-05', incident: 'P-59' },
];

describe('check-doc-rot:命中黑名單', () => {
  it('一個檔案命中一條規則 → FAIL,訊息含 file:line 與規則資訊', () => {
    const root = makeRoot();
    writeBlacklist(root, ONE_RULE);
    write(root, 'docs/notes.md', '見顧問 session llm-learning-cards-57 討論。\n');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('docs/notes.md:1');
    expect(output).toContain('命中黑名單「llm-learning-cards-\\d+」');
    expect(output).toContain('P-59');
    expect(output).toContain('gate=doc-rot result=FAIL');
  }, SPAWN_TIMEOUT_MS);

  it('同樣的字串出現在 docs/02-decision-map.md(ADR 檔)→ 不報', () => {
    const root = makeRoot();
    writeBlacklist(root, ONE_RULE);
    write(root, 'docs/02-decision-map.md', '## ADR-001 · 決定不要再用 llm-learning-cards-57\n\n理由略。\n');
    write(root, 'docs/other.md', '無關內容,純粹讓掃描器有東西可掃。\n'); // 避免「0 個檔案」蓋掉這條測試想驗的東西

    const { code, output } = run(root);

    expect(code).toBe(0);
    expect(output).not.toContain('02-decision-map.md');
    expect(output).toContain('gate=doc-rot result=PASS');
  }, SPAWN_TIMEOUT_MS);

  it('同樣的字串出現在 docs/adr/ 底下 → 不報', () => {
    const root = makeRoot();
    writeBlacklist(root, ONE_RULE);
    write(root, 'docs/adr/0001-foo.md', '決定不要再用 llm-learning-cards-57。\n');
    write(root, 'docs/other.md', '無關內容,純粹讓掃描器有東西可掃。\n');

    const { code } = run(root);

    expect(code).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  it('沒有命中 → PASS', () => {
    const root = makeRoot();
    writeBlacklist(root, ONE_RULE);
    write(root, 'docs/notes.md', '一切正常,沒有可疑字串。\n');

    const { code, output } = run(root);

    expect(code).toBe(0);
    expect(output).toContain('gate=doc-rot result=PASS');
  }, SPAWN_TIMEOUT_MS);

  it('黑名單設定檔自己不會自我命中', () => {
    const root = makeRoot();
    // pattern 字串本身就含 "llm-learning-cards" 這個子字串,故意測「不排除自己就會自我命中」。
    writeBlacklist(root, ONE_RULE);
    write(root, 'docs/notes.md', '沒有可疑字串。\n');

    const { code, output } = run(root);

    expect(code).toBe(0);
    expect(output).not.toContain('doc-rot.blacklist.json:');
  }, SPAWN_TIMEOUT_MS);

  it('.claude/worktrees/ 底下的檔案不被掃到(多層路徑前綴,不是單層目錄名)', () => {
    const root = makeRoot();
    writeBlacklist(root, ONE_RULE);
    write(root, 'docs/notes.md', '沒有可疑字串,純粹讓掃描器有東西可掃。\n');
    // .claude 跟 worktrees 是兩層,單純逐層比對目錄名永遠比不到 ".claude/worktrees"
    // 這個帶斜線的字串——這裡放一個會命中的檔案在裡面,驗證真的被當成整段路徑前綴排除
    // (不是只補一個叫 "worktrees" 的單層目錄名而已)。
    write(root, '.claude/worktrees/other-agent/docs/inner.md', '見顧問 session llm-learning-cards-99。\n');

    const { code, output } = run(root);

    expect(code).toBe(0);
    expect(output).not.toContain('.claude/worktrees');
    expect(output).toContain('gate=doc-rot result=PASS');
  }, SPAWN_TIMEOUT_MS);
});

describe('check-doc-rot:0 目標一律 FAIL', () => {
  it('黑名單是空陣列 → exit 1,scanned=0', () => {
    const root = makeRoot();
    writeBlacklist(root, []);
    write(root, 'docs/notes.md', '內容。\n');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain(SCANNER_BROKEN);
    expect(output).toContain('gate=doc-rot result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);

  it('掃到 0 個檔案(副檔名都不符)→ exit 1,scanned=0', () => {
    const root = makeRoot();
    writeBlacklist(root, ONE_RULE);
    write(root, 'notes.unknownext', 'llm-learning-cards-57\n');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain(SCANNER_BROKEN);
    expect(output).toContain('gate=doc-rot result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);

  it('找不到 doc-rot.blacklist.json → exit 1,可執行的訊息', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', '內容。\n');
    // 「完全不存在」要真的模擬 sync 之後的安裝目錄:把 check-doc-rot.ts 跟它依賴的
    // _root.ts 複製進 fixture 的 scripts/,對這份複製本身執行——不設 GATES_CONFIG_DIR,
    // 順位 1、2 都指到同一個沒有 doc-rot.blacklist.json 的目錄。不這樣做的話,「腳本自己
    // 所在的目錄」(找設定檔的順位 1)會是模板真正的 scripts/,那裡有一份真的
    // doc-rot.blacklist.json,會蓋掉這個測試想模擬的情境(跟 check-boundaries.test.ts
    // 的「owners.json 完全不存在」測試是同一個坑)。
    copyFileSync(CHECK_DOC_ROT_TS, join(root, 'scripts', 'check-doc-rot.ts'));
    copyFileSync(ROOT_TS, join(root, 'scripts', '_root.ts'));

    const r = spawnSync('npx', ['tsx', join(root, 'scripts', 'check-doc-rot.ts'), '--root', root], {
      cwd: root,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });
    const code = r.status ?? -1;
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;

    expect(code).toBe(1);
    expect(output).toContain('找不到 doc-rot.blacklist.json');
    expect(output).toContain('gate=doc-rot result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);
});

describe('check-doc-rot:S9 設定檔壞掉', () => {
  it('doc-rot.blacklist.json 是壞掉的 JSON → 印「設定檔壞掉」,不是未捕捉的堆疊', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'scripts', 'doc-rot.blacklist.json'), '[ broken', 'utf8');
    write(root, 'docs/notes.md', '內容。\n');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('✗ 設定檔壞掉:');
    expect(output).toContain('gate=doc-rot result=FAIL scanned=0');
    expect(output).not.toContain('at JSON.parse');
  }, SPAWN_TIMEOUT_MS);

  it('一筆缺欄位(缺 "reason")→ 每個欄位都是必填,大聲失敗', () => {
    const root = makeRoot();
    writeBlacklist(root, [{ pattern: 'x', since: '2026-01-01', incident: 'P-1' }]);
    write(root, 'docs/notes.md', '內容。\n');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('gate=doc-rot result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);

  it('一筆的 "reason" 是空字串 → 大聲失敗(不可為空)', () => {
    const root = makeRoot();
    writeBlacklist(root, [{ pattern: 'x', reason: '  ', since: '2026-01-01', incident: 'P-1' }]);
    write(root, 'docs/notes.md', '內容。\n');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('不可為空字串');
    expect(output).toContain('gate=doc-rot result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);

  it('一筆的 "pattern" 不是合法正規表達式 → 大聲失敗', () => {
    const root = makeRoot();
    writeBlacklist(root, [{ pattern: '(unclosed', reason: 'r', since: '2026-01-01', incident: 'P-1' }]);
    write(root, 'docs/notes.md', '內容。\n');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('不是合法正規表達式');
    expect(output).toContain('gate=doc-rot result=FAIL scanned=0');
  }, SPAWN_TIMEOUT_MS);
});

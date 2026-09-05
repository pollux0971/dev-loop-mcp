/**
 * P-83 守門(來源 專案 A,2026-09-05,採用模板 1.4.1 之後發現):`template/scripts/**`
 * 底下不准含任何「可照抄的 Stryker CLI 繞過指令」字面值——1.4.1 的
 * `check-doc-rot.test.ts` 測試資料跟出貨的 `doc-rot.blacklist.json` 各自帶一份逐字寫死的
 * Stryker `run` 子指令(三個詞:`npx` + `stryker` + `run`,這裡刻意不連著打,理由見下),
 * 被消費者自己的「不准繞過鎖」掃描器(掃全部文字檔找可照抄的 Stryker CLI 指令,那把鎖是
 * 消費者的變異測試審核上限唯一有意義的入口)當成真的違規命中——對那支掃描器來說,
 * fixture 裡的字面值跟真的貼在文件裡的字面值長得一模一樣。
 *
 * B2(no exemptions anywhere,見 PITFALLS.md P-83):不用 SOURCE 標頭幫「模板同步進來
 * 的檔案」開放白名單——「來源可查」不等於「內容可信」,而且這個豁免會蓋住
 * `template/scripts/` 底下 30 多個檔案,形同幫整個目錄開後門。所以這支守門**連自己
 * (這份測試檔)都不排除**:它自己需要用到的違規字串,一律用陣列 `.join(' ')` 串接
 * 組出來,不留一段連續的字面值——不然這份守門自己就會變成下一個 P-83。
 *
 * 掃描範圍:`template/scripts/**` 底下所有讀得出文字內容的檔案(用「讀不出 utf8 文字」
 * 當二進位檔的判準,例如 `scripts/py/__pycache__/*.pyc`,不特別枚舉副檔名清單——這支
 * 掃描器求的是「掃到即算」,不是「只掃白名單副檔名」),排除 `node_modules`。
 *
 * 命中判準(兩個,任一命中都算):
 *   1. regex `/npx\s+stryker\s+(run|init)/`——`\s+` 允許一個或多個空白字元,涵蓋
 *      單一空格的原始指令,也涵蓋刻意多打幾個空格想閃掉字面比對的變體。
 *   2. 字面 `stryker` + 空格 + `run`(不管前面有沒有 `npx`——直接呼叫本機裝的
 *      `stryker` 執行檔一樣繞得過鎖)。
 *
 * 反向驗證:對一個臨時目錄(放一個用串接組出來的違規字串的檔案)跑同一個掃描函式,
 * 應該要抓到——確認掃描器本身真的會動,不是因為「掃到 0 個檔案」才 0 命中。
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

/** 這份測試檔自己所在的目錄,就是 `template/scripts/`——掃描的目標根目錄。 */
const SCRIPTS_ROOT = resolve(import.meta.dirname);

/** regex 判準:`npx <空白+> stryker <空白+> (run|init)`。 */
const NPX_STRYKER_REGEX = /npx\s+stryker\s+(run|init)/;

/** 字面判準:串接組出來,這個常數本身的原始碼裡不存在一段連續的 `stryker` + 空格 + `run`。 */
const STRYKER_RUN_LITERAL = ['stryker', 'run'].join(' ');

export interface BypassHit {
  /** 相對於掃描根目錄的路徑(posix 分隔)。 */
  file: string;
  /** 1-based 行號。 */
  line: number;
  /** 命中的那一行(trim 過,方便印出來看)。 */
  matched: string;
}

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

/**
 * 掃 `dir` 底下所有檔案(排除 `node_modules`),對每一行套用上面兩個判準。
 * 讀檔失敗(權限、或內容本來就不是合法 utf8——二進位檔常見的症狀)一律當成
 * 「這不是文字檔,跳過」,不讓掃描器自己因為一個 .pyc 檔而炸掉。
 */
export function scanForBypassLiterals(dir: string): BypassHit[] {
  const hits: BypassHit[] = [];

  function walk(current: string): void {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === 'node_modules') continue;
      const full = join(current, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;

      const buf = readFileSync(full);
      // 二進位檔的判準:內容含 NUL byte,或整體讀不出合法 utf8(readFileSync('utf8')
      // 對非法位元組會塞入替代字元 U+FFFD,拿這個當「不是文字檔」的訊號)。
      if (buf.includes(0)) continue;
      const content = buf.toString('utf8');
      if (content.includes('\uFFFD')) continue;

      const lines = content.split('\n');
      lines.forEach((line, i) => {
        if (NPX_STRYKER_REGEX.test(line) || line.includes(STRYKER_RUN_LITERAL)) {
          hits.push({ file: toPosix(relative(dir, full)), line: i + 1, matched: line.trim() });
        }
      });
    }
  }

  walk(dir);
  return hits;
}

describe('no-bypass-literal:template/scripts/** 不准含可照抄的 Stryker CLI 繞過字面(P-83)', () => {
  it('掃真正的 template/scripts/**(含這份測試檔自己)→ 零命中', () => {
    const hits = scanForBypassLiterals(SCRIPTS_ROOT);
    if (hits.length > 0) {
      const detail = hits.map((h) => `  ${h.file}:${h.line}: ${h.matched}`).join('\n');
      throw new Error(`找到 ${hits.length} 處可照抄的 Stryker CLI 繞過字面值(P-83):\n${detail}`);
    }
    expect(hits).toHaveLength(0);
  });

  it('反向驗證:臨時目錄裡放一個含串接組出來的違規字串的檔案 → 掃描器要抓到,不是因為 0 個檔案才 0 命中', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'no-bypass-literal-probe-'));
    try {
      mkdirSync(join(tmpDir, 'nested'), { recursive: true });
      const bypassCmd = ['npx', 'stryker', 'run'].join(' ');
      writeFileSync(join(tmpDir, 'nested', 'probe.md'), `說明文字裡貼了一行:${bypassCmd}\n`, 'utf8');

      const hits = scanForBypassLiterals(tmpDir);

      expect(hits).toHaveLength(1);
      expect(hits[0]!.file).toBe('nested/probe.md');
      expect(hits[0]!.line).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('反向驗證:只有 stryker 執行檔的 run 子指令(沒有 npx 前綴)一樣算命中(直接呼叫本機執行檔一樣繞得過鎖)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'no-bypass-literal-probe-'));
    try {
      const literalOnly = ['stryker', 'run'].join(' ');
      writeFileSync(join(tmpDir, 'probe.sh'), `${literalOnly} --mutate src/foo.ts\n`, 'utf8');

      const hits = scanForBypassLiterals(tmpDir);

      expect(hits).toHaveLength(1);
      expect(hits[0]!.file).toBe('probe.sh');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('反向驗證:node_modules 底下的命中不算(排除清單)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'no-bypass-literal-probe-'));
    try {
      mkdirSync(join(tmpDir, 'node_modules', 'somepkg'), { recursive: true });
      const bypassCmd = ['npx', 'stryker', 'run'].join(' ');
      writeFileSync(join(tmpDir, 'node_modules', 'somepkg', 'README.md'), `${bypassCmd}\n`, 'utf8');

      const hits = scanForBypassLiterals(tmpDir);

      expect(hits).toHaveLength(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/**
 * P-83 guard (source: project A, 2026-09-05, found after adopting template 1.4.1): `template/scripts/**`
 * must not contain any literal of a "copy-pasteable Stryker CLI bypass command". In 1.4.1,
 * the test data in `check-doc-rot.test.ts` and the shipped `doc-rot.blacklist.json` each carried a verbatim hardcoded
 * Stryker `run` subcommand (three words: `npx` + `stryker` + `run`, deliberately not typed together here, see below),
 * and the consumer's own "no bypassing the lock" scanner (it scans all text files for copy-pasteable Stryker CLI commands; that lock is
 * the only meaningful entry point for the consumer's mutation-testing review cap) counted it as a real violation. To that scanner,
 * a literal in a fixture looks exactly the same as a literal really pasted into a document.
 *
 * B2 (no exemptions anywhere, see PITFALLS.md P-83): do not use the SOURCE header to open an allowlist for "files
 * synced in from the template". "Traceable source" does not mean "trusted content", and that exemption would cover
 * the 30+ files under `template/scripts/`, which amounts to opening a back door for the whole directory. So this guard **does not exclude itself either**
 * (this test file): any violating string it needs is always built by joining an array with `.join(' ')`,
 * leaving no contiguous literal, or this guard itself would become the next P-83.
 *
 * Scan scope: every file under `template/scripts/**` whose text content can be read (the "cannot be read as utf8 text" test
 * is the binary-file criterion, e.g. `scripts/py/__pycache__/*.pyc`; there is no list of extensions. This
 * scanner wants "count it if scanned", not "scan only allowlisted extensions"), excluding `node_modules`.
 *
 * Hit criteria (two; either one counts):
 *   1. regex `/npx\s+stryker\s+(run|init)/`. `\s+` allows one or more whitespace characters, covering
 *      the original command with a single space and also variants that deliberately add extra spaces to dodge a literal match.
 *   2. The literal `stryker` + space + `run` (whether or not `npx` precedes it: calling the locally installed
 *      `stryker` executable directly bypasses the lock just the same).
 *
 * Reverse check: run the same scan function on a temp dir (holding a file with a violating string built by concatenation);
 * it must catch it. This confirms the scanner really works and doesn't show 0 hits just because "0 files were scanned".
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { makeIsolatedTempDir } from './_root.js';

/** The directory this test file lives in is `template/scripts/`, the root directory to scan. */
const SCRIPTS_ROOT = resolve(import.meta.dirname);

/** Regex criterion: `npx <whitespace+> stryker <whitespace+> (run|init)`. */
const NPX_STRYKER_REGEX = /npx\s+stryker\s+(run|init)/;

/** Literal criterion: built by concatenation, so the source of this constant itself has no contiguous `stryker` + space + `run`. */
const STRYKER_RUN_LITERAL = ['stryker', 'run'].join(' ');

export interface BypassHit {
  /** Path relative to the scan root (posix separators). */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The matching line (trimmed, easier to print). */
  matched: string;
}

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

/**
 * Scan all files under `dir` (excluding `node_modules`) and apply the two criteria above to each line.
 * A read failure (permissions, or content that is not valid utf8, a common symptom of binary files) is always treated as
 * "not a text file, skip", so the scanner itself doesn't blow up on a .pyc file.
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
      // Binary-file criterion: the content has a NUL byte, or cannot be read as valid utf8 as a whole (readFileSync('utf8')
      // puts the replacement character U+FFFD in place of illegal bytes; use that as the "not a text file" signal).
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
    const tmpDir = makeIsolatedTempDir('no-bypass-literal-probe-');
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
    const tmpDir = makeIsolatedTempDir('no-bypass-literal-probe-');
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
    const tmpDir = makeIsolatedTempDir('no-bypass-literal-probe-');
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

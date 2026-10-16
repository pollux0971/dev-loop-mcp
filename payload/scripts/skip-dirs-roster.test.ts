/**
 * Roster for the shared exclusion layer (1.7.0, DECISIONS_NEEDED #13; the structural version of P-90 / P-91).
 *
 * Background: the same disease showed up four times in one day. The shared thing existed, but someone bypassed it and made their own copy:
 *   - P-90: `.stryker-tmp` was only in `check-doc-links.ts`'s own list, and the other 8 scanners all walked into the mutation sandbox;
 *   - 1.6.3: `check-doc-rot.ts` copied its own `skipDirs` merge logic, so the hard glob error newly added to the shared layer did not apply to it;
 *   - 1.6.5: `check-doc-links.ts`, the same shape;
 *   - 1.6.9: the language detection in `sync-gates.sh` carried its own exclusion list (that one was cross-language; `sync-gates.test.sh`
 *     step 11 asserts the difference set is empty, so it is out of reach of this test).
 *
 * The fix P-91 wrote back then was a general rule: "every time a check is added to the shared layer, go back and confirm nobody bypasses the shared layer".
 * **That is a rule someone has to remember**, and each of the four times it was found only after running into it. grep only ever catches
 * the words you can think of at that moment (the coordinator in 1.6.3 used `grep -l stryker-tmp` to find "which others carry their own list"; that approach only finds
 * those that "carry the same **value**", and structurally cannot find those that "carry the same **logic**").
 * The roster is the structural version of the same rule: it enumerates the directory instead of keeping a hand-copied list, so a new scanner cannot be missed.
 *
 * ## Rule
 *
 * Every `scripts/check-*.ts` (test files excluded) that **touches exclusion logic** (the source contains `skipDirs` or
 * `DEFAULT_SKIP_DIRS`) must pick one of two:
 *   (1) call the shared `resolveSkipDirs(`; or
 *   (2) be listed in `EXEMPT` below, **with a reason**.
 * Neither → red, and the message names which one.
 *
 * ## Exemptions must cost something (hard rule)
 *
 * The exemption entry **requires a reason**, and the reason has a minimum length. Otherwise the roster would degrade into "add whatever was missed to the exemption list and it goes green",
 * which is exactly the failure mode that sank the original #8 proposal (the mechanism diluted by how it is used). Two more anti-rot rules:
 *   - A file named by an exemption must really exist (an exemption left over after a rename or delete → red);
 *   - An exempted file **must not** already call `resolveSkipDirs(` (that exemption has expired, and keeping it would make the next person think
 *     that scanner still takes a detour) → red.
 *
 * ## Why literal matching is still fine (the four places from P-89)
 *
 * This is a literal scan, so the four false-hit places P-89 mentions (comments, log strings, fixtures, doc examples) all happen:
 * a scanner that mentions `skipDirs` only in a **comment** is also required to pick one of two. **That is a deliberately conservative direction**:
 * the cost of a false positive is "write one line of reason", the cost of a false negative is "another silent bypass"; the former is visible, the latter is not.
 * The opposite direction (a scanner really merges its own list but the source happens not to contain those two words) has no known way to be written at present,
 * because the starting point of a merge is always `DEFAULT_SKIP_DIRS` or the consumer's `skipDirs`.
 *
 * ## Positive control
 *
 * At least `MIN_SHARED` scanners must be judged as "calls the shared layer". Scanning 0 is not "very clean", it means this roster is broken
 * (wrong directory path, wrong pattern). Same rule as P-32.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

/** Pattern that decides a file touches exclusion logic. */
const TOUCHES_SKIP = /\bskipDirs\b|\bDEFAULT_SKIP_DIRS\b/;
/** Pattern that decides a file calls the shared layer. */
const CALLS_SHARED = /\bresolveSkipDirs\s*\(/;

/** Minimum length of an exemption reason; exemptions must cost something. */
const MIN_REASON_LENGTH = 40;

/** Positive control: at least this many scanners must be judged as calling the shared layer. Seen in a real run at 1.7.0: 7; after v4.1 removed doc-rot / doc-links / known-defects: 4. */
const MIN_SHARED = 4;

/**
 * Scanners that touch exclusion logic but **deliberately do not** call `resolveSkipDirs()`. Each entry must make clear:
 * what it uses that list for, and why the population for that use differs from "which directories the consumer wants excluded" (P-92's "ask about the population first").
 */
const EXEMPT: Record<string, string> = {
  'check-dry-run.ts':
    '`CWD_SCAN_SKIP` 只用來往下找 cucumber 設定檔所在的目錄(決定要在哪個 cwd 跑 cucumber),' +
    '不是掃描要判定的檔案集合;consumer 的 `skipDirs` 是「哪些目錄的內容不算數」,母體不同(P-92)。' +
    '若把 consumer 的 skipDirs 套進來,排掉的會是設定檔的搜尋路徑而不是掃描對象,語意錯位。',
};

function listScannerFiles(): string[] {
  return readdirSync(SCRIPTS_DIR)
    .filter((f) => /^check-.*\.ts$/.test(f) && !f.endsWith('.test.ts'))
    .sort();
}

function source(file: string): string {
  return readFileSync(join(SCRIPTS_DIR, file), 'utf8');
}

describe('skipDirs 名冊:碰到排除邏輯的掃描器,必須呼叫共用的 resolveSkipDirs() 或附理由豁免', () => {
  const files = listScannerFiles();
  const touching = files.filter((f) => TOUCHES_SKIP.test(source(f)));
  const shared = touching.filter((f) => CALLS_SHARED.test(source(f)));

  it('陽性對照:目錄列舉真的有掃到掃描器,且足夠多支判定為呼叫共用層(掃到 0 是名冊壞了)', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(shared.length).toBeGreaterThanOrEqual(MIN_SHARED);
  });

  it.each(files)('%s:碰到排除邏輯 → 要嘛呼叫 resolveSkipDirs(),要嘛在 EXEMPT 附理由', (file) => {
    if (!touching.includes(file)) return; // A scanner that doesn't touch exclusion logic is out of reach of this rule
    const callsShared = CALLS_SHARED.test(source(file));
    const exempt = Object.prototype.hasOwnProperty.call(EXEMPT, file);
    expect(
      callsShared || exempt,
      `${file} 碰到了排除邏輯(出現 skipDirs / DEFAULT_SKIP_DIRS),但沒有呼叫共用的 resolveSkipDirs(),` +
        `也不在 EXEMPT。自己合併一份的話,共用層以後加的檢查(例如 1.6.3 的 glob 硬錯)對它不會生效。` +
        `改成呼叫 resolveSkipDirs();真的母體不同才加進 EXEMPT 並寫清楚理由(P-91)。`,
    ).toBe(true);
  });

  it.each(Object.entries(EXEMPT))('豁免 %s:理由夠長、檔案存在、而且真的沒有呼叫共用層(不是過期豁免)', (file, reason) => {
    expect(reason.trim().length, `${file} 的豁免理由太短——豁免要貴一點,否則名冊會退化成「補進豁免就綠了」`).toBeGreaterThanOrEqual(
      MIN_REASON_LENGTH,
    );
    expect(existsSync(join(SCRIPTS_DIR, file)), `豁免指名的 ${file} 不存在(改名或刪檔後殘留的豁免)`).toBe(true);
    expect(
      CALLS_SHARED.test(source(file)),
      `${file} 已經呼叫 resolveSkipDirs(),這筆豁免過期了——刪掉它,不然下一個人會以為那支還在繞路`,
    ).toBe(false);
  });
});

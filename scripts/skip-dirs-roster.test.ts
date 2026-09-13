/**
 * 共用排除層的名冊(1.7.0,DECISIONS_NEEDED #13;P-90 / P-91 的結構版)。
 *
 * 背景:同一個病在一天內出現了四次——共用的東西存在,卻有人繞過它自己做一份:
 *   - P-90:`.stryker-tmp` 只在 `check-doc-links.ts` 自帶清單裡,另外 8 支掃描器全踩進變異沙箱;
 *   - 1.6.3:`check-doc-rot.ts` 自己複製了一份 `skipDirs` 合併邏輯,共用層新加的 glob 硬錯對它不生效;
 *   - 1.6.5:`check-doc-links.ts` 同一個形狀;
 *   - 1.6.9:`sync-gates.sh` 的語言偵測自帶排除清單(那一次跨語言,由 `sync-gates.test.sh`
 *     步驟 11 斷言差集為空,不在這支的射程內)。
 *
 * P-91 當時寫的修法是一條通則:「每次在共用層加檢查,都要回頭確認沒有人繞過共用層」。
 * **那是一條要人記得的規則**,而那四次每一次都是撞上才發現——grep 永遠只抓得到當下想得到的
 * 那幾個字(協調者 1.6.3 時用 `grep -l stryker-tmp` 查「還有哪支自帶清單」,那個查法只找得到
 * 「自帶同一個**值**」的,結構上就找不到「自帶同一段**邏輯**」的)。
 * 名冊是同一條規則的結構版:目錄列舉,不是手抄清單,新掃描器加進來時不可能漏掉。
 *
 * ## 規則
 *
 * 每一支 `scripts/check-*.ts`(不含測試檔)只要**碰到排除邏輯**(原始碼出現 `skipDirs` 或
 * `DEFAULT_SKIP_DIRS`),就必須二選一:
 *   (1) 呼叫共用的 `resolveSkipDirs(`;或
 *   (2) 列在下面的 `EXEMPT`,**附理由**。
 * 兩邊都沒有 → 紅,訊息指名是哪一支。
 *
 * ## 豁免要貴一點(硬性)
 *
 * 豁免欄**必填理由**,而且理由有最短長度——否則名冊會退化成「把漏掉的補進豁免清單就綠了」,
 * 那正是 #8 原案被打掉的失效模式(機制被自己的使用方式稀釋)。另外兩條防腐:
 *   - 豁免指名的檔案必須真的存在(改名或刪檔後殘留的豁免 → 紅);
 *   - 豁免的檔案**不准**其實已經呼叫 `resolveSkipDirs(`(那筆豁免已經過期,留著會讓下一個人以為
 *     那支還在繞路)→ 紅。
 *
 * ## 為什麼用字面比對仍然可以(P-89 的四個位置)
 *
 * 這支是字面掃描,所以 P-89 說的四個假命中位置(註解、log 字串、fixture、文件舉例)都會發生:
 * 一支只在**註解**裡提到 `skipDirs` 的掃描器也會被要求二選一。**那是刻意的保守方向**——
 * 假陽性的代價是「寫一行理由」,假陰性的代價是「又一次靜默繞過」;前者可見,後者不可見。
 * 反方向(一支真的自己合併清單,但原始碼裡剛好沒出現那兩個字)目前沒有已知寫法做得到,
 * 因為合併的起點一定是 `DEFAULT_SKIP_DIRS` 或 consumer 的 `skipDirs`。
 *
 * ## 陽性對照
 *
 * 至少要有 `MIN_SHARED` 支被判定為「呼叫共用層」。掃到 0 支不是「很乾淨」,是這支名冊壞了
 * (目錄路徑錯、樣式錯)——跟 P-32 同一條規則。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

/** 碰到排除邏輯的判定字樣。 */
const TOUCHES_SKIP = /\bskipDirs\b|\bDEFAULT_SKIP_DIRS\b/;
/** 呼叫共用層的判定字樣。 */
const CALLS_SHARED = /\bresolveSkipDirs\s*\(/;

/** 豁免理由的最短長度——豁免要貴一點。 */
const MIN_REASON_LENGTH = 40;

/** 陽性對照:至少要有這麼多支被判定為呼叫共用層。1.7.0 當下實測為 7 支。 */
const MIN_SHARED = 5;

/**
 * 碰到排除邏輯、但**刻意不**呼叫 `resolveSkipDirs()` 的掃描器。每一筆都要說清楚:
 * 它用那份清單做什麼、那個用途的母體為什麼跟「consumer 要排除哪些目錄」不同(P-92 的「先問母體」)。
 */
const EXEMPT: Record<string, string> = {
  'check-dry-run.ts':
    '`CWD_SCAN_SKIP` 只用來往下找 cucumber 設定檔所在的目錄(決定要在哪個 cwd 跑 cucumber),' +
    '不是掃描要判定的檔案集合;consumer 的 `skipDirs` 是「哪些目錄的內容不算數」,母體不同(P-92)。' +
    '若把 consumer 的 skipDirs 套進來,排掉的會是設定檔的搜尋路徑而不是掃描對象,語意錯位。',
  'check-phase-coverage.ts':
    '同 `check-dry-run.ts`:`CWD_SCAN_SKIP` 只用於定位 cucumber 設定檔目錄;phase 檔的收集走' +
    ' `features/<NN-name>/phase-*.feature` 的固定樣式,不是自由走訪,consumer 的 skipDirs 對它沒有對應的語意(P-92)。',
  'check-known-defects.ts':
    '同 `check-dry-run.ts`:`CWD_SCAN_SKIP` 只用於往下找 cucumber 設定檔目錄,不是掃描要判定的檔案集合(P-92)。' +
    '這筆豁免是名冊第一次跑時才發現缺的——1.6.x 的手動盤點把這支標成「沒用到排除清單」,因為 shell grep 在這個檔上靜默沒有輸出。',
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
    if (!touching.includes(file)) return; // 沒碰排除邏輯的掃描器不在這條規則的射程內
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

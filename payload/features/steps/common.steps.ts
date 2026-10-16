/**
 * 通用步驟:同一句話在兩個以上的 feature 資料夾出現,就只能在這裡定義一次
 * (cucumber 對重複定義直接報錯)。各功能的步驟檔負責把值填進 World,這裡只讀。
 *
 * v2:這個檔只有 `shared/steps` 節點能改(worker 的 allowed_paths 不含它)。worker 需要新句子就先寫在
 * 自己的 `features/steps/<能力>.steps.ts`;兩個能力都要用時,在 report 的 ticket_problems 提出,由 shared/steps 收斂。
 */
import { Given, When, Then } from '@cucumber/cucumber';
import { strict as assert } from 'node:assert';
import type { ProjectWorld } from './_world.js';

// ---------------------------------------------------------------- Given

// 例:兩個以上的 UI 類功能共用同一句 Background,用 tag 分派到各自的建置邏輯,
// 避免 cucumber 的 ambiguous-step 錯誤(兩個功能各自的步驟檔不准再定義這句)。
//
// Given('the development server is running against the rich fixture set', async function (this: ProjectWorld) {
//   if (this.tags.includes('@feature-a')) {
//     await buildFeatureAState(this);
//   } else if (this.tags.includes('@feature-b')) {
//     await buildFeatureBState(this);
//   } else {
//     throw new Error('未知的功能 tag,無法判斷要建立哪個功能的 fixture 狀態');
//   }
// });

// 例:載入一份由前一個整合點產生的真實資料目錄。
//
// Given('a data directory populated by the I1 pipeline', function (this: ProjectWorld) {
//   this.useFixture('minimal-dataset');
// });

// 日期格式允許有無引號兩種寫法都接,方便不同功能的作者各自習慣的寫法
Given(/^today is "?(\d{4}-\d{2}-\d{2})"?$/, function (this: ProjectWorld, date: string) {
  this.today = date;
});

// 需要外部服務(LLM / 第三方 API)的功能:各功能的 When 讀 this.useFakeRouter
// 決定要不要建自己的假實作。沒有外部服務依賴的專案可以整段刪掉。
Given('a fake router replaying the recorded fixtures', function (this: ProjectWorld) {
  this.useFakeRouter = true;
  this.llmCalls = [];
  this.networkRequests = [];
});

// 例:載入一份核心實體的原文,各功能用自己的 parser 處理 this.fixtureText。
// 原專案在這裡定義了 「a card with three example fences」 之類的句子,讀取
// contracts/fixtures/ 底下對應核心實體的合法/邊界樣本檔案。依你的核心實體改寫:
//
// Given('a note with a body over the length limit', function (this: ProjectWorld) {
//   this.fixtureText = this.readFixture('notes/invalid-too-long.md');
// });

// ---------------------------------------------------------------- When

// dev server 類功能:啟動、等 ready、關掉。Then 用「the server starts」
When('the standalone dev command is run', { timeout: 90_000 }, async function (this: ProjectWorld) {
  await this.startDevServer();
});

// ---------------------------------------------------------------- Then

Then('it exits with status {int}', function (this: ProjectWorld, code: number) {
  assert.ok(this.lastRun, '還沒有跑過任何指令(When 要呼叫 runStandalone / runCommand)');
  assert.equal(
    this.lastRun.status,
    code,
    `退出碼應為 ${code},實際 ${this.lastRun.status}\n${this.lastRun.output.trim().split('\n').slice(-15).join('\n')}`,
  );
});

Then('the server starts', function (this: ProjectWorld) {
  assert.ok(this.lastRun, '還沒有啟動 dev server');
  assert.equal(this.lastRun.status, 0, `dev server 沒有在時限內 ready:\n${this.lastRun.output.slice(-800)}`);
});

// 多個功能各有一種說法,語意相同:沒有碰模型也沒有碰網路
for (const phrase of [
  'it makes no model call',
  'no model call is made',
  'no network request is made',
  'no network connection is attempted',
  'no network request leaves the machine',
]) {
  Then(phrase, function (this: ProjectWorld) {
    assert.deepEqual(this.llmCalls, [], `不該有模型呼叫:${JSON.stringify(this.llmCalls)}`);
    assert.deepEqual(this.networkRequests, [], `不該有網路請求:${JSON.stringify(this.networkRequests)}`);
  });
}

// 純函式檢查。When 要先 this.trackInput(input),再把回傳值放進 lastResult
Then('the original object is unchanged', function (this: ProjectWorld) {
  assert.ok(this.inputSnapshot !== undefined, 'When 步驟要先呼叫 this.trackInput(input)');
  assert.equal(JSON.stringify(this.inputRef), this.inputSnapshot, '輸入物件被修改了');
});

Then('a new object is returned', function (this: ProjectWorld) {
  assert.ok(this.inputRef !== undefined, 'When 步驟要先呼叫 this.trackInput(input)');
  assert.notStrictEqual(this.lastResult, this.inputRef, '回傳的是同一個物件,不是新物件');
});

/**
 * 「the result is X」:多個功能共用這句(pass/fail 類、也接自由文字)。
 * 比對規則:
 *   1. 期望值是 pass/fail 類的字眼 → 取 lastResult 的布林(本身是布林,或物件的 ok/pass/valid/met/success 欄位)
 *   2. 否則用文字比對:先看 resultText,沒有就把原始值 String(),物件則 JSON.stringify()
 */
const PASS_WORDS = new Set(['a pass', 'pass', 'passes', 'valid', 'ok', 'met', 'true', 'yes']);
const FAIL_WORDS = new Set(['a failure', 'failure', 'fail', 'fails', 'invalid', 'not met', 'false', 'no']);
const BOOL_KEYS = ['ok', 'pass', 'valid', 'met', 'success'] as const;

Then('the result is {}', function (this: ProjectWorld, expectedRaw: string) {
  const expected = expectedRaw.trim().replace(/^"(.*)"$/, '$1');
  const lower = expected.toLowerCase();
  const isPass = PASS_WORDS.has(lower);
  const isFail = FAIL_WORDS.has(lower);

  if (isPass || isFail) {
    const actual = booleanOf(this.lastResult);
    assert.notEqual(actual, undefined, `lastResult 沒有可判斷的布林(本身或 ${BOOL_KEYS.join('/')} 欄位):${JSON.stringify(this.lastResult)}`);
    assert.equal(actual, isPass, `期望 ${expected},實際 ${actual ? 'pass' : 'fail'};error=${this.lastError?.message ?? '無'}`);
    return;
  }

  const actualText =
    this.resultText ??
    (this.lastResult !== null && typeof this.lastResult === 'object'
      ? JSON.stringify(this.lastResult)
      : String(this.lastResult));
  assert.equal(actualText, expected);
});

function booleanOf(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v && typeof v === 'object') {
    for (const k of BOOL_KEYS) {
      const x = (v as Record<string, unknown>)[k];
      if (typeof x === 'boolean') return x;
    }
  }
  return undefined;
}

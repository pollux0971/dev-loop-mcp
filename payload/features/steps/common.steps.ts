/**
 * Common steps: a sentence that appears in two or more feature folders can be defined only once, here
 * (cucumber errors out on duplicate definitions). Each feature's step file fills values into the World; this file only reads.
 *
 * v2: only the `shared/steps` node may change this file (the worker's allowed_paths does not include it). When a worker needs a new sentence, write it first in
 * its own `features/steps/<capability>.steps.ts`; when two capabilities both need it, raise it in the report's ticket_problems and shared/steps will consolidate.
 */
import { Given, When, Then } from '@cucumber/cucumber';
import { strict as assert } from 'node:assert';
import type { ProjectWorld } from './_world.js';

// ---------------------------------------------------------------- Given

// Example: two or more UI features share the same Background sentence and dispatch by tag to their own setup logic,
// avoiding cucumber's ambiguous-step error (neither feature's own step file may define this sentence again).
//
// Given('the development server is running against the rich fixture set', async function (this: ProjectWorld) {
//   if (this.tags.includes('@feature-a')) {
//     await buildFeatureAState(this);
//   } else if (this.tags.includes('@feature-b')) {
//     await buildFeatureBState(this);
//   } else {
//     throw new Error('Unknown feature tag; cannot tell which feature fixture state to build');
//   }
// });

// Example: load a real data directory produced by the previous integration point.
//
// Given('a data directory populated by the I1 pipeline', function (this: ProjectWorld) {
//   this.useFixture('minimal-dataset');
// });

// Accept the date with or without quotes, so authors of different features can keep their own habit
Given(/^today is "?(\d{4}-\d{2}-\d{2})"?$/, function (this: ProjectWorld, date: string) {
  this.today = date;
});

// For features that need an external service (LLM / third-party API): each feature's When reads this.useFakeRouter
// to decide whether to build its own fake. A project without external service dependencies can delete this whole block.
Given('a fake router replaying the recorded fixtures', function (this: ProjectWorld) {
  this.useFakeRouter = true;
  this.llmCalls = [];
  this.networkRequests = [];
});

// Example: load the raw text of a core entity; each feature handles this.fixtureText with its own parser.
// The original project defined sentences here like "a card with three example fences", reading
// valid/boundary sample files for the core entity under contracts/fixtures/. Rewrite for your own core entity:
//
// Given('a note with a body over the length limit', function (this: ProjectWorld) {
//   this.fixtureText = this.readFixture('notes/invalid-too-long.md');
// });

// ---------------------------------------------------------------- When

// For dev-server features: start, wait for ready, shut down. Then uses "the server starts"
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

// Several features each have their own phrasing with the same meaning: no model and no network was touched
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

// Pure-function check. When must call this.trackInput(input) first, then put the return value into lastResult
Then('the original object is unchanged', function (this: ProjectWorld) {
  assert.ok(this.inputSnapshot !== undefined, 'When 步驟要先呼叫 this.trackInput(input)');
  assert.equal(JSON.stringify(this.inputRef), this.inputSnapshot, '輸入物件被修改了');
});

Then('a new object is returned', function (this: ProjectWorld) {
  assert.ok(this.inputRef !== undefined, 'When 步驟要先呼叫 this.trackInput(input)');
  assert.notStrictEqual(this.lastResult, this.inputRef, '回傳的是同一個物件,不是新物件');
});

/**
 * "the result is X": several features share this sentence (pass/fail kind, and free text too).
 * Matching rules:
 *   1. If the expected value is a pass/fail word → take the boolean of lastResult (itself a boolean, or the object's ok/pass/valid/met/success field)
 *   2. Otherwise compare as text: look at resultText first; if absent, String() a primitive, or JSON.stringify() an object
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

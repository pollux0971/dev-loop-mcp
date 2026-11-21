// v4.12: the python stack (stacks/python), stack-declared "red for the wrong reason" patterns, and brownfield Python with a virtualenv.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { badRedReason, checkAcceptance } from '../tools/lib/verify/script-checks.mjs';

const PY_BAD_RED = [
  { pattern: 'StepDefinitionNotFoundError', why: 'unbound' },
  { pattern: '\\b(IndentationError|TabError)\\b', why: 'broken' },
];

describe('bad_red: stack patterns', () => {
  test('stack patterns are tested on top of the core ones', () => {
    const unbound = 'E   pytest_bdd.exceptions.StepDefinitionNotFoundError: Step definition is not found: Given "a list". Line 3 in scenario "x"';
    assert.equal(badRedReason(unbound, PY_BAD_RED), 'unbound');
    assert.equal(badRedReason(unbound), null, 'without the stack the core does not know pytest-bdd');
    assert.equal(badRedReason('E     IndentationError: unexpected indent', PY_BAD_RED), 'broken');
    assert.equal(badRedReason('TabError: inconsistent use of tabs', PY_BAD_RED), 'broken');
    assert.match(badRedReason('  File "x.py", line 2\n    def (\n        ^\nSyntaxError: invalid syntax', PY_BAD_RED), /語法錯誤/);
  });

  test('a missing implementation module stays a normal red', () => {
    for (const out of [
      "E   ModuleNotFoundError: No module named 'todo'",
      "ImportError while importing test module '/p/src/todo/test_todo.py'.\nE   ImportError: cannot import name 'add' from 'todo.core'",
      '1 failed, 2 passed in 0.05s',
    ]) assert.equal(badRedReason(out, PY_BAD_RED), null, out);
  });

  test('a broken pattern in a stack is ignored, not a crash', () => {
    assert.equal(badRedReason('anything', [{ pattern: '(', why: 'x' }]), null);
  });

  test('checkAcceptance uses config.stack_add.bad_red for an expected red', () => {
    const ex = { sh: () => ({ code: 1, stdout: 'StepDefinitionNotFoundError: Step definition is not found', stderr: '' }) };
    const config = { verify: { rerun_timeout_seconds: 5 }, stack_add: { bad_red: PY_BAD_RED } };
    const [r] = checkAcceptance(ex, { acceptance: [{ cmd: 'accept', expect_exit: -1 }] }, config);
    assert.equal(r.outcome, 'FAIL');
    assert.match(r.detail, /unbound/);
    const ok = { sh: () => ({ code: 1, stdout: "ModuleNotFoundError: No module named 'todo'", stderr: '' }) };
    assert.equal(checkAcceptance(ok, { acceptance: [{ cmd: 'accept', expect_exit: -1 }] }, config)[0].outcome, 'PASS');
  });
});

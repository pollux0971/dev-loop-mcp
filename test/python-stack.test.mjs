// v4.12: the python stack (stacks/python), stack-declared "red for the wrong reason" patterns, and brownfield Python with a virtualenv.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { detectProject } from '../tools/lib/brownfield.mjs';
import { loadConfig } from '../tools/lib/config.mjs';
import { doctor } from '../tools/lib/doctor.mjs';
import { init, upgrade } from '../tools/lib/install.mjs';
import { sandboxExec, withJudgeEnv } from '../tools/lib/sandbox.mjs';
import { setup } from '../tools/lib/setup.mjs';
import { loadStack, stackName } from '../tools/lib/stack.mjs';
import { readJson, run, writeJson } from '../tools/lib/util.mjs';
import { badRedReason, checkAcceptance, hostExecutor } from '../tools/lib/verify/script-checks.mjs';
import { readEvents } from '../tools/lib/ledger.mjs';
import { FAKE_VERIFIER, REPO, addNode, cleanup, sh, tempDir, tickUntil } from './helpers.mjs';

after(cleanup);

const hasPython = run('python3 -c "import sys; assert sys.version_info >= (3, 10)"').code === 0;
const pyProject = () => {
  const proj = join(tempDir(), 'py');
  init(proj, { name: 'pyapp', stack: 'python' });
  return proj;
};

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

describe('python stack', () => {
  test('stack.json loads; detect is empty so it is never picked without project.stack', () => {
    const st = loadStack('python');
    assert.deepEqual(st.detect, []);
    assert.equal(st.accept_cmd, '.venv/bin/python scripts/accept.py {gherkin}');
    assert.deepEqual(st.accept_probe, { file: 'scripts/accept.py' });
    assert.deepEqual(st.add.bad_red.map((b) => b.pattern), ['StepDefinitionNotFoundError', '\\b(IndentationError|TabError)\\b']);
  });

  test('projects from before 4.12 without project.stack resolve as before (python is never detected)', () => {
    const py = tempDir();
    writeFileSync(join(py, 'pyproject.toml'), '[project]\nname = "x"\n');
    writeFileSync(join(py, 'requirements.txt'), 'pytest\n');
    assert.equal(stackName(py, {}), 'none');
    const node = tempDir();
    writeJson(join(node, 'package.json'), { name: 'x' });
    writeFileSync(join(node, 'pyproject.toml'), '');
    assert.equal(stackName(node, {}), 'node-ts');
    assert.equal(stackName(py, { project: { stack: 'python' } }), 'python');
  });

  test('init --stack python: template, .gitignore lines, project.stack, one clean commit', () => {
    const proj = pyProject();
    for (const f of ['pyproject.toml', 'requirements-dev.txt', 'scripts/accept.py', 'features/steps/README.md', 'src/test_layout.py',
      'tools/stacks/python/stack.json', 'tools/stacks/python/rules.md']) assert.ok(existsSync(join(proj, f)), f);
    for (const f of ['package.json', 'tsconfig.json', 'cucumber.js']) assert.ok(!existsSync(join(proj, f)), `${f} is node-ts only`);
    assert.match(readFileSync(join(proj, 'pyproject.toml'), 'utf8'), /name = "pyapp"/);
    const ignore = readFileSync(join(proj, '.gitignore'), 'utf8').split('\n');
    for (const l of ['.venv/', '__pycache__/', '.pytest_cache/', '.dlm/']) assert.ok(ignore.includes(l), l);
    assert.equal(readJson(join(proj, 'dlm.config.json')).project.stack, 'python');
    assert.equal(sh(proj, 'git status --porcelain'), '');
    const manifest = readJson(join(proj, '.dlm-install.json'));
    assert.equal(manifest.stack, 'python');
    assert.ok(!('pyproject.toml' in manifest.files), 'pyproject.toml is the user\'s (seed-only)');
    assert.ok('scripts/accept.py' in manifest.files, 'accept.py is dlm\'s (upgraded)');
  });

  test('config of a python project: deps, gates, tests, forbidden, rerun prefixes', () => {
    const c = loadConfig(pyProject());
    assert.equal(c.project.stack, 'python');
    assert.equal(c.project.language, 'python');
    assert.deepEqual(c.deps.dirs, ['.venv']);
    assert.equal(c.deps.install, null);
    assert.deepEqual(c.deps.judge_env, { PYTHONPYCACHEPREFIX: '{tmp}' });
    assert.equal(c.deps.setup.dir, '.venv');
    assert.deepEqual(c.gates.chain, ['check:dlm', 'test', 'accept']);
    assert.equal(c.gates.commands.test, '.venv/bin/python -m pytest -q src');
    assert.equal(c.verify.dry_run_cmd, null);
    assert.equal(c.verify.mutation.cmd, null);
    for (const t of ['**/test_*.py', '**/*_test.py', 'features/steps/**']) assert.ok(c.paths.tests.includes(t), t);
    for (const f of ['pyproject.toml', 'requirements*.txt', 'conftest.py', 'scripts/**']) assert.ok(c.paths.forbidden.includes(f), f);
    for (const r of ['.venv/bin/python -m pytest', '.venv/bin/python scripts/accept.py']) assert.ok(c.verify.rerun_allow.includes(r), r);
  });

  test('setup offers to build .venv (answer id npm_install, label from the stack); doctor warns while it is missing', async () => {
    const proj = pyProject();
    const asked = [];
    await setup(proj, {
      ask: async (q) => { asked.push(q); return q.id === 'npm_install' ? 'n' : ''; },
      detect: { claude: true }, project: { language: 'python', test: {}, code_files: 0, test_files: 0, suggested_mode: 'greenfield', scripts: [] }, log: () => {},
    });
    const q = asked.find((x) => x.id === 'npm_install');
    assert.ok(q, 'the dependency question was asked');
    assert.match(q.text, /建立 \.venv 並安裝 requirements-dev\.txt/);
    const rep = await doctor(proj);
    const deps = rep.results.find((r) => r.name === '依賴');
    assert.equal(deps?.status, 'warn');
    assert.match(deps.detail, /有 pyproject\.toml但沒有 \.venv/);
    assert.match(deps.fix, /python3 -m venv \.venv/);
    mkdirSync(join(proj, '.venv'));
    assert.ok(!(await doctor(proj)).results.some((r) => r.name === '依賴'));
  });
});

describe('judging environment (PYTHONPYCACHEPREFIX)', () => {
  const cfg = { deps: { judge_env: { PYTHONPYCACHEPREFIX: '{tmp}', X_FIXED: 'a' } } };

  test('sandboxExec and hostExecutor give each judged run a fresh prefix directory, removed afterwards', () => {
    const cwd = tempDir();
    const a = sandboxExec(cfg, 'gates', 'test -d "$PYTHONPYCACHEPREFIX" && echo "$PYTHONPYCACHEPREFIX $X_FIXED"', { cwd, env: { PYTHONPYCACHEPREFIX: '/caller' } });
    assert.equal(a.code, 0, a.stderr);
    const [dirA, fixed] = a.stdout.trim().split(' ');
    assert.equal(fixed, 'a');
    assert.notEqual(dirA, '/caller', 'the judging env wins over the caller');
    assert.ok(!existsSync(dirA), 'removed after the run');
    const b = hostExecutor(cwd, cfg).sh('test -d "$PYTHONPYCACHEPREFIX" && echo "$PYTHONPYCACHEPREFIX"');
    assert.equal(b.code, 0);
    assert.notEqual(b.stdout.trim(), dirA);
    assert.ok(!existsSync(b.stdout.trim()));
    assert.equal(hostExecutor(cwd).sh('echo "[$X_FIXED]"').stdout.trim(), '[]', 'no config, no judging env');
    assert.deepEqual(withJudgeEnv({}, (e) => e), {});
  });

  test('a python project\'s config carries it into the verify executor', () => {
    const c = loadConfig(pyProject());
    const r = hostExecutor(tempDir(), c).sh('echo "$PYTHONPYCACHEPREFIX"');
    assert.match(r.stdout.trim(), /dlm-judge-/);
  });

  test('a forged .pyc next to an untouched .py is not used by a judged run', { skip: !hasPython && 'python3 >= 3.10 not found' }, () => {
    const root = tempDir();
    const lib = join(root, '.venv', 'lib');
    const forge = join(root, 'forge');
    mkdirSync(lib, { recursive: true });
    mkdirSync(forge);
    writeFileSync(join(lib, 'victim.py'), 'X = 1\n');
    writeFileSync(join(forge, 'victim.py'), 'X = 2\n');
    const st = statSync(join(lib, 'victim.py'));
    utimesSync(join(forge, 'victim.py'), st.atime, st.mtime);
    const tag = execFileSync('python3', ['-c', 'import sys; print(sys.implementation.cache_tag)']).toString().trim();
    mkdirSync(join(lib, '__pycache__'));
    execFileSync('python3', ['-c', `import py_compile; py_compile.compile(${JSON.stringify(join(forge, 'victim.py'))}, cfile=${JSON.stringify(join(lib, '__pycache__', `victim.${tag}.pyc`))})`]);
    const probe = `python3 -c "import sys; sys.path.insert(0, '.venv/lib'); import victim; print(victim.X)"`;
    assert.equal(run(probe, { cwd: root }).stdout.trim(), '2', 'without the prefix Python loads the forged bytecode');
    assert.equal(hostExecutor(root, cfg).sh(probe).stdout.trim(), '1', 'a judged run reads the source');
    assert.equal(sandboxExec(cfg, 'gates', probe, { cwd: root }).stdout.trim(), '1');
  });
});

describe('scripts/accept.py', { skip: !hasPython && 'python3 >= 3.10 not found' }, () => {
  const acc = (proj, args = []) => run(`python3 scripts/accept.py ${args.join(' ')}`, { cwd: proj });

  test('no step modules: exit 0 with a note; a feature with no module: exit 1 with the reason', () => {
    const proj = pyProject();
    const all = acc(proj);
    assert.equal(all.code, 0);
    assert.match(all.stdout, /no step modules to run/);
    const one = acc(proj, ['features/todo/v1.feature']);
    assert.equal(one.code, 1);
    assert.match(one.stderr, /no step module under features\/steps\/ references features\/todo\/v1\.feature/);
  });

  test('picks modules by the exact feature path; skips modules whose features are all pending', () => {
    const proj = pyProject();
    mkdirSync(join(proj, 'features/steps/a'), { recursive: true });
    mkdirSync(join(proj, 'features/steps/b'), { recursive: true });
    // python3 here has no pytest: a fake "pytest" module records which files it was given
    mkdirSync(join(proj, 'fakepy/pytest'), { recursive: true });
    writeFileSync(join(proj, 'fakepy/pytest/__init__.py'), '');
    writeFileSync(join(proj, 'fakepy/pytest/__main__.py'), 'import sys\nprint("RAN", " ".join(a for a in sys.argv[1:] if a.endswith(".py")))\n');
    writeFileSync(join(proj, 'features/steps/a/test_a_v1.py'), 'scenarios("features/a/v1.feature")\n');
    writeFileSync(join(proj, 'features/steps/b/test_b_v1.py'), "scenarios('features/b/v1.feature')\n");
    const env = (cmd) => run(`PYTHONPATH=fakepy python3 scripts/accept.py ${cmd}`, { cwd: proj });
    assert.equal(env('features/a/v1.feature:3').stdout.trim(), 'RAN features/steps/a/test_a_v1.py');
    assert.equal(env('').stdout.trim(), 'RAN features/steps/a/test_a_v1.py features/steps/b/test_b_v1.py');
    mkdirSync(join(proj, '.dlm'), { recursive: true });
    writeJson(join(proj, '.dlm/pending-features.json'), ['features/b/v1.feature']);
    assert.equal(env('').stdout.trim(), 'RAN features/steps/a/test_a_v1.py');
    assert.equal(env('features/b/v1.feature').stdout.trim(), 'RAN features/steps/b/test_b_v1.py', 'an explicit feature still runs');
  });
});

// Optional end to end: needs a Python whose virtualenv has pytest + pytest-bdd (nothing is downloaded in the test suite).
// DLM_TEST_PYTHON=/path/to/venv/bin/python npm test
const TEST_PY = process.env.DLM_TEST_PYTHON;
const pyReady = !!TEST_PY && run(`"${TEST_PY}" -c "import pytest, pytest_bdd"`).code === 0;

describe('python greenfield end to end', { skip: !pyReady && 'set DLM_TEST_PYTHON to a venv python with pytest + pytest-bdd' }, () => {
  test('test leg red (missing module) → dev leg green → merge gates check:dlm, pytest src, accept', async () => {
    const proj = pyProject();
    // .venv/bin/python forwards to the given interpreter (sys.executable stays the real venv, so accept.py runs its pytest)
    mkdirSync(join(proj, '.venv', 'bin'), { recursive: true });
    writeFileSync(join(proj, '.venv', 'bin', 'python'), `#!/bin/sh\nexec "${TEST_PY}" "$@"\n`, { mode: 0o755 });
    const cfg = readJson(join(proj, 'dlm.config.json'));
    cfg.agents.worker.cmd = `node ${join(REPO, 'test', 'fixtures', 'fake-py-worker.mjs')}`;
    cfg.agents.verifier = { ...cfg.agents.verifier, backend: 'cmd', cmd: `FV=ok node ${FAKE_VERIFIER}` };
    cfg.auth = { window_minutes: 30 };
    writeJson(join(proj, 'dlm.config.json'), cfg);
    sh(proj, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm config');
    assert.equal(sh(proj, 'git status --porcelain'), '', '.venv/ is ignored');
    addNode(proj, { id: 'calc/v1', title: '加法', intent: '提供 run(a, b) 回傳兩數之和', owns: ['src/calc/**'] },
      '@calc @v1\nFeature: calc\n  Scenario: adds two numbers\n    When I add 2 and 3\n    Then the result is 5\n');
    const s = await tickUntil(proj, (st) => ['done', 'blocked'].includes(st.nodes.get('calc/v1')?.status), { max: 30 });
    const evs = readEvents(proj);
    assert.equal(s.nodes.get('calc/v1').status, 'done', JSON.stringify(evs.filter((e) => ['reject', 'gates'].includes(e.type)).slice(-3)));
    const ds = [...s.dispatches.values()].filter((d) => d.node_id === 'calc/v1');
    assert.deepEqual(ds.map((d) => d.leg), ['test', 'dev']);
    const testEnv = readJson(join(proj, 'ledger/dispatch', ds[0].dispatch_id, 'envelope.json'));
    assert.deepEqual(testEnv.acceptance, [{ cmd: '.venv/bin/python scripts/accept.py features/calc/v1.feature', expect_exit: -1 }]);
    assert.ok(testEnv.allowed_paths.includes('src/calc/**/test_*.py'));
    const gates = evs.filter((e) => e.type === 'gates').at(-1);
    assert.equal(gates.ok, true);
    assert.deepEqual(gates.results.map((g) => [g.name, g.exit]), [['check:dlm', 0], ['test', 0], ['accept', 0]]);
    assert.match(sh(proj, 'git show main:src/calc/core.py'), /return a \+ b/);
    // gherkin tags become pytest marks: the template silences the unknown-mark warning
    const acc = run('.venv/bin/python scripts/accept.py features/calc/v1.feature', { cwd: proj });
    assert.equal(acc.code, 0, acc.stdout + acc.stderr);
    assert.doesNotMatch(acc.stdout + acc.stderr, /PytestUnknownMarkWarning/);

    // integration point: the hand-try request says how to run it, and that command works from the root
    addNode(proj, { id: 'I1', kind: 'integration', title: '命令列', intent: '使用者在命令列算 2 加 3', owns: ['src/calc/__main__.py'], depends_on: ['calc/v1'] },
      '@integration @i1\nFeature: cli\n  @e2e\n  Scenario: user adds from the command line\n    When I run calc with 2 and 3\n    Then it prints 5\n');
    const s2 = await tickUntil(proj, (st) => ['done', 'blocked'].includes(st.nodes.get('I1')?.status), { max: 30 });
    assert.equal(s2.nodes.get('I1').status, 'done', JSON.stringify(readEvents(proj).filter((e) => ['reject', 'gates', 'block'].includes(e.type)).slice(-3)));
    const { renderInbox } = await import('../tools/lib/inbox.mjs');
    const inbox = renderInbox(proj, { markSeen: false });
    assert.match(inbox, /E2E:I1/);
    assert.match(inbox, /怎麼跑:\.venv\/bin\/python scripts\/run\.py calc 2 3/);
    assert.match(inbox, /怎麼跑:在專案根目錄:\.venv\/bin\/python scripts\/run\.py <套件>/, 'the stack hint too');
    assert.doesNotMatch(inbox, /怎麼跑:\.venv\/bin\/python scripts\/accept\.py/, 'the acceptance runner is not how to run it');
    const tryRun = run('.venv/bin/python scripts/run.py calc 2 3', { cwd: proj });
    assert.equal(tryRun.code, 0, tryRun.stderr);
    assert.equal(tryRun.stdout.trim(), '5');
  });
});

describe('review batch 1: fresh projects and stack-neutral payload', () => {
  test('a fresh python project is not taken for an existing one; setup with mode unanswered stays greenfield', async () => {
    const proj = pyProject();
    assert.equal(readJson(join(proj, 'dlm.config.json')).project.mode, 'greenfield', 'init writes the mode');
    const d = detectProject(proj);
    assert.equal(d.code_files, 0, 'src/test_layout.py is dlm\'s');
    assert.equal(d.test_files, 0);
    assert.equal(d.suggested_mode, 'greenfield');
    assert.ok(readJson(join(proj, '.dlm-install.json')).seed_files.includes('src/test_layout.py'));
    const asked = [];
    await setup(proj, { ask: async (q) => { asked.push(q.id); return q.id === 'npm_install' ? 'n' : ''; }, detect: { claude: true }, log: () => {} });
    assert.ok(asked.includes('mode'));
    assert.equal(loadConfig(proj).project.mode, 'greenfield');
    // even without project.mode (a config from before), detection alone says greenfield
    const raw = readJson(join(proj, 'dlm.config.json'));
    delete raw.project.mode;
    writeJson(join(proj, 'dlm.config.json'), raw);
    assert.equal(detectProject(proj).suggested_mode, 'greenfield');
    // the user's own code still counts
    mkdirSync(join(proj, 'src/app'), { recursive: true });
    writeFileSync(join(proj, 'src/app/main.py'), 'print(1)\n');
    assert.equal(detectProject(proj).code_files, 1);
  });

  test('upgrade keeps the seed list', () => {
    const proj = pyProject();
    upgrade(proj);
    assert.ok(readJson(join(proj, '.dlm-install.json')).seed_files.includes('src/test_layout.py'));
  });

  test('.gitignore: payload is stack-neutral; node-ts gets exactly the lines it had before; python gets no node lines', () => {
    const lines = (p) => readFileSync(join(p, '.gitignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert.deepEqual(readFileSync(join(REPO, 'payload/gitignore'), 'utf8').trim().split('\n'), ['.dlm/', '*.tmp-*']);
    const node = join(tempDir(), 'n');
    init(node, { name: 'n' });
    assert.deepEqual(lines(node).sort(), ['node_modules/', '.dlm/', '*.tmp-*', '.mutate.lock', '.stryker-tmp/', 'reports/', 'coverage/'].sort(), 'same as 4.11');
    assert.equal(sh(node, 'git status --porcelain'), '');
    const py = lines(pyProject());
    for (const l of ['node_modules/', '.mutate.lock', '.stryker-tmp/', 'reports/', 'coverage/']) assert.ok(!py.includes(l), l);
    for (const l of ['.dlm/', '*.tmp-*', '.venv/', '__pycache__/', '.pytest_cache/']) assert.ok(py.includes(l), l);
  });

  test('scripts/run.py runs a package of this tree\'s own src from the root (and from a copy, the copy\'s)', { skip: !hasPython && 'python3 >= 3.10 not found' }, () => {
    const proj = pyProject();
    mkdirSync(join(proj, 'src/greet'), { recursive: true });
    writeFileSync(join(proj, 'src/greet/__init__.py'), '');
    writeFileSync(join(proj, 'src/greet/__main__.py'), 'import sys\nprint(f"Hello, {sys.argv[1]}!")\n');
    const r = run('python3 scripts/run.py greet Grace', { cwd: proj });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'Hello, Grace!');
    assert.notEqual(run('python3 -m greet Grace', { cwd: proj }).code, 0, 'without the launcher the package is not importable from the root');
    const copy = join(tempDir(), 'copy');
    sh(proj, `cp -r src scripts '${copy}'/ 2>/dev/null || (mkdir -p '${copy}' && cp -r src scripts '${copy}'/)`);
    writeFileSync(join(copy, 'src/greet/__main__.py'), 'print("copy")\n');
    assert.equal(run('python3 scripts/run.py greet Grace', { cwd: copy }).stdout.trim(), 'copy');
    assert.equal(run('python3 scripts/run.py', { cwd: proj }).code, 2, 'usage without a module');
    assert.ok(loadConfig(proj).verify.rerun_allow.includes('.venv/bin/python scripts/run.py'));
  });

  test('python template silences PytestUnknownMarkWarning (gherkin tags become marks)', () => {
    assert.match(readFileSync(join(pyProject(), 'pyproject.toml'), 'utf8'), /^filterwarnings = \["ignore::pytest\.PytestUnknownMarkWarning"\]$/m);
  });

  test('project status reports the stack and its layout hint (an MCP-only Front reads it)', async () => {
    const { status } = await import('../tools/lib/ops.mjs');
    const st = status(pyProject());
    assert.equal(st.stack, 'python');
    assert.match(st.layout, /src\/<能力>/);
  });

  test('payload dlm.config.json names no test framework', () => {
    const text = readFileSync(join(REPO, 'payload/dlm.config.json'), 'utf8');
    assert.doesNotMatch(text, /stryker|mutation|vitest|cucumber|pytest/i);
  });
});

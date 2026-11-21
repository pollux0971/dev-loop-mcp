// v4.12: the python stack (stacks/python), stack-declared "red for the wrong reason" patterns, and brownfield Python with a virtualenv.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { loadConfig } from '../tools/lib/config.mjs';
import { doctor } from '../tools/lib/doctor.mjs';
import { init } from '../tools/lib/install.mjs';
import { sandboxExec, withJudgeEnv } from '../tools/lib/sandbox.mjs';
import { setup } from '../tools/lib/setup.mjs';
import { loadStack, stackName } from '../tools/lib/stack.mjs';
import { readJson, run, writeJson } from '../tools/lib/util.mjs';
import { badRedReason, checkAcceptance, hostExecutor } from '../tools/lib/verify/script-checks.mjs';
import { cleanup, sh, tempDir } from './helpers.mjs';

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

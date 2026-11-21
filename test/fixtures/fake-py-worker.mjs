// Fake worker for the python stack e2e (v4.12): a greenfield project from `dlm init --stack python`.
//   test leg  writes the pytest-bdd step module and a unit test; both are red because src/<cap>/core.py does not exist yet
//   dev leg   writes src/<cap>/core.py; acceptance and unit tests go green
//   integration point (I<n>): the test leg writes features/steps/integration/test_<id>.py (runs `calc` through scripts/run.py; red until
//   the entry exists); the integrate leg writes src/calc/__main__.py and claims the real run `.venv/bin/python scripts/run.py calc 2 3`
// The evidence is the node's acceptance command (.venv/bin/python scripts/accept.py <gherkin>).
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const env = JSON.parse(readFileSync('.dlm/envelope.json', 'utf8'));
const isI = /^I\d+$/.test(env.node_id);
const cap = env.node_id.split('/')[0];
const ver = (env.node_id.split('/')[1] ?? '').replaceAll('.', '_');
const sh = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const write = (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const report = (r) => writeFileSync('.dlm/report.json', JSON.stringify({ dispatch_id: env.dispatch_id, ...r }, null, 2));
const accept = env.acceptance[0]?.cmd;
const gherkin = accept?.split(' ').at(-1);

if (isI && env.leg === 'test') {
  write(`features/steps/integration/test_${env.node_id.toLowerCase()}.py`, [
    'import subprocess, sys', 'from pytest_bdd import parsers, scenarios, then, when', '',
    `scenarios("${gherkin}")`, '', '',
    "@when(parsers.parse('I run calc with {a:d} and {b:d}'), target_fixture='out')",
    'def run_calc(a, b):',
    "    return subprocess.run([sys.executable, 'scripts/run.py', 'calc', str(a), str(b)], capture_output=True, text=True)", '', '',
    "@then(parsers.parse('it prints {n:d}'))",
    'def prints(out, n):',
    '    assert out.returncode == 0, out.stderr',
    '    assert out.stdout.strip() == str(n)', '',
  ].join('\n'));
  report({ kind: 'done', summary: '寫好整合步驟,目前是紅的', claims: [{ text: '整合驗收是紅的', evidence: { cmd: accept, exit: sh(accept) } }] });
} else if (env.leg === 'integrate') {
  write('src/calc/__main__.py', 'import sys\nfrom calc.core import run\n\nprint(run(int(sys.argv[1]), int(sys.argv[2])))\n');
  const runCmd = '.venv/bin/python scripts/run.py calc 2 3';
  report({ kind: 'done', summary: '接通命令列', claims: [
    { text: '整合驗收通過', evidence: { cmd: accept, exit: sh(accept) } },
    { text: `\`${runCmd}\` exit 0,印出 5`, evidence: { cmd: runCmd, exit: sh(runCmd) } },
  ] });
} else if (env.leg === 'test') {
  write(`features/steps/${cap}/test_${cap}_${ver}.py`, [
    'from pytest_bdd import parsers, scenarios, then, when', '',
    `scenarios("${gherkin}")`, '', '',
    "@when(parsers.parse('I add {a:d} and {b:d}'), target_fixture='result')",
    'def add(a, b):',
    `    from ${cap}.core import run`,
    '    return run(a, b)', '', '',
    "@then(parsers.parse('the result is {n:d}'))",
    'def result_is(result, n):',
    '    assert result == n', '',
  ].join('\n'));
  write(`src/${cap}/test_core.py`, [`from ${cap}.core import run`, '', '', 'def test_adds():', '    assert run(2, 3) == 5', ''].join('\n'));
  report({ kind: 'done', summary: '寫好步驟與單元測試,目前是紅的', claims: [{ text: '驗收是紅的', evidence: { cmd: accept, exit: sh(accept) } }] });
} else if (env.leg === 'dev') {
  write(`src/${cap}/core.py`, 'def run(a, b):\n    return a + b\n');
  report({ kind: 'done', summary: '實作完成', claims: [{ text: '驗收通過', evidence: { cmd: accept, exit: sh(accept) } }] });
} else {
  report({ kind: 'escalation', summary: `假 worker 不會做 ${env.leg}`, claims: [] });
}

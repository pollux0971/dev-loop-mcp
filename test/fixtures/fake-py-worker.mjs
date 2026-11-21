// Fake worker for the python stack e2e (v4.12): a greenfield project from `dlm init --stack python`.
//   test leg  writes the pytest-bdd step module and a unit test; both are red because src/<cap>/core.py does not exist yet
//   dev leg   writes src/<cap>/core.py; acceptance and unit tests go green
// The evidence is the node's acceptance command (.venv/bin/python scripts/accept.py <gherkin>).
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const env = JSON.parse(readFileSync('.dlm/envelope.json', 'utf8'));
const cap = env.node_id.split('/')[0];
const ver = env.node_id.split('/')[1].replaceAll('.', '_');
const sh = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const write = (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const report = (r) => writeFileSync('.dlm/report.json', JSON.stringify({ dispatch_id: env.dispatch_id, ...r }, null, 2));
const accept = env.acceptance[0]?.cmd;
const gherkin = accept?.split(' ').at(-1);

if (env.leg === 'test') {
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

// brownfield 測試用的假 worker:Python 既有專案(budget/core.py,unittest)。
//   good     characterize 釘住 total();測試棒寫 to_csv 的測試(紅);實作棒加 to_csv
//   breaker  實作棒順手把 total() 改壞(characterize 釘住的行為)
//   regress  實作棒把 tests 以外另一個既有函式 label() 改壞(基線以外新紅一個測試)
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const env = JSON.parse(readFileSync('.dlm/envelope.json', 'utf8'));
const mode = process.env.FAKE_MODE ?? 'good';
const sh = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const write = (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const report = (r) => writeFileSync('.dlm/report.json', JSON.stringify({ dispatch_id: env.dispatch_id, ...r }, null, 2));
const done = (summary, text) => {
  const cmd = env.acceptance[0].cmd;
  report({ kind: 'done', summary, claims: [{ text, evidence: { cmd, exit: sh(cmd) } }] });
};

if (env.leg === 'characterize') {
  write('tests/test_core_characterize.py', [
    'import unittest', 'from budget.core import total', '',
    'class TotalCharacterize(unittest.TestCase):',
    '    def test_sums_amounts(self):',
    "        self.assertEqual(total([{'amount': 10}, {'amount': 20}]), 30)",
    '    def test_empty_is_zero(self):',
    '        self.assertEqual(total([]), 0)', '',
  ].join('\n'));
  done('釘住 total() 的現有行為', 'characterize 測試在現在的程式上是綠的');
} else if (env.leg === 'test') {
  write('tests/test_export.py', [
    'import unittest', '', 'class ExportTest(unittest.TestCase):',
    '    def test_csv(self):',
    '        from budget.core import to_csv',
    "        self.assertEqual(to_csv([{'amount': 10}]), 'amount\\n10\\n')", '',
  ].join('\n'));
  done('寫好 to_csv 的測試,目前是紅的', '測試是紅的');
} else if (env.leg === 'dev') {
  let src = readFileSync('budget/core.py', 'utf8');
  src += "\n\ndef to_csv(entries):\n    return 'amount\\n' + ''.join(f\"{e['amount']}\\n\" for e in entries)\n";
  if (mode === 'breaker') src = src.replace("return sum(e['amount'] for e in entries)", "return sum(e['amount'] for e in entries) + 1");
  if (mode === 'regress') src = src.replace("return name.title()", "return name.upper()");
  write('budget/core.py', src);
  done('加了 to_csv', '驗收通過');
} else {
  report({ kind: 'escalation', summary: `假 worker 不會做 ${env.leg}`, claims: [] });
}

// Fake small model: behavior is chosen by FV. stdin is the prompt.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
const mode = process.env.FV ?? 'ok';
const variantA = /Question: Does this output show|Question: Does the diff make/.test(prompt);
const say = (verdict, reason = 'x') => process.stdout.write(JSON.stringify({ verdict, reason }));
if (mode === 'ok') say('NO_OBJECTION');
else if (mode === 'fail') say('FAIL', '輸出第 3 行寫著 1 failing');
else if (mode === 'disagree') say(variantA ? 'FAIL' : 'NO_OBJECTION');
else if (mode === 'disagree-why') {
  // forms are asked in order a, b: alternate by a counter file (FV_COUNTER), so every check disagrees with a reason on each side
  const n = Number(existsSync(process.env.FV_COUNTER) ? readFileSync(process.env.FV_COUNTER, 'utf8') : '0');
  writeFileSync(process.env.FV_COUNTER, String(n + 1));
  if (n % 2 === 0) say('FAIL', 'exit 2 是收集錯誤,不是測試失敗');
  else say('NO_OBJECTION', 'ModuleNotFoundError 表示實作還不存在');
}
else if (mode === 'garbage') process.stdout.write('I think it is fine!');
else if (mode === 'pass') say('PASS');
else if (mode === 'crash') process.exit(3);

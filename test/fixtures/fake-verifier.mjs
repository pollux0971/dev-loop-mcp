// Fake small model: behavior is chosen by FV. stdin is the prompt.
import { readFileSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
const mode = process.env.FV ?? 'ok';
const variantA = /Question: Does this output show|Question: Does the diff make/.test(prompt);
const say = (verdict, reason = 'x') => process.stdout.write(JSON.stringify({ verdict, reason }));
if (mode === 'ok') say('NO_OBJECTION');
else if (mode === 'fail') say('FAIL', '輸出第 3 行寫著 1 failing');
else if (mode === 'disagree') say(variantA ? 'FAIL' : 'NO_OBJECTION');
else if (mode === 'garbage') process.stdout.write('I think it is fine!');
else if (mode === 'pass') say('PASS');
else if (mode === 'crash') process.exit(3);

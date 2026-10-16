// Fake critic: prints the FAKE_OUT env var as is (stdin is the prompt; it is saved to FAKE_PROMPT_LOG so tests can assert on it).
import { appendFileSync, readFileSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
if (process.env.FAKE_PROMPT_LOG) appendFileSync(process.env.FAKE_PROMPT_LOG, `${prompt}\n=====\n`);
process.stdout.write(process.env.FAKE_OUT ?? '{}');

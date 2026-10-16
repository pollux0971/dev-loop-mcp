// 假 critic:把環境變數 FAKE_OUT 原樣印出(stdin 是 prompt,存到 FAKE_PROMPT_LOG 方便斷言)。
import { appendFileSync, readFileSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
if (process.env.FAKE_PROMPT_LOG) appendFileSync(process.env.FAKE_PROMPT_LOG, `${prompt}\n=====\n`);
process.stdout.write(process.env.FAKE_OUT ?? '{}');

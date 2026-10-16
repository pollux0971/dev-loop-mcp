// 可驗證的使用者授權與帳本簽章共用的金鑰。
//
// 金鑰放在 repo 外(預設 ~/.config/dlm/key,可用 DLM_KEY_FILE 改),權限 0600。用來察覺「有人直接改了帳本或原話紀錄」。
// worker 跟你是同一個 OS 使用者,讀得到這把 key;它防的是手誤與粗糙的竄改,不是蓄意的對手(見 docs/dlm/SECURITY.md)。
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { machineDir } from './legacy.mjs';
import { DlmError, atomicWrite, ensureDir, sha256 } from './util.mjs';

export function keyPath() {
  return process.env.DLM_KEY_FILE || join(machineDir(), 'key');
}

/** 讀金鑰;不存在時 create=true 就建一把新的(0600)。 */
export function loadKey({ create = false } = {}) {
  const p = keyPath();
  if (!existsSync(p)) {
    if (!create) return null;
    ensureDir(dirname(p));
    try { chmodSync(dirname(p), 0o700); } catch { /* 不是自己建的目錄就算了 */ }
    let fd;
    try {
      fd = openSync(p, 'wx', 0o600);
      writeSync(fd, randomBytes(32).toString('hex'));
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const text = readFileSync(p, 'utf8').trim();
  if (text.length < 32) throw new DlmError(`金鑰 ${p} 太短或損毀`);
  return Buffer.from(text, 'utf8');
}

export function mac(key, data) {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function macEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ------------------------------------------------------------------ 使用者原話

export const UTTERANCES_REL = '.dlm/utterances.jsonl';

const utterancePayload = (u) => `${u.ts}\0${u.session ?? ''}\0${u.text}`;

/** UserPromptSubmit hook 呼叫:把使用者這一輪真正送出的文字簽章存檔。 */
export function recordUtterance(root, text, { session } = {}) {
  const key = loadKey({ create: true });
  const u = { ts: new Date().toISOString(), ...(session ? { session } : {}), text };
  const line = `${JSON.stringify({ ...u, mac: mac(key, utterancePayload(u)) })}\n`;
  const p = join(root, UTTERANCES_REL);
  ensureDir(dirname(p));
  const fd = openSync(p, 'a', 0o600);
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
  return u;
}

/** 比對用:只留字母與數字(含中日韓文字)。Front 為了過 shell 規則拿掉標點,仍然對得上。 */
export function normalizeSpeech(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function readUtterances(root) {
  const p = join(root, UTTERANCES_REL);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
    try {
      return { ...JSON.parse(l), line: i + 1 };
    } catch {
      return { bad: true, line: i + 1 };
    }
  });
}

/**
 * --verbatim 必須是最近 windowMinutes 內、某一筆簽章有效的使用者原話的子字串。
 * 回傳 { sha }(那筆原話的 sha256,記進事件);對不上就丟錯,並說明為什麼。
 */
export function verifyVerbatim(root, verbatim, { windowMinutes = 30, now = Date.now() } = {}) {
  const want = normalizeSpeech(verbatim);
  if (want.length < 1) throw new DlmError('--verbatim 至少要有一個字');
  const key = loadKey();
  if (!key) throw new DlmError(`找不到金鑰 ${keyPath()}:還沒有任何已簽章的使用者原話(Claude Code 請確認 .claude/settings.json 的 hooks 已安裝)`);
  const since = now - windowMinutes * 60000;
  let tampered = 0;
  for (const u of readUtterances(root).reverse()) {
    if (u.bad || !u.mac || !macEqual(u.mac, mac(key, utterancePayload(u)))) { tampered++; continue; }
    const t = Date.parse(u.ts);
    if (!(t >= since && t <= now + 60000)) continue;
    if (normalizeSpeech(u.text).includes(want)) return { sha: sha256(utterancePayload(u)).slice(0, 16), utterance: u };
  }
  const extra = tampered ? `(另有 ${tampered} 筆簽章不符的紀錄被忽略:${UTTERANCES_REL} 可能被改過)` : '';
  throw new DlmError(`--verbatim 對不上使用者最近 ${windowMinutes} 分鐘內親口說的任何一句話${extra}。只能記錄使用者這一輪的原話;轉述不算授權`);
}

/** 給測試與 `dlm auth` 用:把金鑰檔換成指定內容。 */
export function writeKey(text) {
  const p = keyPath();
  ensureDir(dirname(p));
  atomicWrite(p, text);
  chmodSync(p, 0o600);
}

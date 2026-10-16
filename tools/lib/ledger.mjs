// 事件帳:ledger/events.jsonl。只 append、不改寫。
// 單一寫入者規則:LLM 永遠不直接寫這個檔;它們產出檔案,dp 驗證後代為 append。
//
// 簽章鏈:每筆事件帶 prev_hash(前一行原文的 sha256)與 mac(repo 外金鑰的 HMAC)。
// 「只增不改」由 git 的已 commit 前綴保證;「尾巴這筆是 dp 寫的」由 mac 保證——任何能寫檔的程序都能附加一行,
// 但拿不到金鑰就算不出 mac。舊帳本從第一筆有 mac 的事件(chain_start)開始上鏈,之前的照舊只驗 seq。
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { keyPath, loadKey, mac, macEqual } from './auth.mjs';
import { validate } from './schema.mjs';
import { EVENT_ACTORS, eventSchema } from './schemas.mjs';
import { DpError, ensureDir, nowIso, run, sha256, withLock } from './util.mjs';

export const LEDGER_REL = 'ledger/events.jsonl';

export function ledgerPath(root) {
  return join(root, LEDGER_REL);
}

export function parseLedger(text, label = LEDGER_REL) {
  const events = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch (e) {
      throw new DpError(`${label}:${i + 1} 不是合法 JSON(帳本損毀不會被跳過):${e.message}`);
    }
    events.push(ev);
  });
  return events;
}

function ledgerLines(text) {
  return text.split('\n').filter((l) => l.trim());
}

const macPayload = (ev) => {
  const { mac: _m, ...rest } = ev;
  return JSON.stringify(rest);
};

export function readEvents(root) {
  const p = ledgerPath(root);
  if (!existsSync(p)) return [];
  return parseLedger(readFileSync(p, 'utf8'));
}

export function validateEvent(ev) {
  const schema = eventSchema(ev.type);
  if (!schema) return [`未知事件型別 ${ev.type}`];
  const errors = validate(schema, ev);
  const allowed = EVENT_ACTORS[ev.type];
  if (allowed && !allowed.includes(ev.actor)) {
    errors.push(`事件 ${ev.type} 只能由 ${allowed.join('/')} 寫入,實際 actor=${ev.actor}`);
  }
  if (ev.type === 'decision' && ev.actor === 'critic' && ev.delegated !== true) {
    errors.push('critic 寫的 decision 必須標 delegated:true(代行要看得出是代行)');
  }
  if (ev.type === 'unblock' && typeof ev.ref === 'string' && ev.ref.startsWith('user#') && ev.actor !== 'user') {
    errors.push(`ref 為 user# 的 unblock 是使用者親自解除封鎖,只能由 user 寫入,實際 actor=${ev.actor}`);
  }
  return errors;
}

export function append(root, actor, type, fields) {
  const p = ledgerPath(root);
  ensureDir(join(root, 'ledger'));
  return withLock(join(root, 'ledger', '.lock'), () => {
    const text = existsSync(p) ? readFileSync(p, 'utf8') : '';
    const events = parseLedger(text);
    const last = events.at(-1);
    let ev = { seq: (last?.seq ?? 0) + 1, ts: nowIso(), actor, type, ...fields };
    const errors = validateEvent(ev);
    if (errors.length) throw new DpError(`拒絕寫入事件 ${type}:\n  - ${errors.join('\n  - ')}`);
    const lastLine = ledgerLines(text).at(-1);
    ev = { ...ev, prev_hash: lastLine ? sha256(lastLine) : 'genesis', ...(events.some((e) => e.mac) ? {} : { chain_start: true }) };
    ev.mac = mac(loadKey({ create: true }), macPayload(ev));
    const fd = openSync(p, 'a');
    try {
      writeSync(fd, `${JSON.stringify(ev)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return ev;
  });
}

/**
 * 簽章鏈檢查。回傳 { problems, note }。沒有金鑰(例如在別台機器上看)時只驗 prev_hash 鏈,note 會說明。
 */
export function verifyChain(text) {
  const lines = ledgerLines(text);
  const problems = [];
  const key = loadKey();
  let started = false;
  lines.forEach((line, i) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; } // 壞行由 parseLedger 報
    if (!ev.mac) {
      if (started) problems.push(`seq ${ev.seq}: 簽章鏈開始之後出現沒有簽章的事件(有人直接寫了帳本)`);
      return;
    }
    if (!started && !ev.chain_start) problems.push(`seq ${ev.seq}: 第一筆有簽章的事件應標 chain_start`);
    if (started && ev.chain_start) problems.push(`seq ${ev.seq}: 簽章鏈中途又出現 chain_start`);
    started = true;
    const expectPrev = i === 0 ? 'genesis' : sha256(lines[i - 1]);
    if (ev.prev_hash !== expectPrev) problems.push(`seq ${ev.seq}: prev_hash 跟前一行對不上(中間被插入、刪除或改寫)`);
    if (key && !macEqual(ev.mac, mac(key, macPayload(ev)))) problems.push(`seq ${ev.seq}: mac 不符(不是持有金鑰的 dp 寫的,或內容被改過)`);
  });
  const note = started && !key ? `找不到金鑰 ${keyPath()},只驗了 prev_hash 鏈,沒驗 mac` : null;
  return { problems, note };
}

/** 帳本健檢:每行合法、seq 連續遞增、簽章鏈完整、已 commit 的內容是現在內容的前綴(只增不改)。 */
export function checkLedger(root, { gitRef = 'HEAD' } = {}) {
  const problems = [];
  const p = ledgerPath(root);
  if (!existsSync(p)) return { ok: true, problems, count: 0, note: '尚無帳本(新專案)' };
  const text = readFileSync(p, 'utf8');
  let events;
  try {
    events = parseLedger(text);
  } catch (e) {
    return { ok: false, problems: [e.message], count: 0 };
  }
  events.forEach((ev, i) => {
    if (ev.seq !== i + 1) problems.push(`第 ${i + 1} 筆 seq=${ev.seq},應為 ${i + 1}`);
    for (const err of validateEvent(ev)) problems.push(`seq ${ev.seq}: ${err}`);
  });
  const chain = verifyChain(text);
  problems.push(...chain.problems);
  const committed = run(`git show ${gitRef}:${LEDGER_REL}`, { cwd: root });
  if (committed.code === 0 && !text.startsWith(committed.stdout)) {
    problems.push(`已 commit 的帳本(${gitRef})不是現在內容的前綴:帳本被改寫了,不是只 append`);
  }
  return { ok: problems.length === 0, problems, count: events.length, ...(chain.note ? { note: chain.note } : {}) };
}

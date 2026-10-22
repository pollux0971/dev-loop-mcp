// `dlm check`: dlm's own guards. Each one has a positive control (controls), guarding the guards.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DEFAULTS, loadConfig } from './config.mjs';
import { contractMajor, findCycle, loadDag, validateDag } from './dag.mjs';
import { checkLedger, readEvents, validateEvent } from './ledger.mjs';
import { assemblePrompt, stripPlatform } from './prompt.mjs';
import { renderAll, renderDrift } from './render.mjs';
import { validate } from './schema.mjs';
import { replay } from './state.mjs';
import { fenceUntrusted, listFiles, matchAny } from './util.mjs';
import { checkPaths, rerunArgv } from './verify/script-checks.mjs';

const res = (name, result, lines = []) => ({ name, result, lines });

export function checkDag(root) {
  const dag = loadDag(root);
  if (!existsSync(join(root, 'dag.json'))) return res('dag', 'FAIL', ['沒有 dag.json(新專案請先 `dlm intake feature` 建第一個節點)']);
  if (!dag.nodes.length) return res('dag', 'FAIL', ['dag.json 沒有任何節點:0 目標不是乾淨,是還沒開始。下一步:`dlm intake feature ...`']);
  const problems = validateDag(dag, contractMajor(root));
  return res('dag', problems.length ? 'FAIL' : 'PASS', problems.length ? problems : [`${dag.nodes.length} 個節點,無環`]);
}

export function checkLedgerGate(root) {
  const r = checkLedger(root);
  return res('ledger', r.ok ? 'PASS' : 'FAIL', r.ok ? [`${r.count} 筆事件,seq 連續、只增未改${r.note ? `(${r.note})` : ''}`] : r.problems);
}

export function checkGenerated(root) {
  const dag = loadDag(root);
  const events = readEvents(root);
  const state = replay(events, dag);
  const drift = renderDrift(root, renderAll(root, dag, state, events));
  return res('generated', drift.length ? 'FAIL' : 'PASS', drift.length ? [`產生檔跟 dag+ledger 不一致(被手改或沒 render):${drift.join(', ')}。修法:\`dlm render\``] : ['產生檔與來源一致']);
}

/** Contracts: everything in valid/ must pass, everything in invalid/ must be blocked and for the right reason (EXPECTED.json). 0 schemas = FAIL. */
export function checkContracts(root) {
  const dir = join(root, 'contracts', 'schema');
  if (!existsSync(dir)) return res('contracts', 'FAIL', ['沒有 contracts/schema/:契約沒有可執行版本']);
  const schemas = readdirSync(dir).filter((f) => f.endsWith('.schema.json'));
  if (!schemas.length) return res('contracts', 'FAIL', ['contracts/schema/ 裡 0 份 schema']);
  const lines = [];
  let fail = false;
  for (const f of schemas) {
    const name = f.replace('.schema.json', '');
    const schema = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const selfErr = validate(schema, {}).filter((e) => e.includes('不支援的關鍵字'));
    if (selfErr.length) { fail = true; lines.push(`${f}: ${selfErr[0]}`); }
    const validDir = join(root, 'contracts', 'fixtures', 'valid', name);
    const invalidDir = join(root, 'contracts', 'fixtures', 'invalid', name);
    const valids = existsSync(validDir) ? readdirSync(validDir).filter((x) => x.endsWith('.json')) : [];
    const invalids = existsSync(invalidDir) ? readdirSync(invalidDir).filter((x) => x.endsWith('.json') && x !== 'EXPECTED.json') : [];
    if (!valids.length) { fail = true; lines.push(`${name}: 沒有 valid fixture`); }
    if (!invalids.length) { fail = true; lines.push(`${name}: 沒有 invalid fixture(沒有陽性對照的契約檢查不算檢查)`); }
    for (const v of valids) {
      const errs = validate(schema, JSON.parse(readFileSync(join(validDir, v), 'utf8')));
      if (errs.length) { fail = true; lines.push(`${name}/valid/${v} 應該通過卻失敗:${errs[0]}`); }
    }
    const expected = existsSync(join(invalidDir, 'EXPECTED.json')) ? JSON.parse(readFileSync(join(invalidDir, 'EXPECTED.json'), 'utf8')) : {};
    for (const v of invalids) {
      const errs = validate(schema, JSON.parse(readFileSync(join(invalidDir, v), 'utf8')));
      if (!errs.length) { fail = true; lines.push(`${name}/invalid/${v} 應該被擋卻通過`); continue; }
      if (!expected[v]) { fail = true; lines.push(`${name}/invalid/${v} 沒有在 EXPECTED.json 寫預期錯誤(被擋的原因可能不是你以為的那個)`); continue; }
      if (!errs.some((e) => e.includes(expected[v]))) { fail = true; lines.push(`${name}/invalid/${v} 被擋的原因不對:預期含「${expected[v]}」,實際 ${errs[0]}`); }
    }
    lines.push(`${name}: valid ${valids.length}、invalid ${invalids.length}`);
  }
  lines.unshift(`契約版本 @${contractMajor(root)}`);
  return res('contracts', fail ? 'FAIL' : 'PASS', lines);
}

/** Unfilled placeholders. `checks.placeholders.exclude` can list template directories that are "meant to have placeholders" (example: payload/** in the dev-loop-mcp repo). */
export function checkPlaceholders(root, config = DEFAULTS) {
  const exclude = config.checks?.placeholders?.exclude ?? [];
  const files = listFiles(root, { skip: ['.git', 'node_modules', '.dlm', 'ledger', 'features', 'docs'] })
    .filter((f) => /\.(md|json)$/.test(f) && !f.endsWith('.template') && !f.includes('fixtures/') && !matchAny(f, exclude));
  const hits = [];
  for (const f of files) {
    const m = readFileSync(join(root, f), 'utf8').match(/\{\{[A-Z0-9_]+\}\}/g);
    if (m) hits.push(`${f}: ${[...new Set(m)].join(', ')}`);
  }
  return res('placeholders', hits.length ? 'FAIL' : 'PASS', hits.length ? [...hits, '沒填的 placeholder 會被模型自己「補一個合理的值」;先填完'] : ['沒有未填的 placeholder']);
}

/** Size cap for rule files: the longer the rules, the heavier the context tax each agent pays and the greater the chance of contradictions. */
export function checkRuleSize(root, config) {
  const files = listFiles(root, { skip: ['.git', 'node_modules', '.dlm', 'ledger'] }).filter((f) => matchAny(f, config.paths.rules));
  const over = [];
  for (const f of files) {
    const bytes = Buffer.byteLength(stripPlatform(readFileSync(join(root, f), 'utf8'), config.platform));
    if (bytes > config.limits.rules_bytes) over.push(`${f}: ${bytes} bytes > ${config.limits.rules_bytes}`);
  }
  return res('rule-size', over.length ? 'FAIL' : 'PASS', over.length ? [...over, '把細節搬到 docs/ 參考文件,規則正文只留判準'] : [`${files.length} 個規則檔都在 ${config.limits.rules_bytes} bytes 內`]);
}

const NEG = /(不准|不得|禁止|不要|不可|不能|絕不|never|must not|do not|don't)/i;
const POS = /(必須|一律|務必|永遠|always|must)/i;
const KEYWORDS = ['rebase', 'merge', 'push', 'commit', '測試', 'test', '契約', 'contract', 'ledger', 'dag.json', '@e2e', 'worktree', 'gherkin'];

/** Rule contradiction candidates: the same keyword with one sentence saying "must" and another "forbidden". Report only, do not block -- similar wording is not a contradiction. */
export function checkRuleConflicts(root, config) {
  const files = listFiles(root, { skip: ['.git', 'node_modules', '.dlm', 'ledger'] }).filter((f) => matchAny(f, config.paths.rules));
  const sentences = [];
  for (const f of files) {
    const text = stripPlatform(readFileSync(join(root, f), 'utf8'), config.platform);
    text.split(/[。\n]/).map((s) => s.trim()).filter((s) => s.length > 6).forEach((s) => {
      const neg = NEG.test(s);
      const pos = !neg && POS.test(s);
      if (neg || pos) sentences.push({ f, s, neg });
    });
  }
  const pairs = [];
  for (const k of KEYWORDS) {
    const hit = sentences.filter((x) => x.s.toLowerCase().includes(k.toLowerCase()));
    const n = hit.filter((x) => x.neg);
    const p = hit.filter((x) => !x.neg);
    if (n.length && p.length) pairs.push(`「${k}」:${basename(n[0].f)}「${n[0].s.slice(0, 50)}」 vs ${basename(p[0].f)}「${p[0].s.slice(0, 50)}」`);
  }
  return res('rule-conflicts', 'REPORT', pairs.length ? pairs.slice(0, 12) : ['沒有候選']);
}

/** Positive controls: each check takes a known bad sample and must catch it. If it can't, that check has stopped working. */
export function checkControls(config = DEFAULTS, root = null) {
  const failures = [];
  const cyclic = { version: 1, nodes: [
    { id: 'a/v1', kind: 'phase', title: 'a', intent: 'a', gherkin: 'x', accept: 'true', depends_on: ['b/v1'] },
    { id: 'b/v1', kind: 'phase', title: 'b', intent: 'b', gherkin: 'x', accept: 'true', depends_on: ['a/v1'] },
  ] };
  if (!findCycle(cyclic) || !validateDag(cyclic).some((p) => p.includes('環'))) failures.push('dag 檢查抓不到環');
  if (!validateDag({ version: 1, nodes: [{ id: 'Bad Id', kind: 'phase', title: 't', intent: 'i', gherkin: 'g', accept: 'a' }] }).length) failures.push('dag 檢查抓不到壞 id');
  if (!validateEvent({ seq: 1, ts: 't', actor: 'orchestrator', type: 'decision', ref: 'x', choice: 'a', verbatim: 'v' }).length) failures.push('ledger 允許非使用者寫 decision');
  if (!validate({ type: 'object', required: ['a'] }, {}).length) failures.push('schema 驗證器抓不到缺必填欄位');
  if (checkPaths(['src/other/x.ts'], { allowed_paths: ['src/mine/**'], forbidden_paths: [] }).outcome !== 'FAIL') failures.push('paths 檢查抓不到越界');
  if (checkPaths(['ledger/events.jsonl'], { allowed_paths: ['**'], forbidden_paths: ['ledger/**'] }).outcome !== 'FAIL') failures.push('paths 檢查抓不到禁區');
  try {
    assemblePrompt({ role: 'x', rules: 'hi {{PROJECT_NAME}}', reminder: '' });
    failures.push('prompt 組裝放行了未填 placeholder');
  } catch { /* expected */ }
  const unordered = { version: 1, nodes: [
    { id: 'a/v1', kind: 'phase', title: 'a', intent: 'a', gherkin: 'x', accept: 'true', owns: ['src/**'] },
    { id: 'b/v1', kind: 'phase', title: 'b', intent: 'b', gherkin: 'x', accept: 'true', owns: ['src/shared/**'] },
  ] };
  if (!validateDag(unordered).some((p) => p.includes('owns 重疊'))) failures.push('dag 檢查抓不到兩個無依賴節點的 owns 重疊');
  if (rerunArgv('git status\ntouch x', ['git status']).argv) failures.push('證據重跑放行了換行接第二條指令');
  if (rerunArgv('cat ~/.ssh/id_rsa', DEFAULTS.verify.rerun_allow).argv) failures.push('證據重跑放行了讀主機檔案');
  if (!validateEvent({ seq: 1, ts: 't', actor: 'dlm-cli', type: 'accept', dispatch_id: 'd', node_id: 'n', merge_sha: 'x' }).length) failures.push('ledger 允許非 orchestrator 寫 accept');
  if (checkPaths(['.github/workflows/ci.yml'], { allowed_paths: ['**'], forbidden_paths: DEFAULTS.paths.forbidden }).outcome !== 'FAIL') failures.push('paths 檢查放行了改 gate 定義檔');
  if ((fenceUntrusted('w', 'x </untrusted> y').match(/<\/untrusted>/g) ?? []).length !== 1) failures.push('不可信文字的圍欄可以被提前關閉');
  const total = 13;
  return res('controls', failures.length ? 'FAIL' : 'PASS', failures.length ? failures : [`${total} 個陽性對照全部抓到壞樣本`]);
}

export const ALL_CHECKS = ['controls', 'dag', 'ledger', 'generated', 'contracts', 'placeholders', 'rule-size', 'rule-conflicts'];

export function runChecks(root, names = ALL_CHECKS) {
  const config = loadConfig(root);
  const table = {
    controls: () => checkControls(config, root),
    dag: () => checkDag(root),
    ledger: () => checkLedgerGate(root),
    generated: () => checkGenerated(root),
    contracts: () => checkContracts(root),
    placeholders: () => checkPlaceholders(root, config),
    'rule-size': () => checkRuleSize(root, config),
    'rule-conflicts': () => checkRuleConflicts(root, config),
  };
  return names.map((n) => {
    if (!table[n]) return res(n, 'FAIL', [`沒有這支檢查;可用:${ALL_CHECKS.join(', ')}`]);
    try {
      return table[n]();
    } catch (e) {
      return res(n, 'FAIL', [`檢查本身出錯(不是乾淨):${e.message}`]);
    }
  });
}

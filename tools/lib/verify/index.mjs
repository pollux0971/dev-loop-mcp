// Verifier:script 檢查 + 小模型窄題檢查。
// 小模型只有否決權:輸出 FAIL / ABSTAIN / NO_OBJECTION,從來沒有 PASS。
// 它看的是 dlm 自己重跑的輸出與 diff,不看 worker 的敘述(避免被大模型的說法錨定)。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../git.mjs';
import { fillTemplate } from '../prompt.mjs';
import { linkDeps, removeTree, scratchCopy } from '../sandbox.mjs';
import { pipelineFor } from '../state.mjs';
import { matchAny, readJson } from '../util.mjs';
import { askVerifier } from './backend.mjs';
import {
  checkAcceptance, checkDryRun, checkEvidence, checkMutation, checkPaths,
  checkReportSanity, checkStandalone, checkStubs, checkWorktreeClean, legDiff, hostExecutor,
} from './script-checks.mjs';

function template(root, name, variant) {
  const p = join(root, 'prompts', 'verifier', `${name}.${variant}.md`);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** 同一題兩種問法各問一次;不一致就 ABSTAIN。輸入太大直接 ABSTAIN,不讓小模型讀長 context。 */
export async function modelCheck(root, config, name, vars, label) {
  const v = config.agents.verifier;
  if (v.backend === 'none') return { check: name, outcome: 'SKIPPED', detail: `${label}:verifier 模型未設定` };
  const size = Object.values(vars).reduce((n, s) => n + String(s).length, 0);
  if (size > v.max_input_chars) return { check: name, outcome: 'ABSTAIN', detail: `${label}:輸入 ${size} 字超過小模型上限 ${v.max_input_chars},交上一層` };
  const variants = ['a', 'b'].slice(0, v.runs);
  const answers = [];
  for (const variant of variants) {
    const tpl = template(root, name, variant);
    if (!tpl) return { check: name, outcome: 'ABSTAIN', detail: `缺模板 prompts/verifier/${name}.${variant}.md` };
    let prompt;
    try {
      prompt = fillTemplate(tpl, vars);
    } catch (e) {
      // 模板是舊版(例:v3 的 scenario-honesty 用 <<SCENARIO>>/<<DIFF>>):不讓整個 tick 當掉,棄權並提示升級
      return { check: name, outcome: 'ABSTAIN', detail: `${label}:prompts/verifier/${name}.${variant}.md 是舊版模板(${e.message}),請跑 dlm upgrade` };
    }
    answers.push(await askVerifier(config, prompt));
  }
  const verdicts = [...new Set(answers.map((a) => a.verdict))];
  const model = answers[0].model;
  if (verdicts.length > 1) {
    return { check: name, outcome: 'ABSTAIN', detail: `${label}:兩種問法答案不一致(${answers.map((a) => a.verdict).join(' vs ')})`, model };
  }
  const only = answers[0];
  return { check: name, outcome: only.verdict, detail: `${label}:${only.reason}`, model };
}

export async function runVerify(ctx) {
  const { root, config, dag, node, dispatch, envelope, report } = ctx;
  const wt = dispatch.worktree;
  const commit = git(wt, 'rev-parse HEAD').stdout.trim();
  const legBase = dispatch.leg_base ?? dispatch.base_sha;
  const range = `${legBase} ${commit}`;
  const results = [];
  results.push(checkWorktreeClean(wt));
  const changed = legDiff(wt, legBase, commit);
  const paths = checkPaths(changed, envelope);
  results.push(paths);
  // 沙箱副本裡碰了 .git / .dlm / node_modules / symlink 的,dlm 沒有同步回來,但這一棒一樣不算數
  const violations = dispatch.violations_path ? readJson(join(root, dispatch.violations_path), []) : [];
  if (violations.length) results.push({ check: 'sandbox-escape', outcome: 'FAIL', detail: `在沙箱副本裡碰了不該碰的地方:${violations.slice(0, 10).join(', ')}` });
  results.push(checkReportSanity(report));
  // 越界的樹(例如改了 package.json 的 test script)不執行任何指令:這一棒反正會被退回,
  // 在它上面跑驗收或重跑證據,等於替 worker 執行它改過的東西。
  if (results.some((x) => x.outcome === 'FAIL' && ['paths', 'worktree-clean', 'sandbox-escape'].includes(x.check))) {
    results.push({ check: 'execution', outcome: 'SKIPPED', detail: '路徑 / worktree / 沙箱檢查沒過,不在這棵樹上執行任何指令' });
    return { results, commit, changed };
  }
  // 會執行程式的檢查都在一份用完即丟的副本上、verify profile 的沙箱裡跑:worker 寫的測試動不到 worktree 與主機
  const scratch = scratchCopy(root, wt, dispatch.dispatch_id);
  linkDeps(root, scratch);
  const ex = hostExecutor(scratch);
  const leg = dispatch.leg;
  const isLast = leg === pipelineFor(node, config).at(-1);
  let reruns = [];
  // 驗收指令 → dlm 自己重跑的結果(PASS = 照規定紅 / 綠,紅的原因也對)
  const accepted = new Map();
  try {
    const evidence = checkEvidence(ex, report, config);
    reruns = evidence.reruns;
    results.push(...evidence.results);
    const acc = checkAcceptance(ex, envelope, config);
    results.push(...acc);
    envelope.acceptance.forEach((a, i) => accepted.set(normCmd(a.cmd), acc[i]?.outcome));
    if (leg === 'test' || leg === 'test-fix') results.push(...checkDryRun(ex, node, config));
    if (['dev', 'integrate'].includes(leg)) results.push(...checkStandalone(ex, node, config));
    if (leg === 'integrate') {
      for (const depId of node.depends_on ?? []) {
        const dep = dag.nodes.find((n) => n.id === depId);
        if (dep?.standalone) results.push(...checkStandalone(ex, dep, config).map((x) => ({ ...x, check: 'regression-standalone', detail: `${dep.id}: ${x.detail}` })));
      }
    }
    if (isLast && ['dev', 'integrate'].includes(leg) && !results.some((x) => x.outcome === 'FAIL')) {
      results.push(...checkMutation(ex, changed, node, config, { leg }));
    }
  } finally {
    removeTree(scratch);
  }
  if (leg === 'integrate') results.push(...checkStubs(wt, dag, node, config));

  // ---- 模型窄題 ----
  for (const rr of reruns) {
    // v4.7.3:證據指令就是這一棒的驗收指令,而且 dlm 剛用它重跑確認過(紅 / 綠照規定、紅的原因也對,退出碼也跟宣稱一樣):
    // 再問小模型「輸出有沒有推翻這個宣稱」是多餘的;兩種問法答得不一樣就變成 ABSTAIN、升級問使用者。
    // 實跑:todo-cli、wordfreq、minilang 好幾次要使用者決定合併,原因都是「驗收是紅的 / 全綠」這種宣稱兩種問法不一致
    if (accepted.get(normCmd(rr.cmd)) === 'PASS') {
      results.push({ check: 'claim-supported', outcome: 'SKIPPED', detail: `宣稱「${rr.claim.slice(0, 40)}」:證據就是驗收指令,dlm 已經重跑確認,不再問小模型` });
      continue;
    }
    results.push(await modelCheck(root, config, 'claim-supported', { CLAIM: rr.claim, CMD: rr.cmd, EXIT: String(rr.exit), OUTPUT: rr.output }, `宣稱「${rr.claim.slice(0, 40)}」`));
  }
  if (['dev', 'integrate'].includes(leg) && node.gherkin) {
    // v4:不再「每個場景 × 截斷的 diff」(v3 實測 90 題 71 題棄權、一次驗證 17 分鐘:關鍵函式常被截掉)。
    // 改成「gherkin 裡出現的值」對「改到的實作檔全文」逐段問一次:小模型看得到完整函式,呼叫次數跟檔案大小走,不跟場景數走。
    const impl = changed.filter((p) => !matchAny(p, config.paths.tests) && existsSync(join(wt, p)));
    const literals = gherkinLiterals(wt, node.gherkin);
    const budget = Math.floor(config.agents.verifier.max_input_chars * 0.85) - literals.length;
    for (const file of impl) {
      const chunks = codeChunks(readFileSync(join(wt, file), 'utf8'), Math.max(budget, 800));
      for (const [i, c] of chunks.entries()) {
        const where = chunks.length > 1 ? `${file} 第 ${c.from}–${c.to} 行` : file;
        results.push(await modelCheck(root, config, 'scenario-honesty', { LITERALS: literals || '(gherkin 沒有具體值)', FILE: where, CODE: c.text }, `實作 ${where}${chunks.length > 1 ? `(${i + 1}/${chunks.length})` : ''}`));
      }
    }
  }
  // v4:不在重跑白名單的證據,如果這一棒的驗收已經由 dlm 自己跑過並通過,只是「多說的話沒驗」,不再升級成問使用者
  const acceptanceRan = results.some((x) => x.check === 'acceptance' && x.outcome === 'PASS');
  if (acceptanceRan) {
    for (const x of results) {
      if (x.check === 'evidence' && x.outcome === 'ABSTAIN' && /重跑白名單/.test(x.detail ?? '')) {
        x.outcome = 'SKIPPED';
        x.detail = `${x.detail}(驗收已由 dlm 重跑通過,這條只記錄不升級)`;
      }
    }
  }
  return { results, commit, changed };
}

/** gherkin 裡出現的具體值(數字、日期、引號字串、表格格子),給小模型對照「有沒有對這些值寫死」。 */
export function gherkinLiterals(root, rel, max = 1500) {
  const p = join(root, rel);
  if (!existsSync(p)) return '';
  const text = readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(#|@|Feature:|Scenario|Background|Rule:|Examples:)/.test(l)).join('\n');
  const seen = new Set();
  const add = (v) => { v = v.trim(); if (v && v.length <= 60) seen.add(v); };
  for (const m of text.matchAll(/"([^"\n]{1,60})"/g)) add(`"${m[1]}"`);
  for (const m of text.matchAll(/\|([^|\n]+)(?=\|)/g)) if (/\d/.test(m[1])) add(m[1]);
  for (const m of text.matchAll(/(?<![\w.])-?\d[\d,]*(?:[.\-/]\d+)*(?![\w])/g)) if (m[0].replace(/\D/g, '').length >= 2) add(m[0]);
  let out = '';
  for (const v of seen) {
    if (out.length + v.length + 2 > max) break;
    out += `${out ? ', ' : ''}${v}`;
  }
  return out;
}

/** 依行切段,每段不超過 maxChars;單行太長就硬切。回傳 [{ from, to, text }](行號從 1 起算)。 */
export function codeChunks(text, maxChars) {
  const lines = text.split('\n');
  const chunks = [];
  let cur = [];
  let size = 0;
  let from = 1;
  lines.forEach((l, i) => {
    const line = l.length > maxChars ? l.slice(0, maxChars) : l;
    if (size + line.length + 1 > maxChars && cur.length) {
      chunks.push({ from, to: i, text: cur.join('\n') });
      cur = [];
      size = 0;
      from = i + 1;
    }
    cur.push(line);
    size += line.length + 1;
  });
  if (cur.length && cur.some((l) => l.trim())) chunks.push({ from, to: lines.length, text: cur.join('\n') });
  return chunks;
}

/**
 * 沒有 Verifier 模型時,「寫死測試值」這類作弊只剩場景誠實度這一題在抓,而它 SKIPPED 了。
 * 這種 SKIPPED 視同 ABSTAIN:交給 Critic 或使用者,不自動合併。帳本裡照實記 SKIPPED,只有路由這樣算。
 */
export const ESCALATE_WHEN_NO_VERIFIER = ['scenario-honesty'];

/** 比對指令用:去頭尾空白、連續空白當一個。 */
const normCmd = (cmd) => String(cmd ?? '').trim().replace(/\s+/g, ' ');

export function summarize(results, { verifierBackend } = {}) {
  const fails = results.filter((x) => x.outcome === 'FAIL');
  const abstains = results.filter((x) => x.outcome === 'ABSTAIN');
  // mutation 達標 = 測試真的抓得到改壞的實作,「寫死測試值」已經被機器排除,不必再升級
  const mutationOk = results.some((x) => x.check === 'mutation' && x.outcome === 'PASS');
  if (verifierBackend === 'none' && !mutationOk) {
    for (const x of results) {
      if (x.outcome === 'SKIPPED' && ESCALATE_WHEN_NO_VERIFIER.includes(x.check)) {
        abstains.push({ ...x, outcome: 'ABSTAIN', detail: `${x.detail}(沒有 Verifier 模型,沒人檢查寫死測試值這類作弊)` });
      }
    }
  }
  return { fails, abstains, ok: fails.length === 0, clear: fails.length === 0 && abstains.length === 0 };
}

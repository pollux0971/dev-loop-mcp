// Verifier: script checks + narrow-question checks by the small model.
// The small model only has a veto: it outputs FAIL / ABSTAIN / NO_OBJECTION, never PASS.
// It looks at the output and diff that dlm re-ran itself, not at the worker's narrative (to avoid being anchored by the big model's wording).
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

/** Ask the same question two ways, once each; ABSTAIN if they disagree. If the input is too large, ABSTAIN right away; the small model never reads a long context. */
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
      // The template is an old version (e.g. v3's scenario-honesty uses <<SCENARIO>>/<<DIFF>>): do not crash the whole tick; abstain and suggest an upgrade
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
  // Anything touched in the sandbox copy under .git / .dlm / node_modules / symlink was not synced back by dlm, but this leg still does not count
  const violations = dispatch.violations_path ? readJson(join(root, dispatch.violations_path), []) : [];
  if (violations.length) results.push({ check: 'sandbox-escape', outcome: 'FAIL', detail: `在沙箱副本裡碰了不該碰的地方:${violations.slice(0, 10).join(', ')}` });
  results.push(checkReportSanity(report));
  // Do not run any command on an out-of-bounds tree (e.g. one that changed the test script in package.json): this leg will be sent back anyway,
  // and running acceptance or re-running evidence on it would mean executing what the worker changed.
  if (results.some((x) => x.outcome === 'FAIL' && ['paths', 'worktree-clean', 'sandbox-escape'].includes(x.check))) {
    results.push({ check: 'execution', outcome: 'SKIPPED', detail: '路徑 / worktree / 沙箱檢查沒過,不在這棵樹上執行任何指令' });
    return { results, commit, changed };
  }
  // Checks that execute code all run on a throwaway copy, inside the verify profile sandbox: tests written by the worker cannot touch the worktree or the host
  const scratch = scratchCopy(root, wt, dispatch.dispatch_id);
  linkDeps(root, scratch);
  const ex = hostExecutor(scratch);
  const leg = dispatch.leg;
  const isLast = leg === pipelineFor(node, config).at(-1);
  let reruns = [];
  // acceptance command -> result of dlm's own re-run (PASS = red / green as required, and the reason for red is right too)
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

  // ---- narrow questions for the model ----
  for (const rr of reruns) {
    // v4.7.3: the evidence command is this leg's acceptance command, and dlm just re-ran it to confirm (red / green as required, the reason for red is right, and the exit code matches the claim):
    // asking the small model "does the output refute this claim" is redundant; if the two phrasings answer differently it becomes ABSTAIN and escalates to the user.
    // Seen in a real run: todo-cli, wordfreq and minilang several times needed the user to decide a merge, always because the two phrasings disagreed on a claim like "acceptance is red / all green"
    if (accepted.get(normCmd(rr.cmd)) === 'PASS') {
      results.push({ check: 'claim-supported', outcome: 'SKIPPED', detail: `宣稱「${rr.claim.slice(0, 40)}」:證據就是驗收指令,dlm 已經重跑確認,不再問小模型` });
      continue;
    }
    results.push(await modelCheck(root, config, 'claim-supported', { CLAIM: rr.claim, CMD: rr.cmd, EXIT: String(rr.exit), OUTPUT: rr.output }, `宣稱「${rr.claim.slice(0, 40)}」`));
  }
  if (['dev', 'integrate'].includes(leg) && node.gherkin) {
    // v4: no longer "every scenario x a truncated diff" (v3 real run: 71 of 90 questions abstained, one verification took 17 minutes: key functions were often cut off).
    // Instead, ask once per chunk: "the values that appear in the gherkin" against "the full text of the changed implementation file". The small model sees the whole function, and the number of calls follows file size, not scenario count.
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
  // v4: evidence not on the re-run allowlist: if dlm already ran this leg's acceptance itself and it passed, it is only "extra words not verified" and no longer escalates to asking the user
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

/** Concrete values in the gherkin (numbers, dates, quoted strings, table cells), so the small model can check whether the code hardcodes them. */
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

/** Split by line into chunks of at most maxChars; a single line that is too long is cut hard. Returns [{ from, to, text }] (line numbers start at 1). */
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
 * With no Verifier model, cheating such as "hardcoding test values" is caught only by the scenario-honesty question, and that was SKIPPED.
 * This kind of SKIPPED counts as ABSTAIN: hand it to the Critic or the user, no automatic merge. The ledger still records SKIPPED as is; only routing counts it this way.
 */
export const ESCALATE_WHEN_NO_VERIFIER = ['scenario-honesty'];

/** For comparing commands: trim both ends and treat runs of whitespace as one. */
const normCmd = (cmd) => String(cmd ?? '').trim().replace(/\s+/g, ' ');

export function summarize(results, { verifierBackend } = {}) {
  const fails = results.filter((x) => x.outcome === 'FAIL');
  const abstains = results.filter((x) => x.outcome === 'ABSTAIN');
  // mutation target met = the tests really catch a broken implementation; "hardcoded test values" is already ruled out by machine, so no need to escalate
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

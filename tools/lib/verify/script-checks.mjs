// Deterministic checks: the same input always gives the same result. Anything a script can judge is never left to the model.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getNode } from '../dag.mjs';
import { git } from '../git.mjs';
import { listFiles, matchAny, run, runArgv, tail } from '../util.mjs';

const r = (check, outcome, detail, evidence) => ({ check, outcome, detail, ...(evidence ? { evidence } : {}) });

/**
 * Executor: acceptance, evidence re-runs and standalone all go through it.
 * hostExecutor runs directly in the directory (the verification copy, unit tests).
 */
export function hostExecutor(cwd) {
  // The acceptance copy is under .dlm/ and has no .git: do not let git search upward and find the outer main repo (see sandboxCommand in sandbox.mjs)
  const env = { GIT_CEILING_DIRECTORIES: dirname(resolve(cwd)) };
  return {
    cwd,
    sh: (cmd, timeoutMs) => run(cmd, { cwd, env, timeoutMs }),
    argv: (argv, timeoutMs) => runArgv(argv[0], argv.slice(1), { cwd, env, timeoutMs }),
  };
}

const asExecutor = (x) => (typeof x === 'string' ? hostExecutor(x) : x);

/**
 * Which files this leg changed in total: walk first-parent from the leg's start, counting only non-merge commits.
 * Merge commits that sync main do not count (they belong to main); half-finished work committed before being blocked does count (it must be verified too).
 */
export function legDiff(cwd, legBase, to, { onlyDlm = true } = {}) {
  // v4: count only the commits dlm made when collecting from the worker (author dlm@localhost; the worker is in a copy with no .git and cannot commit itself).
  // Commits that the user / Front fixed by hand on the branch are not charged to the worker (v3 real run: Front removed files left by the previous leg, and the next leg was then judged out of bounds and could never pass)
  const author = onlyDlm ? ' --author=dlm@localhost' : '';
  const out = git(cwd, `log --no-merges --first-parent${author} --name-only --format= ${legBase}..${to}`).stdout;
  return [...new Set(out.split('\n').map((x) => x.trim()).filter(Boolean))].sort();
}

export function checkWorktreeClean(worktree) {
  const dirty = git(worktree, 'status --porcelain').stdout.split('\n').filter(Boolean)
    .map((l) => l.slice(3)).filter((p) => !p.startsWith('.dlm/'));
  return dirty.length
    ? r('worktree-clean', 'FAIL', `worktree 有未 commit 的變更(交件必須 commit):${dirty.slice(0, 10).join(', ')}`)
    : r('worktree-clean', 'PASS', '無未 commit 變更');
}

export function checkPaths(changed, envelope) {
  const outside = changed.filter((p) => !matchAny(p, envelope.allowed_paths));
  const forbidden = changed.filter((p) => matchAny(p, envelope.forbidden_paths));
  const bad = [...new Set([...outside, ...forbidden])];
  // v4.7.3: an integrate leg may have no changes, because the composition layer was already wired up when the capability node merged (acceptance must still be green; the acceptance check later covers that).
  // Seen in a real run: after todo-cli's I1 skipped the test leg, the integrate leg honestly changed nothing and was sent back by this rule; dispatching again gave the same result, and the only way out was to fake a file
  if (!changed.length) {
    return envelope.leg === 'integrate'
      ? r('paths', 'PASS', '整合棒沒有檔案變動:組合層已經接通(驗收照樣要綠)')
      : r('paths', 'FAIL', '這一棒沒有任何檔案變動');
  }
  return bad.length
    ? r('paths', 'FAIL', `寫到 allowed_paths 以外或禁區:${bad.join(', ')}`, `allowed=${envelope.allowed_paths.join(' ')}`)
    : r('paths', 'PASS', `${changed.length} 個檔都在範圍內`);
}

export function checkReportSanity(report) {
  if (report.kind !== 'done') return r('report', 'PASS', `kind=${report.kind}`);
  const withEvidence = report.claims.filter((c) => c.evidence);
  if (!withEvidence.length) return r('report', 'FAIL', 'done 但沒有任何附指令證據的宣稱;「完成了」本身不是證據');
  return r('report', 'PASS', `${withEvidence.length} 條附證據、${report.claims.length - withEvidence.length} 條標 unverified`);
}

/**
 * The test leg's "red" must be red for the right reason: the implementation does not exist yet. Syntax errors, unbound steps and pending also make the command exit non-zero, but that is not red, it is broken.
 * Returns null if it looks like a normal red; otherwise returns the reason.
 */
export function badRedReason(output) {
  const text = String(output ?? '');
  // "The requested module does not provide an export" means the implementation does not have that function yet, which is a normal red
  if (/\bSyntaxError\b(?!: The requested module)/.test(text)) return '紅的原因是語法錯誤,不是實作不存在';
  const summary = text.match(/\d+ (?:scenarios?|steps?) \(([^)]*)\)/g) ?? [];
  if (summary.some((line) => /\b[1-9]\d* (?:undefined|pending|ambiguous)\b/.test(line))) return '有步驟沒綁定 / pending / ambiguous:紅的原因不是實作不存在';
  return null;
}

export function checkAcceptance(ex, envelope, config) {
  ex = asExecutor(ex);
  const out = [];
  for (const a of envelope.acceptance) {
    const res = ex.sh(a.cmd, config.verify.rerun_timeout_seconds * 1000);
    const output = res.stdout + res.stderr;
    let ok = a.expect_exit === -1 ? res.code !== 0 : res.code === a.expect_exit;
    const want = a.expect_exit === -1 ? '非 0(紅)' : String(a.expect_exit);
    let detail = `${a.cmd} → exit ${res.code},預期 ${want}`;
    const bad = a.expect_exit === -1 && ok ? badRedReason(output) : null;
    if (bad) { ok = false; detail += `;${bad}`; }
    out.push(r('acceptance', ok ? 'PASS' : 'FAIL', detail, tail(output, 1500)));
  }
  return out;
}

/** Test leg: every gherkin step must bind to a step definition (the cucumber dry-run summary lines are clean). */
export function checkDryRun(ex, node, config) {
  const tpl = config.verify.dry_run_cmd;
  if (!tpl || !node.gherkin) return [];
  ex = asExecutor(ex);
  const cmd = tpl.replaceAll('{gherkin}', node.gherkin);
  const res = ex.sh(cmd, config.verify.rerun_timeout_seconds * 1000);
  const output = res.stdout + res.stderr;
  const bad = badRedReason(output);
  const ok = res.code === 0 && !bad;
  return [r('dry-run', ok ? 'PASS' : 'FAIL', `${cmd} → exit ${res.code}${bad ? `;${bad}` : ''}`, tail(output, 1500))];
}

/** Score from a Stryker (mutation-testing-report-schema) report: detected / valid. */
export function mutationScore(report) {
  let detected = 0;
  let valid = 0;
  for (const f of Object.values(report?.files ?? {})) {
    for (const m of f.mutants ?? []) {
      if (m.status === 'Killed' || m.status === 'Timeout') { detected++; valid++; }
      else if (m.status === 'Survived' || m.status === 'NoCoverage') valid++;
    }
  }
  return valid ? { score: (100 * detected) / valid, detected, valid } : null;
}

/**
 * Last leg: run mutation only on the implementation files this leg changed. A low score means the tests do not catch errors,
 * most often because the implementation hardcodes the test values. tier strict gives FAIL, others ABSTAIN (hand to the Critic or you).
 */
/** Stryker found no tests related to the changed files (vitest.related): no unit test imports these files. */
const NO_RELATED_TESTS = /No tests were executed|failed to find test files related to mutated files/;

export function checkMutation(ex, files, node, config, { leg } = {}) {
  const m = config.verify.mutation;
  if (!m?.cmd) return [];
  const targets = files.filter((f) => matchAny(f, m.include ?? []) && !matchAny(f, config.paths.tests));
  if (!targets.length) return [];
  ex = asExecutor(ex);
  const cmd = m.cmd.replaceAll('{files}', targets.join(','));
  const res = ex.sh(cmd, (m.timeout_minutes ?? 30) * 60000);
  const reportPath = join(ex.cwd, m.report);
  let score = null;
  if (existsSync(reportPath)) {
    try { score = mutationScore(JSON.parse(readFileSync(reportPath, 'utf8'))); } catch { /* treat as no report below */ }
  }
  if (!score) {
    const out = res.stdout + res.stderr;
    // v4.7.3: no unit test imports the changed files. The integrate leg's composition layer (command line etc.) is tested from outside through a subprocess and guarded by integration acceptance, so mutation not being able to measure it
    // is not a problem -> SKIPPED; for other legs it is a real warning (the tests never touch these files), so ABSTAIN as before, but state the reason clearly.
    // Seen in a real run: minilang's I1 (apps/cli) ABSTAINed every time because of "No tests were executed", so the integrate leg had to ask the user every time
    if (NO_RELATED_TESTS.test(out)) {
      return leg === 'integrate'
        ? [r('mutation', 'SKIPPED', `整合棒改到的檔(${targets.join(', ')})沒有單元測試直接 import(命令列多半用子程序測),mutation 量不到;這一層由整合驗收把關`)]
        : [r('mutation', 'ABSTAIN', `改到的檔(${targets.join(', ')})沒有任何單元測試直接 import,mutation 量不到測試強度:測試可能只從外面跑程式,或根本沒測到這些檔`, tail(out, 600))];
    }
    return [r('mutation', 'ABSTAIN', `mutation 沒產生可讀的報告(exit ${res.code}),無法判斷測試強度`, tail(out, 1500))];
  }
  const pct = score.score.toFixed(1);
  const min = node.tier === 'strict' ? (m.min_strict ?? m.min) : m.min;
  if (score.score >= min) return [r('mutation', 'PASS', `mutation 分數 ${pct}%(${score.detected}/${score.valid})≥ ${min}%`)];
  const detail = `mutation 分數 ${pct}%(${score.detected}/${score.valid})低於 ${min}%:測試抓不到改壞的實作,可能是對測試值寫死`;
  return [r('mutation', node.tier === 'strict' ? 'FAIL' : 'ABSTAIN', detail)];
}

// Characters allowed in a re-run command. No newline, quote, $, `, ;, |, &, <, >, ~, *: they are not escaped, they are simply not accepted.
const SAFE_CMD = /^[A-Za-z0-9 ._/:=@+-]+$/;

/**
 * Whether a command the worker claimed can be re-run. If yes -> { argv }; if no -> { why } (always ABSTAIN, never executed).
 * The allowlist is a prefix match, but the prefix must end on an argument boundary (`npm test` does not let `npm testx` through).
 * Arguments must not point outside the worktree: absolute paths, `..` and `--x=/abs` are all rejected.
 */
export function rerunArgv(cmd, allow) {
  if (typeof cmd !== 'string' || !SAFE_CMD.test(cmd)) {
    return { why: '含不允許的字元(只收英數、._/:=@+- 與空白;換行、引號、shell 符號一律不執行)' };
  }
  const argv = cmd.split(' ').filter(Boolean);
  const escapes = argv.some((a) => a.split(/[=:]/).some((part) => part.startsWith('/') || part.split('/').includes('..')));
  if (escapes) return { why: '參數含絕對路徑或 ..(重跑只能碰 worktree 裡的東西)' };
  const norm = argv.join(' ');
  const listed = allow.some((p) => {
    const head = p.trimEnd();
    if (!head || !norm.startsWith(head)) return false;
    if (p.endsWith(' ')) return norm.length > head.length && norm[head.length] === ' '; // something must follow 'npm run '
    if (head.endsWith('/')) return true; // 'node packages/' is a path prefix
    return norm.length === head.length || norm[head.length] === ' ';
  });
  if (!listed) return { why: '不在重跑白名單(verify.rerun_allow)' };
  return { argv };
}

/**
 * Re-run the commands the worker claimed. Only commands that are on the allowlist and character-safe are run, via argv and not through a shell; the rest ABSTAIN.
 * On FAIL the re-run output is not attached: the command was chosen by the worker, and the output goes into the ledger and is fed back into the next work order, so it must not become a leak channel.
 */
export function checkEvidence(ex, report, config) {
  ex = asExecutor(ex);
  const results = [];
  const reruns = [];
  for (const c of report.claims) {
    if (!c.evidence) continue;
    const { cmd, exit } = c.evidence;
    const ok = rerunArgv(cmd, config.verify.rerun_allow);
    if (!ok.argv) {
      results.push(r('evidence', 'ABSTAIN', `${ok.why},不執行:${JSON.stringify(cmd).slice(0, 200)}`));
      continue;
    }
    const res = ex.argv(ok.argv, config.verify.rerun_timeout_seconds * 1000);
    reruns.push({ claim: c.text, cmd, exit: res.code, output: tail(res.stdout + res.stderr, 3000) });
    results.push(res.code === exit
      ? r('evidence', 'PASS', `重跑 ${cmd} 得到相同退出碼 ${exit}`)
      : r('evidence', 'FAIL', `宣稱「${c.text.slice(0, 200)}」:${cmd} 聲稱 exit ${exit},重跑得到 ${res.code}`));
  }
  return { results, reruns };
}

export function checkStandalone(ex, node, config) {
  if (!node.standalone) return [];
  ex = asExecutor(ex);
  const res = ex.sh(node.standalone, config.verify.rerun_timeout_seconds * 1000);
  return [r('standalone', res.code === 0 ? 'PASS' : 'FAIL', `${node.standalone} → exit ${res.code}`, tail(res.stdout + res.stderr, 1500))];
}

function transitiveDeps(dag, id, seen = new Set()) {
  for (const d of getNode(dag, id)?.depends_on ?? []) {
    if (seen.has(d) || !getNode(dag, d)) continue;
    seen.add(d);
    transitiveDeps(dag, d, seen);
  }
  return seen;
}

/** Integrate leg: production code (non-test) must no longer import __stubs__. The temporary fake implementations from Wave 0 must be removed at the integration point. */
export function checkStubs(worktree, dag, node, config) {
  const ids = [node.id, ...transitiveDeps(dag, node.id)];
  const owns = ids.flatMap((id) => getNode(dag, id)?.owns ?? []);
  const offenders = [];
  for (const f of listFiles(worktree, { skip: ['.git', 'node_modules', '.dlm'] })) {
    if (!matchAny(f, owns) || matchAny(f, config.paths.tests) || f.includes('__stubs__/')) continue;
    if (!/\.(m?[jt]sx?|py|go|rs)$/.test(f)) continue;
    const text = readFileSync(join(worktree, f), 'utf8');
    if (/(?:import|require|from)[^\n]*__stubs__/.test(text)) offenders.push(f);
  }
  return [offenders.length
    ? r('stubs', 'FAIL', `整合後正式碼仍 import __stubs__:${offenders.join(', ')}`)
    : r('stubs', 'PASS', `掃 ${ids.length} 個節點的 owns,沒有正式碼引用 stub`)];
}

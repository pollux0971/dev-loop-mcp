// 確定性檢查:同樣輸入永遠同樣結果。能用 script 判的絕不交給模型。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getNode } from '../dag.mjs';
import { git } from '../git.mjs';
import { listFiles, matchAny, run, runArgv, tail } from '../util.mjs';

const r = (check, outcome, detail, evidence) => ({ check, outcome, detail, ...(evidence ? { evidence } : {}) });

/**
 * 執行器:驗收、證據重跑、standalone 都經過它。
 * hostExecutor 直接在目錄裡跑(驗證用的副本、單元測試)。
 */
export function hostExecutor(cwd) {
  // 驗收副本在 .dp/ 底下、沒有 .git:不讓 git 往上找到外層主 repo(見 sandbox.mjs 的 sandboxCommand)
  const env = { GIT_CEILING_DIRECTORIES: dirname(resolve(cwd)) };
  return {
    cwd,
    sh: (cmd, timeoutMs) => run(cmd, { cwd, env, timeoutMs }),
    argv: (argv, timeoutMs) => runArgv(argv[0], argv.slice(1), { cwd, env, timeoutMs }),
  };
}

const asExecutor = (x) => (typeof x === 'string' ? hostExecutor(x) : x);

/**
 * 這一棒累積改了哪些檔:從棒的起點沿 first-parent 走、只算非 merge 的 commit。
 * 同步主線的 merge commit 不算(那是主線的東西);被 blocked 前先 commit 的半成品也算(必須一起驗)。
 */
export function legDiff(cwd, legBase, to, { onlyDp = true } = {}) {
  // v4:只算 dp 替 worker 收件的 commit(作者 dp@localhost;worker 在沒有 .git 的副本裡,自己 commit 不了)。
  // 使用者 / Front 在分支上手動修的 commit 不算在 worker 頭上(v3 實測:Front 清掉前一棒留下的檔,下一棒反被判越界、永遠過不了)
  const author = onlyDp ? ' --author=dp@localhost' : '';
  const out = git(cwd, `log --no-merges --first-parent${author} --name-only --format= ${legBase}..${to}`).stdout;
  return [...new Set(out.split('\n').map((x) => x.trim()).filter(Boolean))].sort();
}

export function checkWorktreeClean(worktree) {
  const dirty = git(worktree, 'status --porcelain').stdout.split('\n').filter(Boolean)
    .map((l) => l.slice(3)).filter((p) => !p.startsWith('.dp/'));
  return dirty.length
    ? r('worktree-clean', 'FAIL', `worktree 有未 commit 的變更(交件必須 commit):${dirty.slice(0, 10).join(', ')}`)
    : r('worktree-clean', 'PASS', '無未 commit 變更');
}

export function checkPaths(changed, envelope) {
  const outside = changed.filter((p) => !matchAny(p, envelope.allowed_paths));
  const forbidden = changed.filter((p) => matchAny(p, envelope.forbidden_paths));
  const bad = [...new Set([...outside, ...forbidden])];
  if (!changed.length) return r('paths', 'FAIL', '這一棒沒有任何檔案變動');
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
 * 測試棒的「紅」要紅在對的地方:實作還不存在。語法錯誤、步驟沒綁定、pending 也會讓指令非 0,但那不是紅,是壞。
 * 回傳 null 代表看起來是正常的紅;否則回傳原因。
 */
export function badRedReason(output) {
  const text = String(output ?? '');
  // 「The requested module does not provide an export」是實作還沒有那個函式,屬於正常的紅
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

/** 測試棒:gherkin 的每一步都要綁到步驟定義(cucumber dry-run 的摘要行乾淨)。 */
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

/** Stryker(mutation-testing-report-schema)報告的分數:偵測到的 / 有效的。 */
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
 * 最後一棒:只對這一棒改到的實作檔跑 mutation。分數低代表測試抓不到錯,
 * 常見原因是實作對測試值寫死。tier strict 判 FAIL,其他 ABSTAIN(交 Critic 或你)。
 */
export function checkMutation(ex, files, node, config) {
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
    try { score = mutationScore(JSON.parse(readFileSync(reportPath, 'utf8'))); } catch { /* 下面當成沒有報告 */ }
  }
  if (!score) return [r('mutation', 'ABSTAIN', `mutation 沒產生可讀的報告(exit ${res.code}),無法判斷測試強度`, tail(res.stdout + res.stderr, 1500))];
  const pct = score.score.toFixed(1);
  const min = node.tier === 'strict' ? (m.min_strict ?? m.min) : m.min;
  if (score.score >= min) return [r('mutation', 'PASS', `mutation 分數 ${pct}%(${score.detected}/${score.valid})≥ ${min}%`)];
  const detail = `mutation 分數 ${pct}%(${score.detected}/${score.valid})低於 ${min}%:測試抓不到改壞的實作,可能是對測試值寫死`;
  return [r('mutation', node.tier === 'strict' ? 'FAIL' : 'ABSTAIN', detail)];
}

// 重跑指令能用的字元。沒有換行、引號、$、`、;、|、&、<、>、~、*:不是跳脫,是根本不收。
const SAFE_CMD = /^[A-Za-z0-9 ._/:=@+-]+$/;

/**
 * worker 宣稱的指令能不能重跑。能 → { argv };不能 → { why }(一律 ABSTAIN,完全不執行)。
 * 白名單是前綴比對,但前綴必須落在參數邊界上(`npm test` 不會放行 `npm testx`)。
 * 參數不能指向 worktree 以外:絕對路徑、`..`、`--x=/abs` 都拒絕。
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
    if (p.endsWith(' ')) return norm.length > head.length && norm[head.length] === ' '; // 'npm run ' 後面要有東西
    if (head.endsWith('/')) return true; // 'node packages/' 是路徑前綴
    return norm.length === head.length || norm[head.length] === ' ';
  });
  if (!listed) return { why: '不在重跑白名單(verify.rerun_allow)' };
  return { argv };
}

/**
 * 重跑 worker 宣稱的指令。只跑白名單內、字元安全的指令,以 argv 執行、不經 shell;其餘 ABSTAIN。
 * FAIL 時不附重跑輸出:指令是 worker 自選的,輸出會進帳本、再回灌到下一張工單,不能變成外洩通道。
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

/** 整合棒:正式碼(非測試)不可再 import __stubs__。Wave 0 的暫時假實作要在整合點拆掉。 */
export function checkStubs(worktree, dag, node, config) {
  const ids = [node.id, ...transitiveDeps(dag, node.id)];
  const owns = ids.flatMap((id) => getNode(dag, id)?.owns ?? []);
  const offenders = [];
  for (const f of listFiles(worktree, { skip: ['.git', 'node_modules', '.dp'] })) {
    if (!matchAny(f, owns) || matchAny(f, config.paths.tests) || f.includes('__stubs__/')) continue;
    if (!/\.(m?[jt]sx?|py|go|rs)$/.test(f)) continue;
    const text = readFileSync(join(worktree, f), 'utf8');
    if (/(?:import|require|from)[^\n]*__stubs__/.test(text)) offenders.push(f);
  }
  return [offenders.length
    ? r('stubs', 'FAIL', `整合後正式碼仍 import __stubs__:${offenders.join(', ')}`)
    : r('stubs', 'PASS', `掃 ${ids.length} 個節點的 owns,沒有正式碼引用 stub`)];
}

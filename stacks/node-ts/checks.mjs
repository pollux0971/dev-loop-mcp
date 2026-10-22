// node-ts stack checks. The core calls testLegChecks on characterize / test / test-fix legs and passes in everything it needs:
// this file imports nothing from tools/lib, because it lives at stacks/node-ts/ in the dlm repo and at tools/stacks/node-ts/ in an installed project.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// tsc "Cannot find module" / "is not a module": expected on a test leg, whose implementation does not exist yet
const MISSING_IMPL_TS = new Set(['TS2307', 'TS2306']);

/**
 * v4.11: test-type legs also typecheck the files they wrote.
 * Weave OS real run: 3 of 6 nodes had step definitions that failed tsc under exactOptionalPropertyTypes; the test leg only ran
 * acceptance and dry-run, so the error surfaced at the merge gate after the dev leg, and the dev leg could not fix tests: one extra leg each time.
 * Only errors in files this leg changed count, and "cannot find module" is let through (the implementation comes in the next leg).
 */
export function checkTestTypes({ ex, changed, config, lib }) {
  let cmd = config.verify.typecheck_cmd;
  if (cmd === 'auto') cmd = lib.readJson(join(ex.cwd, 'package.json'), null)?.scripts?.typecheck ? 'npm run --silent typecheck' : null;
  if (!cmd || !changed.length) return [];
  const res = ex.sh(cmd, config.verify.rerun_timeout_seconds * 1000);
  const output = res.stdout + res.stderr;
  const mine = new Set(changed);
  const errors = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^(.+?)\(\d+,\d+\): error (TS\d+):/);
    if (m && mine.has(m[1].trim()) && !MISSING_IMPL_TS.has(m[2])) errors.push(line.trim());
  }
  if (!errors.length) return [lib.r('typecheck', 'PASS', `${cmd}:這一棒寫的檔沒有型別錯誤(找不到實作模組的錯誤不算)`)];
  return [lib.r('typecheck', 'FAIL', `這一棒寫的檔有 ${errors.length} 個型別錯誤,合併前的 typecheck 一定會紅:${errors.slice(0, 5).join(' | ')}`, lib.tail(output, 1500))];
}

/**
 * v4.11: tests must load the implementation with a literal path (`await import('./x.js')`).
 * Weave OS real run: `const path = './index.js'; await import(path)` hides which test covers which file, so mutation could not measure the tests and had to abstain.
 */
export function checkLiteralImports({ wt, changed, config, lib }) {
  const bad = [];
  for (const f of changed.filter((p) => lib.matchAny(p, config.paths.tests) && /\.(m|c)?[jt]sx?$/.test(p))) {
    const p = join(wt, f);
    if (!existsSync(p)) continue;
    readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      const m = line.match(/\bimport\(\s*([^)]*)\)/);
      if (m && !/^(['"])[^'"]*\1$|^`[^`$]*`$/.test(m[1].trim())) bad.push(`${f}:${i + 1}`);
    });
  }
  if (!bad.length) return [];
  return [lib.r('literal-import', 'FAIL', `動態 import 要寫字面路徑(例 await import('./index.js')),不然 mutation 認不出哪個測試在測哪個檔:${bad.slice(0, 5).join(', ')}`)];
}

/** Entry point the core calls. ex runs commands on the throwaway verification copy; wt is the worktree (read only here). */
export function testLegChecks(ctx) {
  return [...checkTestTypes(ctx), ...checkLiteralImports(ctx)];
}

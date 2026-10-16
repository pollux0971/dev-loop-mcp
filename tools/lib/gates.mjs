// Single entry point for the full gate. chain is a list of package.json script names (v4.5: or the matching commands in gates.commands);
// an empty chain or a missing command counts as a failure: "list not filled in" is not "nothing to do".
// v4.5: when an existing project has a test baseline (docs/dlm-baseline.json) and every red test was already red in the baseline, this gate passes (known-red).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { gateCommand, knownRed, readBaseline } from './brownfield.mjs';
import { sandboxExec } from './sandbox.mjs';
import { readJson, tail } from './util.mjs';

/** Whether the chain has a script that really runs the project tests (test, test:*, accept*). */
export function hasTestGate(chain) {
  return (chain ?? []).some((name) => name === 'test' || name.startsWith('test:') || name.startsWith('accept'));
}

export const NO_TEST_GATE = 'gates.chain 沒有任何測試類 script(test、test:*、accept*):合併前不會跑專案測試,自治等級 >= 1 時 dlm 拒絕執行 tick。請把 test 加進 dlm.config.json 的 gates.chain';

/** Run inside the gates profile sandbox (no network, home directory hidden); root is used to find the node_modules to mount read-only. */
export function runGates(cwd, config, { log = () => {}, root = cwd } = {}) {
  const chain = config.gates.chain ?? [];
  const results = [];
  if (!chain.length) {
    log('gate=all result=FAIL reason=empty-chain(gates.chain 是空的;空清單不是「沒事」)');
    return { ok: false, results, output_tail: 'gates.chain 是空的' };
  }
  const pkgPath = join(cwd, 'package.json');
  const scripts = existsSync(pkgPath) ? (readJson(pkgPath).scripts ?? {}) : {};
  // Read the baseline from the root (main), not from the tree under test: a branch cannot change it (it is in paths.forbidden); this is a second safeguard
  const baseline = readBaseline(root);
  let output = '';
  for (const name of chain) {
    const cmd = gateCommand(name, config, scripts);
    if (!cmd) {
      results.push({ name, exit: 127, ms: 0 });
      log(`gate=${name} result=FAIL reason=not-an-npm-script`);
      output += `\n[${name}] 不是 package.json 裡的 npm script,gates.commands 也沒有\n`;
      continue;
    }
    const r = sandboxExec(config, 'gates', cmd, { cwd, timeoutMs: config.gates.timeout_minutes * 60 * 1000 });
    const known = r.code !== 0 ? knownRed(baseline, name, r.stdout + r.stderr) : null;
    if (known?.ok) {
      results.push({ name, exit: r.code, ms: r.ms, known_red: known.failing.length });
      log(`gate=${name} result=PASS exit=${r.code} known-red=${known.failing.length} ms=${r.ms}(紅的都是基線裡本來就紅的)`);
      continue;
    }
    results.push({ name, exit: r.code, ms: r.ms });
    log(`gate=${name} result=${r.code === 0 ? 'PASS' : 'FAIL'} exit=${r.code} ms=${r.ms}`);
    if (r.code !== 0) {
      output += `\n[${name}] exit ${r.code}\n${known?.fresh ? `基線以外新紅的測試:${known.fresh.slice(0, 10).join(', ')}\n` : ''}${tail(r.stdout + r.stderr, 3000)}`;
    }
  }
  const ok = results.every((x) => x.exit === 0 || x.known_red);
  log(`gate=all result=${ok ? 'PASS' : 'FAIL'} ran=${results.length}`);
  return { ok, results, output_tail: tail(output, 4000) };
}

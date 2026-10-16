// 全 gate 單一入口。chain 是 package.json scripts 的名字(v4.5:或 gates.commands 對應的指令);
// 空 chain、找不到指令都算失敗——「清單沒填」不是「沒事可做」。
// v4.5:既有專案有測試基線(docs/dp-baseline.json)時,紅的測試全都是基線裡本來就紅的,這個 gate 算通過(known-red)。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { gateCommand, knownRed, readBaseline } from './brownfield.mjs';
import { sandboxExec } from './sandbox.mjs';
import { readJson, tail } from './util.mjs';

/** chain 裡有沒有真的跑專案測試的 script(test、test:*、accept*)。 */
export function hasTestGate(chain) {
  return (chain ?? []).some((name) => name === 'test' || name.startsWith('test:') || name.startsWith('accept'));
}

export const NO_TEST_GATE = 'gates.chain 沒有任何測試類 script(test、test:*、accept*):合併前不會跑專案測試,自治等級 >= 1 時 dp 拒絕執行 tick。請把 test 加進 dp.config.json 的 gates.chain';

/** 在 gates profile 的沙箱裡跑(沒有網路、看不到家目錄);root 用來找要唯讀掛載的 node_modules。 */
export function runGates(cwd, config, { log = () => {}, root = cwd } = {}) {
  const chain = config.gates.chain ?? [];
  const results = [];
  if (!chain.length) {
    log('gate=all result=FAIL reason=empty-chain(gates.chain 是空的;空清單不是「沒事」)');
    return { ok: false, results, output_tail: 'gates.chain 是空的' };
  }
  const pkgPath = join(cwd, 'package.json');
  const scripts = existsSync(pkgPath) ? (readJson(pkgPath).scripts ?? {}) : {};
  // 基線讀根目錄(主線)的,不讀被測的樹:分支改不到它(在 paths.forbidden),這裡再保險一次
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

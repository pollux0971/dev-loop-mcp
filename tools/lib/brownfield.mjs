// v4.5 既有專案(brownfield):偵測語言與測試指令、測試基線、AS-IS 草稿、characterize 的預設路徑。
// 不匯入外部程式(v4.0 的 intake import 已移除);只處理「在這個 repo 裡繼續開發」。
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { git, headSha, removeWorktree } from './git.mjs';
import { linkDeps, sandboxExec } from './sandbox.mjs';
import { atomicWrite, listFiles, matchAny, readJson, tail, writeJson } from './util.mjs';

export const BASELINE = 'docs/dp-baseline.json';
export const ASIS = 'docs/AS-IS.md';

// dp 自己裝進去的東西(不算「既有程式」)
const DP_PATHS = [
  'tools/**', 'ledger/**', 'prompts/**', '.claude/**', 'docs/dp/**', 'docs/adr/**', 'docs/integration/**', 'contracts/**',
  'features/**', 'scripts/**', 'dag.json', 'dp.config.json', 'STATUS.md', 'DECISIONS.md', 'standalone.json', 'AGENTS.md',
  'AUTONOMY.md', 'CLAUDE.md', '.dp-install.json', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json',
  'vitest*.config.*', 'cucumber.js', 'stryker.config.json', 'docs/ROADMAP.md', 'docs/AS-IS.md', BASELINE,
];
const SKIP_DIRS = ['.git', 'node_modules', '.dp', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', 'coverage', 'reports'];
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.cs', '.c', '.cc', '.cpp', '.h', '.swift']);

/** 每種語言的測試檔慣例(給 paths.tests、node.tests 的預設)。 */
export const TEST_PATTERNS = {
  node: ['**/*.test.*', '**/*.spec.*'],
  python: ['**/test_*.py', '**/*_test.py', 'tests/**/*.py'],
  go: ['**/*_test.go'],
  rust: ['tests/**/*.rs'],
  other: [],
};

function projectFiles(root) {
  return listFiles(root, { skip: SKIP_DIRS }).filter((f) => !matchAny(f, DP_PATHS));
}

function packageJson(root) {
  return readJson(join(root, 'package.json'), null);
}

/** npm 預設的 test script(`npm init` 產生的)不算有測試。 */
function realNpmTest(pkg) {
  const t = pkg?.scripts?.test;
  return !!t && !/no test specified/.test(t);
}

/**
 * 看專案長什麼樣:語言、測試指令、程式檔數量、建議的模式。
 * test.cmd = null 代表用 npm script `test`(gate 照舊跑 npm run test)。
 */
export function detectProject(root) {
  const files = projectFiles(root);
  const code = files.filter((f) => CODE_EXT.has(extname(f)));
  const count = (exts) => code.filter((f) => exts.includes(extname(f))).length;
  const pkg = packageJson(root);
  const has = (f) => existsSync(join(root, f));
  const read = (f) => { try { return readFileSync(join(root, f), 'utf8'); } catch { return ''; } };
  let language = 'other';
  let test = { cmd: null, how: null };
  const py = count(['.py']);
  const js = count(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
  if (has('go.mod')) {
    language = 'go';
    test = { cmd: 'go test ./...', how: 'go.mod' };
  } else if (has('Cargo.toml')) {
    language = 'rust';
    test = { cmd: 'cargo test', how: 'Cargo.toml' };
  } else if (py > js || has('pyproject.toml') || has('setup.py') || has('requirements.txt')) {
    language = 'python';
    const pytest = has('pytest.ini') || has('conftest.py') || /\[tool\.pytest/.test(read('pyproject.toml')) || /\[tool:pytest\]/.test(read('setup.cfg'))
      || /^pytest\b/m.test(read('requirements.txt')) || /^pytest\b/m.test(read('requirements-dev.txt'));
    test = pytest
      ? { cmd: 'python3 -m pytest -q', how: 'pytest 設定' }
      : { cmd: `python3 -m unittest discover -s ${has('tests') ? 'tests' : '.'} -t .`, how: '沒有 pytest 設定,用標準庫 unittest' };
  } else if (pkg || js) {
    language = 'node';
    test = realNpmTest(pkg) ? { cmd: null, how: 'package.json 的 test script' } : { cmd: null, how: null };
  }
  if (!test.how && has('Makefile') && /^test:/m.test(read('Makefile'))) test = { cmd: 'make test', how: 'Makefile 的 test' };
  const tests = files.filter((f) => matchAny(f, TEST_PATTERNS[language] ?? []));
  return {
    language,
    test,
    code_files: code.length,
    test_files: tests.length,
    suggested_mode: code.length ? 'brownfield' : 'greenfield',
    scripts: Object.keys(pkg?.scripts ?? {}),
  };
}

/**
 * brownfield 的 gate 設定:dp 自己的檢查 + 專案原本就有的 script + 專案的測試指令。
 * 不硬塞範本的 typecheck / accept(既有專案多半沒有,不存在的 script 會讓 gate 永遠紅)。
 */
export function brownfieldGates(detect, testCmd) {
  const scripts = new Set(detect.scripts);
  const chain = ['check:dp'];
  if (scripts.has('typecheck')) chain.push('typecheck');
  chain.push('test');
  if (scripts.has('accept')) chain.push('accept');
  const commands = {};
  if (testCmd) commands.test = testCmd;
  return { chain, commands };
}

// ------------------------------------------------------------------ 失敗的測試是哪幾個

/**
 * 從測試輸出抓出失敗的測試名稱。抓不到任何一個 → null(看不懂就不能說「跟基線一樣」)。
 * 支援:pytest、unittest、go test、cargo test、node --test、vitest、jest、cucumber。
 */
export function failingTests(output) {
  const text = String(output ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  const out = new Set();
  const add = (s) => { const v = s.trim(); if (v) out.add(v); };
  for (const line of text.split('\n')) {
    let m;
    if ((m = line.match(/^(?:FAILED|ERROR) (\S+::\S+)/))) add(m[1]); // pytest
    else if ((m = line.match(/^(?:FAIL|ERROR): (\S+) \(([^)]+)\)/))) add(m[2].endsWith(`.${m[1]}`) ? m[2] : `${m[2]}.${m[1]}`); // unittest(3.11 起括號裡已含方法名)
    else if ((m = line.match(/^\s*--- FAIL: (\S+)/))) add(m[1]); // go
    else if ((m = line.match(/^test (\S+) \.\.\. FAILED/))) add(m[1]); // cargo
    else if ((m = line.match(/^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/))) add(m[1]); // node --test (TAP)
    else if ((m = line.match(/^\s*(?:FAIL|×|✗)\s+(\S+\.(?:test|spec)\.\S+\s+>\s+.+?)(?:\s+\d+ms)?$/))) add(m[1]); // vitest
    else if ((m = line.match(/^\s*●\s+(.+›.+)$/))) add(m[1]); // jest
    else if ((m = line.match(/^\s*\d+\) Scenario: (.+?)\s+#/))) add(m[1]); // cucumber
  }
  return out.size ? [...out].sort() : null;
}

export function readBaseline(root) {
  return readJson(join(root, BASELINE), null);
}

/**
 * gate 紅了,但紅的都是基線裡本來就紅的測試 → 當成通過(known-red)。
 * 抓不到失敗名稱、或有任何一個不在基線裡 → 照舊是紅的。
 */
export function knownRed(baseline, name, output) {
  const base = baseline?.gates?.find((g) => g.name === name);
  if (!base || base.exit === 0 || !base.failing?.length) return null;
  const now = failingTests(output);
  if (!now) return null;
  const fresh = now.filter((t) => !base.failing.includes(t));
  return fresh.length ? { ok: false, fresh } : { ok: true, failing: now };
}

/**
 * 在主線的乾淨副本上跑一次專案的 gate(dp 自己的 check:dp 不算:還沒有節點時它一定紅),
 * 記下哪些測試本來就紅。寫到 docs/dp-baseline.json,worker 改不到(在 paths.forbidden)。
 */
export function recordBaseline(root, config, { log = () => {}, run } = {}) {
  const main = config.main_branch;
  const sha = headSha(root, main);
  const dir = join(root, '.dp', 'baseline-tree');
  removeWorktree(root, dir);
  git(root, `worktree add --detach '${dir}' ${main}`);
  const gates = [];
  try {
    linkDeps(root, dir);
    const exec = run ?? ((cmd) => sandboxExec(config, 'gates', cmd, { cwd: dir, timeoutMs: config.gates.timeout_minutes * 60000 }));
    const scripts = packageJson(dir)?.scripts ?? {};
    for (const name of config.gates.chain) {
      if (name === 'check:dp') continue;
      const cmd = gateCommand(name, config, scripts);
      if (!cmd) { gates.push({ name, exit: 127, failing: null, note: '不是 npm script,gates.commands 也沒有' }); continue; }
      const r = exec(cmd);
      const output = (r.stdout ?? '') + (r.stderr ?? '');
      const failing = r.code === 0 ? [] : failingTests(output);
      gates.push({ name, cmd, exit: r.code, failing, ...(r.code !== 0 && !failing ? { note: '紅了但看不出是哪些測試;這個 gate 在修好之前每次合併都會擋', output_tail: tail(output, 800) } : {}) });
      log(`baseline ${name}: exit ${r.code}${failing?.length ? `(${failing.length} 個本來就紅)` : ''}`);
    }
  } finally {
    removeWorktree(root, dir);
  }
  const data = { main_sha: sha, ts: new Date().toISOString(), gates };
  writeJson(join(root, BASELINE), data);
  return data;
}

/** chain 裡一個名字實際要跑的指令;null = 找不到。 */
export function gateCommand(name, config, scripts) {
  const mapped = config.gates.commands?.[name];
  if (mapped) return mapped;
  if (name in scripts) return `npm run --silent ${name}`;
  // 既有專案自己的 package.json 沒有 check:dp(init --existing 不覆蓋它),直接叫 dp
  if (name === 'check:dp') return 'node tools/dp.mjs check';
  return null;
}

// ------------------------------------------------------------------ characterize 的預設

/** 一個既有檔的 characterize 測試放哪裡(依語言慣例;跟節點自己的測試檔分開)。 */
export function characterizeTestPath(file, language) {
  const dir = dirname(file);
  const ext = extname(file);
  const name = basename(file, ext);
  const at = (p) => (dir === '.' ? p : `${dir}/${p}`);
  if (language === 'python') return `tests/test_${name}_characterize.py`;
  if (language === 'go') return at(`${name}_characterize_test.go`);
  if (language === 'rust') return `tests/${name}_characterize.rs`;
  if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return at(`${name}.characterize.test${ext === '.tsx' || ext === '.jsx' ? ext.slice(0, -1) : ext}`);
  return null;
}

/** 只跑 characterize 測試的指令(必須在現在的程式上綠)。 */
export function characterizeCmd(tests, config) {
  const test = config.gates.commands?.test;
  const lang = config.project?.language;
  if (lang === 'go') return `go test ${[...new Set(tests.map((t) => `./${dirname(t)}`))].join(' ')}`;
  if (lang === 'rust') return `cargo test ${tests.map((t) => `--test ${basename(t, '.rs')}`).join(' ')}`;
  if (lang === 'python') {
    if (test?.includes('pytest')) return `python3 -m pytest -q ${tests.join(' ')}`;
    return `python3 -m unittest ${tests.join(' ')}`;
  }
  if (test) return `${test} ${tests.join(' ')}`;
  return `npm test -- ${tests.join(' ')}`;
}

/** 主線上符合 globs 的既有檔(不含測試檔)。 */
export function existingFiles(root, globs, config) {
  const r = git(root, `ls-files`, { allowFail: true });
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter(Boolean)
    .filter((f) => matchAny(f, globs) && !matchAny(f, config.paths.tests) && CODE_EXT.has(extname(f)));
}

// ------------------------------------------------------------------ AS-IS 草稿

function topDirs(files) {
  const m = new Map();
  for (const f of files) {
    const top = f.includes('/') ? `${f.split('/')[0]}/` : '(根目錄)';
    m.set(top, (m.get(top) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function entryPoints(root, files, pkg) {
  const out = [];
  if (pkg?.main) out.push(`package.json main:\`${pkg.main}\``);
  if (pkg?.bin) out.push(`package.json bin:${typeof pkg.bin === 'string' ? `\`${pkg.bin}\`` : Object.entries(pkg.bin).map(([k, v]) => `\`${k}\` → \`${v}\``).join('、')}`);
  for (const s of ['start', 'dev', 'build']) if (pkg?.scripts?.[s]) out.push(`npm run ${s}:\`${pkg.scripts[s]}\``);
  for (const f of files) {
    if (/(^|\/)(__main__|main|cli|app|server|index)\.(py|go|rs|ts|js|mjs)$/.test(f) && !f.includes('test')) out.push(`\`${f}\``);
  }
  return [...new Set(out)].slice(0, 15);
}

/**
 * 機器能寫的部分先寫好(檔案分布、進入點、測試指令、基線);「模組在做什麼」留給 Front 讀程式後補。
 * 已經存在就不覆蓋(那是使用者確認過的內容)。
 */
export function asIsDraft(root, detect, baseline, testCmd) {
  const files = projectFiles(root);
  const pkg = packageJson(root);
  const red = (baseline?.gates ?? []).filter((g) => g.exit !== 0);
  const lines = [
    '# 現況(AS-IS)',
    '',
    `> \`dp onboard\` 產生的草稿(主線 ${baseline?.main_sha?.slice(0, 8) ?? headSha(root).slice(0, 8)})。標「待補」的段落由 Front 讀程式後補上、跟你確認;之後節點的 intent 以這份為準。`,
    '',
    '## 怎麼跑、怎麼測',
    '',
    `- 語言:${detect.language}`,
    `- 測試指令:\`${testCmd ?? 'npm test'}\`(${detect.test.how ?? '自己填的'})`,
    `- 程式檔 ${detect.code_files} 個、測試檔 ${detect.test_files} 個`,
    ...(entryPoints(root, files, pkg).length ? ['- 進入點:', ...entryPoints(root, files, pkg).map((e) => `  - ${e}`)] : ['- 進入點:待補']),
    '',
    '## 測試基線',
    '',
    ...(baseline
      ? (red.length
        ? red.flatMap((g) => [`- \`${g.name}\` 在主線上本來就紅(exit ${g.exit}):`, ...(g.failing ?? ['(看不出是哪些測試)']).slice(0, 20).map((t) => `  - ${t}`)])
        : ['- 主線上專案的測試全綠。'])
      : ['- 還沒跑(`dp baseline`)。']),
    '',
    '## 目錄',
    '',
    '| 目錄 | 檔案數 | 在做什麼 |',
    '|---|---|---|',
    ...topDirs(files).slice(0, 20).map(([d, n]) => `| \`${d}\` | ${n} | 待補 |`),
    '',
    '## 模組與資料流',
    '',
    '待補:主要模組各負責什麼、資料從哪裡進來到哪裡出去、外部依賴(資料庫、API、檔案)。',
    '',
    '## 已知的坑',
    '',
    '待補:沒有測試保護的地方、行為奇怪但不能改的地方、改了會連帶壞掉的地方。',
    '',
  ];
  return lines.join('\n');
}

// 規劃頁讀的是「- v<n> …」這種行(dashboard 的 readRoadmap)
export const ROADMAP_V0 = (name, detect) => [
  `# ${name} 路線圖`,
  '',
  `- v0 現況:既有專案(${detect.language},${detect.code_files} 個程式檔),dp 從這裡接手。現在能做什麼見 docs/AS-IS.md,測試基線見 ${BASELINE}`,
  '- v1 待定:跟 Front 說你要加或改什麼,它會整理成一版(含整合點)給你批准',
  '',
].join('\n');

/** `dp onboard`:基線 + AS-IS 草稿 + ROADMAP v0。回傳寫了哪些檔。 */
export function onboard(root, config, { log = () => {}, run } = {}) {
  const detect = detectProject(root);
  const written = [];
  const baseline = recordBaseline(root, config, { log, run });
  written.push(BASELINE);
  const testCmd = config.gates.commands?.test ?? (detect.scripts.includes('test') ? 'npm test' : null);
  if (!existsSync(join(root, ASIS))) { atomicWrite(join(root, ASIS), asIsDraft(root, detect, baseline, testCmd)); written.push(ASIS); }
  if (!existsSync(join(root, 'docs', 'ROADMAP.md'))) {
    const name = packageJson(root)?.name ?? basename(root);
    atomicWrite(join(root, 'docs', 'ROADMAP.md'), ROADMAP_V0(name, detect));
    written.push('docs/ROADMAP.md');
  }
  return { detect, baseline, written };
}

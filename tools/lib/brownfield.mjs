// v4.5 existing project (brownfield): detect language and test command, test baseline, AS-IS draft, default characterize paths.
// Does not import external code (the v4.0 intake import was removed); it only handles "keep developing inside this repo".
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { git, headSha, removeWorktree } from './git.mjs';
import { linkDeps, sandboxExec } from './sandbox.mjs';
import { atomicWrite, listFiles, matchAny, readJson, tail, writeJson } from './util.mjs';

export const BASELINE = 'docs/dlm-baseline.json';
export const ASIS = 'docs/AS-IS.md';

// Things dlm installed itself (not counted as "existing code")
const DLM_PATHS = [
  'tools/**', 'ledger/**', 'prompts/**', '.claude/**', 'docs/dlm/**', 'docs/adr/**', 'docs/integration/**', 'contracts/**',
  'features/**', 'scripts/**', 'dag.json', 'dlm.config.json', 'STATUS.md', 'DECISIONS.md', 'standalone.json', 'AGENTS.md',
  'AUTONOMY.md', 'CLAUDE.md', '.dlm-install.json', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json',
  'vitest*.config.*', 'cucumber.js', 'stryker.config.json', 'docs/ROADMAP.md', 'docs/AS-IS.md', BASELINE,
];
const SKIP_DIRS = ['.git', 'node_modules', '.dlm', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', 'coverage', 'reports'];
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.cs', '.c', '.cc', '.cpp', '.h', '.swift']);

/** Test file conventions per language (defaults for paths.tests and node.tests). */
export const TEST_PATTERNS = {
  node: ['**/*.test.*', '**/*.spec.*'],
  python: ['**/test_*.py', '**/*_test.py', 'tests/**/*.py'],
  go: ['**/*_test.go'],
  rust: ['tests/**/*.rs'],
  other: [],
};

function projectFiles(root) {
  return listFiles(root, { skip: SKIP_DIRS }).filter((f) => !matchAny(f, DLM_PATHS));
}

function packageJson(root) {
  return readJson(join(root, 'package.json'), null);
}

/** npm's default test script (made by `npm init`) does not count as having tests. */
function realNpmTest(pkg) {
  const t = pkg?.scripts?.test;
  return !!t && !/no test specified/.test(t);
}

/**
 * Look at what the project is like: language, test command, number of code files, suggested mode.
 * test.cmd = null means use the npm script `test` (the gate still runs npm run test).
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
 * Gate setup for brownfield: dlm's own checks + the project's existing scripts + the project's test command.
 * Do not force the template's typecheck / accept (existing projects mostly lack them, and a missing script would keep the gate red forever).
 */
export function brownfieldGates(detect, testCmd) {
  const scripts = new Set(detect.scripts);
  const chain = ['check:dlm'];
  if (scripts.has('typecheck')) chain.push('typecheck');
  chain.push('test');
  if (scripts.has('accept')) chain.push('accept');
  const commands = {};
  if (testCmd) commands.test = testCmd;
  return { chain, commands };
}

// ------------------------------------------------------------------ which tests failed

/**
 * Pull the failing test names out of the test output. If none can be found -> null (if we can't read it, we can't say "same as the baseline").
 * Supports: pytest, unittest, go test, cargo test, node --test, vitest, jest, cucumber.
 */
export function failingTests(output) {
  const text = String(output ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  const out = new Set();
  const add = (s) => { const v = s.trim(); if (v) out.add(v); };
  for (const line of text.split('\n')) {
    let m;
    if ((m = line.match(/^(?:FAILED|ERROR) (\S+::\S+)/))) add(m[1]); // pytest
    else if ((m = line.match(/^(?:FAIL|ERROR): (\S+) \(([^)]+)\)/))) add(m[2].endsWith(`.${m[1]}`) ? m[2] : `${m[2]}.${m[1]}`); // unittest (since 3.11 the parentheses already contain the method name)
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
 * The gate is red, but every red test was already red in the baseline -> treat as passed (known-red).
 * If no failing names can be found, or any one is not in the baseline -> still red as before.
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
 * Run the project's gate once on a clean copy of main (dlm's own check:dlm does not count: with no nodes yet it is always red),
 * and record which tests are already red. Write to docs/dlm-baseline.json, which the worker cannot change (it is in paths.forbidden).
 */
export function recordBaseline(root, config, { log = () => {}, run } = {}) {
  const main = config.main_branch;
  const sha = headSha(root, main);
  const dir = join(root, '.dlm', 'baseline-tree');
  removeWorktree(root, dir);
  git(root, `worktree add --detach '${dir}' ${main}`);
  const gates = [];
  try {
    linkDeps(root, dir);
    const exec = run ?? ((cmd) => sandboxExec(config, 'gates', cmd, { cwd: dir, timeoutMs: config.gates.timeout_minutes * 60000 }));
    const scripts = packageJson(dir)?.scripts ?? {};
    for (const name of config.gates.chain) {
      if (name === 'check:dlm') continue;
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

/** The command that one name in the chain actually runs; null = not found. */
export function gateCommand(name, config, scripts) {
  const mapped = config.gates.commands?.[name];
  if (mapped) return mapped;
  if (name in scripts) return `npm run --silent ${name}`;
  // An existing project's own package.json has no check:dlm (init --existing does not overwrite it), so call dlm directly
  if (name === 'check:dlm') return 'node tools/dlm.mjs check';
  return null;
}

// ------------------------------------------------------------------ characterize defaults

/** Where the characterize test for one existing file goes (by language convention; separate from the node's own test file). */
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

/** Command that runs only the characterize tests (must be green on the current code). */
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

/** Existing files on main that match the globs (test files excluded). */
export function existingFiles(root, globs, config) {
  const r = git(root, `ls-files`, { allowFail: true });
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter(Boolean)
    .filter((f) => matchAny(f, globs) && !matchAny(f, config.paths.tests) && CODE_EXT.has(extname(f)));
}

// ------------------------------------------------------------------ AS-IS draft

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
 * Write the parts a machine can write first (file layout, entry points, test command, baseline); leave "what each module does" for Front to fill in after reading the code.
 * If it already exists, do not overwrite it (that is content the user has confirmed).
 */
export function asIsDraft(root, detect, baseline, testCmd) {
  const files = projectFiles(root);
  const pkg = packageJson(root);
  const red = (baseline?.gates ?? []).filter((g) => g.exit !== 0);
  const lines = [
    '# 現況(AS-IS)',
    '',
    `> \`dlm onboard\` 產生的草稿(主線 ${baseline?.main_sha?.slice(0, 8) ?? headSha(root).slice(0, 8)})。標「待補」的段落由 Front 讀程式後補上、跟你確認;之後節點的 intent 以這份為準。`,
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
      : ['- 還沒跑(`dlm baseline`)。']),
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

// The planning page reads lines like "- v<n> …" (readRoadmap in dashboard)
export const ROADMAP_V0 = (name, detect) => [
  `# ${name} 路線圖`,
  '',
  `- v0 現況:既有專案(${detect.language},${detect.code_files} 個程式檔),dlm 從這裡接手。現在能做什麼見 docs/AS-IS.md,測試基線見 ${BASELINE}`,
  '- v1 待定:跟 Front 說你要加或改什麼,它會整理成一版(含整合點)給你批准',
  '',
].join('\n');

/** `dlm onboard`: baseline + AS-IS draft + ROADMAP v0. Returns which files were written. */
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

// v4.12: generic dependency folders (deps.dirs). The core no longer knows node_modules by name: every folder the stack lists is linked into
// the copies, fingerprinted around each dispatch, and writing under it is a violation. node-ts keeps exactly the pre-4.12 behavior.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { DEFAULTS, depDirs, loadConfig } from '../tools/lib/config.mjs';
import { init } from '../tools/lib/install.mjs';
import { readEvents } from '../tools/lib/ledger.mjs';
import { depsFingerprint, linkDeps, nodeModulesFingerprint, scratchCopy, treeManifest } from '../tools/lib/sandbox.mjs';
import { probe } from '../tools/lib/stack.mjs';
import { writeJson } from '../tools/lib/util.mjs';
import { CALC, CALC_GHERKIN, addNode, cleanup, makeProject, tempDir, tickUntil, waitWorkers } from './helpers.mjs';

after(cleanup);

const RUNNER = '.venv/lib/python3.12/site-packages/_pytest/runner.py';
function fakeVenv(root) {
  mkdirSync(join(root, '.venv/lib/python3.12/site-packages/_pytest'), { recursive: true });
  mkdirSync(join(root, '.venv/bin'), { recursive: true });
  writeFileSync(join(root, '.venv/bin/python'), '#!/bin/sh\n');
  writeFileSync(join(root, RUNNER), 'def runtestprotocol(item):\n    return item.run()\n');
  writeFileSync(join(root, '.venv/pyvenv.cfg'), 'home = /usr/bin\n');
}
const escapeOf = (proj) => readEvents(proj).find((e) => e.type === 'reject' && e.findings.some((f) => f.check === 'sandbox-escape'))
  ?.findings.find((f) => f.check === 'sandbox-escape');

describe('deps config', () => {
  test('core default is node_modules with no install / setup; node-ts brings npm ci and npm install', () => {
    assert.deepEqual(DEFAULTS.deps, { dirs: ['node_modules'], install: null, setup: null });
    assert.deepEqual(depDirs({}), ['node_modules']);
    assert.deepEqual(depDirs({ deps: { dirs: ['.venv', '.git', '.dlm', '..'] } }), ['.venv']);
    const proj = join(tempDir(), 'p');
    init(proj, { name: 'n' });
    const c = loadConfig(proj);
    assert.deepEqual(c.deps.dirs, ['node_modules']);
    assert.deepEqual(c.deps.install.argv, ['npm', 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund']);
    assert.equal(c.deps.install.lockfile, 'package-lock.json');
    assert.equal(c.deps.setup.label, 'npm install');
    assert.deepEqual(c.deps.setup.commit_files, ['package-lock.json']);
  });

  test('stack none keeps node_modules and links (no install spec)', () => {
    const proj = join(tempDir(), 'p');
    init(proj, { name: 'n', stack: 'none' });
    const c = loadConfig(proj);
    assert.deepEqual(c.deps.dirs, ['node_modules']);
    assert.equal(c.deps.install, null);
  });

  test('a project can set its own dirs; bad names are refused by the schema', () => {
    const proj = join(tempDir(), 'p');
    init(proj, { name: 'n', stack: 'none' });
    const cfg = JSON.parse(readFileSync(join(proj, 'dlm.config.json'), 'utf8'));
    writeJson(join(proj, 'dlm.config.json'), { ...cfg, deps: { dirs: ['venv'] } });
    assert.deepEqual(loadConfig(proj).deps.dirs, ['venv']);
    writeJson(join(proj, 'dlm.config.json'), { ...cfg, deps: { dirs: ['a/b'] } });
    assert.throws(() => loadConfig(proj), /deps/);
    writeJson(join(proj, 'dlm.config.json'), { ...cfg, deps: { install: { lockfile: 'x' } } });
    assert.throws(() => loadConfig(proj), /deps/);
  });

  test('probe: a key path counts only when its value is non-empty; no keys = the file exists', () => {
    const root = tempDir();
    writeJson(join(root, 'package.json'), { dependencies: {}, devDependencies: { a: '1' }, scripts: { accept: '' }, flag: true, list: [] });
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "x"\n');
    assert.equal(probe(root, { file: 'package.json', keys: [['dependencies']] }), false);
    assert.equal(probe(root, { file: 'package.json', keys: [['dependencies'], ['devDependencies']] }), true);
    assert.equal(probe(root, { file: 'package.json', keys: [['scripts', 'accept']] }), false);
    assert.equal(probe(root, { file: 'package.json', keys: [['flag']] }), true);
    assert.equal(probe(root, { file: 'package.json', keys: [['list']] }), false);
    assert.equal(probe(root, { file: 'pyproject.toml' }), true);
    assert.equal(probe(root, { file: 'pyproject.toml', keys: [['project']] }), false, 'not JSON: a key probe does not match');
    assert.equal(probe(root, { file: 'missing.toml' }), false);
  });
});

describe('deps fingerprint and links', () => {
  test("for ['node_modules'] the value is exactly the pre-4.12 nodeModulesFingerprint", () => {
    const root = tempDir();
    mkdirSync(join(root, 'node_modules/vitest/dist'), { recursive: true });
    writeFileSync(join(root, 'node_modules/vitest/index.js'), 'x');
    writeFileSync(join(root, 'node_modules/vitest/dist/a.js'), 'yy');
    // the pre-4.12 algorithm, written out: every entry (files and directories) as path \0 size \0 mtime, sorted, sha256
    assert.equal(depsFingerprint(root, ['node_modules']), nodeModulesFingerprint(root));
    assert.equal(depsFingerprint(root), nodeModulesFingerprint(root));
    assert.equal(depsFingerprint(tempDir(), ['node_modules']), null);
    assert.equal(depsFingerprint(tempDir(), ['.venv']), null);
  });

  test('venv: a patched .py in site-packages changes the fingerprint; bytecode caches do not', () => {
    const root = tempDir();
    fakeVenv(root);
    const before = depsFingerprint(root, ['.venv']);
    assert.ok(before);
    mkdirSync(join(root, '.venv/lib/python3.12/site-packages/_pytest/__pycache__'));
    writeFileSync(join(root, '.venv/lib/python3.12/site-packages/_pytest/__pycache__/runner.cpython-312.pyc'), 'b');
    writeFileSync(join(root, '.venv/lib/python3.12/site-packages/x.pyc'), 'b');
    assert.equal(depsFingerprint(root, ['.venv']), before, 'pytest writing bytecode is not a change');
    appendFileSync(join(root, RUNNER), '\n# always report pass\n');
    assert.notEqual(depsFingerprint(root, ['.venv']), before, 'patching pytest is caught');
    // same size, new mtime only (a rewrite with the same length) is caught too
    const b2 = depsFingerprint(root, ['.venv']);
    const t = new Date(Date.now() + 5000);
    utimesSync(join(root, RUNNER), t, t);
    assert.notEqual(depsFingerprint(root, ['.venv']), b2);
  });

  test('a non-node dep folder is linked, not copied; a real folder in its place is recorded as replaced', () => {
    const root = tempDir();
    const src = join(root, 'src-tree');
    fakeVenv(root);
    fakeVenv(src);
    writeFileSync(join(src, 'main.py'), 'print(1)\n');
    const copy = scratchCopy(root, src, 'deps', ['.venv']);
    assert.ok(!existsSync(join(copy, '.venv')), 'scratchCopy leaves the dep folder out');
    linkDeps(root, copy, ['.venv', 'node_modules']);
    assert.ok(lstatSync(join(copy, '.venv')).isSymbolicLink());
    assert.ok(!existsSync(join(copy, 'node_modules')), 'a folder missing in the root is not linked');
    const m = treeManifest(copy, { skip: ['.venv'] });
    assert.deepEqual(Object.keys(m).sort(), ['main.py']);
    const other = tempDir();
    mkdirSync(join(other, '.venv/lib'), { recursive: true });
    writeFileSync(join(other, '.venv/lib/x.py'), 'x');
    assert.equal(treeManifest(other, { skip: ['.venv'] })['.venv/'], 'replaced');
  });
});

describe('deps isolation in a real dispatch (.venv)', () => {
  const venvProject = (mode) => {
    const proj = makeProject({ mode, config: { deps: { dirs: ['.venv'] } } });
    return proj;
  };

  test('worker patches pytest in the root .venv through the link → sandbox-escape, sent back', async () => {
    const proj = venvProject('venv-patch');
    fakeVenv(proj);
    const before = readFileSync(join(proj, RUNNER), 'utf8');
    addNode(proj, CALC, CALC_GHERKIN);
    await tickUntil(proj, () => !!escapeOf(proj));
    assert.match(escapeOf(proj).detail, /\.venv\/\(根目錄的依賴在施工期間被改了/);
    assert.notEqual(readFileSync(join(proj, RUNNER), 'utf8'), before, 'the patch went through the symlink (that is what the fingerprint is for)');
    await waitWorkers(proj);
  });

  test('worker writes under .venv in the copy (no .venv in the root) → violation, nothing synced back', async () => {
    const proj = venvProject('venv-write');
    addNode(proj, CALC, CALC_GHERKIN);
    await tickUntil(proj, () => !!escapeOf(proj));
    assert.match(escapeOf(proj).detail, /\.venv\/\(把依賴資料夾換掉了\)/);
    assert.ok(!existsSync(join(proj, '.venv')));
    await waitWorkers(proj);
  });

  test('only bytecode caches under .venv (a normal pytest run) → no violation, node finishes', async () => {
    const proj = venvProject('venv-cache');
    fakeVenv(proj);
    addNode(proj, CALC, CALC_GHERKIN);
    const s = await tickUntil(proj, (st) => st.nodes.get('calc/v1').status === 'done');
    assert.equal(s.nodes.get('calc/v1').status, 'done');
    assert.equal(escapeOf(proj), undefined);
  });
});

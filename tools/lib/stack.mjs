// Technology stacks (v4.11). The core knows no test framework, compiler or package manager by name: everything specific to one
// (template files, default commands, extra forbidden paths, worker rules, extra verify checks) lives in one folder per stack,
// stacks/<name>/ in the dlm repo and tools/stacks/<name>/ in an installed project. See stacks/README.md.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DlmError, readJson } from './util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the stack folders are: tools/stacks (installed project) or the repo's top-level stacks/. */
export function stacksDir() {
  for (const d of [join(HERE, '..', 'stacks'), join(HERE, '..', '..', 'stacks')]) if (existsSync(join(d, 'README.md'))) return d;
  return null;
}

export function listStacks() {
  const dir = stacksDir();
  if (!dir) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'stack.json'))).map((e) => e.name).sort();
}

/**
 * The stack this project uses: project.stack in dlm.config.json; 'none' = no stack (the core alone).
 * Projects from before 4.11 have no project.stack: the first stack whose detect files all exist in the root is used, so their behavior does not change.
 */
export function stackName(root, raw) {
  const s = raw?.project?.stack;
  if (s) return s;
  for (const name of listStacks()) {
    const detect = readStackJson(name).detect ?? [];
    if (detect.length && detect.every((f) => existsSync(join(root, f)))) return name;
  }
  return 'none';
}

function readStackJson(name) {
  const dir = stacksDir();
  const p = dir && join(dir, name, 'stack.json');
  if (!p || !existsSync(p)) throw new DlmError(`找不到技術棧 ${name}(有的:${listStacks().join('、') || '沒有'});改 dlm.config.json 的 project.stack,或設成 none`);
  return readJson(p);
}

/** The stack's declaration ({} for none). */
export function loadStack(name) {
  if (!name || name === 'none') return { name: 'none' };
  return { ...readStackJson(name), name, dir: join(stacksDir(), name) };
}

/** The stack's worker rules (rules.md), or ''. */
export function stackRules(stack) {
  const p = stack?.dir && join(stack.dir, 'rules.md');
  return p && existsSync(p) ? readFileSync(p, 'utf8').trim() : '';
}

/** Run the stack's extra checks for test-type legs (checks.mjs → testLegChecks). No stack or no checks.mjs → []. */
export async function stackTestLegChecks(stack, ctx) {
  const p = stack?.dir && join(stack.dir, 'checks.mjs');
  if (!p || !existsSync(p)) return [];
  const mod = await import(pathToFileURL(p).href);
  return mod.testLegChecks ? mod.testLegChecks(ctx) : [];
}

/** The acceptance command a node gets when the spec does not give one, or null. */
export function defaultAcceptFor(stack, gherkin) {
  return stack?.accept_cmd ? stack.accept_cmd.replaceAll('{gherkin}', gherkin) : null;
}

/** Whether a probe ({ file, keys: [[...path]] }) finds any of its key paths in that JSON file of the project. */
export function probe(root, p) {
  if (!p?.file) return false;
  const json = readJson(join(root, p.file), null);
  return (p.keys ?? []).some((path) => path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), json) !== undefined);
}

/**
 * For an existing project (the stack's template was not installed): the stack defaults to switch off because the project lacks what they run
 * (stack.json existing_project_needs). Returns a verify overlay, e.g. { dry_run_cmd: null, mutation: { cmd: null } }.
 */
export function existingProjectOff(root, stack) {
  const off = {};
  for (const [key, p] of Object.entries(stack?.existing_project_needs ?? {})) {
    if (key.startsWith('$') || probe(root, p)) continue;
    const parts = key.split('.');
    if (parts[0] !== 'verify') continue;
    let o = off;
    for (const k of parts.slice(1, -1)) o = o[k] ??= {};
    o[parts.at(-1)] = null;
  }
  return off;
}

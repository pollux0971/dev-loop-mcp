// Gherkin is in English, so use cucumber's default language; no language header is needed.
// Config file rule of @cucumber/cucumber 11: the top-level `export default` is itself the content of the "default"
// profile. There is no need (and no way) to wrap it again in `default: {...}`. With that wrapper, paths/import/tags
// are all ignored (what gets read is the object { default: {...} }, none of whose keys match the schema),
// cucumber quietly falls back to its built-in defaults, the import never happens at all, and every step becomes undefined
// (see docs/02-decision-map.md ADR-013).
// For extra profiles use named exports (for example `export const ci = {...}`); do not put them inside this object.
//
// v4: paths are no longer hard-coded.
//   1. When a feature path is given on the command line (`npm run accept -- features/x/v1.feature`), run only what the command line gave.
//      cucumber merges the paths of the config file with the paths on the command line, so in v3 acceptance of a single node also ran the scenarios of other nodes.
//   2. When no path is given, run everything, but skip the files listed in .dlm/pending-features.json: gherkin that is approved but whose node is not done yet
//      (they are on main, the implementation is not merged yet, so they are always red). This list is maintained by dlm; do not edit it by hand.
//      v3 real run: when two or more nodes were in progress at the same time, the full-gate accept stayed red forever because of each other's unfinished scenarios, and they were stuck on each other.
// Note: the paths array does **not support** negative exclusion with `!` (PITFALLS P-07), so list the files ourselves here.
// The template file in _template uses the .feature.template extension, so *.feature never picks it up; rename it after copying.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['features', 'docs/integration'];

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((name) => {
    const p = join(dir, name).split('\\').join('/');
    if (statSync(p).isDirectory()) return name.startsWith('_') ? [] : walk(p);
    return p.endsWith('.feature') ? [p] : [];
  });
}

function pendingFeatures() {
  try {
    return new Set(JSON.parse(readFileSync('.dlm/pending-features.json', 'utf8')));
  } catch {
    return new Set();
  }
}

const cliPaths = process.argv.slice(2).filter((a) => !a.startsWith('-') && existsSync(a.replace(/(:\d+)+$/, '')));
const pending = pendingFeatures();
const all = ROOTS.flatMap(walk).filter((p) => !pending.has(p));

export default {
  // When everything is skipped, give a glob that does not exist: an empty paths array makes cucumber fall back to its own default (features/**)
  paths: cliPaths.length ? [] : all.length ? all : ['features/__none__/*.feature'],
  import: ['features/steps/**/*.ts'],
  tags: 'not @manual',
  format: ['progress'],
};

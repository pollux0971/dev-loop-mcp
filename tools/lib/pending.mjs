// Approved gherkin whose node is not done yet. They are on main (committed when intake was approved) but the implementation is not merged, so they are always red.
// The payload's cucumber.js reads .dlm/pending-features.json and skips them; dlm rewrites this list before tick, merge-tree and `dlm gates`.
// v3 real run: with two or more nodes in progress, the full gate's accept was always red because of each other's unfinished scenarios, and every merge got stuck on the others.
import { join } from 'node:path';
import { atomicWrite, ensureDir } from './util.mjs';

/** except: the node being merged right now (its own scenarios must run). */
export function pendingFeatures(dag, state, except = null) {
  const doneGherkin = new Set(dag.nodes.filter((n) => n.gherkin && state.nodes.get(n.id)?.status === 'done').map((n) => n.gherkin));
  return [...new Set(dag.nodes
    .filter((n) => n.gherkin && n.id !== except && state.nodes.get(n.id)?.status !== 'done' && !doneGherkin.has(n.gherkin))
    .filter((n) => !(except && dag.nodes.find((x) => x.id === except)?.gherkin === n.gherkin))
    .map((n) => n.gherkin))].sort();
}

export function writePendingFeatures(dir, list) {
  ensureDir(join(dir, '.dlm'));
  atomicWrite(join(dir, '.dlm', 'pending-features.json'), `${JSON.stringify(list, null, 2)}\n`);
}

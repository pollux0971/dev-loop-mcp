// 已批准、但節點還沒完成的 gherkin。它們在主線上(intake 批准時就 commit 了),實作還沒合併,一定是紅的。
// payload 的 cucumber.js 讀 .dlm/pending-features.json 跳過它們;dlm 在 tick、merge-tree、`dlm gates` 前重寫這份清單。
// v3 實測:兩個以上節點同時在做時,全 gate 的 accept 因為彼此未完成的場景永遠紅,所有合併互相卡死。
import { join } from 'node:path';
import { atomicWrite, ensureDir } from './util.mjs';

/** except:正在合併的那個節點(它自己的場景要跑)。 */
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

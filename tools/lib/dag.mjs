// dag.json 是「結構」的唯一真相:有哪些節點、誰依賴誰、誰擁有哪些路徑。
// 狀態不存在這裡——狀態從 ledger 重播得出(state.mjs),避免同一件事寫兩份。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './schema.mjs';
import { CONTRACT_REF, NODE_ID, nodeSchema } from './schemas.mjs';
import { DlmError, globPrefix, matchGlob, readJson, sha256, stableJson, writeJson } from './util.mjs';

export const DAG_REL = 'dag.json';

export function emptyDag() {
  return { version: 1, nodes: [] };
}

export function loadDag(root) {
  return readJson(join(root, DAG_REL), emptyDag());
}

export function saveDag(root, dag) {
  const problems = validateDag(dag, contractMajor(root));
  if (problems.length) throw new DlmError(`dag.json 不合法,拒絕寫入:\n  - ${problems.join('\n  - ')}`);
  writeJson(join(root, DAG_REL), dag);
}

export function nodeSha(node) {
  return sha256(stableJson(node)).slice(0, 12);
}

export function contractMajor(root) {
  const p = join(root, 'contracts', 'VERSION');
  if (!existsSync(p)) return 0;
  const n = Number(readFileSync(p, 'utf8').trim().split('.')[0]);
  return Number.isInteger(n) ? n : 0;
}

export function isContractRef(id) {
  return new RegExp(CONTRACT_REF).test(id);
}

export function contractRefMajor(id) {
  return Number(id.split('@')[1]);
}

export function capabilityOf(id) {
  const i = id.indexOf('/v');
  return i < 0 ? id : id.slice(0, i);
}

export function validateDag(dag, currentContractMajor = Infinity) {
  const problems = [];
  if (!dag || dag.version !== 1 || !Array.isArray(dag.nodes)) return ['dag.json 應為 { "version": 1, "nodes": [...] }'];
  const ids = new Set();
  for (const n of dag.nodes) {
    for (const e of validate(nodeSchema, n)) problems.push(`${n.id ?? '?'}: ${e}`);
    if (!n.id || !n.kind) continue;
    if (ids.has(n.id)) problems.push(`${n.id}: id 重複`);
    ids.add(n.id);
    const pattern = NODE_ID[n.kind];
    if (pattern && !new RegExp(pattern).test(n.id)) problems.push(`${n.id}: kind=${n.kind} 的 id 應符合 ${pattern}`);
    if (n.kind === 'phase' && !n.accept) problems.push(`${n.id}: phase 節點必須有 accept 指令(沒有可執行的完成定義就不能派工)`);
    if (n.kind !== 'shared' && !n.gherkin) problems.push(`${n.id}: 必須有 gherkin 路徑(沒有 gherkin 不寫程式)`);
    if (!(n.owns ?? []).length) problems.push(`${n.id}: 必須有 owns(沒有寫入範圍就沒辦法驗越界)`);
    if (n.relation && !n.parent) problems.push(`${n.id}: 有 relation 就必須有 parent`);
    if (n.parent && !n.relation) problems.push(`${n.id}: 有 parent 就必須標 relation(prereq|followup)`);
  }
  for (const n of dag.nodes) {
    for (const d of n.depends_on ?? []) {
      if (isContractRef(d)) {
        if (contractRefMajor(d) > currentContractMajor) problems.push(`${n.id}: 依賴 ${d},但契約目前只到 @${currentContractMajor}`);
      } else if (!ids.has(d)) {
        problems.push(`${n.id}: depends_on 指向不存在的節點 ${d}`);
      }
      if (d === n.id) problems.push(`${n.id}: 依賴自己`);
    }
    if (n.parent && !ids.has(n.parent)) problems.push(`${n.id}: parent ${n.parent} 不存在`);
  }
  const cycle = findCycle(dag);
  if (cycle) problems.push(`依賴有環:${cycle.join(' → ')}`);
  else problems.push(...ownsOverlaps(dag));
  return problems;
}

const hasWildcard = (g) => /[*?]/.test(g);
const staticHead = (g) => {
  const i = g.search(/[*?]/);
  return i < 0 ? g : g.slice(0, i);
};

/** 兩個 owns glob 可不可能碰到同一個檔。拿不準時回 true(寧可要求拆範圍,也不要兩個 worker 同時寫同一檔)。 */
export function globsOverlap(a, b) {
  if (!hasWildcard(a) && !hasWildcard(b)) return a === b;
  if (!hasWildcard(a)) return matchGlob(a, b);
  if (!hasWildcard(b)) return matchGlob(b, a);
  const ha = staticHead(a);
  const hb = staticHead(b);
  return ha.startsWith(hb) || hb.startsWith(ha);
}

/** 每個節點的所有上游(遞移,不含契約)。 */
function ancestors(dag) {
  const deps = new Map(dag.nodes.map((n) => [n.id, (n.depends_on ?? []).filter((d) => !isContractRef(d))]));
  const memo = new Map();
  const walk = (id) => {
    if (memo.has(id)) return memo.get(id);
    const out = new Set();
    memo.set(id, out);
    for (const d of deps.get(id) ?? []) {
      if (!deps.has(d)) continue;
      out.add(d);
      for (const x of walk(d)) out.add(x);
    }
    return out;
  };
  for (const id of deps.keys()) walk(id);
  return memo;
}

/**
 * owns 重疊檢查:兩個節點之間沒有依賴順序(誰都不是誰的上游),就可能被同時派工;
 * 這時 owns 不可重疊,否則合併衝突最後都丟給人。有順序的可以重疊(x/v2 依賴 x/v1,改同一批檔是正常的)。
 */
export function ownsOverlaps(dag) {
  const anc = ancestors(dag);
  const nodes = dag.nodes.filter((n) => n.id && (n.owns ?? []).length);
  const problems = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (anc.get(a.id)?.has(b.id) || anc.get(b.id)?.has(a.id)) continue;
      const hit = a.owns.flatMap((ga) => b.owns.filter((gb) => globsOverlap(ga, gb)).map((gb) => `${ga} ↔ ${gb}`));
      if (hit.length) {
        problems.push(`${a.id} 與 ${b.id} 的 owns 重疊(${hit.slice(0, 3).join(', ')}),兩者之間沒有依賴順序、可能同時施工;請拆開範圍或加 depends_on`);
      }
    }
  }
  return problems;
}

export function edges(dag) {
  const out = new Map(dag.nodes.map((n) => [n.id, []]));
  for (const n of dag.nodes) {
    for (const d of n.depends_on ?? []) if (out.has(d)) out.get(d).push(n.id);
  }
  return out; // dep → dependents
}

export function findCycle(dag) {
  const deps = new Map(dag.nodes.map((n) => [n.id, (n.depends_on ?? []).filter((d) => !isContractRef(d))]));
  const color = new Map();
  const stack = [];
  const visit = (id) => {
    color.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      if (!deps.has(d)) continue;
      if (color.get(d) === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (!color.get(d)) {
        const c = visit(d);
        if (c) return c;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };
  for (const id of deps.keys()) {
    if (!color.get(id)) {
      const c = visit(id);
      if (c) return c;
    }
  }
  return null;
}

/** 分層:同一層內互不依賴,可以同時開工。 */
export function layers(dag) {
  const deps = new Map(dag.nodes.map((n) => [n.id, new Set((n.depends_on ?? []).filter((d) => !isContractRef(d)))]));
  const out = [];
  const remaining = new Set(deps.keys());
  while (remaining.size) {
    const layer = [...remaining].filter((id) => [...deps.get(id)].every((d) => !remaining.has(d))).sort();
    if (!layer.length) throw new DlmError('有環,無法分層');
    out.push(layer);
    layer.forEach((id) => remaining.delete(id));
  }
  return out;
}

/** 下游節點數(遞移),用來當預設優先序:解鎖愈多的愈先做。 */
export function descendantCounts(dag) {
  const down = edges(dag);
  const count = (start) => {
    const seen = new Set();
    const queue = [...(down.get(start) ?? [])];
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(...(down.get(id) ?? []));
    }
    return seen.size;
  };
  return new Map(dag.nodes.map((n) => [n.id, count(n.id)]));
}

export function getNode(dag, id) {
  return dag.nodes.find((n) => n.id === id);
}

/** 子節點的 owns 是否都在父節點範圍內(側向延伸能不能被代批的機械判準)。 */
export function scopeContained(child, parent) {
  const parentPrefixes = (parent.owns ?? []).map(globPrefix);
  return (child.owns ?? []).length > 0
    && child.owns.every((g) => parentPrefixes.some((p) => p && globPrefix(g).startsWith(p)));
}

/**
 * 側向延伸。prereq:父節點要等子節點完成(子節點繼承父節點的依賴,父節點新增一條邊到子節點)。
 * followup:子節點在父節點之後(子節點依賴父節點)。回傳新的 dag(不就地修改)。
 */
export function withSpawn(dag, parentId, spec) {
  const parent = getNode(dag, parentId);
  if (!parent) throw new DlmError(`父節點 ${parentId} 不存在`);
  const next = structuredClone(dag);
  const p = getNode(next, parentId);
  const child = {
    id: spec.id,
    kind: 'phase',
    title: spec.title,
    intent: spec.intent,
    owns: spec.owns,
    gherkin: spec.gherkin ?? `features/${capabilityOf(spec.id)}/${spec.id.split('/').pop()}.feature`,
    accept: spec.accept ?? parent.accept,
    ...(spec.standalone ? { standalone: spec.standalone } : {}),
    parent: parentId,
    relation: spec.relation,
    depends_on: spec.relation === 'prereq' ? [...(parent.depends_on ?? [])] : [parentId],
  };
  if (spec.relation === 'prereq') p.depends_on = [...new Set([...(p.depends_on ?? []), child.id])];
  next.nodes.push(child);
  return { dag: next, child };
}

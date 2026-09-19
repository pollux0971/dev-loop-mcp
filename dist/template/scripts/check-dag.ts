/**
 * 依 ADR-019 第 3 點檢查 phase DAG。
 *
 * 節點是 FEATURE.md phase 表裡的 phase 加上文件裡宣告的 I<N>；NEXT.md gate
 * 的 phase / I<N> 引用形成依賴邊，ADR / § / commit sha 則是外部阻擋。引用
 * parser 直接重用 check-next-gates.ts，兩支 gate 不各自維護一套 NEXT.md 語法。
 *
 * 用法:
 *   npx tsx scripts/check-dag.ts
 *   npx tsx scripts/check-dag.ts --root <dir>
 *
 * 退出碼:0 = 無環並完成分層；1 = 有環，或 --root 指向不存在的目錄。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectFeatureFolders,
  extractGateLines,
  loadResolvers,
  parseGateReferences,
  readFeaturePhaseRows,
  type GateLine,
  type GateReference,
  type Resolvers,
} from './check-next-gates.js';
import { ROOT as GIT_ROOT, requireRootDir } from './_root.js';

const GATE_NAME = 'dag';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROOT_EXPLICIT = argValue('--root') !== undefined;
const ROOT = resolve(argValue('--root') ?? GIT_ROOT);

interface PhaseNode {
  kind: 'phase';
  id: string;
  folder: string;
  phaseNum: string;
  status: string;
}

interface IntegrationNode {
  kind: 'integration';
  id: string;
  integrationId: string;
}

type Node = PhaseNode | IntegrationNode;

interface Edge {
  source: string;
  target: string;
}

interface ExternalBlocker {
  target: string;
  token: string;
}

interface Dag {
  nodes: Map<string, Node>;
  edges: Edge[];
  outgoing: Map<string, Set<string>>;
  incoming: Map<string, Set<string>>;
  externalBlockers: Map<string, Set<string>>;
  satisfiedIntegrations: Set<string>;
}

function phaseId(folder: string, phaseNum: string): string {
  return `${folder.slice(0, 2)} phase-${phaseNum}`;
}

function integrationId(id: string): string {
  return `I${id}`;
}

function compareNodeIds(a: string, b: string): number {
  const phaseA = /^(\d{2}) phase-(\d+)([a-z]?)$/.exec(a);
  const phaseB = /^(\d{2}) phase-(\d+)([a-z]?)$/.exec(b);
  if (phaseA && phaseB) {
    return Number(phaseA[1]) - Number(phaseB[1])
      || Number(phaseA[2]) - Number(phaseB[2])
      || phaseA[3]!.localeCompare(phaseB[3]!);
  }
  const integrationA = /^I(\d+)$/.exec(a);
  const integrationB = /^I(\d+)$/.exec(b);
  if (integrationA && integrationB) return Number(integrationA[1]) - Number(integrationB[1]);
  if (phaseA) return -1;
  if (phaseB) return 1;
  return a.localeCompare(b);
}

function normalizeStatus(status: string): string {
  const normalized = status.replace(/[`*_]/g, '').trim().toLowerCase();
  const known = /^(todo|ready|in-progress|done|blocked)(?:\s|\(|$)/.exec(normalized);
  return known?.[1] ?? normalized.split(/\s+/)[0] ?? '';
}

function collectNodes(root: string, folders: string[], resolvers: Resolvers): Map<string, Node> {
  const nodes = new Map<string, Node>();

  for (const folder of folders) {
    for (const row of readFeaturePhaseRows(root, folder)) {
      if (!/^\d+[a-z]?$/.test(row.phase)) continue;
      const id = phaseId(folder, row.phase);
      nodes.set(id, {
        kind: 'phase',
        id,
        folder,
        phaseNum: row.phase,
        status: normalizeStatus(row.status),
      });
    }
  }

  for (const id of resolvers.integrationPoints) {
    const nodeId = integrationId(id);
    nodes.set(nodeId, { kind: 'integration', id: nodeId, integrationId: id });
  }

  return nodes;
}

function referenceIsSatisfied(gate: GateLine, reference: GateReference): boolean {
  if (gate.checked !== undefined) return gate.checked;
  const tokenIndex = gate.text.indexOf(reference.token);
  const textAfterToken = (tokenIndex >= 0 ? gate.text.slice(tokenIndex + reference.token.length) : gate.text)
    .split(/[、,，;；]/, 1)[0] ?? '';
  return /(?:已解除|已滿足|已通過|已完成|通過|\b(?:done|passed)\b)/i.test(textAfterToken);
}

function addEdge(dag: Dag, source: string, target: string): void {
  if (!dag.nodes.has(source) || !dag.nodes.has(target)) return;
  if (dag.outgoing.get(source)?.has(target)) return;
  dag.outgoing.get(source)?.add(target);
  dag.incoming.get(target)?.add(source);
  dag.edges.push({ source, target });
}

function addExternalBlocker(dag: Dag, target: string, token: string): void {
  const existing = dag.externalBlockers.get(target);
  if (existing) existing.add(token);
  else dag.externalBlockers.set(target, new Set([token]));
}

function phaseReferenceTarget(reference: GateReference): string | undefined {
  if (reference.kind !== 'phase' || !reference.resolved || reference.folder === undefined || reference.phaseNum === undefined) {
    return undefined;
  }
  return phaseId(reference.folder, reference.phaseNum);
}

function integrationReferenceTarget(reference: GateReference): string | undefined {
  if (reference.kind !== 'integration' || !reference.resolved || reference.integrationId === undefined) return undefined;
  return integrationId(reference.integrationId);
}

function dagGateText(lines: string[], gate: GateLine): string {
  if (gate.checked === undefined) return gate.text;

  // extractGateLines() 合併了 checklist bullet 的縮排續行，供 check:next-gates
  // 檢查整條 gate。DAG 的語意不同：邊只能來自 bullet 的第一行，所以回到
  // GateLine.lineNo 取原始行，不能把已合併的 gate.text 拿來解析。
  const bullet = /^-\s*\[[ xX]\]\s*(.*)$/.exec((lines[gate.lineNo - 1] ?? '').trim());
  return bullet?.[1] ?? '';
}

function buildDag(root: string, folders: string[], nodes: Map<string, Node>, resolvers: Resolvers): Dag {
  const dag: Dag = {
    nodes,
    edges: [],
    outgoing: new Map([...nodes.keys()].map((id) => [id, new Set<string>()])),
    incoming: new Map([...nodes.keys()].map((id) => [id, new Set<string>()])),
    externalBlockers: new Map(),
    satisfiedIntegrations: new Set(),
  };
  const warnedSelfReferences = new Set<string>();

  for (const folder of folders) {
    const nextPath = join(root, 'features', folder, 'NEXT.md');
    if (!existsSync(nextPath)) continue;
    const content = readFileSync(nextPath, 'utf8');
    const gateLines = extractGateLines(folder, `features/${folder}/NEXT.md`, content);
    const lines = content.split('\n');

    for (const gate of gateLines) {
      const target = phaseId(folder, gate.phaseNum);
      if (!dag.nodes.has(target)) continue;

      const references = parseGateReferences(root, folder, dagGateText(lines, gate), resolvers);
      for (const reference of references) {
        const source = phaseReferenceTarget(reference) ?? integrationReferenceTarget(reference);
        if (source !== undefined) {
          if (reference.kind === 'phase' && source === target) {
            const phaseNum = reference.phaseNum ?? gate.phaseNum;
            const warningKey = `${gate.file}:${gate.lineNo}:phase-${phaseNum}`;
            if (!warnedSelfReferences.has(warningKey)) {
              warnedSelfReferences.add(warningKey);
              console.log(`${gate.file}: 第 ${gate.lineNo} 行 gate 引用了自己(phase-${phaseNum}),已忽略`);
            }
            continue;
          }
          addEdge(dag, source, target);
          if (reference.kind === 'integration' && referenceIsSatisfied(gate, reference)) {
            dag.satisfiedIntegrations.add(source);
          }
          continue;
        }

        if (reference.kind === 'adr' || reference.kind === 'contract' || reference.kind === 'commit') {
          if (!referenceIsSatisfied(gate, reference)) addExternalBlocker(dag, target, reference.token);
        }
      }
    }
  }

  return dag;
}

function findCycle(dag: Dag): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stack.push(id);
    const nextIds = [...(dag.outgoing.get(id) ?? [])].sort(compareNodeIds);
    for (const next of nextIds) {
      const nextState = state.get(next) ?? 0;
      if (nextState === 0) {
        const cycle = visit(next);
        if (cycle) return cycle;
      } else if (nextState === 1) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  };

  for (const id of [...dag.nodes.keys()].sort(compareNodeIds)) {
    if ((state.get(id) ?? 0) !== 0) continue;
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return undefined;
}

function topologicalLayers(dag: Dag): string[][] {
  const indegree = new Map([...dag.nodes.keys()].map((id) => [id, dag.incoming.get(id)?.size ?? 0]));
  const remaining = new Set(dag.nodes.keys());
  const layers: string[][] = [];

  while (remaining.size > 0) {
    const layer = [...remaining].filter((id) => (indegree.get(id) ?? 0) === 0).sort(compareNodeIds);
    if (layer.length === 0) return [];
    layers.push(layer);
    for (const id of layer) {
      remaining.delete(id);
      for (const next of dag.outgoing.get(id) ?? []) {
        indegree.set(next, (indegree.get(next) ?? 0) - 1);
      }
    }
  }

  return layers;
}

function isDoneNode(dag: Dag, id: string): boolean {
  const node = dag.nodes.get(id);
  if (!node) return false;
  if (node.kind === 'phase') return node.status === 'done';
  return dag.satisfiedIntegrations.has(id);
}

function readyPhases(dag: Dag): string[] {
  return [...dag.nodes.values()]
    .filter((node): node is PhaseNode => node.kind === 'phase' && node.status === 'todo')
    .filter((node) => {
      const incoming = dag.incoming.get(node.id) ?? new Set<string>();
      return [...incoming].every((source) => isDoneNode(dag, source)) && !dag.externalBlockers.has(node.id);
    })
    .map((node) => node.id)
    .sort(compareNodeIds);
}

function printReady(dag: Dag): void {
  console.log('\n目前 ready 集合');
  const ready = readyPhases(dag);
  if (ready.length === 0) {
    console.log('（無）');
    return;
  }
  for (const id of ready) console.log(`- ${id}`);
}

function formatLayerNode(dag: Dag, id: string): string {
  const node = dag.nodes.get(id);
  if (!node) return id;
  if (node.kind === 'integration') return `${id} [整合點]`;
  return `${id} [${node.status}]`;
}

function printExternalBlockers(dag: Dag): void {
  console.log('\n被外部阻擋卡住的 phase');
  const targets = [...dag.externalBlockers.keys()].sort(compareNodeIds);
  if (targets.length === 0) {
    console.log('（無）');
    return;
  }
  for (const target of targets) {
    const tokens = [...(dag.externalBlockers.get(target) ?? [])];
    console.log(`- ${target}: ${tokens.join('、')}`);
  }
}

function main(): void {
  requireRootDir(ROOT, ROOT_EXPLICIT, GATE_NAME);

  const folders = collectFeatureFolders(ROOT);
  const resolvers = loadResolvers(ROOT);
  const nodes = collectNodes(ROOT, folders, resolvers);

  if (![...nodes.values()].some((node) => node.kind === 'phase')) {
    console.log('沒有 phase');
    console.log('gate=dag result=PASS scanned=0');
    process.exit(0);
  }

  const dag = buildDag(ROOT, folders, nodes, resolvers);
  const cycle = findCycle(dag);
  if (cycle) {
    console.log(`✗ phase DAG 有環路:${cycle.join(' → ')}`);
    console.log(`gate=${GATE_NAME} result=FAIL scanned=${nodes.size}`);
    process.exit(1);
  }

  console.log('\n拓撲分層');
  for (const [index, layer] of topologicalLayers(dag).entries()) {
    console.log(`第 ${index + 1} 層(節點數=${layer.length}): ${layer.map((id) => formatLayerNode(dag, id)).join('、')}`);
  }
  printReady(dag);
  printExternalBlockers(dag);
  console.log(`gate=${GATE_NAME} result=PASS scanned=${nodes.size}`);
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();

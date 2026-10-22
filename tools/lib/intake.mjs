// The single entry point for everything that "enters the DAG":
//   feature    a single new node
//   bundle     a whole version (several nodes + gherkin + integration point)
// (The v4.0 brownfield scan and import were never used in real runs and were removed; v4.5 changed it to: in brownfield mode, a node that has to change existing code automatically gets a characterize leg)
// Always write the proposal + decision_request first; only after the user says yes in the single window does the next tick or `dlm intake apply` write it into the DAG.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { characterizeCmd, characterizeTestPath, existingFiles } from './brownfield.mjs';
import { buildConfigPaths, loadConfig } from './config.mjs';
import { defaultAcceptFor, loadStack, probe } from './stack.mjs';
import { capabilityOf, contractMajor, getNode, loadDag, saveDag, validateDag } from './dag.mjs';
import { commitAll } from './git.mjs';
import { append, readEvents } from './ledger.mjs';
import { renderAll, writeRendered } from './render.mjs';
import { replay } from './state.mjs';
import { DlmError, atomicWrite, matchAny, readJson, run, sha256, stableJson, writeJson } from './util.mjs';

const PROPOSALS = 'ledger/proposals';

function nextProposalId(root) {
  const dir = join(root, PROPOSALS);
  const n = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).length : 0;
  return `p-${String(n + 1).padStart(3, '0')}`;
}

/**
  * v4.7.3 parent / relation in a proposal now take effect just like the child nodes a worker proposes: prereq = the parent node waits for this node (this node is added to the parent's depends_on),
  * followup = this node waits for the parent node. Before, a proposal only recorded these two fields without wiring dependencies: the AI told the user "I3 will wait for the fix before asking you to try it", but I3 did not actually wait.
  * Real run: a minilang hand trial found a recursion depth bug in expr, and Front proposed expr/v4 (parent I3, prereq). Returns a new dag (does not modify the one passed in).
 */
export function wireParents(dag, fresh) {
  const next = { ...dag, nodes: dag.nodes.map((n) => ({ ...n, ...(n.depends_on ? { depends_on: [...n.depends_on] } : {}) })) };
  const byId = new Map(next.nodes.map((n) => [n.id, n]));
  for (const f of fresh) {
    if (!f.parent || !f.relation) continue;
    const child = byId.get(f.id);
    const parent = byId.get(f.parent);
    if (!child || !parent) continue; // parent does not exist: validateDag will point it out
    if (f.relation === 'prereq') parent.depends_on = [...new Set([...(parent.depends_on ?? []), child.id])];
    else child.depends_on = [...new Set([...(child.depends_on ?? []), parent.id])];
  }
  return next;
}

/** A prereq parent node that is already done can no longer be waited for (to change it, propose a new node or a new version). */
function checkParents(root, nodes) {
  const dag = loadDag(root);
  const state = replay(readEvents(root), dag);
  for (const n of nodes) {
    if (n.relation === 'prereq' && n.parent && state.nodes.get(n.parent)?.status === 'done') {
      throw new DlmError(`${n.id} 是 ${n.parent} 的 prereq,但 ${n.parent} 已經完成了,不能再讓它等;要改它就另提新節點(不寫 parent)`);
    }
  }
}

function checkNodes(root, nodes) {
  const dag = loadDag(root);
  checkParents(root, nodes);
  const next = wireParents({ ...dag, nodes: [...dag.nodes, ...nodes] }, nodes);
  const problems = validateDag(next, contractMajor(root));
  if (problems.length) throw new DlmError(`提案不合法:\n  - ${problems.join('\n  - ')}`);
}

function propose(root, proposal, question, { recommendation = 'yes', warnings = [], supersedes = [] } = {}) {
  const id = nextProposalId(root);
  const path = `${PROPOSALS}/${id}.json`;
  writeJson(join(root, path), { id, ...proposal, ...(warnings.length ? { warnings } : {}), ...(supersedes.length ? { supersedes } : {}) });
  const replaces = supersedes.length ? `(取代 ${supersedes.map((r) => r.slice(5)).join('、')})` : '';
  append(root, 'dlm-cli', 'decision_request', {
    ref: `node:${id}`,
    question: `${question}${replaces}`,
    options: [{ key: 'yes', label: '批准,寫進 DAG' }, { key: 'no', label: '不要' }],
    recommendation,
    ...(warnings.length ? { reason: `提醒:${warnings.join(';')}` } : {}),
    ...(supersedes.length ? { supersedes } : {}),
    from: 'intake',
    detail_path: path,
  });
  return { id, path, warnings, supersedes };
}

/**
  * v4.7.3 Replace not-yet-decided proposals: supersedes holds p-001 or node:p-001. Only proposals still waiting for a decision can be replaced; a replaced one is no longer pending and can no longer be approved.
  * Seen in a real run: the AI found its gherkin was wrong after proposing and proposed again, and the old one could only be "ignored" by the user; when both were approved, the old (wrong) one was written into the DAG first.
 */
function supersedeRefs(root, list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new DlmError('supersedes 要是陣列(例 ["p-001"])');
  const state = replay(readEvents(root), loadDag(root));
  return [...new Set(list.map((x) => (String(x).startsWith('node:') ? String(x) : `node:${x}`)))].map((ref) => {
    const rec = state.decisions.get(ref);
    if (!rec?.request) throw new DlmError(`supersedes 的 ${ref} 不是一份提案`);
    if (rec.answer) throw new DlmError(`${ref} 已經決定過了(${rec.answer.choice}),不能取代;要改就另提一份新的`);
    if (rec.superseded) throw new DlmError(`${ref} 已經被 ${rec.superseded} 取代了`);
    return ref;
  });
}

/** An older proposal still waiting for a decision has the same nodes as this one and has no supersedes -> remind (if both are approved, the old one is written into the DAG first). */
function pendingOverlapWarnings(root, nodes, superseded) {
  const state = replay(readEvents(root), loadDag(root));
  const ids = new Set(nodes.map((n) => n.id));
  const out = [];
  for (const rec of state.decisions.values()) {
    const ref = rec.request?.ref ?? '';
    if (!ref.startsWith('node:') || rec.answer || rec.superseded || superseded.includes(ref)) continue;
    const old = readJson(join(root, PROPOSALS, `${ref.slice(5)}.json`), null);
    const same = (old?.nodes ?? []).map((n) => n.id).filter((nid) => ids.has(nid));
    if (same.length) {
      out.push(`${ref.slice(5)} 還在等決定,也有 ${same.join('、')}:這份如果是要取代它,提案時帶 supersedes: ["${ref.slice(5)}"]`
        + '(舊的會關掉,不會被誤批准);兩份都批准的話,先寫進 DAG 的是舊的那份');
    }
  }
  return out;
}

/**
  * Layout of a new project: the stack's template decides where code and unit tests must live for the merge gate and mutation to see them
  * (node-ts: npm workspaces packages/*, apps/*, unit tests *.test.ts). If a phase node's owns falls entirely outside those directories -> warn, do not block.
  * Existing projects keep their own layout and are not checked; a stack without `layout` is not checked either.
  * v4.7.3 real run: an AI that could only see MCP could not read the intake skill's examples and put code in src/, bin/*.mjs: the merge gate's test was green with 0 tests,
  * mutation found nothing to test and ABSTAINed every time, and every leg had to ask the user.
 */
export function layoutWarnings(root, nodes) {
  if (brownfieldConfig(root)) return [];
  let layout;
  try { layout = loadStack(loadConfig(root).project.stack).layout; } catch { return []; }
  const dirs = layout?.workspaces ?? [];
  if (!dirs.length) return [];
  const inside = (g) => dirs.some((d) => g === d || g.startsWith(`${d}/`));
  return nodes.filter((n) => n.kind === 'phase' && (n.owns ?? []).length && !n.owns.some(inside)).map((n) => {
    const tests = dirs.map((d) => `${d}/**/${layout.unit_tests ?? '*'}`).join('、');
    return `${n.id} 的 owns(${n.owns.join('、')})不在 ${dirs.map((d) => `${d}/`).join('、')} 底下:`
      + `範本的單元測試只跑 ${tests},mutation 也只測那裡的程式,這個節點的單元測試不會進合併 gate。${layout.hint ?? ''}`;
  });
}

/** The step sentences of a gherkin (keywords removed, whitespace collapsed). Both English and Traditional Chinese keywords are recognized. */
const STEP = /^\s*(?:Given|When|Then|And|But|\*|假如|假設|假定|當|那麼|而且|並且|同時|但是)\s+(.+?)\s*$/;
export function gherkinSteps(text) {
  return String(text ?? '').split('\n').map((l) => l.match(STEP)?.[1]?.replace(/\s+/g, ' ')).filter(Boolean);
}

function featureFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) featureFiles(join(dir, e.name), out);
    else if (e.name.endsWith('.feature')) out.push(join(dir, e.name));
  }
  return out;
}

/**
  * An integration point's gherkin reuses the capability gherkin's sentences (word for word) -> warn. cucumber allows only one definition per sentence: the integration point's sentences bind to the capability's step definitions,
  * so when the capability is done the integration point's acceptance is already green and the test leg cannot produce a red light (the intake skill says this, but an AI that can only see MCP cannot read it).
  * Compares against the other nodes' gherkin in this proposal, plus what already exists under features/ on main.
  * Real run: todo-cli's I1 had 7/8 sentences identical to todo/v1, and I1's test leg got stuck.
 */
export function gherkinOverlapWarnings(root, nodes, files) {
  const own = new Set(nodes.map((n) => n.gherkin).filter(Boolean));
  const others = new Set();
  for (const n of nodes) if (n.kind !== 'integration' && files[n.gherkin]) gherkinSteps(files[n.gherkin]).forEach((x) => others.add(x));
  for (const f of featureFiles(join(root, 'features'))) {
    const rel = f.slice(root.length + 1);
    if (!own.has(rel)) gherkinSteps(readFileSync(f, 'utf8')).forEach((x) => others.add(x));
  }
  const out = [];
  for (const n of nodes.filter((x) => x.kind === 'integration' && files[x.gherkin])) {
    const mine = [...new Set(gherkinSteps(files[n.gherkin]))];
    const dup = mine.filter((x) => others.has(x));
    if (!dup.length) continue;
    out.push(`${n.id} 的 gherkin 有 ${dup.length}/${mine.length} 句跟能力節點一字不差(例「${dup[0]}」):cucumber 一句只能有一個定義,`
      + '整合點的句子會綁到能力的步驟,能力做完時整合點已經是綠的,測試棒做不出紅燈。整合點的句子寫成從使用者的角度操作整個程式'
      + '(例 When I run "todo add milk" in a terminal),命令列等組合層放在整合點的 owns(apps/<名稱>/**),不要放在能力節點裡');
  }
  return out;
}

// ------------------------------------------------------------------ feature

/** Rules that apply only to existing projects (brownfield). If the config cannot be read, treat it as greenfield. */
function safeConfig(root) {
  try { return loadConfig(root); } catch { return null; }
}

/**
 * The acceptance command a node gets when its spec has none: the stack's accept_cmd. In an existing project the stack's template was not installed,
 * so it is used only when the stack's accept_probe (a JSON file and key path, node-ts: package.json → scripts.accept) says the project has it.
 */
function stackAccept(root, config, bf, gherkin) {
  let stack;
  try { stack = loadStack(config?.project.stack ?? 'none'); } catch { return null; }
  if (bf && !probe(root, stack.accept_probe)) return null;
  return defaultAcceptFor(stack, gherkin);
}

function brownfieldConfig(root) {
  try {
    const c = loadConfig(root);
    return c.project?.mode === 'brownfield' ? c : null;
  } catch { return null; }
}

// The most existing files characterize pins at once: when owns is a wide range like src/**, one leg would have to add tests for the whole project, which cannot be finished or verified
export const CHARACTERIZE_MAX = 10;

function withCharacterize(root, node, config) {
  const lang = config.project?.language ?? 'node';
  const ch = node.characterize ? { ...node.characterize } : null;
  if (ch?.skip) return node;
  const targets = ch?.targets?.length ? ch.targets : existingFiles(root, node.owns ?? [], config);
  if (!targets.length) return node;
  if (targets.length > CHARACTERIZE_MAX) {
    throw new DlmError(`${node.id} 的 owns 涵蓋 ${targets.length} 個既有程式檔(${targets.slice(0, 5).join(', ')} …),一棒釘不完。`
      + `把 owns 縮到真的會改的檔,或在 characterize.targets 列出要釘住的(最多 ${CHARACTERIZE_MAX} 個),或寫 characterize.skip 說明為什麼不釘`);
  }
  const tests = ch?.tests?.length ? ch.tests : [...new Set(targets.map((t) => characterizeTestPath(t, lang)).filter(Boolean))];
  if (!tests.length) throw new DlmError(`${node.id} 要改既有程式 ${targets.join(', ')},但 dlm 推不出 characterize 測試該放哪裡:請在 characterize.tests 指定`);
  return { ...node, characterize: { targets, tests, cmd: ch?.cmd ?? characterizeCmd(tests, config) } };
}

function normalizeFeature(root, spec, gherkinText) {
  const node = { ...spec };
  node.kind ??= 'phase';
  const bf = brownfieldConfig(root);
  const config = bf ?? safeConfig(root);
  // v4: only shared nodes may change gate definition files (package.json and the like); in v3 an integration point owning package.json passed the proposal and was then judged out of bounds three times during construction (seen in a real run)
  const build = node.kind === 'shared' ? [] : (node.owns ?? []).filter((g) => buildConfigPaths(config).some((b) => g === b || matchAny(g, [b])));
  if (build.length) {
    throw new DlmError(`${node.id} 的 owns 有 ${build.join(', ')}:這些是 gate 定義檔,只有 shared 節點能改(例:另提 shared/deps,owns 明列 package.json,讓 ${node.id} 依賴它)`);
  }
  if (node.kind === 'shared' && gherkinText && !node.gherkin) {
    // v3 real run: a shared node with a gherkin wrote a file named undefined. shared has no default gherkin path, so either specify one yourself or change it to a phase node
    throw new DlmError(`${node.id} 是 shared 節點又附了 gherkin:shared 沒有預設的 gherkin 路徑。要機器驗收就在 spec 寫 gherkin 路徑與 accept,或改成 phase 節點`);
  }
  if (node.kind !== 'shared' && !node.gherkin) node.gherkin = node.kind === 'integration'
    ? `docs/integration/${node.id.toLowerCase()}.feature`
    : `features/${capabilityOf(node.id)}/${node.id.split('/').pop()}.feature`;
  if (node.gherkin && !node.accept) {
    node.accept = stackAccept(root, config, bf, node.gherkin);
    if (!node.accept) {
      const t = config?.gates.commands?.test ?? '<專案的測試指令>';
      throw new DlmError(`${node.id}:這個專案的技術棧(${config?.project.stack ?? 'none'})沒有預設的驗收指令,要在 spec 寫 accept——用專案自己的測試指令只跑這個節點的測試,`
        + `例:"accept": "${t} <這個節點的測試檔>"。測試棒會照 gherkin 的每個場景寫一個測試(名稱用場景名),它必須先紅、實作後變綠`);
    }
  }
  if (node.gherkin && !gherkinText && !existsSync(join(root, node.gherkin))) {
    throw new DlmError(`${node.gherkin} 不存在,也沒附 gherkin 內容:沒有 gherkin 不寫程式`);
  }
  if (node.kind === 'integration' && gherkinText && !/@e2e/.test(gherkinText)) {
    throw new DlmError(`整合點 ${node.id} 的 gherkin 至少要有一個 @e2e 場景(使用者親手試用的清單)`);
  }
  return bf ? withCharacterize(root, node, bf) : node;
}

const chNote = (n) => (n.characterize?.targets?.length && !n.characterize.skip ? `;先釘住 ${n.characterize.targets.length} 個既有檔的現有行為` : '');
const parentNote = (n) => (n.parent && n.relation ? (n.relation === 'prereq' ? `;${n.parent} 會等它完成` : `;等 ${n.parent} 完成才開工`) : '');

export function proposeFeature(root, spec, gherkinText, { supersedes } = {}) {
  const sup = supersedeRefs(root, supersedes);
  const node = normalizeFeature(root, spec, gherkinText);
  checkNodes(root, [node]);
  return propose(root, { kind: 'feature', nodes: [node], files: gherkinText ? { [node.gherkin]: gherkinText } : {} },
    `新增 ${node.id}(${node.title}):${node.intent}${chNote(node)}${parentNote(node)}`,
    {
      warnings: [...layoutWarnings(root, [node]), ...gherkinOverlapWarnings(root, [node], gherkinText ? { [node.gherkin]: gherkinText } : {}),
        ...pendingOverlapWarnings(root, [node], sup)],
      supersedes: sup,
    });
}

/**
  * v4: propose a whole version at once. bundle = { release: "v2", goal: "what the user can do in this version", roadmap?: "...", nodes: [
 *   { id, kind, title, intent, owns, depends_on?, ..., gherkin_text?: "Feature: ...", gherkin_file?: "path" } ] }
  * - The last node of every version must be an integration point (kind=integration, with @e2e scenarios) -- the point where the user tries it by hand; reject if there is none
  *   (write "no_integration_reason" when it is really not needed).
  * - Nodes in this version that have no dependencies automatically depend on "the previous version's integration point": if the previous version is not merged or hand-trialed, this version does not start.
  * - If roadmap is given, it is saved as docs/ROADMAP.md (the direction of later versions; only this version enters the DAG).
  * v3 real run: 6 nodes were proposed in 4 rounds and the user approved 4 times; the roadmap lived only in Front's conversation and was lost on switching session.
 */
export function proposeBundle(root, bundle, { supersedes } = {}) {
  const sup = supersedeRefs(root, supersedes);
  if (!bundle?.release || !/^[\w.-]+$/.test(bundle.release)) throw new DlmError('bundle 要有 release(例:"v1")');
  if (!Array.isArray(bundle.nodes) || !bundle.nodes.length) throw new DlmError('bundle.nodes 是空的');
  const dag = loadDag(root);
  const files = {};
  const nodes = bundle.nodes.map((raw) => {
    const { gherkin_text: text0, gherkin_file: file, ...spec } = raw;
    const text = text0 ?? (file ? readFileSync(join(root, file), 'utf8') : null);
    const node = normalizeFeature(root, { ...spec, release: bundle.release }, text);
    if (text) files[node.gherkin] = text;
    return node;
  });
  const integrations = nodes.filter((n) => n.kind === 'integration');
  if (!integrations.length && !bundle.no_integration_reason) {
    throw new DlmError(`bundle ${bundle.release} 沒有整合點:每一版最後要有一個 kind=integration 的節點(I<n>,依賴這一版所有節點,含 @e2e 場景),那是使用者親手試用、確認這一版能用的時間點。真的不需要就寫 no_integration_reason`);
  }
  for (const i of integrations) {
    const missing = nodes.filter((n) => n.kind !== 'integration' && !(i.depends_on ?? []).includes(n.id)).map((n) => n.id);
    if (missing.length) throw new DlmError(`整合點 ${i.id} 沒有依賴這一版的 ${missing.join(', ')}:整合點要在這一版全部做完之後`);
  }
  // Previous version's integration point: dag is ordered by insertion, so the last integration point with a different release is the previous version's
  const gate = dag.nodes.filter((n) => n.kind === 'integration' && n.release && n.release !== bundle.release).at(-1)?.id ?? null;
  const ids = new Set(nodes.map((n) => n.id));
  if (gate) {
    for (const n of nodes) {
      const internal = (n.depends_on ?? []).some((d) => ids.has(d));
      if (!internal && !(n.depends_on ?? []).includes(gate)) n.depends_on = [...(n.depends_on ?? []), gate];
    }
  }
  if (bundle.roadmap) files['docs/ROADMAP.md'] = bundle.roadmap;
  checkNodes(root, nodes);
  const list = nodes.map((n) => `${n.id}${n.kind === 'integration' ? '(整合點)' : ''}`).join('、');
  const pinned = nodes.reduce((k, n) => k + (n.characterize?.skip ? 0 : n.characterize?.targets?.length ?? 0), 0);
  return propose(root, { kind: 'bundle', release: bundle.release, nodes, files, ...(bundle.roadmap ? { overwrite: ['docs/ROADMAP.md'] } : {}) },
    `新增 ${bundle.release}:${bundle.goal ?? ''}(${nodes.length} 個節點:${list}${gate ? `;等 ${gate} 試用過才開工` : ''}${pinned ? `;先釘住 ${pinned} 個既有檔的現有行為` : ''})`,
    { warnings: [...layoutWarnings(root, nodes), ...gherkinOverlapWarnings(root, nodes, files), ...pendingOverlapWarnings(root, nodes, sup)], supersedes: sup });
}

// ------------------------------------------------------------------ apply

export function applyProposal(root, id) {
  const path = `${PROPOSALS}/${id}.json`;
  const proposal = readJson(join(root, path));
  const events = readEvents(root);
  const dag = loadDag(root);
  const state = replay(events, dag);
  const answer = state.decisions.get(`node:${id}`)?.answer;
  if (!answer) throw new DlmError(`node:${id} 還沒被決定;先在單一窗口問使用者`);
  if (answer.choice !== 'yes') throw new DlmError(`node:${id} 被拒絕了(${answer.verbatim})`);
  const fresh = proposal.nodes.filter((n) => !getNode(dag, n.id));
  if (!fresh.length) return { applied: 0 };
  const touched = [];
  for (const [file, text] of Object.entries(proposal.files ?? {})) {
    if (!existsSync(join(root, file)) || (proposal.overwrite ?? []).includes(file)) atomicWrite(join(root, file), text.endsWith('\n') ? text : `${text}\n`);
    touched.push(file);
  }
  const next = wireParents({ ...dag, nodes: [...dag.nodes, ...fresh] }, fresh);
  saveDag(root, next);
  for (const n of fresh) {
    append(root, 'orchestrator', 'node_added', { node_id: n.id, approved_by: `decision:node:${id}#${answer.seq}`, spec_sha: sha256(stableJson(n)).slice(0, 12) });
  }
  const ev = readEvents(root);
  writeRendered(root, renderAll(root, next, replay(ev, next), ev));
  commitAll(root, ['dag.json', 'ledger', 'STATUS.md', 'DECISIONS.md', 'standalone.json', ...touched], `dlm: 批准 ${id},新增 ${fresh.map((n) => n.id).join(', ')}`);
  return { applied: fresh.length, nodes: fresh.map((n) => n.id) };
}

/** Called by tick: apply proposals that are approved but not yet applied. */
export function applyApprovedProposals(root, log = () => {}) {
  const dir = join(root, PROPOSALS);
  if (!existsSync(dir)) return 0;
  const dag = loadDag(root);
  const state = replay(readEvents(root), dag);
  let n = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const id = f.replace('.json', '');
    const answer = state.decisions.get(`node:${id}`)?.answer;
    if (answer?.choice !== 'yes') continue;
    const p = readJson(join(dir, f));
    if (p.nodes.every((x) => getNode(dag, x.id))) continue;
    const r = applyProposal(root, id);
    log(`+ 套用提案 ${id}:${r.nodes?.join(', ')}`);
    n += r.applied;
  }
  return n;
}

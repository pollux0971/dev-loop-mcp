// 所有「新東西進 DAG」的單一入口:
//   feature    一個新節點
//   bundle     一整個版本(多個節點 + gherkin + 整合點)
// (v4.0 的 brownfield 掃描與 import 實跑沒用到,已移除;v4.5 改成:brownfield 模式下,要改到既有程式的節點自動加 characterize 棒)
// 一律先寫提案 + decision_request;使用者在單一窗口說 yes 之後,下一個 tick 或 `dp intake apply` 才寫進 DAG。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { characterizeCmd, characterizeTestPath, existingFiles } from './brownfield.mjs';
import { BUILD_CONFIG_PATHS, loadConfig } from './config.mjs';
import { capabilityOf, contractMajor, getNode, loadDag, saveDag, validateDag } from './dag.mjs';
import { commitAll } from './git.mjs';
import { append, readEvents } from './ledger.mjs';
import { renderAll, writeRendered } from './render.mjs';
import { replay } from './state.mjs';
import { DpError, atomicWrite, matchAny, readJson, run, sha256, stableJson, writeJson } from './util.mjs';

/**
 * 預設的驗收指令。範本的步驟定義是 TypeScript,要靠 package.json 的 accept script(NODE_OPTIONS=--import=tsx)才載入得了;
 * 直接 `npx cucumber-js <gherkin>` 會 ERR_MODULE_NOT_FOUND,實作棒永遠綠不了(v3 實測)。
 */
export const defaultAccept = (gherkin) => `npm run accept -- ${gherkin}`;

const PROPOSALS = 'ledger/proposals';

function nextProposalId(root) {
  const dir = join(root, PROPOSALS);
  const n = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).length : 0;
  return `p-${String(n + 1).padStart(3, '0')}`;
}

function checkNodes(root, nodes) {
  const dag = loadDag(root);
  const next = { ...dag, nodes: [...dag.nodes, ...nodes] };
  const problems = validateDag(next, contractMajor(root));
  if (problems.length) throw new DpError(`提案不合法:\n  - ${problems.join('\n  - ')}`);
}

function propose(root, proposal, question, recommendation = 'yes', reason) {
  const id = nextProposalId(root);
  const path = `${PROPOSALS}/${id}.json`;
  writeJson(join(root, path), { id, ...proposal });
  append(root, 'dp-cli', 'decision_request', {
    ref: `node:${id}`,
    question,
    options: [{ key: 'yes', label: '批准,寫進 DAG' }, { key: 'no', label: '不要' }],
    recommendation,
    ...(reason ? { reason } : {}),
    from: 'intake',
    detail_path: path,
  });
  return { id, path };
}

// ------------------------------------------------------------------ feature

/** 既有專案(brownfield)才有的規則。設定讀不到就當 greenfield。 */
function brownfieldConfig(root) {
  try {
    const c = loadConfig(root);
    return c.project?.mode === 'brownfield' ? c : null;
  } catch { return null; }
}

// characterize 一次最多釘幾個既有檔:owns 寫成 src/** 這種大範圍時,一棒要替整個專案補測試,做不完也驗不了
export const CHARACTERIZE_MAX = 10;

function withCharacterize(root, node, config) {
  const lang = config.project?.language ?? 'node';
  const ch = node.characterize ? { ...node.characterize } : null;
  if (ch?.skip) return node;
  const targets = ch?.targets?.length ? ch.targets : existingFiles(root, node.owns ?? [], config);
  if (!targets.length) return node;
  if (targets.length > CHARACTERIZE_MAX) {
    throw new DpError(`${node.id} 的 owns 涵蓋 ${targets.length} 個既有程式檔(${targets.slice(0, 5).join(', ')} …),一棒釘不完。`
      + `把 owns 縮到真的會改的檔,或在 characterize.targets 列出要釘住的(最多 ${CHARACTERIZE_MAX} 個),或寫 characterize.skip 說明為什麼不釘`);
  }
  const tests = ch?.tests?.length ? ch.tests : [...new Set(targets.map((t) => characterizeTestPath(t, lang)).filter(Boolean))];
  if (!tests.length) throw new DpError(`${node.id} 要改既有程式 ${targets.join(', ')},但 dp 推不出 characterize 測試該放哪裡:請在 characterize.tests 指定`);
  return { ...node, characterize: { targets, tests, cmd: ch?.cmd ?? characterizeCmd(tests, config) } };
}

function normalizeFeature(root, spec, gherkinText) {
  const node = { ...spec };
  node.kind ??= 'phase';
  const bf = brownfieldConfig(root);
  if (bf && node.kind !== 'shared' && !node.accept && !('accept' in (readJson(join(root, 'package.json'), {})?.scripts ?? {}))) {
    const t = bf.gates.commands?.test ?? 'npm test --';
    throw new DpError(`${node.id}:既有專案沒有 accept script(範本的 cucumber),要在 spec 寫 accept——用專案自己的測試指令只跑這個節點的測試,`
      + `例:"accept": "${t} <這個節點的測試檔>"。測試棒會照 gherkin 的每個場景寫一個測試(名稱用場景名),它必須先紅、實作後變綠`);
  }
  // v4:只有 shared 節點能改 gate 定義檔(package.json 之類);v3 讓整合點 owns package.json 通過提案,施工時才被判越界三次(實測)
  const build = node.kind === 'shared' ? [] : (node.owns ?? []).filter((g) => BUILD_CONFIG_PATHS.some((b) => g === b || matchAny(g, [b])));
  if (build.length) {
    throw new DpError(`${node.id} 的 owns 有 ${build.join(', ')}:這些是 gate 定義檔,只有 shared 節點能改(例:另提 shared/deps,owns 明列 package.json,讓 ${node.id} 依賴它)`);
  }
  if (node.kind === 'shared' && gherkinText && !node.gherkin) {
    // v3 實測:shared 節點附 gherkin 時寫出一個叫 undefined 的檔。shared 沒有預設的 gherkin 路徑,要嘛自己指定,要嘛改成 phase
    throw new DpError(`${node.id} 是 shared 節點又附了 gherkin:shared 沒有預設的 gherkin 路徑。要機器驗收就在 spec 寫 gherkin 路徑與 accept,或改成 phase 節點`);
  }
  if (node.kind !== 'shared' && !node.gherkin) node.gherkin = node.kind === 'integration'
    ? `docs/integration/${node.id.toLowerCase()}.feature`
    : `features/${capabilityOf(node.id)}/${node.id.split('/').pop()}.feature`;
  if (node.kind === 'phase' && !node.accept) node.accept = defaultAccept(node.gherkin);
  if (node.kind === 'integration' && !node.accept) node.accept = defaultAccept(node.gherkin);
  if (node.kind === 'shared' && node.gherkin && !node.accept) node.accept = defaultAccept(node.gherkin);
  if (node.gherkin && !gherkinText && !existsSync(join(root, node.gherkin))) {
    throw new DpError(`${node.gherkin} 不存在,也沒附 gherkin 內容:沒有 gherkin 不寫程式`);
  }
  if (node.kind === 'integration' && gherkinText && !/@e2e/.test(gherkinText)) {
    throw new DpError(`整合點 ${node.id} 的 gherkin 至少要有一個 @e2e 場景(使用者親手試用的清單)`);
  }
  return bf ? withCharacterize(root, node, bf) : node;
}

const chNote = (n) => (n.characterize?.targets?.length && !n.characterize.skip ? `;先釘住 ${n.characterize.targets.length} 個既有檔的現有行為` : '');

export function proposeFeature(root, spec, gherkinText) {
  const node = normalizeFeature(root, spec, gherkinText);
  checkNodes(root, [node]);
  return propose(root, { kind: 'feature', nodes: [node], files: gherkinText ? { [node.gherkin]: gherkinText } : {} },
    `新增 ${node.id}(${node.title}):${node.intent}${chNote(node)}`);
}

/**
 * v4:一次提一整個版本。bundle = { release: "v2", goal: "這一版使用者能做什麼", roadmap?: "...", nodes: [
 *   { id, kind, title, intent, owns, depends_on?, ..., gherkin_text?: "Feature: ...", gherkin_file?: "path" } ] }
 * - 每個版本最後要有一個整合點(kind=integration,含 @e2e 場景)——使用者親手試用的時間點;沒有就拒絕
 *   (真的不需要時寫 "no_integration_reason")。
 * - 這一版裡沒有依賴的節點,會自動依賴「上一版的整合點」:上一版沒合併、沒試用過,這一版不開工。
 * - roadmap 有寫就存成 docs/ROADMAP.md(後面幾版的方向;只有這一版會進 DAG)。
 * v3 實測:6 個節點分 4 次提案、使用者批 4 次;路線圖只存在 Front 的對話裡,換一個 session 就沒了。
 */
export function proposeBundle(root, bundle) {
  if (!bundle?.release || !/^[\w.-]+$/.test(bundle.release)) throw new DpError('bundle 要有 release(例:"v1")');
  if (!Array.isArray(bundle.nodes) || !bundle.nodes.length) throw new DpError('bundle.nodes 是空的');
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
    throw new DpError(`bundle ${bundle.release} 沒有整合點:每一版最後要有一個 kind=integration 的節點(I<n>,依賴這一版所有節點,含 @e2e 場景),那是使用者親手試用、確認這一版能用的時間點。真的不需要就寫 no_integration_reason`);
  }
  for (const i of integrations) {
    const missing = nodes.filter((n) => n.kind !== 'integration' && !(i.depends_on ?? []).includes(n.id)).map((n) => n.id);
    if (missing.length) throw new DpError(`整合點 ${i.id} 沒有依賴這一版的 ${missing.join(', ')}:整合點要在這一版全部做完之後`);
  }
  // 上一版的整合點:dag 是依加入順序排的,最後一個 release 不同的整合點就是上一版的
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
    `新增 ${bundle.release}:${bundle.goal ?? ''}(${nodes.length} 個節點:${list}${gate ? `;等 ${gate} 試用過才開工` : ''}${pinned ? `;先釘住 ${pinned} 個既有檔的現有行為` : ''})`);
}

// ------------------------------------------------------------------ apply

export function applyProposal(root, id) {
  const path = `${PROPOSALS}/${id}.json`;
  const proposal = readJson(join(root, path));
  const events = readEvents(root);
  const dag = loadDag(root);
  const state = replay(events, dag);
  const answer = state.decisions.get(`node:${id}`)?.answer;
  if (!answer) throw new DpError(`node:${id} 還沒被決定;先在單一窗口問使用者`);
  if (answer.choice !== 'yes') throw new DpError(`node:${id} 被拒絕了(${answer.verbatim})`);
  const fresh = proposal.nodes.filter((n) => !getNode(dag, n.id));
  if (!fresh.length) return { applied: 0 };
  const touched = [];
  for (const [file, text] of Object.entries(proposal.files ?? {})) {
    if (!existsSync(join(root, file)) || (proposal.overwrite ?? []).includes(file)) atomicWrite(join(root, file), text.endsWith('\n') ? text : `${text}\n`);
    touched.push(file);
  }
  const next = { ...dag, nodes: [...dag.nodes, ...fresh] };
  saveDag(root, next);
  for (const n of fresh) {
    append(root, 'orchestrator', 'node_added', { node_id: n.id, approved_by: `decision:node:${id}#${answer.seq}`, spec_sha: sha256(stableJson(n)).slice(0, 12) });
  }
  const ev = readEvents(root);
  writeRendered(root, renderAll(root, next, replay(ev, next), ev));
  commitAll(root, ['dag.json', 'ledger', 'STATUS.md', 'DECISIONS.md', 'standalone.json', ...touched], `dp: 批准 ${id},新增 ${fresh.map((n) => n.id).join(', ')}`);
  return { applied: fresh.length, nodes: fresh.map((n) => n.id) };
}

/** tick 會呼叫:把已批准但還沒套用的提案套上去。 */
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

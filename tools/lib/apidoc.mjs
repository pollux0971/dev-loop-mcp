// v4.7 Generate docs from api.mjs and flow.mjs: docs/dlm/API.md, docs/dlm/openapi.json, docs/dlm/FLOW.md.
// `dlm api md|openapi|flow` prints them; the three copies in payload are made this way, and a test compares them, so the docs and the implementation cannot drift apart.
import { ROUTES, openapi } from './api.mjs';
import { FLOW, PROMPTS, RULES, toolName } from './flow.mjs';

const TAGS = [
  ['meta', '流程與規格'], ['monitor', '多專案監控'], ['projects', '專案清單與設定'], ['project', '一個專案的現況'],
  ['decisions', '提案與使用者的決定'], ['loop', '背景迴圈與停機'], ['accounts', '訂閱帳號與角色'],
];
const PATH_DESC = { project: '專案名稱(或 MCP 裡的專案目錄絕對路徑)', account: '帳號名稱', role: 'worker / critic / verifier' };

const typeOf = (s) => {
  if (!s) return 'string';
  const t = Array.isArray(s.type) ? s.type.join(' \\| ') : s.type ?? 'any';
  if (s.enum) return s.enum.map((x) => `\`${x}\``).join(' \\| ');
  if (t === 'array' && s.items) return `${typeOf(s.items)}[]`;
  return t;
};
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const mcpOf = (r) => (r.kind === 'stream' || r.id === 'openapi' ? '—' : `\`${toolName(r.id)}\``);

function params(r) {
  const rows = [];
  for (const [, k] of r.path.matchAll(/\{(\w+)\}/g)) rows.push([k, 'path', 'string', '必填', PATH_DESC[k]]);
  for (const [k, s] of Object.entries(r.query ?? {})) rows.push([k, 'query', typeOf(s), (r.required ?? []).includes(k) ? '必填' : '', s.description]);
  // Objects and arrays of objects are expanded downward (spec.id, bundle.nodes[].gherkin_text…); required follows each level's own required
  const walk = (prefix, s, required) => {
    rows.push([prefix, 'body', typeOf(s), required ? '必填' : '', s.description]);
    const inner = s.type === 'array' && s.items?.properties ? { s: s.items, at: `${prefix}[]` } : s.properties ? { s, at: prefix } : null;
    if (!inner) return;
    for (const [k, s2] of Object.entries(inner.s.properties)) walk(`${inner.at}.${k}`, s2, (inner.s.required ?? []).includes(k));
  };
  for (const [k, s] of Object.entries(r.body?.properties ?? {})) walk(k, s, (r.body.required ?? []).includes(k));
  return rows;
}

export function apiMarkdown(version) {
  const out = [
    `# dlm API(v${version})`,
    '',
    '> 這份是 `node tools/dlm.mjs api md` 從 `tools/lib/api.mjs` 產生的,不要手改。機器讀的版本:[openapi.json](openapi.json)(或執行中的 `GET /api/v1/openapi.json`)。',
    '',
    '同一張路由表有三個入口,參數與結果完全一樣:',
    '',
    '- **MCP**:`dlm mcp install` 裝一次(這台電腦所有專案共用)。工具名是 `dlm_` + operationId 的 snake_case;路徑參數、query、body 攤平成同一層參數。',
    '  在 dlm 專案目錄裡啟動時 `project` 可以省略;給目錄的絕對路徑時,還沒登記的 dlm 專案會自動登記。',
    '- **HTTP**:`dlm hub` 開在 `http://127.0.0.1:7170`(只綁本機)。除了 health 與 openapi,都要帶 `Authorization: Bearer <token>`',
    '  (`dlm hub token` 看;瀏覽器的 EventSource 不能帶 header,串流端點也接受 `?token=`)。Host 必須是 127.0.0.1 / localhost,有 Origin 就必須是同一個。',
    '- **CLI**:`dlm op <操作> --args \'{json}\'`(在專案裡),stdout 最後一行是 `{"ok":true,"result":…}` 或 `{"ok":false,"error":"…","status":409}`。',
    '  hub 與 MCP 對專案的操作就是在那個專案裡跑這一行,所以專案的 dlm 版本不同也不會讀錯格式;太舊(4.7 以前)回 501,先 upgradeProject。',
    '',
    '錯誤一律是 `{"error":{"message","status"}}`:400 參數不對、401 沒 token、403 Host / Origin 不對、404 沒有這個專案或路由、',
    '405 方法不對、409 狀態衝突(例 背景迴圈已經在跑、已經停機)、501 專案的 dlm 太舊、500 其他。',
    '',
    '**決定類**(decide、confirm、unblock、resume)只轉達使用者這一輪親口說的話,`verbatim` 照抄;dlm 派出去的 worker / Critic 不能用 MCP(`DLM_ROLE` 有值就拒絕啟動)。',
    '',
    '## 總表',
    '',
    '| 方法 | 路徑 | MCP 工具 | 說明 |',
    '|---|---|---|---|',
    ...ROUTES.map((r) => `| ${r.method} | \`${r.path}\` | ${mcpOf(r)} | ${cell(r.summary)} |`),
    '',
  ];
  for (const [tag, title] of TAGS) {
    const rs = ROUTES.filter((r) => r.tag === tag);
    if (!rs.length) continue;
    out.push(`## ${title}`, '');
    for (const r of rs) {
      out.push(`### \`${r.method} ${r.path}\``, '', `operationId \`${r.id}\` · MCP ${mcpOf(r)}${r.kind === 'op' ? ` · \`dlm op ${r.op}\`` : ''}${r.ok && r.ok !== 200 ? ` · 成功回 ${r.ok}` : ''}`, '', r.summary + (r.description ? `。${r.description}` : ''), '');
      const ps = params(r);
      if (ps.length) out.push('| 參數 | 位置 | 型別 | | 說明 |', '|---|---|---|---|---|', ...ps.map((p) => `| \`${p[0]}\` | ${p[1]} | ${p[2]} | ${p[3]} | ${cell(p[4])} |`), '');
    }
  }
  out.push('## 範例', '', '```bash',
    'TOKEN=$(node tools/dlm.mjs hub token)',
    'curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7170/api/v1/overview',
    'curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \\',
    '  -d \'{"ref":"node:p-001","choice":"yes","verbatim":"好"}\' http://127.0.0.1:7170/api/v1/projects/my-app/decisions',
    'curl -N "http://127.0.0.1:7170/api/v1/events/stream?token=$TOKEN"     # SSE:event: ledger / data: {"project":…,"event":…}',
    'node tools/dlm.mjs op status                                            # 同一個操作,不經 hub',
    '```', '');
  return out.join('\n');
}

export function flowMarkdown(version) {
  const out = [
    `# dlm 的流程(v${version})`,
    '',
    '> 這份是 `node tools/dlm.mjs api flow` 從 `tools/lib/flow.mjs` 產生的,不要手改。同一份也在 `GET /api/v1/flow`、MCP 的 `dlm_flow` 工具與 prompts。',
    '',
    '每一步寫明誰做:**使用者**(本人)、**你**(呼叫 MCP / API 的 AI)、**dlm**(背景迴圈)。工具名後面括號是 HTTP 端點。',
    '',
  ];
  const byId = Object.fromEntries(ROUTES.map((r) => [r.id, r]));
  const who = { user: '使用者', agent: '你', dlm: 'dlm' };
  FLOW.forEach((st, i) => {
    out.push(`## ${i + 1}. ${st.title}${st.optional ? '(選用)' : ''}`, '', `目標:${st.goal}`, '');
    st.steps.forEach((x, j) => out.push(`${j + 1}. **${who[x.who]}**${x.call ? ` \`${toolName(x.call)}\`(\`${byId[x.call].method} ${byId[x.call].path}\`)` : ''}${x.when ? `,${x.when} 時` : ''}:${x.note}`));
    out.push('');
  });
  out.push('## 規則', '', ...RULES.map((r) => `- ${r}`), '', '## MCP prompts', '',
    'Claude Code 裡打 `/mcp__dlm__<名稱>`。', '',
    '| 名稱 | 做什麼 | 參數 | 走哪幾段 |', '|---|---|---|---|',
    ...PROMPTS.map((p) => `| \`${p.name}\` | ${cell(p.description)} | ${p.arguments.map((a) => `${a.name}${a.required ? '' : '(選填)'}`).join('、')} | ${p.flow.map((id) => FLOW.find((s) => s.id === id).title).join(' → ')} |`),
    '');
  return out.join('\n');
}

export const openapiJson = (version) => `${JSON.stringify(openapi(version), null, 2)}\n`;

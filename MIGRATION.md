# 從 dp(4.7.3 及以前)升級到 dlm(4.8.0)

專案改名:dev-paradigm-mcp → dev-loop-mcp,簡稱與指令 `dp` → `dlm`。dag、ledger 的格式不變,只有名字變。

**改名對照**

| 舊 | 新 |
|---|---|
| MCP server `dp`、工具 `dp_*`、prompts `/mcp__dp__...` | `dlm`、`dlm_*`、`/mcp__dlm__...` |
| `node tools/dp.mjs` | `node tools/dlm.mjs` |
| `dp.config.json`、`.dp/`、`.dp-install.json` | `dlm.config.json`、`.dlm/`、`.dlm-install.json` |
| `docs/dp/`、`docs/dp-baseline.json`、`npm run check:dp` | `docs/dlm/`、`docs/dlm-baseline.json`、`npm run check:dlm` |
| `~/.config/dp` | `~/.config/dlm` |
| 環境變數 `DP_*`(`DP_CONFIG_DIR`、`DP_ACCOUNTS_FILE`、`DP_PROJECTS_FILE`、`DP_KEY_FILE`、worker 的 `DP_PROMPT`/`DP_REPORT`/`DP_ROLE`、通知的 `DP_NOTIFY_TEXT`) | `DLM_*` |
| GitHub:`dev-paradigm-mcp` | `github.com/pollux0971/dev-loop-mcp` |

**升級步驟**

1. **重裝 MCP**:從 dev-loop-mcp 的目錄跑 `node tools/dlm.mjs mcp install`。它註冊 `dlm`,並把指向 `tools/dp.mjs` 的舊 `dp` 註冊移除。重開 Claude Code。
2. **電腦層級設定自動搬家**:新版第一次跑時,`~/.config/dp` 搬到 `~/.config/dlm`,`accounts.json` 裡的絕對路徑一併改寫,舊位置留一個指過去的捷徑(升級前就在跑的舊程序繼續用同一份;沒有舊程序後可以刪)。你自己設過 `DP_*` 環境變數的話(例如 CI、shell 設定),要手動改成 `DLM_*`;`dlm doctor` 會提醒。
3. **每個專案各升級一次**:先停掉背景迴圈(`dlm_stop_loop`),再呼叫 `dlm_upgrade_project`,或在專案裡跑 `node <新版 dlm>/tools/dlm.mjs upgrade`。它會:
   - 把 `dp.config.json` 改名成 `dlm.config.json`,裡面的 `check:dp`、`.dp/`、`DP_` 一起改;
   - 把 `.dp/` 搬到 `.dlm/` 並修好 git worktree;
   - 改名 `docs/dp-baseline.json`、`.dp-install.json`;
   - 換掉 `docs/dp/`,`tools/dp.mjs` 換成只轉給 `tools/dlm.mjs` 的小檔(升級前就開著的 Claude Code session 還會呼叫舊的 hook 路徑;重開後可以刪)。這兩個你若改過,會回報衝突、什麼都不寫;
   - 修補 `package.json` scripts、`.claude/settings.json` hooks、`.gitignore`、`.mcp.json`、`cucumber.js`;
   - 改寫 `AGENTS.md`、`AUTONOMY.md`、`CLAUDE.md` 和範本 README 裡 dp 寫過的形式(`` `dp` ``、`dp status` 這類指令、`dp_*` 工具),你自己文字裡的 dp 不動;
   - 全部做成一個 commit。
4. **還沒升級的專案照樣能用**:新的 MCP 會去跑該專案自己的 `tools/dp.mjs`。
5. **歷史不動**:舊事件的 actor `dp-cli` 仍然有效;舊的 `dp-archive/*` tag 和 `dp/*` 分支保留。

# 從 v4.6 升級到 v4.7

dag、ledger、`dlm.config.json` 的格式不變。每個專案在專案裡跑 `node <新版 dlm>/tools/dlm.mjs upgrade`(或從 MCP 呼叫 `dlm_upgrade_project`)。

1. **MCP 改成這台電腦一個**:從 dev-loop-mcp 的目錄跑 `node tools/dlm.mjs mcp install`(裝進 Claude Code 的 user scope)。
   v4.6 寫在專案 `.mcp.json` 的 `dlm`(`node tools/dlm.mjs mcp`)還能用,但兩個都在時 Claude Code 會看到兩組;建議把專案 `.mcp.json` 的 `dlm` 那段刪掉。
2. **MCP 工具名改了**(跟 HTTP API 同一份定義):`dlm_status` → `dlm_get_project`、`dlm_inbox` → `dlm_get_inbox`、`dlm_show` 不變、
   `dlm_intake_feature` → `dlm_propose_feature`、`dlm_intake_bundle` → `dlm_propose_bundle`、`dlm_accounts` → `dlm_list_accounts`、
   `dlm_use_accounts` → `dlm_set_role`、`dlm_dashboard` → `dlm_get_dashboard`;`dlm_decide`、`dlm_confirm`、`dlm_halt`、`dlm_resume`、`dlm_unblock`、`dlm_tick`、`dlm_doctor` 不變。
   全部列表:`dlm mcp tools` 或 `docs/dlm/API.md`。每個工具多一個 `project` 參數(在專案目錄啟動時可省略)。
3. **舊專案登記到清單**:`dlm project add <目錄>`(在 MCP 裡給專案的絕對路徑也會自動登記)。hub 與 MCP 對 4.7 以前的專案回 501,升級後就好。
4. **帳號紀錄**:4.6 的用量只算在各專案的帳本裡;4.7 起另外寫一份到 `~/.config/dlm/account-log.jsonl`,升級前的派工不會補進去(冷卻最多 5 小時,影響很小)。
5. `DLM_ACCOUNTS_FILE` 照舊有效;新的 `DLM_CONFIG_DIR` 會把帳號、專案清單、帳號紀錄、hub token 一起搬到別的目錄。

# 從 v4.5 升級到 v4.6(含 4.6.1)

dag、ledger 格式不變,新欄位都是選填。`node <新版 dlm>/tools/dlm.mjs upgrade` 即可;沒設 `agents.<角色>.accounts` 時行為跟 4.5 一樣。
要用多個訂閱帳號:`dlm account add` → `dlm account login` → `dlm account use`(見 docs/dlm/AGENTS-SETUP.md)。
要讓 Claude Code 透過 MCP 呼叫 dlm:`node tools/dlm.mjs mcp install`,重開 Claude Code。

# 從 v4.4 升級到 v4.5

dag、ledger 格式不變;新欄位都是選填。`node <新版 dlm>/tools/dlm.mjs upgrade` 即可,新專案預設 `project.mode = greenfield`,行為跟 4.4 一樣。
既有專案想改用 brownfield 規則:重跑 `dlm setup` 第一題選 Brownfield,再 `dlm onboard`。

# 從 v4.0 升級到 v4.1

v4.1 只拿掉功能(見 CHANGELOG 4.1.0),dag、ledger 格式不變。

1. 先停背景迴圈(`node tools/dlm.mjs halt --reason "升級"`)。
2. `node <新版 dlm>/tools/dlm.mjs upgrade`。會刪掉 `.agents/skills/`、`prompts/manager.md`、三支用不到的 gate 與 `scripts/py/`、`scripts/hooks/`。
3. `node tools/dlm.mjs doctor`:`dlm.config.json` 裡已移除的設定會逐條列出。讀的時候已經略過,照提醒刪掉就好。
   要特別看的兩項:
   - 原本 `sandbox.backend` 是 docker / podman / srt:現在 worker 直接在你的電腦上執行。不接受的話先留在 4.0。
   - 原本 Verifier 是 `backend: http`(Ollama):現在是停用狀態。重跑 `dlm setup` 選 Claude Haiku,或自己接 `cmd`。
4. 你的 `package.json`(seed 檔,upgrade 不動)如果有 `check:doc-rot`、`check:known-defects`、`lint:docs`,
   它們指到的檔已經刪了;沒放進 `gates.chain` 就不影響,想乾淨就刪掉那三行。
5. `dlm resume`。

# 從 v3 升級到 v4

資料格式(dag、ledger)向下相容,不用遷移資料。

1. 先停背景迴圈(`node tools/dlm.mjs halt --reason "升級"`,確認 `dlm status` 沒有在跑的 worker)。
2. 在專案裡跑 `node <新版 dlm>/tools/dlm.mjs upgrade`(tools、規則、skills、prompts、docs/dlm 換成 v4 版)。
3. **換 `cucumber.js`**(它是你的檔,upgrade 不會動):把新版 `payload/cucumber.js` 複製過來。
   你改過 `import`、`tags`、`format` 的話保留你的值,只換掉 `paths` 那段與檔頭的 import。不換的話,兩個以上節點同時在做時全 gate 會互相卡死;
   `dlm doctor` 會提醒。
4. 重跑 `node tools/dlm.mjs setup`:Critic 還是 v3 預設的話會換成有唯讀工具的版本;沒有 Ollama 可以改選 Claude Haiku 當 Verifier。
5. 選用:`dlm.config.json` 加 `"notify": { "cmd": "…" }`(通知)、`"integration": { "gate_next_version": false }`(不想等試用就開下一版)、
   `"caps": { "test_reopens": 2 }`。
6. `node tools/dlm.mjs doctor`,然後 `dlm resume`。

已經在 DAG 裡的節點沒有 `release` 欄位,照舊運作;之後用 `dlm intake bundle` 提的新版本才有版本閘門。
要讓下一版等某個舊的整合點,在 bundle 的節點 `depends_on` 手動寫上它。

# 從 v2 升級到 v3

v3 只改預設值與 Front 的權限,資料格式(dag、ledger、事件)不變。

1. 在專案裡跑 `node <新版 dlm>/tools/dlm.mjs upgrade`(規則、skills、docs/dlm 會換成 v3 版)。
2. 你的 `dlm.config.json` 是你的檔,升級不會改。v2 範本裡明寫了 `"auth": { "mode": "signed" }`,要用 v3 的寬鬆授權請改成 `"trust"`。
3. 重跑 `node tools/dlm.mjs setup`:如果 worker 指令還是 v2 預設(只有 `acceptEdits`),它會換成跑得了指令的新寫法。
4. 跑 `node tools/dlm.mjs doctor` 確認。

想維持 v2 的嚴格程度,在 `dlm.config.json` 加:

```json
"front": { "guard": "strict" },
"auth": { "mode": "signed", "window_minutes": 30 },
"sandbox": { "allow_unsandboxed_autonomy": false }
```

# 從 v1 遷移

v4.1 拿掉了 `dlm migrate-v1`。還有 v1 專案要搬:先用 4.0.0 的 dlm 照它的 MIGRATION.md 遷移,再升級到 4.1。

# 從 v4.6 升級到 v4.7

dag、ledger、`dp.config.json` 的格式不變。每個專案在專案裡跑 `node <新版 dp>/tools/dp.mjs upgrade`(或從 MCP 呼叫 `dp_upgrade_project`)。

1. **MCP 改成這台電腦一個**:從 dev-paradigm-mcp 的目錄跑 `node tools/dp.mjs mcp install`(裝進 Claude Code 的 user scope)。
   v4.6 寫在專案 `.mcp.json` 的 `dp`(`node tools/dp.mjs mcp`)還能用,但兩個都在時 Claude Code 會看到兩組;建議把專案 `.mcp.json` 的 `dp` 那段刪掉。
2. **MCP 工具名改了**(跟 HTTP API 同一份定義):`dp_status` → `dp_get_project`、`dp_inbox` → `dp_get_inbox`、`dp_show` 不變、
   `dp_intake_feature` → `dp_propose_feature`、`dp_intake_bundle` → `dp_propose_bundle`、`dp_accounts` → `dp_list_accounts`、
   `dp_use_accounts` → `dp_set_role`、`dp_dashboard` → `dp_get_dashboard`;`dp_decide`、`dp_confirm`、`dp_halt`、`dp_resume`、`dp_unblock`、`dp_tick`、`dp_doctor` 不變。
   全部列表:`dp mcp tools` 或 `docs/dp/API.md`。每個工具多一個 `project` 參數(在專案目錄啟動時可省略)。
3. **舊專案登記到清單**:`dp project add <目錄>`(在 MCP 裡給專案的絕對路徑也會自動登記)。hub 與 MCP 對 4.7 以前的專案回 501,升級後就好。
4. **帳號紀錄**:4.6 的用量只算在各專案的帳本裡;4.7 起另外寫一份到 `~/.config/dp/account-log.jsonl`,升級前的派工不會補進去(冷卻最多 5 小時,影響很小)。
5. `DP_ACCOUNTS_FILE` 照舊有效;新的 `DP_CONFIG_DIR` 會把帳號、專案清單、帳號紀錄、hub token 一起搬到別的目錄。

# 從 v4.5 升級到 v4.6(含 4.6.1)

dag、ledger 格式不變,新欄位都是選填。`node <新版 dp>/tools/dp.mjs upgrade` 即可;沒設 `agents.<角色>.accounts` 時行為跟 4.5 一樣。
要用多個訂閱帳號:`dp account add` → `dp account login` → `dp account use`(見 docs/dp/AGENTS-SETUP.md)。
要讓 Claude Code 透過 MCP 呼叫 dp:`node tools/dp.mjs mcp install`,重開 Claude Code。

# 從 v4.4 升級到 v4.5

dag、ledger 格式不變;新欄位都是選填。`node <新版 dp>/tools/dp.mjs upgrade` 即可,新專案預設 `project.mode = greenfield`,行為跟 4.4 一樣。
既有專案想改用 brownfield 規則:重跑 `dp setup` 第一題選 Brownfield,再 `dp onboard`。

# 從 v4.0 升級到 v4.1

v4.1 只拿掉功能(見 CHANGELOG 4.1.0),dag、ledger 格式不變。

1. 先停背景迴圈(`node tools/dp.mjs halt --reason "升級"`)。
2. `node <新版 dp>/tools/dp.mjs upgrade`。會刪掉 `.agents/skills/`、`prompts/manager.md`、三支用不到的 gate 與 `scripts/py/`、`scripts/hooks/`。
3. `node tools/dp.mjs doctor`:`dp.config.json` 裡已移除的設定會逐條列出。讀的時候已經略過,照提醒刪掉就好。
   要特別看的兩項:
   - 原本 `sandbox.backend` 是 docker / podman / srt:現在 worker 直接在你的電腦上執行。不接受的話先留在 4.0。
   - 原本 Verifier 是 `backend: http`(Ollama):現在是停用狀態。重跑 `dp setup` 選 Claude Haiku,或自己接 `cmd`。
4. 你的 `package.json`(seed 檔,upgrade 不動)如果有 `check:doc-rot`、`check:known-defects`、`lint:docs`,
   它們指到的檔已經刪了;沒放進 `gates.chain` 就不影響,想乾淨就刪掉那三行。
5. `dp resume`。

# 從 v3 升級到 v4

資料格式(dag、ledger)向下相容,不用遷移資料。

1. 先停背景迴圈(`node tools/dp.mjs halt --reason "升級"`,確認 `dp status` 沒有在跑的 worker)。
2. 在專案裡跑 `node <新版 dp>/tools/dp.mjs upgrade`(tools、規則、skills、prompts、docs/dp 換成 v4 版)。
3. **換 `cucumber.js`**(它是你的檔,upgrade 不會動):把新版 `payload/cucumber.js` 複製過來。
   你改過 `import`、`tags`、`format` 的話保留你的值,只換掉 `paths` 那段與檔頭的 import。不換的話,兩個以上節點同時在做時全 gate 會互相卡死;
   `dp doctor` 會提醒。
4. 重跑 `node tools/dp.mjs setup`:Critic 還是 v3 預設的話會換成有唯讀工具的版本;沒有 Ollama 可以改選 Claude Haiku 當 Verifier。
5. 選用:`dp.config.json` 加 `"notify": { "cmd": "…" }`(通知)、`"integration": { "gate_next_version": false }`(不想等試用就開下一版)、
   `"caps": { "test_reopens": 2 }`。
6. `node tools/dp.mjs doctor`,然後 `dp resume`。

已經在 DAG 裡的節點沒有 `release` 欄位,照舊運作;之後用 `dp intake bundle` 提的新版本才有版本閘門。
要讓下一版等某個舊的整合點,在 bundle 的節點 `depends_on` 手動寫上它。

# 從 v2 升級到 v3

v3 只改預設值與 Front 的權限,資料格式(dag、ledger、事件)不變。

1. 在專案裡跑 `node <新版 dp>/tools/dp.mjs upgrade`(規則、skills、docs/dp 會換成 v3 版)。
2. 你的 `dp.config.json` 是你的檔,升級不會改。v2 範本裡明寫了 `"auth": { "mode": "signed" }`,要用 v3 的寬鬆授權請改成 `"trust"`。
3. 重跑 `node tools/dp.mjs setup`:如果 worker 指令還是 v2 預設(只有 `acceptEdits`),它會換成跑得了指令的新寫法。
4. 跑 `node tools/dp.mjs doctor` 確認。

想維持 v2 的嚴格程度,在 `dp.config.json` 加:

```json
"front": { "guard": "strict" },
"auth": { "mode": "signed", "window_minutes": 30 },
"sandbox": { "allow_unsandboxed_autonomy": false }
```

# 從 v1 遷移

v4.1 拿掉了 `dp migrate-v1`。還有 v1 專案要搬:先用 4.0.0 的 dp 照它的 MIGRATION.md 遷移,再升級到 4.1。

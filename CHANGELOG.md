# CHANGELOG(dev-paradigm-mcp,4.7.1 以前叫 dev-paradigm)

v1(1.0 – 1.11.0)的紀錄在 4.0.0 以前的 `docs/reference/v1/CHANGELOG-v1.md`(git 歷史)。

## 4.7.3 — MCP 看得到提案的格式、dp_health 能用

- **提案的欄位寫進工具的 schema**(PR #1,hermes-rsi 用 agent 操作 MCP 時發現;這一版合併了它,再加上底下幾點):
  `dp_propose_feature` 的 `spec`、`dp_propose_bundle` 的 `bundle` 以前只宣告 `type: object`,
  只看得到 MCP 的 AI 讀不到 `docs/dp/INTAKE.md`,猜不出格式(實測第一次呼叫把 spec 當字串送,被擋:`body.spec: 型別應為 object,實際是 string`)。
  現在每個欄位的型別與限制直接取自 `schemas.mjs` 的 `nodeSchema`(格式仍然只定義在那一處),`api.mjs` 只補說明與範例;
  bundle 列出 `release`、`goal`、`roadmap`、`no_integration_reason`、`nodes[]`(節點欄位 + `gherkin_text`、`gherkin_file`)。
  只有 `enum` 的欄位補上 `type: string`(有些工具呼叫格式要求每個欄位都有 type)。格式錯了在呼叫時就回 400,並指出是哪一個欄位
  (例 `body.bundle.nodes[0].kind`),不用等到 intake 才失敗。PR #1 刻意不加 `additionalProperties: false`;這裡加了:
  不認識的節點欄位本來就會被 intake 的 nodeSchema 擋下,現在只是提早在呼叫時擋,原本能過的提案照樣能過。
- `docs/dp/API.md` 的參數表往下展開物件與物件陣列(`spec.id`、`bundle.nodes[].gherkin_text`…),必填照各層的 required。
  `API.md`、`openapi.json`、`FLOW.md` 用 `dp api` 重產。
- **`dp_health` 從 MCP 呼叫一律失敗**(`health 不能這樣呼叫`):它列在工具裡,但只有 hub 會處理。現在 hub 與 MCP 共用同一個 `health()`。
- **`owns` 在提案的 schema 標成必填、至少一個**:nodeSchema 沒要求,但 `validateDag` 要求每個節點(含整合點)都要有,提案一定會進 DAG。
  實跑時只看得到 MCP 的 AI 第一次提案,整合點沒寫 owns,到 intake 才被擋;現在呼叫時就回 `body.bundle.nodes[2]: 缺必填欄位 owns`。
- **帳號模式的 Verifier 模型被丟掉**:`dp account use verifier <帳號> --model haiku`(或 `dp_set_role`)寫進 `agents.verifier.model`,
  但讀設定時被當成 v4.1 拿掉的 Ollama 設定刪掉,doctor 還警告「http(Ollama)模式已移除」;結果 Verifier 永遠用預設模型(Claude 是 haiku,
  Codex 沒有預設就不帶模型)。現在只有舊的 http 設定(`backend: "http"` 或有 `url`)才把 `model` 當成已移除的設定。
- **新專案的節點把程式放在範本版面以外會被提醒**:範本的 `npm test`(vitest)只跑 `packages/**/*.test.ts`、`apps/**/*.test.ts`,
  mutation 也只測 `packages/*/src`。實跑時只看得到 MCP 的 AI 讀不到 intake skill 的範例,把程式放 `src/todo/**`、`bin/todo.mjs`(.mjs + `node --test`):
  合併 gate 的 `test` 是 0 個測試照樣綠(gherkin 的 accept 仍然有跑),mutation 測不到東西每次都 ABSTAIN,每一棒都要問使用者。
  現在 phase 節點的 owns 完全在 `package.json` 的 workspaces 以外時,`dp_propose_*` / `dp intake` 的結果帶 `warnings`,
  決定請求的 reason 也寫上(收件匣看得到);提案照樣建立,不擋。既有專案不檢查。`owns` 的說明與 schema 的範例也改成範本的版面(`packages/<能力>/**`、`apps/<名稱>/**`)。
- **改自治等級、預算、同時幾個 worker 有自己的操作**:`dp settings --autonomy 2 --budget 8 --parallel 3 --verbatim "…"`,
  API `PATCH /api/v1/projects/{project}/settings`,MCP `dp_set_settings`(路由表 41 個操作、MCP 38 個工具)。只改有給的那幾項,
  改 `dp.config.json` 並 commit,commit 訊息帶使用者原話;跟 decide 一樣只轉達使用者親口說的。L2 沒設 Critic 時回提醒。
  實跑時使用者說「預算提高到每天 $8」,只看得到 MCP 的 AI 沒有工具可用:讀了 setup.mjs、停背景迴圈、重跑 `dp_setup_project`,
  worker 的帳號被換成固定指令,再用 `dp_set_role` 改回來。流程(`dp_flow`)的「建專案」多一步:之後要改就用 setSettings,不要重跑 setup。
- **重跑 setup 不再把 worker 的帳號換成固定指令**:worker 已經用帳號(沒有自己的 cmd)時,worker_cmd 的預設是「維持用帳號那個 CLI 的預設指令」;
  明確給了 worker_cmd 才換。
- **整合點的驗收在動手前就是綠的,可以跳過測試棒**:能力節點已經把整合 gherkin 全部做到時(例:命令列入口放在能力節點裡,
  整合 gherkin 又沿用能力的句子),整合點的測試棒只能造假才紅得了。誠實的 worker 回報卡住,重試也一樣,這一版永遠到不了試用。
  現在 dp 在那一棒的樹上(用完即丟的副本)自己重跑驗收,exit 0 才在卡住的決定請求多一個選項 `skip`(並建議它);
  使用者選了,套用前再重跑一次,還是綠的才記 `leg_done`,接著跑整合棒,合併後照常請使用者試用。只限整合點的測試棒
  (能力節點一開始就綠,代表 gherkin 沒寫到新東西,該改規格)。實跑:todo-cli 的 I1。
  接著的整合棒也一樣沒東西可接:**整合棒沒有檔案變動不再算 paths 失敗**(驗收照樣要綠)。實跑時整合棒誠實地什麼都沒改,
  被「這一棒沒有任何檔案變動」退回一次,再派又回報卡住;其他棒沒有變動照舊是失敗。
- **整合點的 gherkin 沿用能力的句子會被提醒**:跟這份提案裡其他節點、主線 `features/` 底下已有的 gherkin 比,一字不差的句子列出幾句、舉一句例子,
  說明為什麼測試棒會做不出紅燈、該怎麼寫。intake skill 本來就有這條規則,現在也寫進 `dp_propose_bundle` 的說明。
- **既有專案(已經有 git)裝 dp 後,dp 的檔沒進 git → 每個實作棒都過不了全 gate**:`dp init --existing`(和 MCP 的 `dp_init_project` existing)
  只在自己建 git 時 commit;已經有 git 的專案什麼都不 commit,之後 setup、onboard 也只 commit 自己寫的那幾個檔,`tools/`、`AGENTS.md`、`.claude/` 一直是 untracked。
  合併前的全 gate 在從 git 建的「main + 分支」臨時樹裡跑 `node tools/dp.mjs check`,找不到 dp,exit 1、沒有輸出;實作棒連續 3 次被退回後封鎖。
  doctor 只看 tracked 的檔,說「乾淨」。測試裡的既有專案一直是 init 之後手動 `git add -A && git commit`,所以沒抓到。實跑:wordfreq 的 top/v1。
  現在:init 在已經有 git 的專案把 dp 的檔 commit(`dp init --existing`,只 commit 這些路徑,使用者 staged 的東西不動;`--no-commit` 可以不 commit),
  既有的 `.gitignore` 補上 `.dp/` 與 `*.tmp-*`;**`dp upgrade` 會把 dp 的檔 commit**,連同 dp 規劃的檔裡還沒進 git 的(修好 4.7.3 以前裝的專案;
  MCP 是 `dp_upgrade_project`)。以前升級完留在工作目錄,tick 拒絕執行,從 MCP 升級的 AI 沒有 git 可用,只能請使用者自己 commit(實測漏了 `.dp-install.json`)。
  doctor 多一項「dp 的檔」:沒進 git 就 ✗,修法是 `dp upgrade`。
- **主控台沒有軟體在開發時,一打開是規劃頁(Front · intake)**:沒有節點在施工、驗收、卡住、退避、可以派工,也沒有等合併 / 卡住 / 子節點的決定時,
  `dashboardData` 的 `initial_view` 是 `planning`(另有 `building`),否則是 `console`。頁面照它開第一頁,不再記住上次看的頁;
  舊版 dp 的專案沒有這個欄位,頁面用看得到的資料估。hub 點「開主控台」也一樣。
- **改提案用 `supersedes` 取代還沒決定的舊提案**:`dp_propose_feature` / `dp_propose_bundle` 多一個參數 `supersedes`(例 `["p-001"]`,
  指令是 `dp intake … --supersedes p-001`)。新的決定請求記下它取代誰;被取代的不再待決(收件匣、主控台都不列)、`decide` 會拒絕並指出該決定哪一份,
  規劃頁標成「已被 p-002 取代」。只能取代還沒決定的。沒帶 `supersedes`、但還在等決定的舊提案有同樣的節點時,提案結果帶提醒。
  實跑(minilang,Sonnet 5.5 當 Front):AI 發現第一份提案的 gherkin 欄位算錯,重提一份後只能請使用者「忽略」舊的;
  兩份都被批准的話,先寫進 DAG 的是舊的(錯的)那份。事件格式只多一個選填欄位 `decision_request.supersedes`,舊帳本照樣重播。
- **mutation 找不到相關的單元測試時分清楚**:Stryker(vitest.related)找不到 import 改到的檔的單元測試,會印「No tests were executed」、exit 1,
  以前一律 ABSTAIN(「沒產生可讀的報告」),每次都升級問使用者。現在整合棒是 SKIPPED:命令列等組合層本來就用子程序從外面測、
  由整合驗收把關;其他棒照舊 ABSTAIN,但說明是「沒有任何單元測試直接 import 改到的檔」。實跑:minilang 的 I1(apps/cli)。
- 新測試 12 個,加上 PR #1 的 1 個。`npm test` 183 個全部通過(4.7.2 是 171 個)。

## 4.7.2 — 改名 dev-paradigm-mcp

- 專案改名 dev-paradigm-mcp(package.json、README、`dp --help`、MCP 的 serverInfo、OpenAPI 標題、主控台左上角)。打包的資料夾也叫 `dev-paradigm-mcp/`。
- 沒改的:指令還是 `dp`(`node tools/dp.mjs …`),`dp mcp install` 註冊的 server 名稱還是 `dp`,工具還是 `dp_` 開頭,
  `~/.config/dp/`、`dp.config.json`、`.dp/` 都一樣。已經裝好的專案與 MCP 設定不用動;要讓 Claude Code 指到新的資料夾就從新資料夾再跑一次 `dp mcp install`。
- 功能跟 4.7.1 一樣。

## 4.7.1 — 修好一直失敗的「worker 不碰 .git」測試

- 那個測試從 v4 起一直紅,之前寫成「測試環境的問題」,其實是測試用的假 worker 有 bug,dp 本身沒問題:
  假 worker 在副本裡建了 `.git/hooks/post-merge`,接著看到有 `.git` 就跑 `git add`。dp 給 worker 設了 `GIT_CEILING_DIRECTORIES`
  (git 不准往上找到專案本身的 repo),所以 git 說「不是 repo」,假 worker 當掉、沒交 report,dp 根本沒機會檢查 `.git/hooks`。
  沒有 ceiling 的話,git 會往上找到專案的 repo 把東西 commit 進去,所以 ceiling 加上之前這個測試是綠的。
- 修法:假 worker 只在 `.git/HEAD` 存在(真的是 repo)時才 commit。現在這個測試證明:worker 寫 `.git/hooks` → sandbox-escape 退回、hook 沒進 worktree。
- `npm test` 171 個全部通過。

## 4.7.0 — MCP server 當主要入口、多專案監控、完整 API

- **一張路由表,三個入口**:`tools/lib/api.mjs` 定義 40 個操作(路徑、方法、參數 schema、說明)。`dp hub` 的 HTTP API(`/api/v1`)、
  OpenAPI 3.1(`/api/v1/openapi.json`)、MCP 工具(`dp_` + operationId,例 `dp_get_inbox`、`dp_propose_bundle`、`dp_start_loop`)、
  `dp op <操作>` 都從它來;參數先照 schema 檢查,錯了回 400 並說哪一個。`dp api md|openapi|flow` 產生文件,
  `docs/dp/API.md`、`openapi.json`、`FLOW.md` 就是這樣來的,測試會比對,改了表忘了重產會紅。
- **流程定義**:`tools/lib/flow.mjs` 寫下建專案 → 帳號 → 規劃一版 → 施工 → 監控與回答 → 試用與下一版 → 暫停與恢復,
  每一步誰做(使用者 / AI / dp)、呼叫哪個操作。`GET /api/v1/flow`、MCP 的 `dp_flow`、initialize 的 instructions、
  四個 MCP prompts(`new-project`、`existing-project`、`progress`、`next-release`)都用這一份。
- **MCP server 這台電腦一個**:`dp mcp install` 一行裝進 Claude Code(`claude mcp add --scope user`;`--client cursor|codex|project`),
  在任何目錄開都能用,管所有登記的專案;在 dp 專案目錄裡啟動時 `project` 可以省略,給絕對路徑會自動登記。
  可以從 MCP 建專案(`dp_init_project`)、不互動設定(`dp_setup_project`,answers 對應 setup 的每一題)、升級(`dp_upgrade_project`)。
  同時處理多個呼叫(tick、setup 跑很久也不會卡住其他工具)。worker / Critic 仍然不能用。v4.6 的 15 個工具名改了,見 MIGRATION。
- **專案清單**:`dp project add|list|rm`,存在 `~/.config/dp/projects.json`;`dp init` 建的自動登記。
- **`dp hub`**(預設 http://127.0.0.1:7170):所有專案的總覽頁(進度、在跑的節點 · 棒 · 帳號、等你幾件、停機、背景迴圈開關、
  有事的排前面;帳號用量與冷卻;所有專案的即時事件,打開時先補最近 30 筆;等你的事變多時瀏覽器通知),點進去是原本的四欄主控台。
  API 的串流端點是 SSE(`event: ledger`,不含簽章欄位)。只綁 127.0.0.1、檢查 Host 與 Origin、`/api/*` 要 token(`dp hub token`)。
- **專案操作在專案自己的 dp 裡跑**:hub 與 MCP 對專案的操作都是在那個專案執行 `node tools/dp.mjs op <名稱>`(stdin JSON → stdout JSON),
  專案的 dp 版本跟 hub 不同也不會讀錯格式;4.7 以前的專案回 501 並說要升級。讀的操作有快取(帳本、設定、dag、帳號紀錄都沒變就不重算)。
- **帳號跨專案共用**:派工、結束、額度用完的冷卻、花費寫進 `~/.config/dp/account-log.jsonl`(7 天,超過 2MB 就修剪),
  每個專案選號時看所有專案加起來的用量;專案 A 把帳號用到冷卻,專案 B 也會跳過它。
  新設定 `max_parallel`(`dp account add|set --max-parallel N`):所有專案加起來同時最多幾個 worker 用這個帳號,滿了換下一個,全滿這輪不派。
- **背景迴圈可以從外面停**:`dp run --stop`(API `loop/stop`)寫 `.dp/run.stop`,迴圈這一輪做完就結束,不會在合併到一半時被砍;
  `loop/start` 等到迴圈真的拿到鎖才回,緊接著再啟動一次一定是 409。
- `dp inbox` 的資料版(`inboxData`)給 API 用:決定項目、待試用、上次看之後的統計都是結構化欄位。
- `dp setup` 不再寫 `.mcp.json`,改成提示 `dp mcp install`(專案層級要的話 `dp mcp install --client project`)。
- 實跑:Claude Code(不在任何專案目錄)只靠 MCP 建 notes-app、設定、提出 v1(一個能力節點 + 一個整合點),使用者說「好,批准」後它照抄原話
  `dp_decide`、`dp_start_loop`;真的 Claude worker 施工,問「進度?」它用 `dp_overview` + `dp_get_inbox` 轉述待合併的事,使用者說合併才 decide。
  hub 同時監控兩個專案。實跑中修的:使用者說「這版可以了,幫我停掉迴圈」時 AI 只停了迴圈、沒記試用結果 → instructions 與 `dp_confirm`
  說明補上「說試過了就是試用結果、一句話裡每件事都要處理」,重跑後正確;Front 規則超過 6000 bytes(`check:dp` 的 rule-size 擋下)→ 精簡;
  背景迴圈剛啟動時再啟動一次會成功(還沒拿到鎖)→ 等到拿到鎖才回;hub 的即時事件打開時是空的 → 先補最近 30 筆。

## 4.6.1 — 在主控台設定帳號

- `dp dashboard --serve` 多一頁「帳號」:新增 / 移除這台電腦的訂閱帳號,勾選每個角色(worker、Critic、Verifier)輪流用哪幾個、填模型,按儲存。
  每個動作就是跑一次 `dp account …`(設定一樣會 commit),顯示它印的結果;每個帳號的登入狀態、近 5 小時派工、冷卻到幾點也在這頁。
  登入要開瀏覽器,頁面只給你要在終端機跑的那行指令。用 `dp dashboard` 寫出來的單一 HTML 檔只能看、不能改。
- 這是主控台唯一能寫的地方:`POST /api/account` 只收 127.0.0.1 / localhost 的 Host 與 Origin、要帶這次啟動才產生的 token(換一次 `--serve` 就換一個)、
  只收 JSON,每個值先檢查過、不經 shell。決定、批准、合併仍然只能在 Front 或 `dp decide`。
- `dp account use <角色> none` 拿掉這個角色的帳號(worker 沒有 cmd 時拒絕;Verifier 會關掉),`--model none` 拿掉模型。
- 新測試 3 個(argv 檢查、token / Origin / Content-Type 擋下、帶對 token 改設定並 commit)。

## 4.6.0 — 多個訂閱帳號、MCP

參考 Orca 的帳號切換做的,只做 dp 用得到的部分。沒有搬 Orca 的終端機、瀏覽器、模擬器控制。

- **帳號池**:`dp account add <name> --cli claude|codex [--plan max]` 在這台電腦登記一個帳號(`~/.config/dp/accounts.json`,
  `DP_ACCOUNTS_FILE` 可改,不進 repo)。每個帳號一個獨立的登入目錄(Claude Code 用 `CLAUDE_CONFIG_DIR`、Codex 用 `CODEX_HOME`),
  `dp account login <name>` 在那個目錄登入一次。`dp account list` 看登入狀態、這個專案近 5 小時 / 7 天的派工與花費、冷卻到幾點、哪個角色在用。
- **每個角色配帳號**:`dp account use worker max-a,max-b [--model sonnet]` 寫進 `agents.<角色>.accounts` / `model` 並 commit。
  worker、Critic、Verifier 各自設定。沒自己寫 `cmd` 時用那個 CLI 的預設指令;有寫就照你的指令跑,只帶上帳號的環境變數。
  派工時會清掉 shell 裡的 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`(Codex 是 `OPENAI_API_KEY`、`CODEX_API_KEY`),
  否則每個帳號都會變成同一把金鑰。
- **輪流與限流換號**:每一棒從 pool 挑沒在冷卻、近 5 小時派得最少的帳號。worker 的 log 出現額度用完(`usage limit reached|<時間>`、
  `resets 3pm`、429 等)→ 那個帳號冷卻到重置時間(看不出來就 `caps.account_cooldown_minutes`,預設 30),馬上換下一個帳號重派,
  不算嘗試次數、不算連續 infra 失敗。全部都在冷卻就這輪不派。交件成功會提早解除冷卻。帳號沒登入時停機,並說要跑哪一個 `dp account login`。
- 額度用完的訊息(`usage limit reached`、`weekly limit`)以前會被當成 worker 自己的失敗,算一次嘗試;現在算基礎設施失敗。
- **`dp mcp`**:stdio MCP server(JSON-RPC 2.0,零依賴),Claude Code、Codex、Cursor 等工具都能呼叫。工具有 dp_status、dp_inbox、dp_show、
  dp_decide、dp_confirm、dp_intake_feature、dp_intake_bundle、dp_halt、dp_resume、dp_unblock、dp_tick、dp_doctor、dp_accounts、dp_use_accounts、dp_dashboard。
  每個工具就是跑一次對應的 `dp` 指令,沒有第二套邏輯。`dp mcp install`(Claude Code 平台的 `dp setup` 也會)把它寫進專案的 `.mcp.json`。
  worker 的副本沒有 `.mcp.json`;`DP_ROLE` 有值或在 `.dp/` 底下時拒絕啟動,worker 跟 Critic 不能替你 decide。
- `dp doctor` 對每個用到的帳號檢查:這台電腦有沒有登記、CLI 有沒有裝、登入了沒。
- 主控台花費頁多一張「訂閱帳號」表:CLI · 方案、角色、近 5 小時 / 7 天的派工、花費、冷卻狀態。
- 新測試 `test/accounts-mcp.test.mjs`(13 個):選號、重置時間、用量、環境變數清除、A 額度用完自動改派 B、單一帳號照舊退避、
  `dp account` 指令、MCP 協定與 stdio 實跑。

## 4.5.0 — 既有專案(brownfield)

- **模式開關**:`dp setup` 第一題問 Greenfield / Brownfield(偵測到既有程式就預設 Brownfield),寫進 `dp.config.json` 的
  `project.mode` 與 `project.language`。主控台規劃頁右上角顯示模式,brownfield 另有一行測試基線與 AS-IS 狀態;路線圖的 v0「現況」算已完成。
- **gate 對應既有專案的測試指令**:新設定 `gates.commands`(chain 名字 → 指令)。setup 偵測 `package.json` 的 test、pytest、
  unittest、`go test`、`cargo test`、`make test`;專案沒有的 typecheck / accept 不放進 chain,沒裝 cucumber / stryker 就關掉 dry-run 與 mutation。
  `check:dp` 沒有 npm script 時直接叫 `node tools/dp.mjs check`。測試框架那一段(例 `python3 -m unittest`)自動加進證據重跑白名單。
- **測試基線**:`dp baseline` 在主線的乾淨副本跑一次專案的 gate,把失敗的測試名稱記進 `docs/dp-baseline.json`(worker 改不到)。
  合併 gate 紅了但失敗的全都在基線裡 → 算通過(主控台 ≈);有基線以外的新紅就擋,並列出是哪幾個。
  看得懂 pytest、unittest、go test、cargo test、node --test、vitest、jest、cucumber 的輸出;看不懂的一律當紅。`dp doctor` 會提醒沒記基線。
- **characterize 棒**:brownfield 模式下,節點的 `owns` 涵蓋主線上已有的程式檔時,intake 自動加
  `characterize: { targets, tests, cmd }`,pipeline 前面多一棒。這一棒只能寫 `tests`、不能碰 owns 與 targets,`cmd` 必須在現在的程式上綠;
  之後的棒都不准改這些測試,實作棒的驗收多一條「`cmd` 仍然綠」。一次最多 10 個檔(owns 寫太大會被擋),`characterize.skip` 可以不釘。
  沿用 v4.0 backfill 的想法,但只用在要改的地方,不替整個專案補測試。
- **`brownfield-onboard` skill**(Front 用一次)+ `dp onboard`:基線、`docs/AS-IS.md` 草稿(語言、測試指令、進入點、目錄、基線;
  模組與已知的坑留給 Front 讀程式後補)、`docs/ROADMAP.md` 的 v0;已經有的檔不覆蓋。
- intake 的 brownfield 規則:專案沒有 `accept` script 時,節點一定要寫 `accept`(專案的測試指令只跑這個節點的測試);新欄位 `tests`(節點的測試檔 glob)。
- `dp init --existing` 遇到已經有程式的專案,不裝範本的 TypeScript 工具鏈(package.json、tsconfig、vitest / cucumber / stryker 設定、
  `scripts/*.ts`、`features/steps/*.ts`);`.dp-install.json` 記 `profile: existing`,`dp upgrade` 也不會補裝。
- worker 副本裡的 `__pycache__`、`.pytest_cache` 等測試快取不算變動(Python 專案每一棒都被判寫到範圍外,自動測試抓到的)。
- 沒有拿回 hard / soft 匯入(intake import)。
- 實跑:budgetbook 的程式(拿掉 dp 帳本)當既有專案,加「匯出 CSV」:characterize(11 個測試)→ test → dev,0 次退回,約 5 分鐘、$0.42,
  合併後 75 個測試全綠。觀察到一件事:characterize 釘住了用法說明的原文,所以實作棒沒有把 export 加進用法說明。
  想改既有的訊息時,要寫進 gherkin(見 brownfield-onboard)。
- 新測試 `test/brownfield.test.mjs`(10 個,Python unittest 專案:基線、characterize 擋下改壞現況、基線以外的新紅擋合併、從提案到合併)。

## 4.4.0 — 主控台加規劃頁

- 新的「規劃」頁(仿 demo 的 Planning Steward):左邊把帳本裡的規劃對話照時間排成聊天——Front 的提案(節點、owns、可展開的 gherkin、
  選項與建議)、你的回答原話、寫進 DAG、請你試用的場景、你的試用確認;「含施工卡點」也列出卡點與你的處置。還沒回答的提案用黃框標出。
  右邊是 `docs/ROADMAP.md` 的路線圖(沒有就用 dag 裡的版本),每一版顯示已批准 / 節點完成數 / 試用,點一下跳到主控台看那個節點。
- 仍然唯讀:Front 的對話本身不在帳本裡,這頁只顯示帳本有記的事(提案、決定、原話、試用)。要說話還是在 Front。
- 資料多讀 `ledger/proposals/*.json` 與 `docs/ROADMAP.md`。

## 4.3.0 — 主控台改成四欄 dev console

- `dp dashboard` 的頁面改成 CodeHarness demo 的版面:深色、可收合的左側導覽、四欄(Orchestrator / Worker / Verifier · Critic / Harness)、
  角色燈號、花費條、Worker 底部 to-do、底部「要你決定」列(可複製指令)。資料一樣只來自帳本重播,仍然唯讀、零依賴、不連外部資源。
- 新增「▶ 重播」:把選定節點的事件依序重放,看它怎麼從派工走到合併(或被退回)。
- 主控台多讀兩個檔:`ledger/dispatch/<d>/envelope.json`(工單)與 `report.json`(交件報告與證據),缺檔時略過。
- 頁面本體搬到 `tools/lib/dashboard.html`;`dashboard.mjs` 只負責資料與伺服器。
- 用 budgetbook v4 帳本(完成的專案)與測試用的半途專案(施工中 + 一個待批准提案)截圖驗過;手機寬度 390px 沒有橫向捲動。

## 4.2.0 — 視覺化主控台

- 新增 `dp dashboard`:把帳本重播成一頁 HTML。`--serve [port]` 開本機頁面(預設 7171,`--interval` 秒數),
  不加就寫出 `.dp/dashboard.html`(或 `--out`)。內容:要你決定的事、依版本分組的節點與棒進度、退回 / 卡住次數、
  花費依角色與節點、可篩選的時間軸(退回理由、Critic 說明、驗證與 gate 結果可展開)。
- 唯讀:資料來自 `replay` + `computeSnapshot`(跟 `dp status` 同源),不寫事件;伺服器只綁 127.0.0.1、只回 GET。
- 零依賴:`tools/lib/dashboard.mjs` 一個檔(Node 內建 http),頁面是內嵌 CSS / JS 的單一 HTML。
- Front skill 多一條:使用者想用畫面看進度時,開 `dashboard --serve` 給他網址。
- 用 budgetbook v4 的真實帳本(200 個事件)驗過:6 個節點、花費 worker $4.41 / Critic $1.31,跟實測報告一致。
- 新測試 `test/dashboard.test.mjs`(4 個)。

## 4.1.0 — 拿掉實跑沒用到的功能

原則:三次實跑(kakeibo、budgetbook v3、budgetbook v4,都是 Claude Code、沒有沙箱、L1/L2)沒用到的功能先拿掉,
等真的遇到需要它的情況再加回來。程式都在 4.0.0(git 歷史),加回來時從那裡拿,不用重寫。

資料格式向下相容:舊帳本裡的 `node_imported`、`contract_bump` 事件與 `manager` / `migration` 身分照樣重播;
舊 `dp.config.json` 裡已移除的設定讀的時候略過,`dp doctor` 逐條提醒(只是當時預設值的不提醒)。

| 拿掉的 | 什麼情況該加回來 |
|---|---|
| **Manager**(可派節點比空位多時由模型排順序,`agents.manager`、`prompts/manager.md`) | 同時可派的節點常常超過 `caps.parallel`,而且預設順序(解鎖多少下游)明顯排錯 |
| **容器沙箱**(`sandbox.*`:docker / podman / srt、`pass_env`、訂閱登入資料夾、`dp-worker.Dockerfile`、`dp check sandbox` 與 controls 裡的三個對照) | 要讓 worker 碰不到家目錄 / 金鑰、只放行模型 API 網域,或要在不信任的需求上跑 L2。沒有 .git 的副本、node_modules 指紋、paths / sandbox-escape 檢查都還在 |
| **Codex 支援**(`platform: codex`、`.codex/hooks.json`、`apply_patch` 檢查、`.agents/skills` 鏡像與 `dp mirror` / `dp check mirror`) | 真的要用 Codex 當 Front 或 worker。現在 codex 指令仍可當 `generic` 的 worker 指令跑,只是沒有 hooks |
| **嚴格授權**(`auth.mode: signed` / `off`、`dp approve`、`dp request`) | 有人能把文字塞進 Front 看得到的地方,而且你需要「沒對上原話就拒絕」。原話簽章與 hash 紀錄還在(trust 模式) |
| **Front 唯讀模式**(`front.guard: strict`、Bash 白名單) | Front 要交給不熟的人用、或要在無人看管時跑 |
| **L3**(Critic 代行一般決定) | 本來就沒接上:只有 Manager 會產生 `DN-*` 決定。過夜無人值守、而且累積了很多可 revert 的小決定時再設計 |
| **既有專案回填**(`dp intake brownfield`、`backfill` 棒) | 要把 dp 接到已經有程式碼的專案 |
| **匯入別的 repo**(`dp intake import` hard / soft、`port` / `analyze` / `rebuild` 棒、import-map / clean-room / behavior-doc 檢查) | 要把別的 repo 的程式照搬或依行為重建 |
| **v1 遷移**(`dp migrate-v1`、`docs/reference/v1/`、MIGRATION 的 v1 → v2 段) | 還有 v1 專案要搬:先用 4.0.0 遷移,再升級到 4.1 |
| **`dp contract bump`** | 第一次真的要升契約 major。帳本仍讀得懂 `contract_bump`,依賴舊版的已完成節點會變 stale |
| **Verifier 的 http 後端**(Ollama 等 OpenAI 相容端點、`url` / `model`) | 要用本機模型當 Verifier;或包一支讀 stdin 的小指令接 `cmd` |
| **`dp prompt` / `dp snapshot`**(除錯用) | 送出的 prompt 本來就存在 `ledger/dispatch/<d>/prompt.md`;snapshot 用 `dp status --json` |
| **`dp doctor --deep`** | 只有沙箱對照用到它 |
| **payload 的 gate:`check:doc-rot`、`check:known-defects`、`lint:docs`(doc-links)、`scripts/py/`、`scripts/hooks/pre-commit`** | 專案開始累積「已知有毒字串」「已知缺陷清單」或大量文件交叉連結時 |

**順手改的**
- `dp setup` 只剩:用 Claude Code 還是自訂指令 → worker 指令 → Verifier(Haiku / 不用)→ 自治等級 → Critic → 預算 → 平行數 → hooks → 依賴 → commit。
- inbox 不再常駐「沒有沙箱」警告(現在沒有別的選項,提醒只留在 `dp doctor` 的「隔離」一項)。
- PreToolUse hook 不再攔 Bash(light 模式本來就全部放行)。
- 自治等級最高 2;舊設定的 3 當成 2。

**數字**:`tools/` 從 6,833 行降到 5,445 行;dp 自動測試 154 → 132 個(拿掉的都是測已移除功能的);
payload gate 包自我測試 183 → 118 個,全過。

## 4.0.0 — 實測修正:多節點並行、退回測試棒、版本整合點

v4 的每一項都來自 v3 的實測(用真的 Claude Code 從零做一個分版本的記帳 app,見 v3 實測報告)。資料格式向下相容:
v3 的 dag、ledger 照用,只新增事件 `leg_reopen` 與欄位。

**會卡死的(P0)**
- **多節點同時在做時全 gate 互相卡死**:批准的 gherkin 會先進主線,兩個以上節點同時在做時,`accept` 會跑到別人還沒實作的場景,
  每個合併都紅。dp 現在維護 `.dp/pending-features.json`(已批准、還沒完成的 gherkin),範本的 `cucumber.js` 跳過它們;
  merge-tree 裡只排除「別的」節點,自己的場景照跑。另外修了 `npm run accept -- <檔>` 會把設定檔的 paths 一起跑的問題
  (cucumber 把兩者合併):命令列有給路徑就只跑命令列的。
- **實作棒發現測試寫錯時沒有出路**:v3 的實作棒改不了測試,Critic PASS 只會把同一棒原樣重派,形成迴圈。
  新增 `test-fix` 棒:實作棒回報 `fix_leg: "test"` → Critic(L2)或你確認 → 退回測試棒修正(只能改測試與步驟、同一條分支)→
  實作棒從乾淨狀態重來。自動退回上限 `caps.test_reopens`(預設 2)。Critic 指引重試過還卡住的,第二次直接問你。
- **scenario-honesty 幾乎全棄權**:v3 是「每個場景 × 截斷的 diff」,90 題 71 題 ABSTAIN、一次驗證 17 分鐘。
  改成「gherkin 的具體值 × 每個改到的實作檔全文(依行切段)」,小模型看得到完整函式。舊版 prompt 模板會被偵測並提示 `dp upgrade`。

**讓你多回幾次話的(P1)**
- 等合併的決定:能走到這裡代表 script 檢查與全 gate 都綠,v4 推薦「合併」(v3 只要有棄權就推薦退回,你每次都得反著選)。
  沒把握的清單把機器檢查(mutation、證據)排前面、每行截短(v3 從尾巴截 1500 字,mutation 那行常被切掉)。
- 證據指令不在重跑白名單、但 dp 自己重跑的驗收已通過 → 記 SKIPPED,不再升級問你。重跑白名單加入 `node tools/dp.mjs check`。
- 卡住時推薦「擱置」而不是沒有指示的「重試」;選項多了「退回測試棒」。
- `dp decide` 一次決定多件:`dp decide a,b yes`、`dp decide 'accept:*' yes`。
- `dp intake bundle`:一版一個提案、一次批准(v3 六個節點批了四次)。路線圖存成 `docs/ROADMAP.md`(v3 只在 Front 的對話裡)。
- mutation 門檻:一般節點 `min` 50(v3 60,小專案太高),strict 節點 `min_strict` 70。

**版本整合點**
- 每一版是一個 bundle,最後一定有整合點 `I<n>`(依賴這一版所有節點、含 `@e2e` 場景);沒有就拒絕。
- 下一版的起點自動依賴上一版的整合點,而且要等你試用說 OK 才開工(`integration.gate_next_version`,預設開)。
- intake skill 改寫:先畫路線圖、一版一版切,寫完 gherkin 逐一驗算數字(v3 實測有場景算錯,測試棒照錯的寫)。

**Critic**
- 在交件分支的 worktree 裡審(v3 在主線根目錄跑,讀到的是還沒合併的舊程式)。
- Claude 的預設指令給唯讀工具與跑測試的權限(v3 什麼都沒給,headless 下連 Read 都被拒)。`dp setup` 會換掉 v3 的預設。
- reason 超過 1500 字不再整個被當成格式錯誤:帳本存前 1500 字,全文存 `ledger/dispatch/<d>/critic-<seq>.json`。
- prompt 分三題(accept / escalation / test-fix),要求 reason 1200 字內。

**操作**
- `dp halt` 立刻終止還在跑的 worker(`class: halted`:不算嘗試、不退避、worktree 不動)。v3 的 worker 會跑到 lease 到期,
  恢復後被 reset,把你停機期間手動修好的東西洗掉。`--keep-workers` 維持舊行為。
- `notify.cmd`:有新的決定 / 試用 / 停機時通知(文字在 `DP_NOTIFY_TEXT` 與 stdin)。
  Front 的 user-prompt hook 在有事等你時附一行【dp】提醒。
- 任何指令加 `--help` 只印說明(v3 的 `dp run --help` 直接啟動了背景迴圈);不認得的旗標直接拒絕,什麼都不做。
- `dp setup`:沒有 Ollama 又用 Claude 時,可以選 Claude Haiku 當 Verifier(不給任何工具)。
- `dp doctor`:偵測 v3 版的 `cucumber.js`(seed-only,`dp upgrade` 不會換)。
- shared 節點附 gherkin 但沒指定路徑時說清楚(v3 寫出一個叫 `undefined` 的檔)。
- `dp setup` 的自治等級選項直接用等級當編號(v3 顯示「1) L0 2) L1 3) L2」,`--answers` 寫 2 會變成 L1)。

**v4 實跑中再修的**(用 v4 從零做記帳 CLI 的 v1–v3 時發現)
- 整合點也先有測試棒(pipeline `integration: ['test', 'integrate']`)。之前整合 gherkin 的步驟定義沒有任何一棒能寫:
  integrate 棒不准碰 `features/steps`,整合點永遠 undefined。整合點的測試棒可以寫 `features/steps/integration.steps.*`。
- 換了一棒(或被退回測試棒)時,這一棒的起點從那一串的第一次派工算起;之前沿用前一棒的起點,測試棒被算進前一棒留下的實作檔,判越界三次後卡住。
- 這一棒改了哪些檔只算 dp 替 worker 收件的 commit:使用者 / Front 在分支上手動修的 commit 不算在 worker 頭上。
- spawn 的決定只套用一次:之前父節點之後因為別的原因再被封鎖時,會被同一個舊決定再解開一次,繞過新的待決事項。
- worker 回報卡住、Critic 回 ASK_USER 時,建議改成「擱置」,並附上 Critic 的說明(之前照樣推薦重試)。
- 非 shared 節點的 owns 有 `package.json` 之類的 gate 定義檔時,提案當下就拒絕(之前施工時才被判越界三次)。
- worker 在 workspaces 底下新增套件、lockfile 對不上時,merge-tree 改用根目錄的 node_modules,不再判 gate 紅。
- intake skill:整合點的 gherkin 不要沿用能力 gherkin 的句子(cucumber 一句只能有一個定義)。
- 範本 `dp.config.json` 的 mutation 門檻改成 `min` 50、`min_strict` 70(之前範本寫死 60,預設值改了也沒用)。

## 3.0.0 — 放寬權限

實際使用時,唯讀與授權限制造成的摩擦比它擋下的風險多。v3 把預設改寬,每一項都留開關可以改回 v2。

- **Front 不再唯讀**(`front.guard`,預設 `light`):Front 可以讀檔、改檔、跑任何指令。PreToolUse hook 只擋
  用檔案工具直接寫 `ledger/`、`dag.json`、`.dp/`(`.dp/intake/` 除外)、原話紀錄,以及讀寫金鑰目錄。`strict` = v2 的唯讀模式。
  Codex 的 `apply_patch` 一樣照這個設定檢查。
- **Front skill 改寫**:小事(文案、設定、文件、點名的小 bug)可以直接做並 commit;新功能仍走 intake → DAG。
- **worker 跑得了指令**:v2 預設的 `claude -p --permission-mode acceptEdits` 在 headless 下會拒絕所有 Bash
  (實測回傳 `permission_denials`),worker 連測試都跑不了。新預設:
  - 沒有沙箱:`--permission-mode acceptEdits --allowedTools "Bash" --disallowedTools "Bash(rm -rf *)" "Bash(rm -fr *)" "Bash(sudo *)"`
    (實測:一般指令能跑,`rm -rf`、`sudo` 被擋)
  - 有沙箱:`--dangerously-skip-permissions`
  - `dp setup` 看到 v2 的預設指令會自動換掉。
- **授權**(`auth.mode`,預設改成 `trust`):`decide` / `confirm` / `resume` / `unblock` 的 `--verbatim` 可省略、可轉述;
  對得上 hook 簽章的原話時仍記 hash(`auth: utterance`),否則記 `auth: trust`。`signed` = v2 的嚴格比對。
- **沒有沙箱也能跑 L2 以上**(`sandbox.allow_unsandboxed_autonomy` 預設改成 `true`):`dp setup` 沒沙箱時也列出 L2,
  `dp doctor` 從 ✗ 改成 ⚠。
- `dp doctor`:`trust` 模式下沒裝 hooks 是 ⚠ 不是 ✗。tick 遇到未 commit 變更時,訊息直接說要 commit。
- **實測修掉的 v2 bug**(用真的 Claude Code 跑一遍 init → setup → Front → intake → worker 時發現,都讓測試棒或實作棒永遠過不了):
  - 沒有容器時,驗收副本在 `.dp/` 底下、沒有 `.git`,gate 包的 `_root.ts` 用 `git rev-parse` 會找到外層主 repo,
    看不到 worker 新寫的步驟檔,dry-run 每次誤報 undefined。現在沙箱與驗收執行器都設 `GIT_CEILING_DIRECTORIES`。
  - vitest 載入設定時會建 `node_modules/.vite-temp`,node_modules 指紋沒跳過它,跑過 vitest 的 worker 都被判 sandbox-escape。
  - intake 預設的驗收指令 `npx cucumber-js <gherkin>` 載入不了 TypeScript 步驟定義(ERR_MODULE_NOT_FOUND),
    改成 `npm run accept -- <gherkin>`(範本的 accept script 有 `--import=tsx`)。
  - worker prompt 說明證據指令要能原樣重跑(不加環境變數前綴),避免多出一題問你。
- 沒動的:worker 改不到 gate 定義檔(`package.json`、`scripts/**`、測試設定)與規則層、worker 在沒有 `.git` 的副本施工、
  帳本簽章鏈、證據重跑白名單。這些防的是「驗收被繞過」,不是權限,而且對你沒有摩擦。

## 2.4.0 — Codex 的 hooks

- 用 codex-cli 0.160 實測:Codex 的 `UserPromptSubmit` / `PreToolUse` hooks 給的資料跟 Claude Code 同格式
  (`prompt`;`tool_name: "Bash"`、`tool_input.command` 字串;改檔是 `tool_name: "apply_patch"`、`tool_input.command` 是 patch 全文)。
  專案層的 `.codex/hooks.json` 只在 Codex **信任這個資料夾**、且 hook 在 `/hooks` 被信任後才會執行。
- 新增 `payload/.codex/hooks.json`(seed-only),`dp setup` 選 Codex 時合併進專案並提醒信任步驟。
  Codex 當 Front 時一樣:你的原話會簽章,Bash 看得到改不了。
- PreToolUse hook 檢查 Codex 的 `apply_patch`:Add / Update / Delete / Move to 的每個路徑都不能是 ledger、dag.json、.dp(除了 .dp/intake)、金鑰。
- `dp doctor`:Codex 前端檢查 hooks 是否已裝、資料夾是否已信任、hook 是否已在 `/hooks` 信任。

## 2.3.4 — npm install 修正

- 實際使用時發現:npm 10.9 安裝 `vitest@^4.1` 會當掉(`Cannot read properties of null (reading 'edgesOut')`),
  每個新專案的 `npm install` 都失敗。範本的 `vitest`、`@vitest/coverage-v8` 改固定在 `~4.0.0`(npm 10 / 11 都裝得起來)。
- `dp setup` 換施工 AI 或沙箱時,Critic 指令跟著換(之前會留著舊的 Claude 指令)。
- `dp setup` 的 npm install 失敗時自動改用 `--legacy-peer-deps` 重試,並印出失敗原因。

## 2.3.3 — 沙箱裡的 Codex 用訂閱帳號

- `sandbox.login_dirs`:訂閱帳號的登入資料夾,只掛給 worker 與 critic(可寫,token 自動更新),驗收與 gate 看不到。
- `dp setup` 選 Codex + 沙箱時:「用我的 Codex 訂閱帳號」會建 `~/.config/dp/codex-home`(跟你自己的 `~/.codex` 分開),
  跑 `codex login --device-auth` 登入一次;已登入就沿用。選訂閱就不再帶 `OPENAI_API_KEY`。
- Codex 0.160 起沒有 `--full-auto`:預設指令改成 `codex exec --skip-git-repo-check -s workspace-write -`(沒有 dp 沙箱)或
  `--dangerously-bypass-approvals-and-sandbox`(外層已有 dp 沙箱)。`dp doctor` 會抓出還在用 `--full-auto` 的設定。
- docker 實測:映像裡的 codex 0.160.1 會讀 `CODEX_HOME` 指到的掛載資料夾。

## 2.3.2 — worker 沒登入時立刻停機

- 實際使用時發現:docker 沙箱裡的 claude 沒登入(`Not logged in · Please run /login`),輸出裡同時帶 `api_error`,
  被當成限流一直退避重派。現在先辨識「沒登入 / 金鑰無效」:不算嘗試次數、不重試,第一次就停機(`[auth]`),
  原因寫清楚要跑 `dp setup` 的沙箱登入。

## 2.3.1 — Front 可以唯讀查看專案;沙箱裡的 worker 用你的帳號登入

- `dp setup` 選了沙箱時,多一題「沙箱裡的 AI 要怎麼登入」:Claude 訂閱帳號會幫你跑 `claude setup-token`,
  或填 API key。值存在 `~/.config/dp/secrets.json`(repo 外、0600;沙箱與 Front 的 hook 都讀不到),
  `sandbox.pass_env` 只記名字。啟動 worker / critic 時才傳進沙箱;驗收與 gate(跑 worker 寫的程式)拿不到。
  docker 指令列只出現變數名,值不會出現在 `ps`;srt 不再整包繼承主機環境變數。
- `dp doctor` 多一項「沙箱登入」。

- PreToolUse hook 從「只能跑 dp 指令」放寬成「看得到、改不了」:Front 與它派出去的幫手可以用 git 的唯讀子指令與
  `ls` `cat` `head` `grep` `rg` `find` 等(可接 `|`)。會寫檔或執行別的程式的參數、重導向、`;` `&` `$` 一律擋;
  路徑必須在專案裡;金鑰與原話紀錄怎樣都讀不到。`--verbatim` 的標點放在引號裡即可。

## 2.3.0 — 新手引導

- `dp setup`:互動問答。偵測已安裝的 Claude Code / Codex、docker / podman / srt、本機 Ollama 模型與金鑰環境變數當預設值;
  一題一題問施工 AI、沙箱(可產生 `dp-worker.Dockerfile` 並幫你 build)、Verifier、自治等級(沒沙箱時最高 L1)、預算、
  平行數;要不要 `npm install`。寫入 `dp.config.json`(保留你其他設定,驗證不過就還原)、把 dp 的 hooks **合併**進既有的
  `.claude/settings.json`、commit,最後跑健康檢查。`--yes` / `--answers file.json` 可不互動。
- `dp doctor`:Node、設定格式、git 狀態、worker 指令(有容器時在映像裡找)、沙箱(`--deep` 實跑三個陽性對照)、hooks、金鑰權限、
  Verifier 連線、gate script、依賴、帳本、DAG、背景迴圈。每項 ✓ / ⚠ / ✗,✗ 附一行修法;`--json` 給 Front 用。
- `dp init` 的下一步改成指向 `dp setup`;Front 可以跑 `dp doctor` 轉述設定問題。

## 2.2.0 — P1:沙箱與授權

依據:`dev-paradigm-v2-changes.md` 的 #13–#19。測試在 `test/p1-sandbox-auth.test.mjs`(需要 docker 的在沒有 docker 時跳過)。

### 安全
- **統一沙箱執行層**(#13,`tools/lib/sandbox.mjs`):worker、驗收、證據重跑、standalone、mutation、合併 gate、Critic、Manager
  都經過它。backend `none` / `srt` / `docker` / `podman`;四個內建 profile(worker / verify / gates / critic)。
  新設定 `sandbox.*`。`none` 時 inbox 常駐警告、L2 以上拒絕 tick(`sandbox.allow_unsandboxed_autonomy` 是你明確接受風險的開關)。
  `allow_domains` 禁止 `*`、`*.com`。`dp check sandbox` 與 `dp check controls` 會在沙箱裡試讀家目錄、連外網、寫範圍外,三件都要失敗。
- **worker 不碰 `.git`**(#14):worker 在 `.dp/sandboxes/<dispatch>/`(沒有 .git)施工;dp 比對整份副本(含 ignore 的檔),
  範圍內的同步回 worktree 並以 `dp` 身分 commit;碰 `.git`、`.dp/`、`node_modules`、symlink 記為 `sandbox-escape` 並退回。
  `prompts/worker.md` 拿掉 commit 步驟。
- **node_modules 隔離**(#15):容器裡唯讀掛載;沒有容器時比對根目錄 node_modules 指紋。merge-tree 有 lockfile 時用
  `npm ci --offline --ignore-scripts` 重裝(`gates.install`: auto / ci-offline / link)。
- **可驗證的使用者授權**(#16):`.claude/settings.json` 的 UserPromptSubmit hook 以 repo 外金鑰(`~/.config/dp/key`)簽章你的原話;
  decide / confirm / resume / unblock 的 `--verbatim` 必須對得上最近 30 分鐘內的簽章原話(`auth.mode`、`auth.window_minutes`)。
  PreToolUse hook 把 Front 的 Bash 限制在 dp 的允許子指令,檔案工具碰不到金鑰與帳本。沒有 hooks 的前端用 `dp approve`(讀 /dev/tty)。
  新指令:`dp hook user-prompt|pre-tool`、`dp approve`。
- **帳本簽章鏈**(#17):每筆事件帶 `prev_hash` 與 `mac`;`dp check ledger` 驗整條鏈;鏈壞了 tick 拒絕執行(退出碼 3)。

### 驗收強度(#18)
- 測試棒「紅」要紅在對的地方:語法錯誤、步驟未綁定 / pending / ambiguous 判 FAIL。`verify.dry_run_cmd` 要求 dry-run 摘要行乾淨。
- 最後一棒:`verify.mutation` 對這一棒改到的實作檔跑增量 mutation;低於 `min` 時 strict 判 FAIL、其他 ABSTAIN。
  mutation 達標時,沒有 Verifier 模型的 `scenario-honesty` SKIPPED 不再升級(放寬 2.1 的 #11)。

### 小瑕疵(#19)
- `agents.worker.timeout_minutes` 生效:worker 時限取它與 `caps.lease_minutes` 的小者。
- 花費解析也認 `cost_usd`,串流輸出取最後一筆;AGENTS-SETUP 註明 Codex 不印花費、補本地模型 worker 範例。
- `checks.placeholders.exclude`:列出本來就該有 placeholder 的模板目錄(取代「依 package 名稱豁免」的提案 p-001)。
- SECURITY.md 改寫成新流程;ADR-021 補上 2.1 / 2.2 的決定與取捨。

### 升級注意
- **預設 `auth.mode` 是 `signed`**:升級後請確認 `.claude/settings.json` 有 dp 的 hooks(已有自己的設定檔時 dp 不會覆蓋,
  請手動合併 `payload/.claude/settings.json`)。Codex 前端改用 `dp approve`。
- 在途的派工(升級前派出、worker 在 worktree 施工)照舊流程收件;之後的派工走沙箱副本。
- 舊帳本會從升級後的第一筆事件開始上鏈。
- L2 以上需要設 `sandbox`。
- 有 lockfile 的專案,合併 gate 會先跑 `npm ci --offline`;本機快取不全時先 `npm install` 一次,或設 `gates.install: "link"`。

### 已知限制
- srt backend 的參數依照 sandbox-runtime 0.0.78 的文件撰寫,但在開發機上沒有實跑過(那台機器的 AppArmor 擋住 bubblewrap);
  docker backend 有端到端測試。用 srt 前請先跑 `dp check sandbox`。
- docker 的 worker 網路不分網域。
- 沒有沙箱時,金鑰與 dp 對 worker 都是可及的;授權與簽章的保證以有沙箱為前提。

## 2.1.0 — P0 加固(接上真模型之前必修)

依據:`dev-paradigm-v2-changes.md` 的 #1–#12。每一項都有「壞樣本被擋下」的測試(`test/p0-hardening.test.mjs`),
`dp check controls` 多了 6 個陽性對照。

### 安全
- **證據重跑不再經過 shell**(#1):以 argv 執行;指令只收英數與 `._/:=@+-`、空白,不能有絕對路徑或 `..`;
  白名單前綴要落在參數邊界。預設白名單移除 `cat`、`ls`。重跑 FAIL 不附輸出,退回的 findings 不帶 worker 自選指令的輸出。
- **越界的樹不執行任何指令**:paths / worktree 檢查沒過,就不跑驗收、證據、standalone,直接退回。
- **dp 的 git 一律停用 hooks**(#2);每個 tick 比對 `.git/config` 指紋,被改就停機(`[git-config]`),`dp resume` 才重記基準。
- **gate 定義檔與 agent 設定進 forbidden_paths**(#7):根目錄 `package.json`、lockfile、`tsconfig.json`、`vitest*.config.*`、
  `cucumber.js`、`stryker.config.json`、`scripts/**`、`.mcp.json`、`.codex/**`、`.github/**`、`.gitattributes`、`.gitignore`。
  owns 明列該檔的 `shared/*` 節點例外。
- **事件權責表補齊**(#8):施工事件只有 orchestrator、`verify` 只有 verifier、`critic` 只有 critic、使用者解封(`user#`)只有 user。
  `dp decide` 移除 `--as critic`。
- **不可信文字加圍欄**(#9):`decision_request` 新增 `untrusted_text` / `untrusted_source`,question 只放 dp 自己的字;
  inbox、`dp show` 把 worker / 模型 / git 文字與附件包在 `<untrusted>` 裡並跳脫結尾標籤。Front skill 補對應規則。

### 正確性
- **tick 全域鎖**(#3):整個 tick 在 `.dp/tick.lock` 內;拿不到鎖 `dp tick` 印「另一個 tick 正在執行」、exit 0。
  `dp run` 改用 `.dp/run.lock`(O_EXCL)佔位,兩個迴圈不會同時通過檢查。
- **owns 重疊檢查**(#4):沒有依賴順序的兩個節點 owns 不可重疊(含 spawn 出來的兄弟節點);有順序的可以。
- **預設 gate 鏈跑專案測試**(#5):`["check:dp", "typecheck", "test", "accept"]`;L1 以上而 chain 沒有 `test` / `test:*` / `accept*`
  時 tick 拒絕執行,inbox 顯示原因。
- **合併 gate 過期重跑**(#6):`gates` 事件記 `main_sha`;合併前主線程式碼變了(只有 dp 狀態檔變不算)就在新主線上重跑,紅了退回。
- **基礎設施失敗不計次**(#10):`worker_failed` 新增 `class: infra|quality` 與 `retry_after`。log 顯示 429 / 5xx / 過載 / 連線錯誤、
  或沒成功啟動 → infra:不加嘗試次數、指數退避;全系統連續 `caps.infra_halt_after`(預設 5)次就停機通知。
  新設定:`caps.infra_halt_after`、`caps.infra_backoff_seconds`(60)、`caps.infra_backoff_max_minutes`(30)。snapshot 新增 `backoff`。
- **沒設 Verifier 不自動合併**(#11):`backend: none` 時 `scenario-honesty` 的 SKIPPED 在路由上視同 ABSTAIN。
- **沒有 accept 的 shared 節點不自動合併**(#12):一律交 Critic 或使用者。

### 升級注意
- 既有專案的 `dp.config.json` 若 `gates.chain` 只有 `check:dp`,L1 以上 tick 會停,請加上 `test`(與 `typecheck`、`accept`)。
- 沒設 Verifier 的 L1 專案,有 gherkin 的最後一棒會開始問你(之前會直接合併)。
- 舊帳本裡由非 orchestrator 寫的施工事件,`dp check ledger` 會報出來。

### 已知限制(P1 以後)
- 驗收、合併 gate、Critic 仍在主機上執行 worker 寫的測試碼(需要沙箱,#13)。
- worker 與使用者仍是同一個 OS 使用者,可以直接呼叫 `dp decide`(需要可驗證授權,#16)。

## 2.0.0 — 架構重寫

決策紀錄:`docs/adr/ADR-021-v2-architecture.md`;對照與遷移:`MIGRATION.md`。

### 新增
- `dp` CLI(零依賴 Node ≥ 20):init / upgrade / tick / run(含 `--daemon`)/ status / inbox / show / decide / confirm /
  halt / resume / unblock / request / check / gates / render / mirror / intake / contract bump / migrate-v1 / stats / prompt。
- 事件帳 `ledger/events.jsonl`(只 append、持鎖、逐型別 schema、actor 權責表);狀態由重播得出。
- orchestrator(script):收件 → 驗證 → 臨時樹全 gate → 自治路由 → 合併 → 派工;可在任何一步中斷後重跑。
- Verifier:script 檢查 + 本機小模型窄題(只能 FAIL / ABSTAIN / NO_OBJECTION;兩種問法不一致即棄權)。
- 自治等級 L0–L3(`AUTONOMY.md`)。
- intake 單一入口:feature / brownfield(backfill 節點)/ import(hard 照搬附來源對照、soft 行為文件 + 淨室重建)。
- 可執行契約:`contracts/schema/*.schema.json` + valid/invalid fixture(被擋的原因也要對)+ `VERSION`。
- `dp check`:controls(陽性對照)、dag、ledger(只增未改)、generated、contracts、mirror、placeholders、rule-size、rule-conflicts。
- v1 → v2 遷移(`dp migrate-v1`):推不出 owns 的節點標 blocked,不猜。
- 51 個自動測試,含以 consumer 身分跑完整流程的吃自己狗糧測試。

### 開發過程中由測試抓到並修掉的問題
- 被退回那次嘗試的改動會留在分支上,下一次只驗新 commit,越界改動可能跟著合併 → 退回時留 `dp-rejected/<d>` 標籤並重置 worktree;改驗整棒累積改動。
- 分支落後時同步主線會快轉,主線的 commit 混進這一棒 → 同步一律 `--no-ff`。
- 在測試框架底下執行時,`NODE_TEST_CONTEXT` 漏進 worker,讓巢狀的 `node --test` 全部跳過並 exit 0(假綠)→ 子程序環境一律清掉這類變數。
- 讀 `git status --porcelain` 時 trim 掉第一行的狀態欄,路徑被截一個字 → 不 trim。
- v1 專案沒有 `contracts/VERSION`,遷移後契約依賴驗證失敗 → 遷移時定為 1。
- 範本裡的 placeholder 地雷(`stryker.config.json`、`features/steps/_world.ts`)→ 換成可用預設值。

### 刪除 / 取代
- 協調者、接線、整合、sprint-planning、workflow-coordinator、autopilot 等角色與 skills → orchestrator + Front + intake。
- check-dag、check-next-gates、check-phase-status、check-phase-coverage、check-all、check-skills-mirror → `dp check` / `dp gates`。
- sync-gates.sh、npx 初始化、verify-against.sh、shipping-coverage、`plugin/`、`package/` → `dp init` / `dp upgrade`。
- FEATURE.md 的 phase 表、NEXT.md、DECISIONS_NEEDED.md、REVIEW.md、MAILBOX → dag.json + ledger + 產生檔。

### 歸檔
- PITFALLS.md、07-practices、02-decision-map 等移到 `docs/reference/v1/`,不再是必讀規則;PITFALLS 有索引,105 條待分類。

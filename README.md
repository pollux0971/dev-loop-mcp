# dev-paradigm-mcp v4.7.2

> 原名 dev-paradigm。從 4.7.2 起叫 dev-paradigm-mcp:主要入口是 MCP server;指令還是 `dp`,MCP 工具還是 `dp_` 開頭。

讓 AI 從需求一路做到合併的開發範式。你只跟**一個對話視窗**說話;背景有一支 script 排程、派 headless agent 施工、
用機器(含小模型)驗收,只有真正需要你判斷的事才會出現在你的收件匣。

```
你:「我想要一個記帳 app,先能記一筆支出就好」
Front(你唯一的視窗):問兩個問題 → 跟你寫好 gherkin → 「這樣可以嗎?」
你:「可以」
            ……背景:測試棒(紅)→ 實作棒(綠)→ 驗證 → 合併……
你:「進度?」
Front:【要你決定的 · 1】E2E:I1 你親手試過了嗎?  【上次看之後】合併 3 · 退回 1 · $0.84
```

## 核心想法

- **一個事實只放一個地方,只由 script 寫。** 結構在 `dag.json`,歷史在只增不改的 `ledger/events.jsonl`,
  狀態由重播得出。沒有「兩份文件說法不一樣」這種事。
- **agent 只拿它那一棒需要的東西。** 不給整張 DAG、不給 475KB 的規則;每份送出的 prompt 都留檔可查。
- **「完成」要能重跑。** worker 的每個宣稱附指令與退出碼,機器用同一條指令重跑;測試棒必須紅、實作棒必須綠、
  寫到範圍外就退回;合併前在「main + 分支」的臨時樹再跑一次全 gate(預設 `check:dp`、`typecheck`、`test`、`accept`;
  gate 鏈沒有任何測試類 script 時,L1 以上 dp 拒絕執行)。等你決定的期間主線若前進,合併前會在新主線上重跑。
- **權限從寬,紀錄從嚴。** Front 可以讀寫、跑指令,worker 跑得了測試;只擋會弄壞狀態或救不回來的事(手改帳本、`rm -rf`、`sudo`)。
  你說的話由 hook 簽章,決定對得上原話時會記 hash;帳本每筆也簽章。要 v2 的嚴格模式見 [MIGRATION.md](MIGRATION.md)。
- **小模型審大模型,但只能說不。** 小模型(預設 Claude Haiku)回答很窄的題目(這段輸出有沒有推翻這個宣稱?這段實作是不是對測試值寫死?),
  兩種問法不一致就棄權,棄權交給大模型 Critic 或你。小模型的錯只會造成「多問一次」,不會讓壞程式進主線。
- **一版一版長大。** intake 先畫路線圖(`docs/ROADMAP.md`),一次只把一版放進 DAG;每一版最後是一個整合點,
  你親手試過說 OK,下一版才開工。側向是施工中發現的必要小功能 v1.1、v1.2(worker 提出,依自治等級自動或問你)。
- **錯的地方退回對的那一棒。** 實作棒發現測試寫錯時退回測試棒修正,不是原地重試到卡死。

## 快速開始

需要 Node ≥ 20 與 git。

**用 MCP(v4.7,建議):** 這台電腦裝一次,之後在任何目錄開 Claude Code 都能用,管這台電腦上所有 dp 專案。

```bash
git clone <this repo> dev-paradigm-mcp
node dev-paradigm-mcp/tools/dp.mjs mcp install                 # 裝進 Claude Code(user scope);--client cursor / codex 裝到別的工具
```

重開 Claude Code,直接說「用 dp 在 ~/code/my-app 開一個新專案,我想做一個記帳 CLI」,或打 `/mcp__dp__new-project`。
它會照流程呼叫 `dp_init_project` → `dp_setup_project` → 跟你談第一版 → `dp_propose_bundle` → 等你說好才 `dp_decide` → `dp_start_loop`。
之後問「我的專案現在怎麼樣?」就是 `dp_overview` + `dp_get_inbox`。流程全文:`payload/docs/dp/FLOW.md`(或呼叫 `dp_flow`)。

**用指令:**

```bash
node dev-paradigm-mcp/tools/dp.mjs init my-app --name my-app  # 會自動登記到這台電腦的專案清單
cd my-app
node tools/dp.mjs setup      # 一題一題問:用哪個 AI、Verifier、自治等級、預算;寫好設定並 commit
node tools/dp.mjs doctor     # 健康檢查,每一項 ✓ / ⚠ / ✗,不對的附修法(隨時可以再跑)
```

接著:

1. (setup 已經做好;想手動調整時)編輯 `dp.config.json`:`agents.worker.cmd`(headless 指令)、選配 `verifier`(預設 Claude Haiku)、
   `critic`。範例在 `docs/dp/AGENTS-SETUP.md`。worker 在不含 `.git` 的副本裡跑,但程式仍在你的主機上執行
   (Claude worker 會擋 `rm -rf` 與 `sudo`);要更強的隔離就把整個專案放進容器或 VM。見 `docs/dp/SECURITY.md`。
2. 在 `my-app` 開 Claude Code 打 `/inbox`。從此只跟這個視窗說話:要新功能就說,它會用 intake 跟你把規格寫到可以批准;小改動它可以直接做。
3. Front 會問你要不要啟動背景迴圈(`dp run --daemon`,停止用 `dp run --stop`),之後每 60 秒自動推進。

既有專案見下一節;從舊版升級:見 [MIGRATION.md](MIGRATION.md)。

## 既有專案(brownfield)

```bash
node dev-paradigm-mcp/tools/dp.mjs init . --existing   # 只補 dp 的檔;已經有程式時不裝範本的 TS 工具鏈
node tools/dp.mjs setup                            # 第一題選 Brownfield(偵測到程式就是預設),確認專案的測試指令
node tools/dp.mjs onboard                          # 測試基線 + docs/AS-IS.md 草稿 + ROADMAP v0,並 commit
```

然後在 Claude Code 打 `/inbox`:Front 會用 `brownfield-onboard` skill 讀程式、補完 `docs/AS-IS.md`、跟你確認,再接著問你要加什麼。
跟新專案不一樣的地方:

- **gate 跑專案自己的測試。** setup 偵測 `package.json` 的 test、pytest / unittest、`go test`、`cargo test`、`make test`,
  寫進 `gates.commands`(例 `{"test": "python3 -m pytest -q"}`);範本的 typecheck / accept / dry-run / mutation 專案沒有就不放。
- **本來就紅的測試不算 worker 的。** `dp onboard`(之後可用 `dp baseline` 重記)在主線上跑一次測試,把失敗的測試記進 `docs/dp-baseline.json`。
  合併前 gate 紅了,但紅的全都在基線裡 → 算通過;多一個新的紅就擋,並指出是哪一個。看不出是哪些測試紅的,一律當紅。
- **改到既有程式先釘住現況。** 節點的 `owns` 涵蓋主線上已有的程式檔時,提案自動在最前面加一棒 `characterize`:
  只准寫測試、不准改原始碼,而且要在現在的程式上全綠;之後每一棒都改不到這些測試,實作棒還要讓它們維持綠。
  pipeline 變成 characterize → test → dev。一次最多 10 個檔,刻意要改掉的行為寫進 gherkin 並把那個檔從 characterize 拿掉。
- 主控台規劃頁右上角顯示 Greenfield / Brownfield,brownfield 另外列出測試基線與 AS-IS 有沒有寫。

## 多個訂閱帳號(v4.6)

手上有好幾個 Claude Max / Pro 或 ChatGPT(Codex)方案,可以讓 dp 輪流用,一個額度用完就換下一個:

```bash
node tools/dp.mjs account add max-a --cli claude --plan max     # 每個帳號一個獨立的登入目錄
node tools/dp.mjs account add max-b --cli claude --plan max
node tools/dp.mjs account add gpt --cli codex --plan plus
node tools/dp.mjs account login max-a                           # 開瀏覽器登入那個帳號(每個做一次)
node tools/dp.mjs account use worker max-a,max-b --model sonnet # worker 輪流用 max-a、max-b
node tools/dp.mjs account use critic gpt                        # Critic 用 Codex
node tools/dp.mjs account use verifier max-b                    # Verifier 預設 haiku
node tools/dp.mjs account list                                  # 登入狀態、用量、冷卻到幾點
```

也可以在主控台設定:`node tools/dp.mjs dashboard --serve`,左邊的「帳號」頁可以新增、移除帳號,勾選每個角色用哪幾個、填模型。
登入那一步要開瀏覽器,還是在終端機跑 `dp account login`。

做法跟 Orca 一樣:Claude Code 用 `CLAUDE_CONFIG_DIR`、Codex 用 `CODEX_HOME` 指到帳號的目錄。帳號清單在這台電腦的
`~/.config/dp/accounts.json`,不進 repo;`dp.config.json` 只寫哪個角色用哪幾個帳號。每一棒挑近 5 小時用得最少、沒在冷卻的帳號。
log 出現額度用完就讓那個帳號冷卻到重置時間,馬上換下一個重派,不算 worker 的嘗試次數。
v4.7 起用量與冷卻是這台電腦所有專案共用的,`--max-parallel N` 限制一個帳號同時跑幾個 worker;也可以從 hub 的 API / MCP 設定(`dp_add_account`、`dp_set_role`)。

## 多專案、API 與 MCP(v4.7)

```bash
node tools/dp.mjs project list             # 這台電腦登記的 dp 專案(dp init 建的會自動登記;dp project add <dir> 補登)
node tools/dp.mjs hub                      # http://127.0.0.1:7170/ :所有專案的總覽 + HTTP API
node tools/dp.mjs hub token                # API 的 token
```

**hub 總覽頁**:每個專案一張卡(進度、在跑的 worker 是哪個節點哪一棒用哪個帳號、等你決定幾件、停機、背景迴圈開關),
有事的排前面;右邊是帳號用量與冷卻、所有專案的即時事件(SSE)。點專案進到原本的四欄主控台,左上「所有專案」回來。
同時好幾個專案各自跑背景迴圈就是多專案平行開發;每個專案裡 `caps.parallel` 個 worker 平行施工。

**一張路由表,三個入口**:`tools/lib/api.mjs` 定義 40 個操作,HTTP API(`/api/v1`,OpenAPI 3.1 在 `/api/v1/openapi.json`)、
MCP 工具(`dp_` + operationId,例 `dp_get_inbox`、`dp_propose_bundle`、`dp_start_loop`)、`dp op <操作>` 都從它來,參數與結果一樣。
文件:`payload/docs/dp/API.md`(總表 + 每個端點的參數)、`FLOW.md`(每一步誰做、呼叫哪個操作)。兩份都是 `dp api` 產生的,測試會比對。

- hub 與 MCP 對專案的操作是在那個專案裡跑它自己的 `tools/dp.mjs op`,所以專案的 dp 版本不同也不會讀錯;4.7 以前的回 501,`dp_upgrade_project` 升級。
- 帳號用量與冷卻跨專案共用;`dp account set <name> --max-parallel 2` 限制一個帳號同時跑幾個 worker(所有專案加起來)。
- 安全:hub 只綁 127.0.0.1、檢查 Host 與 Origin、`/api/*` 要 token。MCP 拒絕在 worker / Critic 的環境啟動。見 `docs/dp/SECURITY.md`。

`dp mcp install` 預設裝進 Claude Code 的 user scope(`claude mcp add --scope user dp -- node <dp.mjs 絕對路徑> mcp`);
`--client cursor` 寫 `~/.cursor/mcp.json`,`--client codex` 用 `codex mcp add`,`--client project` 只寫這個專案的 `.mcp.json`。
`dp mcp config` 印出各工具的設定讓你自己貼。要從 dev-paradigm-mcp 的目錄裝(專案裡的副本沒有 payload,不能建專案)。

## 視覺化主控台

```bash
node tools/dp.mjs dashboard --serve        # http://127.0.0.1:7171/ ,每 5 秒從帳本重播一次
node tools/dp.mjs dashboard                # 不開伺服器:寫出 .dp/dashboard.html(單一檔、資料內嵌,可直接打開或傳給別人)
```

主控台是四欄(深色):**Orchestrator**(派工、退回、合併,加上這一棒的工單:objective / write-set / forbidden / accept)、
**Worker**(依棒分頁:每次交件的報告與證據指令,底下是這個節點的 to-do)、**Verifier · Critic**(每項機器檢查與 Critic 的判決)、
**Harness**(worktree、啟動、commit、gate、合併、花費)。上方是角色燈號與花費條,底部列出要你決定的事和該打的指令。
「▶ 重播」會把一個節點的事件從頭一筆一筆放一次。
**規劃**頁左邊是你和 Front 的規劃紀錄(每份提案的節點、gherkin、選項,和你批准、試用時的原話),右邊是 `docs/ROADMAP.md` 的版本進度。
另有管線(版本與看板)、時間軸、花費三頁。
資料跟 `dp status` 同一份重播結果,不寫事件、只綁 127.0.0.1;決定仍然在 Front 說或用 `dp decide`。
唯一能改的是「帳號」頁(`--serve` 時):它跑的就是 `dp account`,要帶這次啟動才有的 token,別的網站送不進來。

## 自治等級

`dp.config.json` 的 `autonomy.level`:L0 每次合併都問你、L1(預設)機器全過就自動、L2 沒把握的交 Critic。新功能、契約 major、規則層、預算、`@e2e` 試用永遠只有你能決定。
沒設 Verifier 模型時,有 gherkin 的最後一棒不自動合併(沒人檢查「寫死測試值」);沒有 `accept` 的 shared 節點也不自動合併。
見 `payload/AUTONOMY.md`。

## 狀態:什麼驗過、什麼沒有

**用真的 Claude Code 實跑過(v4,沒有沙箱,L2 + Critic + Claude Haiku 當 Verifier):**

- 一句中立的需求(個人記帳 CLI,六項功能,沒提 MVP)→ Front 自己畫出六版路線圖 → v1、v2、v3 各一個 bundle,
  每版一個能力節點 + 一個整合點,合併後親手試用、確認後才開下一版。6 個節點全部合併,約 1.5 小時,約 $8。
- 使用者一共說了 20 句話:8 句是流程本來就該問的(需求、設計取捨、試用確認),7 句是「進度?」,5 句是處理卡點;
  卡點都追到 dp 的問題並在 v4 修掉(見 CHANGELOG 4.0.0 的「v4 實跑中再修的」)。第三版(預算)從提案到合併沒有任何卡點。
- 不用問你合併:0 次(v3 實跑 4 次)。scenario-honesty 18 題 4 題棄權(v3:90 題 71 題)。
- 同時有已批准的整合 gherkin 在主線上時,能力節點的全 gate 照樣是綠的(pending features 生效)。

**既有專案(v4.5,Claude Code、L1、Claude Haiku 當 Verifier):** budgetbook 的程式拿掉 dp 的帳本與設定,當成一個普通的 TypeScript 專案
(vitest,59 個測試)。`init --existing` → setup 選 Brownfield → `onboard`(基線全綠)→ Front 補完 AS-IS → 提「`bb export` 匯出 CSV」,
owns 含既有的 `main.ts`,提案自動加 characterize。characterize 棒寫了 11 個測試釘住 add / list / edit / balance 與錯誤訊息的現況,
測試棒 5 個測試(紅),實作棒加 `export.ts` 與 `main.ts` 9 行,驗收同時要求那 11 個測試維持綠;合併前全 gate(check:dp、typecheck、test)綠。
3 棒、0 次退回、沒問使用者,約 5 分鐘、$0.42。合併後專案 75 個測試全綠,手動跑 `bb export` 跟 gherkin 一字不差。
基線裡「本來就紅的測試」與「基線以外的新紅」兩條路徑只有自動測試涵蓋(Python unittest 專案)。

**多帳號(v4.6):** 只有自動測試涵蓋(假的 worker 印出 `usage limit reached|<時間>`、檢查派工拿到的環境變數)。
真的用兩個訂閱帳號登入、跑到額度用完再換號,還沒實跑過。
Codex 的預設指令(`codex exec --skip-git-repo-check --sandbox workspace-write -`)照它的文件寫,這台測試機沒有 codex,沒有實跑。
Gemini CLI、OpenCode 沒有帳號目錄的設定,沒有預設;要用就在 `agents.<角色>.cmd` 自己寫指令。

**MCP、多專案、API(v4.7,Claude Code + 真的 Claude worker,L1,Claude Haiku 當 Verifier):** 在不是專案的目錄開 Claude Code(只給 dp 的 MCP 工具):
它用 `dp_init_project`、`dp_setup_project` 建好 notes-app,依「`notes add` / `notes list`,越小越好」提出 v1(一個能力節點 + 一個整合點,
自己補的三個行為列出來讓使用者改),沒有替使用者批准。使用者說「好,批准」→ 它照抄原話 `dp_decide`、`dp_start_loop`。
4 棒(test → dev → test → integrate)0 次退回,約 10 分鐘、$0.62;integrate 棒有 2 項 Verifier 棄權,停下來等合併。
問「我的專案現在怎麼樣?」→ `dp_overview` + `dp_get_inbox`,照實轉述兩項沒把握的地方並等使用者說;說「合併吧」才 decide。
使用者手動試過 CLI 後說「這版可以了,幫我把背景迴圈停掉」:**第一次它只停了迴圈、沒有記下試用結果**;
在 MCP 的 instructions 與 `dp_confirm` 的說明補上「使用者說試過了就是試用結果」後重跑,它先 `dp_get_inbox` 找到 I1,`dp_confirm` 帶原話,再停迴圈。
hub 同時監控兩個專案(一個在跑、一個閒置),SSE 即時事件與 API 都用過。六次對話(含那次重跑)共 $0.54。

沒實跑的:`dp mcp install` 只在這台機器跑過 Claude Code 的指令格式(`claude mcp add --help`);Cursor 與 Codex 的安裝、兩個以上訂閱帳號真的登入輪流、
`max_parallel` 在真的 worker 上滿載,都只有自動測試或沒驗。

**自動測試(`npm test`,171 個,全部通過):**


- 完整流程(吃自己狗糧):建新專案 → intake 提案 → 批准 → 測試棒紅 → 實作棒綠 → 臨時樹全 gate → 合併 → 整合點 → 使用者確認 → `dp check` 全綠。
- 失敗路徑:越界退回、第三次封鎖、說謊的證據、沒交 report、側向子節點(L1 問你 / L2 自動)、兩種當機重跑的冪等、
  L0 逐次批准、停機、預算、Critic PASS / ASK_USER、根目錄被別人改過時拒絕執行。
- 安裝與升級的所有權語意(含升級時移除已不在 payload 的檔)、intake、舊設定載入時的警告。
- 小模型呼叫層:一致、不一致、亂回、回 PASS、當掉、輸入過大(用假的小模型)。

測試用的是假的 worker / agent / 小模型(`test/fixtures/`),在真的 git repo 裡跑。

**還沒驗過(第一次實際使用時請盯著看):**

- `test-fix` 棒在實跑中還沒被觸發過,只有自動測試涵蓋。
- 沿用的 v1 gate 包:在這台機器跑 118 個自我測試,全部通過。

## 這個 repo

```
tools/      dp CLI(零依賴),會被安裝進你的專案
payload/    dp init 寫進你專案的檔:規則、prompts、skills、docs/dp、契約範例、v1 gate 包
test/       自動測試
docs/       ARCHITECTURE.md(設計與理由)、adr/ADR-021
```

文件地圖:設計 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md);升級 → [MIGRATION.md](MIGRATION.md);
使用者流程 → `payload/docs/dp/WORKFLOW.md`;角色 → `payload/docs/dp/ROLES.md`;小模型驗收 → `payload/docs/dp/VERIFIER.md`。

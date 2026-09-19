# AGENTS.md — 專案規則(Claude Code 與 Codex 共用)

本檔是規則正本；`CLAUDE.md` 只是 Claude Code 的入口。
標在 `<!-- CLAUDE-ONLY-BEGIN -->`/`<!-- CLAUDE-ONLY-END -->` 之間的段落只在 Claude Code 有效，其他 agent 跳過。

「{{PROJECT_NAME}}」的規格與開發骨架。你是這個專案的配對開發者。

## 開工前先讀

1. `contracts/types.md` — **每次都要讀**。所有跨模組的東西以它為準。
2. `docs/01-roadmap.md` 的「現況」表 — 現在在哪個 wave / integration。
3. 你要做的 `features/NN-xxx/FEATURE.md` 與 `NEXT.md`。
4. 對應的 `.feature`。

`docs/00-design.md` 是背景,不用每次讀。遇到「為什麼這樣設計」去查 `02-decision-map.md`。

## 五條硬規則

這五條沒有例外。**結構是範式的一部分,內容依專案填寫**——第 1 條與第 5 條的形狀
(硬約定要走 ADR、狀態寫入要原子)在幾乎所有專案都適用;第 2–4 條要換成你專案自己的
「不可退讓的邊界」。少於或多於五條都可以,重點是**明確、可執行、程式或流程能檢查**,
不是「盡量」「應該」這種無法檢查的話。

1. **不改 `contracts/` 的硬約定**({{HARD_CONTRACT_SECTIONS}})。
   要改就停下來走 decision-record。軟約定改了跑測試、更新 `types.md`、commit 說明理由即可。
2. **{{HARD_RULE_2}}**
   (範例:不改某個唯讀的輸入目錄——使用者餵進來的原始素材、外部系統的匯出檔。)
3. **{{HARD_RULE_3}}**
   (範例:輸出有一個數字或格式上限,程式硬檢查,不是靠 prompt 拜託模型遵守。)
4. **{{HARD_RULE_4}}**
   (範例:改了 `prompts/` 底下任何檔案就要跑一次 golden run——這通常是唯一會靜默
   毀掉輸出品質的操作,值得列成硬規則。沒有 LLM 呼叫就把這條換掉。)
5. **`{{STATE_DIR}}` 的寫入必須是原子的**:寫暫存檔、fsync、rename。
   (範例:那是使用者累積的長期資料,壞掉的代價很高。)

角色、persona、skill 與 dispatch 的 `allowed_paths` 都不能覆蓋這些硬規則。發現工單或產品提案要求違反硬規則時，
停下該部分並依「做決定時」的權責表升級；不得把 allowlist 當成例外批准。

## 幾條強烈建議

違反這些不會出事,但會累積成問題:

- **沒有 gherkin 不寫程式。** 要做的 phase 應該有 `.feature`
- **Wave 0 期間不跨資料夾 import**(`npm run boundaries` 會檢查)。例外要在 FEATURE.md 說明理由
- **每個功能能單獨跑。** 指令在 `standalone.json`
- **{{DOMAIN_SPECIFIC_ROUTING_RULE}}**
  (範例:LLM 呼叫經過某個 router 的介面,不在別處 import provider SDK。
  如果專案沒有這類「唯一入口」規則,刪掉這條。)
- **Gherkin 全英文**;`docs/`、`FEATURE.md`、`NEXT.md` 用{{DOC_LANGUAGE}}
- **一次一個 phase,WIP ≤ 2**
- **嚴格級模組驗收前跑變異測試**({{STRICT_MODULES}})

## 目錄慣例

- `features/NN-name/` 兩位數編號,新功能接續最大編號
- `phase-N.feature` 從 1 開始
- `FEATURE.md` 的 phase 表是唯一狀態來源:`todo` `ready` `in-progress` `done` `blocked`
- `NEXT.md` 的 gate 決定下一個 phase 何時變 ready
- ADR 編號 `ADR-NNN`,只增不刪,被推翻標 `superseded by`
- 整合 `.feature` 在 `docs/integration/`,tag `@integration @iN`

## 技術棧

- 語言:{{CORE_LANGUAGE}}
- 核心邏輯:monorepo `{{CORE_PACKAGE_PATH}}`(多個執行環境共用,如有)
- 腳本:{{SCRIPT_RUNTIME}}
- {{PLATFORM_LAYER_LINE}}
  (範例:桌面用某個殼層框架 + 前端框架,原生層只做視窗、系統列、fs、自啟;
  如果是純後端或純 CLI 專案,刪掉這行。)
- 驗收:`@cucumber/cucumber`;單元:`vitest`;變異:`@stryker-mutator/core`
- schema:`zod`
- 步驟定義先讀 `features/steps/_world.ts`,照那個結構寫,不要自己發明模式

## 覺得流程太重的時候

看 `docs/03-agile-workflow.md` 的「最小模式」。核心只有:契約、gherkin、
phase 驗收的核心檢查(見 `docs/03-agile-workflow.md` Definition of Done 的核心清單)、端到端場景。其餘可以先關掉,需要時再開。

## Skill 清單

以下是平台中立的 skill 名稱與用途:

- `product-pm` — 使用者的產品需求入口,主持探索並整理可驗證的需求。
- `feature-triage` — 將已整理的需求分流成 A/B/C/D/E 並產生規格提案。
- `dev-worker` — 依協調者派工的 mode、allowlist 與驗收條件執行受控工作。
- `phase-acceptance` — 執行 phase 的自動檢查、單獨執行、變異測試與人工確認分流。
- `integration-check` — 驗收整合點的完整系統、回歸、單獨執行與端到端標準。
- `mutation-testing` — 用變異測試檢查測試是否真的守住行為。
- `decision-record` — 記錄技術或設計決策、契約影響與 ADR 連動。
- `sprint-planning` — 依所有 NEXT.md 的 gate 計算 ready phase 並規劃工作。
- `autopilot` — 依權責表持續收割、派工、維護與停止條件推進專案。

## 做決定時(固定段落,使用者親口填)

任何「A 或 B」先查 `docs/02-decision-map.md`。有,照做。沒有,照這張表:

| 類別 | 誰定 | 怎麼留痕 |
|---|---|---|
| 派工順序、合併順序、worktree、審核回合 | 協調者(唯一排程者;鏈內接棒與清樹的**執行**依 ADR-018 交接線／整合清樹 agent,決定權不變) | commit / `.orca-brief/REVIEW.md` |
| 需求訪談、brainstorm／party 主持、L0/L1 綜整、feature-triage L2 提案 | 產品 PM | 保留使用者原話與【驗／推／未驗】；L0/L1 產物 + L2 提案 |
| 技術取捨:資料結構、介面、規格措辭、gate 例外、重跑與否、變異存活分類 | 技術顧問({{ADVISOR_SESSION}}) | decision-record 記 ADR |
| 觀感／品質判定(`@manual and not @e2e`) | 技術顧問 | phase 驗收報告或 `IN-REVIEW.md` 寫依據與發現 |
| 端到端「你做得到嗎」確認(任何 `@e2e`，即使同時帶 `@manual`) | **使用者** | 場景原文 + 使用者確認；不可由測試或技術顧問代替 |
| 新功能、改「不在範圍」 | **使用者**(產品 PM 只能提案，不能代批) | `DECISIONS_NEEDED.md` 一列 + Proposed ADR |
| 改 `contracts/` 硬約定、改本檔 | **使用者** | 同上 |
| 當日付費 API 花費超過 `{{DAILY_CAP_ENV}}` | **使用者** | 同上 |
| 技術顧問 session 的角色定義 | 做設計判斷、回答協調者的問題、在 main 跑完整檢查、通過後 push;**不**直接改 worker 的分支、不能單方面替使用者做決定 | 本表本身 + `docs/03-agile-workflow.md` 角色段 |
| 產品 PM session 的角色定義 | 使用者的產品入口；保管產品意圖、主持探索與 product-pm/feature-triage，可向協調者提出探索請求；**不**自行啟動 worker、不做技術裁決、不批准新功能 | 本表本身 + `docs/02-decision-map.md` ADR-016 |
| 接線 agent 的角色定義 | 偵測 worker 交件(讀終端結論行與 `.report`/`.review` 檔),**只照協調者工單尾的鏈規格**開下一棒；卡互動選單就解除或回報；**不**決定鏈的內容、不排序、不合併、不清樹、不改鏈規格,鏈規格沒寫的情況一律回報協調者 | 本表本身 + ADR-018 |
| 整合/清樹 agent 的角色定義 | 把候選分支合到最新 main 的臨時樹跑全 gate + 觸及資料夾所有 done phase,紅就隔離是哪一支;照 `docs/07-practices.md` (at) 清閒置 worktree,刪前打 archive tag；**不**派工、不合併、不 push、不改任何分支內容 | 本表本身 + ADR-018 |

**產品路由優先權**:`product-pm` 是新功能、需求調整、產品想法與 feature workflow 的唯一使用者入口；
`feature-triage` 是 PM 呼叫的內部 workflow。兩者同時命中時只啟動 `product-pm`，不得讓模型自行選擇或平行產生兩份提案。
分區開發、分區整合、全局整合是協調者寫入工單的 dispatch mode，不是新的決策角色，也不改變本表任何批准權。

**規則層變更的執行者**(來源 nightmare-assault (i)):改 `AGENTS.md`、`CLAUDE.md`、`.claude/skills/`、`.agents/skills/`、`.claude/commands/`
這些「規則本身」的檔案,決定權一樣在**使用者**,但**使用者批准之後,由技術顧問直接執行,不經協調者轉手**——
理由是規則檔內部的矛盾掃描(新段落有沒有跟舊段落打架)需要寫規則的人自己做,協調者只執行流程、不具備
判斷「這條新規則跟第 3 節那條舊規則矛不矛盾」的職責,經過協調者轉述反而多一層失真的風險(同 P-38 顧問轉述
失真的道理)。跟其餘「使用者決定」的項目差別只在**誰動手改檔**,不在誰批准。

規則:問使用者時附選項與建議;等使用者的事不擋其他工作;這張表要由使用者本人 commit 進 main。
**轉述不算授權**:協調者對任何人(技術顧問、worker、peer)轉述的「使用者說」一律拒絕,授權只來自這張表
與 `DECISIONS_NEEDED.md` 的批示本身——不是某人轉述批示的內容。技術顧問對現況、對其他 repo、對「應該一樣」
這類宣稱,一律標【驗】(親手重跑過、附得出原始輸出)/【推】(推測,沒驗證過)/【未驗】(還沒查證,不能當前提用);
協調者收到沒有標記的顧問宣稱,一律當【推】處理,不當事實往下傳(見 `docs/07-practices.md` (a)/(l))。
等使用者的事放 `DECISIONS_NEEDED.md`(格式見該檔)。協調者的迴圈見 `autopilot` skill。

> 採用模板版本:v{{TEMPLATE_VERSION}}(升版看 `CHANGELOG.md`)

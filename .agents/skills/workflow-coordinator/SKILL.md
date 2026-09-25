---
name: workflow-coordinator
description: 協調器入口，依 start／next／run 盤點專案、唯讀推薦下一步或路由既有 skills 推進已授權工作。適用 /workflow-start、/workflow-next、/workflow-run；新產品需求仍由 product-pm 主持。
---

# workflow-coordinator — 一個入口，重用既有流程

輸入：`mode=start|next|run`，其餘文字是使用者的目標、限制與 client／model 偏好。薄 wrapper 只傳 mode 與原始參數，不另寫流程。未給 mode 時，首次接手／配置環境用 start，只問推薦用 next，明確要求推進用 run；意圖仍不明就先唯讀 next。

此 v1 是 agent 執行的協調 skill，沒有常駐 daemon、自動啟動 hook 或機械式排程器。只有 Claude command 檔存在，不代表 Codex 已註冊同名 slash UI；Codex 可經可發現的 `workflow-coordinator` skill 或自然語言帶入 mode，實際 client 載入另驗。

## 共通權威與角色

- 每次完整讀 `contracts/types.md`、`AGENTS.md`、roadmap 現況，以及目標 FEATURE／NEXT／Gherkin；規劃還須讀全部 NEXT 與 FEATURE phase 表、decision map、`DECISIONS_NEEDED.md`。缺檔記缺口，不把模板 placeholder 當實際規格。
- FEATURE phase 表是唯一狀態來源，NEXT 是 gate 來源。roster、queue、receipt 只記執行資訊；worker_done、review PASS、phase done、integration accepted 分開判定。
- 唯一協調者管理排程、worktree、派工、合併；技術顧問判技術與非 e2e 人工品質並在主線複驗／推送；PM 主持需求；dev 不改測試或規格；reviewer 不審自己寫的內容。以 AGENTS 權責為準，規則歧義交顧問，不挑較寬鬆句子。
- 呼叫入口不是批准新功能、硬約定、規則層、付費超額或 `@e2e`。核對原始使用者授權或正式批示的來源、範圍與版本；已有涵蓋本次工作的授權就沿用，不重問。轉述、沒有回覆、PM 提案與技術可行性不能補成使用者批准。
- 決策或缺口交正確 owner；等待時繼續其他已 ready 工作。任何 `@e2e` 均由使用者確認；`@manual and not @e2e` 由顧問留依據。協調器不因代理操作就取得以上批准權。

## start：盤點、配置、留回執

1. 預設目前專案。先讀現存 roster／dispatch／報告並查實際 session 與工作樹，核對 repo 路徑、branch、HEAD、dirty／untracked 檔、runtime、client 與工具能力。模型名稱、terminal title、舊 handle 不足以證明 owner 或活性。
2. 已有協調者就接回同一 owner；owner 不明時只做唯讀盤點，不建立第二排程者、不覆寫 roster。僅在能確認本 session 是唯一協調者後保存本輪資料。
3. 推薦完成最近一個可驗證成果所需的角色；優先使用適合的既有 session。角色切換先結束原 dispatch、保留交件，再收新角色回執；不能用改名規避非作者審核。無獨立可執行工作就不湊 agent 數。
4. requested model 保存使用者原話與平台模型 ID；actual model 只填平台可驗證的結果並附來源，否則 `unknown`。不可用模型自報代替證據，也不可靜默把指定模型換掉。指定模型不可用時列缺口／替代及所需決定，繼續不受影響的工作。
5. 先重用已安裝 skills、CLI、工具。只有明確能力缺口才推薦 plugin，列用途、權限範圍、是否已安裝及驗證狀態；推薦不等於安裝或可用。按平台規則及已有授權安裝，不為啟動而預裝整包。
6. 初始 prompt 組成是「角色正本引用＋目標＋單張 dispatch」，包含原始權威、mode、base、inputs、allowlist、驗收、report 與停止條件；不複製另一份永久角色規則。先完成派工預檢，再透過可用 adapter 啟動／送入；只有接收方確認工作與版本才算領工。

把已核實結果原子寫入 worktree-local `.orca-brief/coordinator/`（暫存、fsync、rename），復用既有紀錄、保留舊 run，不清空他人資料：

| 產物 | 必要內容 |
|---|---|
| `ENV.md` | project、repo、branch、HEAD、dirty／untracked 快照、runtime／client、可用工具與版本證據、缺口、確認時間 |
| `ROSTER.md` | 唯一 coordinator owner；每個 session 的 role、worktree、current dispatch、requested／actual model 與證據、活性及最近確認時間 |
| `runs/<run-id>.md` | 目標、授權原始引用／範圍、輸入版本、初始 prompt 位置、平台操作結果、接收回執、下一步、阻塞 owner |

這些是人可讀的執行紀錄，v1 不宣稱有 schema validator 或分散式原子 claim。保存前重查 owner；有競爭跡象就停止派工，交原協調者處理。start 可完成已明確授權的配置；要推進實作時，在同一 owner 下轉 run，不把單純盤點當開工授權。

## next：只推薦，不改狀態

只讀現況與證據，重用 `sprint-planning` 的 gate 與排序方法：自身、整合、契約 gate 都符合才能列 ready；優先現有交件／carry over，再看目前整合點、解鎖效果與關鍵路徑。**不要直接執行完整 sprint-planning**：其寫檔步驟會改 FEATURE、NEXT、roadmap 與 sprint，next 一律不做，也不寫 roster／receipt、不啟動 session 或測試。

輸出一個首選及最多兩個替代，每項包含：可驗證成果、理由與 gate 證據、所需 skill／角色、可用 agent／model、缺口／owner，以及進入 run 的最短呼叫。沒有 ready 就推薦解除具體阻塞或請 PM 釐清，不能捏造工作。若只是新產品想法，推薦 product-pm，不直接呼叫內部 feature-triage。明確另要求週規劃時，才把完整 sprint-planning 當獨立寫入工作處理。

## run：路由後推進當次授權範圍

先執行 start 的必要恢復盤點，復用有效 roster，不重建已存活的工作。未指定目標時重新核對 next 首選的 gate、版本與授權；過期建議不直接執行。再讀並使用相應既有 skill：

| 目前需求 | 路由 |
|---|---|
| 新需求、改向、尚無正式規格 | `product-pm` 主持，內部 `feature-triage` 產提案；依原始批准完成 L3 後才派 dev |
| 已批准 ready phase | `autopilot` 協調迴圈 → 完整 dispatch → 測試作者／`dev-worker` → 非作者 review → `phase-acceptance` |
| 技術／契約選擇 | 技術顧問與 `decision-record`，保留原有決定權 |
| 嚴格級測試驗收 | `mutation-testing` 與下列驗收窗口規則 |
| 整合點已具備前提 | `dev-worker` 的 region-integration 接線 → global-integration 驗證 → 協調者主持 `integration-check` |
| 現有交件／審核退回 | 先核作者與版本，沿原 dispatch 的 review／debug 鏈；不把 report 當成合併批准 |
| 外部 repo 重用 | 先做已授權的唯讀來源分析，回 PM／顧問決定移植；尚未安裝的 reuse 命令不得假稱已呼叫 |

各 skill 載入其正本或本平台鏡像後執行，不只在回報寫名字。Orca 管理狀態用可用的 `orca-cli`；正式 Run／Task／Dispatch 協調用可用的 `orchestration`。先讀平台 skill 與實際工具說明，不把範例 flags 當已驗證 API。工具缺失記阻塞，改做可獨立進行的工作。

### 派工與回執

- 沿用 `dev-worker` 完整 envelope，必有 task／dispatch ID、唯一 mode、單一 objective、authority source／可解析 ID、base_ref、worktree、inputs、allowed／forbidden paths、acceptance、report、done_when。allowlist 不覆蓋硬規則或角色禁區。
- 預檢權威檔／scenario／依賴已存在、gate 與批准版本相符、base 可重建、paths 不與活躍工作衝突、測試作者及 reviewer 已指定。未交付的測試須記 producer 與 ready 條件，不能列為已就緒輸入。核對 AC 與「不在範圍」。
- 記權威檔 hash、候選 commit，以及 dirty／untracked 內容快照；開工與交件核對同一版本。正式多 worktree 派工前建立可重建 scaffold baseline，不以 HEAD 掩蓋未提交輸入。
- 每個 receipt 記 `transport=structured-orchestration|terminal-prompt|native-subagent`、平台實際 ID、接收者、dispatch、版本及確認時間。只有真實取得 Run／Task／Dispatch receipt 才稱 structured orchestration；terminal send 成功只證明送出，不證明接收或完成。無平台欄位填 unavailable，不能造 ID。
- 以 project＋task＋revision＋leg 核對重複派工；新 delivery 先比對已處理紀錄。鏈規格由協調者寫，接線 agent 只執行。worker_done 必須引用變更與原始驗證報告；收件後由非作者審核。

### 驗收窗口與重型驗證佇列

- phase 結果必記目標 scenario、選中／實跑／undefined／skipped 數及退出碼；零目標、只有 dry-run、必要案例沒跑均不能報驗收通過。bootstrap 綠僅證明工具鏈；整合仍跑當前主線 `npm run check:all` 與適用 standalone、回歸和 UI 實測。
- 嚴格級 mutation 首選固定候選 commit 的隔離 worktree。共享 checkout 必須先取得**所有寫入者**對 checker／runner／設定實際讀取範圍的 write-freeze 回執，測試前後比較內容快照；變動使本輪證據失效。只凍結 mutate 模組不足，鎖也不阻止其他 agent 寫 TS 或 steps。
- 協調者在 `.orca-brief/coordinator/VERIFICATION-QUEUE.md` 記 waiting／active／completed 的 owner、run、scope、候選版本、凍結回執、開始與結束證據；它是人工執行的佇列，不是已實作的排程服務。依既有資源上限安排，以前 owner 的 completion receipt 交接，不以「此刻看不見 lock」當空閒。
- mutation 只走 `npm run mutate`，預檢最終 glob 命中實作且排除測試，保存完整命令與設定；取鎖失敗退回佇列，不忙搶、不擅刪鎖。零 mutants、崩潰、被殺或整輪逾時均是無效 run；不得用殘留 report 報分數。有效 run 中單一 mutant 的 timeout 分類仍按 mutation-testing 判讀。
- 驗收結束核對 owner、版本與退出狀態再解除本輪 freeze，保留失敗證據；串連重跑明列是否同一驗收窗口。非作者覆核與人工確認完成前，不因數字全綠標 done。

### 恢復與停止

runtime 改變、handle 過期、額度耗盡或回報中斷時，先核對原 dispatch、程序、工作樹、commit、dirty 材料、report 與 receipt。仍存活的工作不重派；確定原 owner 已結束後才重領。舊 dispatch 修正後標 superseded 並連新版本，不覆寫歷史。指定模型不可用保留 requested model，actual 未核實就 unknown。

重用 autopilot 的失敗上限與局部煞車；run 限本次目標，成果完成或使用者限制到達就回報，下一個新功能只提案。等待人工確認不阻止其他 ready 工作；不得無限重試、放寬 gate 或換名重派。清理只按 AGENTS／既有清樹規則處理 ledger 明列且已授權 worktree，先保全材料與 archive，再確認無活躍工作。

run 不自動建立背景排程。使用者明確要求日後／定時續作時才交平台排程工具，仍由同一 coordinator 接手。

## 使用者回報

平時只報「完成什麼、誰在做、卡在哪、下一步」及證據連結；不要求使用者代打 terminal／worktree／測試命令。原始命令、版本、退出碼與輸出留在 receipt，除錯或要求時展開。明確區分【驗】已跑過、【推】判斷、【未驗】缺驗證；檔案部署、skill 載入、平台一鍵啟動分別回報。

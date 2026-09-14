# 候選 #25:多 session 分工(4 個 session + 4 份啟動 prompt)

來源:AI_KM 技術顧問,2026-09-14。**尚未批准,素材。**
⚠️ 提案方自己標明:使用者在 AI_KM 那邊說「可以把這個工作模式告訴 dev-paradigm,引導用戶開啟至少 4 個 session,
給予 4 個 prompt」——**那是轉述,依本範式規則不算授權**,提案方要求當成候選交 dev-paradigm 的使用者與技術顧問裁。

標記:「量過」= AI_KM 2026-09-14 實測;「推」= 提案方推論。dev-paradigm 協調者**沒有親自重現**,對本 repo 而言全部是【推】。

## 一、提議的分工(AI_KM 現行)

| session | 週期(錯開) | 職責 | 不做 |
|---|---|---|---|
| 協調者 | 15 分 :04/:19/:34/:49 | 跨節點排序、組批、唯一 merger、推 mirror、活躍 agent ≤12 | 鏈內接棒、清樹、裁決 |
| **接線 agent(新)** | Monitor 每 2–3 分 + 巡檢 15 分 :08/:23/:38/:53 | 偵測 worker 交件 → 同節點鏈內接下一棒(測試紅→開發→非作者審核→通知可收批) | 排序、合併、清樹 |
| **整合/清樹 agent(新)** | 15 分 :11/:26/:41/:56 | 合併到最新 main 的臨時樹跑全 gate、分支漂移監控、清閒置 worktree(ledger) | 派工、合併 |
| 技術顧問 | 20 分 :17/:37/:57 | 合併後獨立重驗、契約/產品裁決、merge 證據抽查、WIP/漂移/狀態失真監督 | 寫文件、改碼 |

## 二、提案方量過的理由(原文要點)

1. worker 多在 20 分內完工,**瓶頸是「交件→收件→下一棒」的等待**;13 個 worker 曾有 8 個完工閒置無人收。
2. 分支落後 main 243/320 顆時,合併衝突與漏改(契約 enum、done phase 場景字面值)集中出現;**高 WIP ≠ 快**。
3. 審核只在分支上測自己新增的東西,**兩次漏掉跨模組迴歸** → 固定條款:審核須在「main + 分支合併後」的臨時樹跑全 gate
   + 觸及資料夾的 done phase;動 session/角色語意加跑 e2e。
4. 作者自驗的反向驗證被當審核證據合入**兩次** → 嚴格級一律非作者重做,失敗原文進 merge body 或 evidence 檔。
5. 背景長跑的 gate 被 Claude Code session 的記憶體管理**砍掉兩次**(系統實際仍有 19G)→ 用 `setsid nohup` + done 檔 + Monitor。
6. worker 在遠端工作樹 `git push origin`(origin = 會起 CI 的 mirror)**誤觸 CI 兩次** → 工單固定「禁 push origin,交件只 commit + 印終端」。
7. 清閒置 worktree:條件「分支是 main 祖先」會**誤判剛開、尚未 commit 的新工作樹** →
   需「自己的 commit 已進 main」+ 終端 ≥60 分無輸出 + porcelain 只剩已歸檔 brief。

## 三、四份啟動 prompt(提案方草稿,雙大括號為 template 變數)

(全文保留在 DECISIONS_NEEDED #25 對應的 AI_KM 訊息;要點:)
- **協調者**:cron 15 分;只合「合併後樹全 gate 逐行原文 + 嚴格級非作者審核 + 角色守門輸出」的批;活躍 agent ≤12;
  in-progress 分支每 2 小時同步 main、落後 >50 先同步;工單固定開發不碰測試/規格/共用檔、禁 push origin。
- **接線 agent**:Monitor 偵測 lastOutputAt 與完工訊號,只在同一節點鏈內接下一棒;卡互動選單就解除或回報;巡檢 cron 確認 Monitor 存活。
- **整合/清樹 agent**:把候選合到最新 main 的臨時樹、setsid nohup 背景跑全 gate、紅就隔離是哪一支;列分支落後顆數;照 ledger 清 worktree。
- **技術顧問**:cron 20 分;裁決收件匣;合併後獨立重驗(無快取);merge 證據抽查,缺就要求補或 revert;監督 WIP、漂移、狀態表失真。

## 四、提案方建議的落點(推)

`docs/05-parallel-and-integration.md` 加「多 session 分工」段 + 新增 `docs/session-prompts/` 四份 prompt
+ `CLAUDE.md` 權責表加兩列(接線、整合/清樹)。

## 五、dev-paradigm 協調者的評估(給使用者裁決用)

**跟已批准的規則直接衝突的地方(要使用者裁,不能由協調者或顧問放行):**
- **ADR-016 條件 2「協調者是唯一 session/worktree 排程者」**:「接線 agent」在鏈內接下一棒 = 派工;
  「整合/清樹 agent」清 worktree、代為同步分支 = worktree 管理,決策權表明列歸協調者。**兩個新角色都會變成第二、第三個排程者。**
- **ADR-016 條件 1 與使用者 09-10 的原話**「我只想和技術顧問、產品 PM 聊天,其餘 session 交給協調 agent 控制」:
  提案的形狀是**使用者親自開 4 個 session、貼 4 份 prompt**,而且 4 個裡沒有產品 PM。拓撲不同。

**跟既有規則相容、而且有實測的部分(可以跟角色拆開單獨收):**
上面二、的 3~7 條——合併後樹審核、嚴格級非作者重做、長跑 gate 用 setsid nohup、工單禁 push origin、worktree 清理條件、
分支落後門檻。這些不需要新角色,可以進 `PITFALLS.md` / `docs/07-practices.md` 與 `.orca-brief/TASK.md.template`(#22 的樣板)。
**第 1、2 條(瓶頸是交件等待、高 WIP 不等於快)是這整個提案的核心論據**,值得先問:在「協調者是唯一排程者」的前提下,
能不能用「協調者用 Monitor 事件驅動收件、而不是 15 分鐘輪詢」解決同一個瓶頸,而不新增排程者?

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

---

## 六、模板現況對照(2026-09-14,AI_KM 問「模板有沒有已經做完整」,協調者逐項 grep 查證)

AI_KM 追加了 7 條已在執行的優化(傳菜員接線、在製品上限、清舊分支、一個功能一口鍋、自動記帳、重活搬大機器、兩條審核規則),
並問模板是否已有 (a)~(e)。**【驗】以下每條都是 grep 模板 docs/、CLAUDE.md、PITFALLS、skills、工單樣板後的結果。**

| 項目 | 模板現況 | 缺什麼 |
|---|---|---|
| (a) 在製品上限 / 整合優先停線 | **部分有**:`CLAUDE.md`「WIP ≤ 2」;`docs/07-practices.md` 890 起「WIP ≤ 2 → 同開上限 = ready 集合大小」,代價由三條吸收(一次合一條、rebase 由協調者吸收、審核輪 ≤ 1);`autopilot` §2 第 3 步 | **沒有「未合入交付物上限」與「超過就停止派工、產能轉整合」**。模板限的是**開工**(ready 集合大小)和**合併節奏**(一次一條),沒限**做完卻還沒合的量**。【推】「同開上限 = ready 集合大小」加「一次合一條」這個組合,**正好會製造 AI_KM 量到的症狀**(開得多、合得慢、完工閒置) |
| (b) 熱點共用檔解耦 | **部分有**:ADR-014「共用檔只有協調者改」(package.json、lock、tsconfig、standalone.json、`_world.ts`、`common.steps.ts`…)與「跨資料夾的 gherkin 句子只在 common.steps 定義一次」;「組合層」概念(`docs/05`、`docs/01-roadmap.md`、ADR-004) | 模板的做法是**序列化**(只有一個人能改熱點檔),**沒有解耦慣例**(把熱點檔改成每個能力自己註冊,讓大家根本不必改它)。AI_KM 的 #4「server.ts 只遍歷能力註冊表」是新的 |
| (c) merge 證據自動產生 / 機械檢查 | **只有規範,沒有機械化**:工單樣板「四段輸出(突變/紅訊息原文/sha256/回綠)進 commit body」;P-15(判定只看退出碼與明確成功訊息,數字審核輪要重跑);P-28(反向驗證的腳本要在 repo 裡) | **沒有產生器、沒有檢查 merge body 完整性的 gate**。AI_KM 的 #5 是新的 |
| (d) 分支漂移上限 | **部分有**:工單樣板與 07-practices (ag)「續用舊 worktree 看紅燈前先 `git merge main`,不 rebase」;`autopilot`「rebase 由協調者吸收」 | **沒有數字門檻或同步頻率**(落後幾顆必須同步)。另外查到**模板自相矛盾**,見下 |
| (e) 閒置 worktree 清理 / archive tag 可逆刪除 | **幾乎沒有**:`autopilot` §2「全綠 → tag 打在合併 commit、清 worktree」——只有**合併後**清,沒有閒置判定條件,也沒有刪前打 archive tag | AI_KM 的 #3 是新的;他們量到的坑(「分支是 main 祖先」會誤判剛開、未 commit 的新 worktree)也是新的 |
| 規則 7:審核在「main + 分支合併後」的樹跑 / 嚴格級非作者重做 | **沒有**:grep「非作者」「合併後的樹」零命中。工單樣板要求反向驗證,但沒要求非作者、也沒要求在合併後的樹 | 新的 |
| #6 重活搬大機器 | **相關但不同**:`autopilot` 的 `{{PARALLEL_CAP}}`(同時跑幾份變異測試由使用者填,3 份約 OOM 臨界)、審核輪 ≤ 1 | 模板只限**同時幾份**,沒有**移到別台機器**的做法 |

### 查的時候撞到的模板矛盾(登記為 DECISIONS_NEEDED #26)

【驗】`.claude/skills/autopilot/SKILL.md` **同一份檔案內**:
- 第 63 行:合併 `git merge --no-ff <branch>`,「**不 rebase**,每個 phase 三輪 commit 的軌跡是刻意留的」;
- 第 92-93 行:「**rebase 由協調者吸收**(worker 的分支落後 main 時,**rebase 這件事由協調者做**)」。
而 `.orca-brief/TASK.md.template:86` 與 `docs/07-practices.md:770` 寫的是「`git merge main`(**不 rebase**)」,
`docs/07-practices.md:903` 又是「rebase 由協調者吸收」。【推】92-93 行想說的多半是「**同步落後的分支這件事**由協調者做」,
動詞用錯了;但照字面執行的協調者會去 rebase,毀掉第 63 行刻意保留的三輪 commit 軌跡。

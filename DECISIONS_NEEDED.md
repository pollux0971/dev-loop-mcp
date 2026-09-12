# DECISIONS_NEEDED — 等使用者的收件匣

只放**決策權表裡歸使用者**的項目。每列一件,協調者或顧問寫,使用者一句話批。批完搬到「已批示」並記 ADR(若是決策)。
技術取捨不放這裡(問技術顧問,記 ADR)。

**編號規則**(來源:nightmare-assault 踩過編號碰撞,見 `PITFALLS.md` P-59 的變體):
- **編號永不重用**,包含已經搬到「已批示」的項目——編號一旦用過,即使那筆事項後來作廢,那個號碼也不再發給別人。
- **下一個編號 = 整份檔案(待批示 + 已批示兩區都算)目前最大編號 + 1**,不是「待批示表看起來空的那個號碼」。
  不要手動挑一個「中間看起來空著」的號碼——這正是 `PITFALLS.md` P-14(建編號檔覆蓋既有檔)同一個病灶在編號欄位的版本。
- 條目**不限於表格的一列**:一件事項如果需要附選項的詳細說明、多段落的背景,可以用多行的區塊寫(標題帶編號),
  不必硬塞進表格的一個儲存格;表格列適用於一句話能講完的事項。
- **不給不擋**:待批示的項目沒被批示之前,永遠不擋其他工作——協調者的迴圈照常推進其餘 ready 的 phase,
  只是這件事項本身按下不動;沒有裁決之前,迴圈維持在**保守狀態**(定義見 `PITFALLS.md` P-57:一次
  `git revert` 就能整個還原的那個選項),不會因為等待而自己選一個方向往前走。

**命名**:本檔在別的採用專案可能叫別的名字(例如 nightmare-assault 叫 `PENDING.md`)——內容與規則跟這裡一致,
只是檔名不同;採用模板時不強制跟 `DECISIONS_NEEDED.md` 這個檔名一樣,但同一個專案裡只能有一份,不要兩個檔名並存。

## 待批示

| # | 日期 | 事項(一句話) | 選項與建議 | 影響(擋什麼) | 提出者 |
|---|---|---|---|---|---|
| 8 | 2026-09-12 | `PITFALLS.md` 要不要加一條規則:**條目正文的絕對句,要嘛降級成帶條件的敘述,要嘛當場寫出量測條件**?並做一支可機械化的守門掃它 | **單一提案(原提案方已撤回加欄版本,不再是二選一)**。動機:「把當時量到的狀態寫成現在的性質」今天累積三個實例(export 無效、機器負載寫成程式性質、ListAgents 快照當現在式),按 P-78「同一個警告寫到第三次就該改結構」。原案是加第 6 欄「量測脈絡」,**被雙方判定為壞解**——它靠「空著很明顯」運作,但回溯 89 列後大半是「—」,一個大半是「—」的欄位就不再明顯,**機制會被自己的填充率消滅**。改成只擋絕對句:涵蓋全部三個實例,回溯成本 0(grep 得到),而且要求的是「把話說對」不是「多填一格」。命中時的修法**預設是降級成帶條件敘述**,不是貼一段罐頭脈絡。掃描字串清單專案 A 已提供。**附帶**:提案方撤回時抽出一條更泛用的教訓(「機制的有效性依賴使用率,而設計又保證使用率會低」+ 三個檢查點),素材在 `.orca-brief/proposals/self-diluting-mechanism.md`,建議與本案一起落地 | 不擋任何事;要做是 1.7.0 | 技術顧問 llm-learning-cards-3d 提案並自行撤回加欄版,ARIA 評估 |
| 9 | 2026-09-12 | `check-dry-run.ts` 要不要在啟動時比對 `gates.config.json` 的 `dryRun.tags` 與 `package.json` 驗收 script 的 tag 運算式,不一致就警告? | A(**我建議**)做,1.7.0。**理由**:段 A 的全部意義是「驗收 job 會跑的那批現在就要可跑」,兩處一旦不同步,這道 gate 就在保證一個**不存在的集合**——綠燈但什麼都沒保證,跟 `check:gates` 接線檢查(裝了沒接)是同一種病。**這是行為變更,要 minor** / B 只在文件寫明「兩處要逐字相同」,不做程式檢查(就是提案方說的最低版本) | 不擋現有 gate;1.7.0 範圍 | 同上 |
| 10 | 2026-09-12 | 守門/測試 runner 的機器可讀標記行,要不要在**行尾**自動蓋一個 `load=` 欄位(`gate=boundaries result=PASS scanned=211 **load=5.74**`)? | A(**我建議**)做,1.7.0。**理由**:1.6.0 才收的 (am)「逾時理由要附 `uptime`」是一條**給人遵守的規則**,而它的作者在警覺性最高的那一刻就沒守住(專案 A 實例,真跑 load 12.47)。**要求人在正確的瞬間做正確的事是最脆的規則**——沒有第二次機會,而且**漏掉長得跟「不適用」一模一樣**,事後查不出來。成本是一行 `os.loadavg()[0]`,換成結構保證。**施工要小心**:標記行加欄位會打到所有解析它的東西(`verify-against.sh`、consumer 斷言、junit 腳本),加欄位前先 grep 誰在讀,**且一律加在行尾** / B 不做,維持靠 (am) 那條紀律 | 不擋任何事;行為變更,要 minor | 技術顧問 llm-learning-cards-3d(經 ARIA 評估);素材 `.orca-brief/proposals/ephemeral-observations-auto-stamp.md` |
| 11 | 2026-09-12 | 要不要收「**暫時措施要有退場條件**」,並給 **consumer 的自救設定(workaround config)**一個正式地位(**允許自救,但要求標註上游條件**)? | A(**我建議**)收,1.7.0,寫成 `PITFALLS.md` 條目並與 #8 相鄰互指。**理由**:按 P-78「同型第三次即升類」已超標——同一天四個載體各撞一次(逾時放寬、TODO 狀態宣稱、暫時放寬登記、自救設定)。自救設定的毒性形狀特別:**它會變成沉默的分歧點,上游改變主意 consumer 永遠不會知道,因為本地覆蓋把差異蓋掉了**;但它的退場條件天然可查(「上游哪一版修好」),沒理由不寫。**「允許自救但要求標註」比「請回報上游、不要自己改」實際**——後者在上游沒修之前會逼人偷偷改 / B 不收 | 不擋任何事;1.7.0 | 技術顧問 llm-learning-cards-3d(經 ARIA 評估);素材 `.orca-brief/proposals/temporary-measures-exit-conditions.md`(內含 #8 的第四個實例) |

## 已批示

| # | 批示 | 日期 | 落地(ADR / commit) |
|---|---|---|---|
| 1 | **A** — 先產「BMAD 29 支 skill 逐一分類」對照表 ADR,使用者看過分類再決定動哪些規則層檔案 | 2026-09-10 | ADR-015 (proposed) |
| 2 | **A** — 批准四條組織架構條件:(1) PM 是使用者的產品入口,新功能仍由使用者批准;(2) ARIA 是唯一 session/worktree 排程者,PM 只能發起探索請求;(3) 分區開發/分區整合/全局整合是 dispatch mode 不是角色,分區整合不可改分區內部,全局整合預設只驗證;(4) `/feature` 確認 gate 是探索素材變成權威規格的唯一界線 | 2026-09-10 | ADR-016(待寫) + ADR-015 修訂 |
| 3 | **B** — 批准規則層檔案層級變更五個檔全做:新增 `.claude/skills/product-pm/SKILL.md` 與 `.claude/skills/dev-worker/SKILL.md`;修改 `.claude/skills/feature-triage/SKILL.md`(加 L0~L3 權威階梯、主持人改 PM、收成 PM 的內部 workflow)、`CLAUDE.md`(角色表加產品 PM、可用指令加新 skill)、`.claude/skills/autopilot/SKILL.md`(協調者迴圈認得三種 dispatch mode)。執行者依 CLAUDE.md 為技術顧問 NOVA,不經協調者轉手 | 2026-09-10 | 依 ADR-016;ADR-015 相關列可由 proposed 轉 accepted 的範圍僅限本列五檔 |
| 4 | **A** — `@manual`/`@e2e` 人眼確認**拆成兩列**:觀感/品質判定→技術顧問(寫 `IN-REVIEW.md`);`@e2e` 端到端「你做得到嗎」→**使用者**。四處表述統一:`CLAUDE.md`、`.claude/skills/autopilot/SKILL.md`、`phase-acceptance`、`integration-check`。執行者為技術顧問 NOVA | 2026-09-10 | 待 ADR |
| 5 | **B** — 新功能:把本模板做成 **npm 套件**,支援 `npx <pkg> init` 一行部署(skill + `contracts/` + `features/` 骨架 + `scripts/` 守門腳本 + `package.json`),不是只做 plugin marketplace,也不是只靠第三方 `npx skills add`(那只裝 skill 裝不了骨架)。已知前置:`package.json` 現為 `name: {{PROJECT_NAME}}` / `private: true`,需先解決模板檔與套件檔分家 | 2026-09-10 | `/feature` L2 已確認(2026-09-10,PM):v1 只支援 greenfield、init 不自動 npm install/git init、套件先 private、payload 以 README 五步驟為準、CLI flag + 互動問(有 --yes)、npm version 綁根目錄 VERSION;三階段(A 打包計畫/B init 主程式/C 黑箱測試),不建 `features/NN`(本專案自身不用該機制,比照 sync-gates.sh/P-85 先例走 `scripts/`+ADR)。詳見 MAILBOX.md「PM → ARIA」。ADR 待 A 階段完成後補記；**A 階段已完成(2026-09-10,worker NPX-A@gpt-5.6-luna high,分支 `npx-init-a`)**:`package/` 發布殼骨架 + `payload-manifest.json`(glob 不寫死數量) + `cli.mjs` stub;硬指標 `npm pack --dry-run` 通過。**已知待辦**:`package/package.json` 的 version 目前是寫死複本,使用者裁決(2026-09-10)由 **B 階段的建置流程從根 `VERSION` 讀出並加一致性 gate**,不另開工單。 |
| 6 | **合併** — `bmad-integration-and-npx` 與 `npx-init-a` 兩條分支都併進 `main` | 2026-09-12 | merge commits 4cbac58(規則層)、6441520(npx 三階段) |
| 7 | **`pollux-dev-paradigm`** — npm 套件最終名稱 | 2026-09-12 | `package/package.json` 的 `name` 與 `bin` key 兩處已改;黑箱測試 4/4 綠 |

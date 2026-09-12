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
| — | — | (目前無待批示事項) | — | — | — |

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

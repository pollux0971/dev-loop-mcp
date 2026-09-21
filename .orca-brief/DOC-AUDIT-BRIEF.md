# 工單：文件去蕪存菁審計（只讀）

派工者：技術顧問。**只讀不改**，唯一能寫的檔案是 `.orca-brief/DOC-AUDIT-REPORT.md`。不 commit。做完印 `AUDIT DONE`。
注意：另一個 worker 同時在改 `CLAUDE.md`、`docs/03-agile-workflow.md`、`scripts/README.md`、
`.claude/skills/autopilot/SKILL.md`、`package/README.md`、`CHECKLIST.md`、`VERSION`、`CHANGELOG.md`、`package/package.json`，
這些檔案請用 `git show HEAD:<path>` 讀 HEAD 版本，避免讀到半成品。

忽略 `BMAD-METHOD-main (1)/`、zip、`node_modules/`。

## 目標
使用者想「去蕪存菁」：找出**死文件**和**廢話**，給出刪／合併／縮／留的建議。你只提建議，不動手。

## 請做四件事

### A. 死文件
對 repo 內每個 `.md`、每支 `.claude/skills/*/SKILL.md`、`docs/**`、`features/**`、`contracts/**`、`.orca-brief/**`、`package/**`、`scripts/**/*.md`：
- 有沒有任何其他檔案引用它？（`grep -rn "<檔名>"`）
- 它是不是被 `payload-manifest.json` 或 `sync-gates.sh` 出貨？（沒出貨又沒人引用 = 候選死檔）
- 內容是不是全部 placeholder、或已被別的檔取代（找「superseded」「已移到」「見 X」這類字）
- `.orca-brief/` 底下哪些是協調歷史（MAILBOX.md 98K、REVIEW.md、PM-BRIEF.md、dispatch/、drafts/、proposals/），
  逐個看：還有活的用途嗎？還是純歷史？有沒有被 git 追蹤（`git ls-files .orca-brief`）？

### B. 廢話與重複
重點看四個大檔：`PITFALLS.md`（93K）、`CHANGELOG.md`（97K）、`docs/07-practices.md`（近千行）、`DECISIONS_NEEDED.md`（20K），
以及 `README.md`、`CLAUDE.md`、`docs/00~06`、九支 SKILL.md。找：
- 同一條規則／警告在 ≥2 個檔案各講一遍（列出所有位置，建議留哪一份、其他改成一行引用）
- 一段話反覆說同一件事、或用大量鋪陳講一句話就能講完的（給行號範圍與「可縮成」的一句話）
- 「三個專案都…」「第 N 次…」這類敘事性回顧，判斷是規則（留）還是故事（可移到 PITFALLS 或刪）
- PITFALLS 裡互相重複或已被後面的 P- 條目取代的舊條目（列 P- 編號對）
- SKILL.md 裡跟 `CLAUDE.md`／`docs/03` 重複的流程描述
- 已完成、已落地、已 superseded 的待辦／提案還留在正文的

### C. 大小盤點
`wc -c` 每個 `.md`，由大到小列前 20，每個一行：用途、最近一次 commit 日期（`git log -1 --format=%ad -- <path>`）、你的建議。

### D. 給使用者的決定清單
最後一節按「刪／合併／縮／留」四類彙整，每條：路徑、行號範圍、現在幾行、建議、預估能省幾行、風險（誰在引用它）。
排序：省最多、風險最低的在前。**不要建議刪任何 ADR、任何 P- 條目正文、任何 `contracts/`**（那些是紀錄），
只能建議「縮」或「合併」。

每個宣稱標【驗】（親手 grep／讀過）或【推】。報告完整，不偷工減料。

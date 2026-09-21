# 工單：專案全面理解（只讀）

你是技術顧問的研究助理。請完整讀懂 /data/python/dev-paradigm 這個專案，寫一份繁體中文的專案理解報告。
**只讀不改**：唯一允許寫的檔案是 `.orca-brief/SURVEY-REPORT.md`。不要 commit。

專案背景：這是一個「AI 配對開發範式」的模板 repo，被其他專案採用。它不是一般應用程式，
核心是文件、規則、skill、腳本與 gherkin 骨架。

忽略 `BMAD-METHOD-main (1)/` 目錄與同名 zip，那是使用者暫放的外部資料。

## 請依序讀

1. `README.md`、`CLAUDE.md`、`VERSION`、`CHECKLIST.md`
2. `contracts/types.md`、`contracts/README.md`、`contracts/fixtures/`
3. `docs/00-design.md` ~ `docs/07-practices.md`、`docs/integration/`、`docs/sprints/`
4. `docs/02-decision-map.md` 全部 ADR（列編號 + 一句話）
5. `features/README.md`、`features/_template/`、`features/steps/_world.ts` 與其他 steps
6. `.claude/` 底下所有 commands、skills、agents、settings（`find .claude -type f`）
7. `scripts/` 每支腳本的用途、`package.json` 所有 npm scripts
8. `package/` 目錄與 `template/`（如存在）：模板發布機制；`CHANGELOG.md` 最近 5 版重點
9. `PITFALLS.md` 的結構與最近 10 條 P-編號
10. `DECISIONS_NEEDED.md` 待使用者決定的項目
11. `git log --oneline -30`、`git status`

## 報告格式（繁體中文 Markdown，寫到 `.orca-brief/SURVEY-REPORT.md`）

## 1. 專案一句話 + 它解決什麼問題
## 2. 目錄地圖（每個頂層目錄一行）
## 3. 角色與權責（使用者 / 產品 PM / 協調者 / 技術顧問 / worker；引 CLAUDE.md 的表）
## 4. 開發流程（feature → phase → gherkin → phase-done → integrate 完整迴圈）
## 5. 五條硬規則與強烈建議（原文摘要）
## 6. 契約系統（types.md 硬/軟約定怎麼分）
## 7. 所有 .claude commands / skills 一覽表（名稱、誰能用、做什麼）
## 8. 所有 scripts 一覽表（名稱、npm script、檢查什麼）
## 9. 模板發布機制（package/、VERSION、npx 分發、CHANGELOG）
## 10. ADR 清單（編號 + 一句話）
## 11. PITFALLS 最近 10 條摘要
## 12. DECISIONS_NEEDED 待決項目
## 13. 現況（roadmap 現況表、git 最近動態、未追蹤檔案）
## 14. 我發現的矛盾、過時或可疑之處（文件互相打架、腳本與文件不一致、README 指令跑不動），每條附檔案路徑與行號
## 15. 技術顧問接手時最該先知道的 10 件事

每節都要具體、附檔案路徑。第 14 節最重要，請認真找。報告要完整，不要偷工減料。
每個宣稱標【驗】（親手跑過）或【推】（推測）。
寫完後在終端印一行 `SURVEY DONE`。

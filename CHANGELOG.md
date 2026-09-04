# CHANGELOG

版本規則(semver):PITFALLS / docs / 措辭改動升 **patch**;新增或改變檔案結構、腳本、CLAUDE.md 固定段落升 **minor**;改硬規則或落地步驟升 **major**。
採用模板的專案在自己的 `CLAUDE.md` 記「採用模板 vX.Y.Z」;升版時用
`git diff <採用版 tag>..<新版 tag> -- template/` 決定要不要跟。每個版本打 tag `template/vX.Y.Z`。

## 1.0.1 — 2026-09-04

- 六支守門腳本的 ROOT 改用 `git rev-parse --show-toplevel`(退回 `process.cwd()`)解析,抽成共用模組 `scripts/_root.ts`,腳本可直接從模板路徑對目前 cwd 所在的 repo 執行,不必先複製進去
- `check-doc-links` 掃描根改聯集加 `.claude/`(排除 `.claude/worktrees/`)——agent 每次載入的 commands / rules / skills,壞連結比一般 docs 更貴

(來源:專案 B 對照回饋)

## 1.0.0 — 2026-09-04

第一個有版本的發布。內容累積自三個專案(A:本 repo,greenfield;B:AI_KM;C:nightmare-assault,皆 brownfield)兩天的實戰。

- 結構:CLAUDE.md(含決策權表與 DECISIONS_NEEDED 格式)、contracts/、docs/00–06、features/(_template、steps)、scripts/(check-boundaries、check-standalone、check-step-dup、check-gherkin-dup、check-phase-coverage、check-doc-links)、standalone.json、cucumber/vitest/stryker 設定、.claude/skills/ 七個(六個流程 + autopilot)
- PITFALLS P-01 ~ P-32
- docs/06-brownfield:greenfield 與 brownfield 的切入順序

## 0.x — 2026-09-03 ~ 09-04(未版本化)

從專案 A 抽出;逐日加入 P-01..P-29、autopilot、角色分工、brownfield 心得。歷史見分支 `template/dev-paradigm` 的 commit。

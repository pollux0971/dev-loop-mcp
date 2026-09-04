# CHANGELOG

版本規則(semver):PITFALLS / docs / 措辭改動升 **patch**;新增或改變檔案結構、腳本、CLAUDE.md 固定段落升 **minor**;改硬規則或落地步驟升 **major**。
採用模板的專案在自己的 `CLAUDE.md` 記「採用模板 vX.Y.Z」;升版時用
`git diff <採用版 tag>..<新版 tag> -- template/` 決定要不要跟。每個版本打 tag `template/vX.Y.Z`。

## 1.2.0 — 2026-09-05

- `check-boundaries.ts`、`check-standalone.ts`、`check-doc-links.ts` 三支以主 repo(採用專案)的版本為準重寫,補回舊模板版少掉的功能:`check-doc-links.ts` 換成真正的 CommonMark 圍欄規則(收尾圍欄無 info string 且長度 ≥ 開頭、`~~~`、最多 3 格縮排、inline code 用配對掃描而不是非貪婪 regex);`check-boundaries.ts` 補 `--root`、`--verbose`、掃到 0 個檔案 FAIL；`check-standalone.ts` 補 `--manifest`、`--only`、`--list`、`--timeout`、讀到 0 個條目 FAIL。
- **程式與設定分離**:`check-boundaries.ts` 的落點表(OWNERS)、glue 集合、alias 對映、掃描範圍抽到 `scripts/boundaries.owners.json`(格式見 `scripts/README.md`),腳本讀 ROOT 下的這份檔,不存在就 exit 1 並印範例;附一份用採用專案落點表當範例的 `boundaries.owners.json`。`check-standalone.ts` 的暫存目錄清理改成讀每個條目可選的 `"cleanup": [...]` 陣列,執行前後各清一次,不再寫死目錄名稱。
- `sync-gates.sh` 新增「設定檔」清單 `CONFIG_FILES`(`boundaries.allow.json`、`boundaries.owners.json`):只在目標不存在時複製一次,之後永遠不覆蓋;`--check` 對這些檔案跳過比對,印「(你的設定檔,不比對)」。
- 新增 `scripts/README.md` 說明落點表在 `boundaries.owners.json`。
- 來源:專案 A 協調者在同步模板到專案時擋下的迴歸——舊模板版三支掃描器是主 repo 版本的舊子集,直接同步會讓已經修好的圍欄誤報、落點檢查漏檢等問題重新出現。

## 1.1.2 — 2026-09-05

- PITFALLS P-15 補「量化數字重跑」、新增 P-35(宣稱要有測試 + 開發輪自跑變異)、P-36(檢查不准留副作用)、P-37(不用 `git push --tags`);docs/03 審核清單第 7 項。

## 1.1.1 — 2026-09-04

- `sync-gates.sh --check`:本地急修規則——守門檔第 2 行 `// HOTFIX: YYYY-MM-DD <理由>` 可暫時偏離模板,--check 只警告;超過 24 小時未回流模板即紅(來源:專案 B 提問「--check 當 CI gate 的前提」)。

## 1.1.0 — 2026-09-04

- 新增 `scripts/sync-gates.sh`:把守門複製進目標 repo 並寫入版本標頭(`// SOURCE: template vX.Y.Z (commit)`),`--check` 比對版本與內容。CI 上沒有模板路徑,守門必須自包含;靠版本號防漂移,不靠路徑(來源:專案 B 修正)。
- README「版本」段:採用方式改成 sync-gates,不再建議直接呼叫模板路徑。

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

@AGENTS.md

## Claude Code 專用

本檔只提供 Claude Code 的入口與斜線指令別名；跨平台規則與 skill 說明在 `AGENTS.md`。

- `/product-pm [意圖]` — 使用者的產品需求入口；主持探索、brainstorm、party、brief、PRD 與 `/feature`
- `/feature <描述>`（skill：`feature-triage`，經 `product-pm`） — 由產品 PM 主持，內部呼叫 `feature-triage` 做 A/B/C/D/E 分流；**先提案、等確認、再寫檔**
- `/dev-worker <dispatch>` — 只供協調者派工；必須帶單一 mode、`allowed_paths`、權威來源與完成條件，不接受使用者直接呼叫
- `/phase-done <folder>/<phase>`（skill：`phase-acceptance`） — 驗收一個 phase
- `/integrate <IN>`（skill：`integration-check`） — 驗收一個整合點
- `/mutate [folder]`（skill：`mutation-testing`） — 跑 mutation testing 並判讀
- `/decide <描述>`（skill：`decision-record`） — 記錄 ADR
- `/sprint`（skill：`sprint-planning`） — 規劃本週
- `/loop 15m /autopilot`（skill：`autopilot`） — 週期執行協調者的自動推進迴圈

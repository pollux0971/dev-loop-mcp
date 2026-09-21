---
description: 驗收一個 phase(自動檢查、單獨執行、變異測試、人工確認分流)
argument-hint: <folder>/<phase>
---

使用 `phase-acceptance` skill 驗收 `$ARGUMENTS`。

照 skill 的順序跑,不要跳步驟。沒有第二個 session 可以做非作者審核時,
結論要寫「單 session 自審(降級),未經非作者審核」,**不得自稱嚴格級通過**。

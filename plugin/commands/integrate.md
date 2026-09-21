---
description: 驗收一個整合點(完整系統、回歸、單獨執行、端到端)
argument-hint: <IN 編號,例如 I2>
---

使用 `integration-check` skill 驗收整合點 `$ARGUMENTS`。

任何 `@e2e` 場景(即使同時帶 `@manual`)的「你做得到嗎」確認**只能由使用者本人做**,
不可由測試或技術顧問代替;其餘 `@manual and not @e2e` 的觀感判定由技術顧問確認並寫下依據。

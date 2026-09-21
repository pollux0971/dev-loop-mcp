---
description: 跑變異測試並判讀存活變異
argument-hint: [資料夾或模組路徑]
---

使用 `mutation-testing` skill 對 `$ARGUMENTS`(沒給就照 skill 的預設範圍)跑變異測試。

`npm run mutate` 是唯一入口——設定與排除清單掛在它上面,而且它包了跨 worktree 的
`.stryker.lock`;裸的 `stryker run` 會繞過鎖。分數一律附完整指令與設定檔路徑。

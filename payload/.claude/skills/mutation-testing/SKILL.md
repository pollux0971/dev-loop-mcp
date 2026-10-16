---
name: mutation-testing
description: tier strict 的節點用來證明測試真的會抓錯。Critic 審 strict 節點、或 worker 在 strict 節點的測試棒結束前使用。
---

# 變異測試(strict 節點)

行覆蓋率只證明「跑過」,不證明「會抓錯」。strict 節點要證明後者。

- TypeScript:`npm run mutate -- <檔案>`(經 `scripts/mutate-with-lock.ts`,同一時間只有一個變異測試;不要直接呼叫變異工具繞過鎖)。
- 門檻:存活的突變體要逐一說明(等價突變可接受,寫原因);沒說明的存活 = 測試不足。

工具跑不動或太慢時,改做**定向反向驗證**:挑三個最可能寫錯的地方,手動改壞 → 測試必須變紅 → 還原 → `git diff` 必須是空的。
把每一次「改了什麼、哪個測試變紅」當成 claim 的 evidence 附上。

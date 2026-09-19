# 常駐 session 啟動 prompt(ADR-018)

只有規模大到協調者一個人接棒會變瓶頸時才需要這套——單人或單 session 帶多個 worktree,
用 `docs/03-agile-workflow.md` 的角色分工就夠,不必開這 4 個常駐 session。

開之前先確認:`docs/02-decision-map.md` ADR-018 已經是 `accepted`(不是 proposed),
且使用者本人批准要開這 4 個角色——這是組織架構變更,依 `AGENTS.md`「做決定時」表屬於使用者裁決,
不是協調者或技術顧問能自己決定要不要開的事。

## 怎麼用

每個角色一份可直接貼進新 session 的啟動 prompt。開新 session 時:

1. 先把 `{{PROJECT_NAME}}`、`{{ACTIVE_AGENT_CAP}}`、`{{UNMERGED_CAP}}` 換成這個專案 `CHECKLIST.md`
   實際填的值(不要留雙大括號進 session)。
2. 把對應檔案整份貼給新開的 session 當第一句話。
3. 等它回報完成「啟動時先做的三件事」,再開始派工/等它收件。

## 四份角色與對應檔

| 角色 | 檔案 | 對應 `docs/05-parallel-and-integration.md` 拓撲表 |
|---|---|---|
| 協調者 | `coordinator.md` | 唯一排程者、唯一 merger |
| 技術顧問 | `advisor.md` | 裁決、合併後獨立重驗、規則層執行者 |
| 接線 agent | `wiring.md` | 只照鏈規格接棒,不合併 |
| 整合/清樹 agent | `integrator.md` | 臨時樹跑 gate、照 `docs/07-practices.md` (at) 清 worktree、記 ledger |

## 這 4 份不是唯一入口

使用者的產品需求入口仍是 `product-pm` skill(在技術顧問 session 或任一對話 session 呼叫,不必另開 PM session);
新功能、改「不在範圍」、改 `contracts/` 硬約定與規則層,一律照 `AGENTS.md`「做決定時」表走,
這 4 份 prompt 不改變任何一列的批准權——只是把協調者原本一個人做的「決定」與「執行」拆給不同 session。

## 停用回單人模式

拆掉任何一個常駐 session 前,先確認它手上沒有未收尾的鏈(接線 agent)或未清完的 ledger(整合/清樹 agent),
再把它的職責收回協調者自己做,不要留著一半的鏈規格沒人接。

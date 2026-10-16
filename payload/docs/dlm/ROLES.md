# 角色

| 角色 | 是什麼 | 讀什麼 | 寫什麼 | 能批准 |
|---|---|---|---|---|
| Front | 互動模型(你唯一對話的那個) | `dlm inbox/show/status` 的輸出、整個專案 | 狀態只透過 `dlm decide/confirm/halt/resume/intake`;小改動可直接改檔並 commit | 無(轉達你的話) |
| orchestrator | `dlm tick`,純 script | dag + ledger + git | ledger(唯一寫入者)、merge | 無(只執行規則) |
| Worker | headless LLM,每棒一次 | 工單 + 資料切片 | allowed_paths 內的檔 + report | 無 |
| Verifier | script 檢查 + 小模型窄題 | dlm 重跑的輸出、diff;**不讀 worker 敘述** | 驗證結果 | 只能否決(FAIL)或棄權(ABSTAIN) |
| Critic | 選配大模型 | 規格、驗證結果、diff;**不讀 worker 敘述** | 一份 JSON 判決 | L2:ABSTAIN 的交件、範圍內子節點、worker 回報卡住 |
| 你 | — | 單一窗口 | 原話 | 一切;AUTONOMY.md 列的只有你能 |

## 為什麼這樣分

- **只有 script 寫 ledger**:LLM 產出檔案,dlm 驗證格式後代寫。沒有「兩個 agent 同時改狀態」這回事。
- **審查者不讀作者的敘述**:讀了就會被說服。Verifier 與 Critic 看證據(重跑輸出、diff、gherkin),不看「我做了什麼」。
- **小模型只能說不**:它的錯誤是「多擋了」而不是「放過了」,多擋的代價是一次 Critic 或一次詢問,放過的代價是壞程式進主線。
- **沒有常駐 session**:每次呼叫都是新的 context,不會累積漂移,也不需要有人盯多個視窗。

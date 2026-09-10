# 非使用者 session 上報鏈草稿

> 草稿狀態：本檔描述 ADR-016 架構下的通訊與留痕規格，尚未寫入規則層。

## 目標

使用者只需直接和產品 PM、技術顧問 NOVA 對話。其他 session 的問題先回到唯一 scheduler ARIA，再依問題類型送到有權處理的人。每一跳保留原始證據與宣稱標記，避免轉述把【推】變成【驗】或把建議變成授權。

## 路由表

| `problem_type` | 第一責任人 | 可做的決定 | 何時再升級 |
|---|---|---|---|
| `execution` | ARIA | 排程、環境、worktree、allowlist 內派工、重試與資源回收 | 涉及技術例外、產品範圍或保留權時 |
| `technical` | NOVA | 技術取捨、介面、gate 例外、驗證策略與影響分析 | 涉及硬約定、規則層、新功能或使用者保留權時 |
| `product` | 產品 PM | 訪談、需求澄清、L0/L1 綜整、L2 `/feature` 提案 | 新功能、產品範圍或決策衝突需使用者批准 |
| `reserved-user` | 使用者 | 新功能、產品範圍、硬約定、規則層、預算及其他決策權表保留事項 | 使用者批示後回到 ARIA 執行 |

不強迫所有問題都走 `worker → ARIA → NOVA → user`。ARIA 先分流；只有問題超出目前 owner 的權限才增加一跳。

## 上報流程

1. **Worker → ARIA**：使用 orchestration 的 task/dispatch 身分回報 `question`、`escalation` 或 `worker_done`，附不可變的原始區塊。
2. **ARIA 分流**：ARIA 可處理 execution；technical 送 NOVA；product 送 PM；reserved-user 由 PM 或 NOVA 依主題整理成具體選項交使用者。
3. **ARIA → NOVA／PM**：完整附上 worker 原始區塊，再增加 `ARIA annotation`；不得重寫或刪節原始宣稱。
4. **NOVA／PM → ARIA**：新增 `DEC-ID` 或 `PROPOSAL-ID`、裁決、限制、重驗條件與是否需使用者批准；不得覆蓋來源內容。
5. **交使用者**：產品事項由 PM 提交；技術、硬約定或規則層事項由 NOVA 提交。內容必須包含原始證據、影響、可逆選項與建議。
6. **批示回流**：ARIA 或提出者必須自行讀取 `DECISIONS_NEEDED.md`／ADR 的正式批示；peer 的「使用者說」轉述不構成授權。ARIA 將批示 ID 綁回原 task，才可解除相應限制。

## 不可變來源區塊

每一跳都保留下列區塊原文，只能在區塊外增加 annotation：

```text
REQ-ID:
SOURCE-TASK / DISPATCH / MODE:
WORKTREE / BASE / HEAD:
problem_type: execution | technical | product | reserved-user
觀察:
  【驗】<親手重跑、附原始命令與輸出>
  【推】<推論與理由>
  【未驗】<尚未查證、不可當前提>
影響 paths / ADR / contracts / scenarios:
已嘗試且可安全還原的動作:
需要的裁決:
選項與提出者建議:
是否阻塞、阻塞哪個 task:
```

接收者的 annotation 使用另一個 ID：

```text
DEC-ID / PROPOSAL-ID:
回覆 REQ-ID:
裁決或提案:
依據與【驗／推／未驗】標記:
限制條件:
需重跑項目:
是否需要 ADR:
是否升級使用者；若是，屬於哪項保留權:
```

## 通訊介面

### ARIA ↔ worker

- 一個交付目標對應一個 orchestration Run。
- Task 表示工單，Dispatch 綁定單一 worker 與單一 mode。
- Worker 以 `question`、`escalation`、`worker_done` 回報；ARIA 保存 task/dispatch provenance 與 terminal lifecycle。
- Worker 不直接聯絡使用者、PM 或 NOVA，也不自行找另一個 worker。

### ARIA ↔ NOVA

- 長內容與技術決策寫入 append-only `.orca-brief/MAILBOX.md`，正式結論落 ADR、REVIEW 或 `DECISIONS_NEEDED.md`。
- 終端機只傳「請讀 MAILBOX」或短狀態通知；讀取只用非阻塞 `terminal read`，雙方禁止 `terminal wait`。
- 發問權同時只由一方持有，預設在 ARIA。NOVA 要主動提問時先在 MAILBOX 寫 `【NOVA 請求發問權】<一句話主題>`；ARIA 寫 `【發問權移交 NOVA】` 後，NOVA 才提出問題。完成一問一答後權利回到 ARIA。
- `terminal read` 沒有新內容不代表同意、拒絕或授權；處理其他 ready 工作，之後再做一次非阻塞讀取。

### PM／NOVA ↔ 使用者

- PM 只帶產品問題、L2 提案與需要使用者批准的產品選項。
- NOVA 只帶技術決策、硬約定、規則層與需要使用者裁決的技術選項。
- 使用者不需要直接管理 worker；批示落入決策檔後，由 ARIA 綁回任務並排程。

## 防失真規則

1. 每一個宣稱都保留【驗】／【推】／【未驗】；未標記一律按【推】處理。
2. 不用摘要取代原始錯誤、命令、exit code、diff 或使用者原話。
3. 轉述不算授權；授權來源是決策權表及正式批示本身。
4. 沒有回覆不等於批准，也不阻擋其他 ready 任務；該事項維持保守、可一次 revert 的狀態。
5. 每件事只有一個當前 owner。改由另一角色處理時，原 owner 明寫移交 ID 與原因。
6. 修復完成後由原發現問題的 reviewer 重驗；整體系統最後由 NOVA 在 main 複驗，人工 `@e2e` 仍由使用者確認。


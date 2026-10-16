# 流程

```
你 ──(單一窗口 / Front)──> dlm intake 提案 ──你批准──> dag.json + ledger
                                                          │
                          背景 dlm run(每 60 秒一個 tick) ─┘
  tick:收件 → 驗證(script + 小模型)→ 合併後全 gate → 依自治等級分流 → merge → 派下一批
                          │                                   │
                  Critic / 你(只在需要時)              headless worker(每棒一次、跑完就結束)
```

## 一個節點的一生

1. **提案**:intake 產生節點(id、intent、owns、gherkin、accept 指令、依賴)。你批准後 dlm 寫進 `dag.json`,記 `node_added`。
2. **可派**:依賴全部 `done`、契約版本相符、沒有擋住它的待決事項 → 出現在 snapshot 的 `dispatchable`。
   優先序 = 解鎖多少下游;同分時重做優先於新開。
3. **派工**:每個節點一個 worktree(`.dlm/worktrees/<id>`)、一條分支(`dlm/<id>`)。落後主線就先 merge 主線(不 rebase)。
   工單與完整 prompt 同時存進 `ledger/dispatch/<d-id>/`,之後任何人都能看到 worker 當時看到什麼。
4. **施工**:預設兩棒。`test` 棒只寫測試而且必須紅;`dev` 棒寫實作讓它綠、不能碰測試與 gherkin。
   整合點是 `test` → `integrate`。
   實作棒發現**測試本身寫錯**(跟 gherkin 矛盾)時回報 `fix_leg: "test"`:Critic(L2)或你確認後,dlm 插一棒 `test-fix`
   (只能改測試與步驟、同一條分支),做完再把實作棒派回來。同一個節點自動退回超過 `caps.test_reopens` 次(預設 2)就改問你。
5. **交件**:worker 在沒有 .git 的沙箱副本裡施工,寫 `.dlm/report.json`。dlm 驗證格式、比對副本、把範圍內的變動 commit 進分支,
   複製 report 到 ledger,記 `worker_done`(見 SECURITY.md)。
6. **驗證**:見 VERIFIER.md。任何 FAIL → 退回(findings 帶進下一次工單)。同一棒三次沒過 → 封鎖並問你
   (建議「擱置」:沒有新指示的重試通常是同樣的結果;要重試就把指示寫在原話裡)。
   worker 沒交件而 log 顯示是限流、5xx、連線問題(`worker_failed` 的 `class: infra`)不算嘗試次數,改成指數退避重派
   (`caps.infra_backoff_seconds`、`caps.infra_backoff_max_minutes`);全系統連續 `caps.infra_halt_after` 次就停機通知你。
7. **合併**:最後一棒通過後,在「main + 分支」的臨時樹跑 `gates.chain`,綠了才依自治等級決定自動合併、交 Critic、或問你。
   已批准但還沒完成的節點的 gherkin 不算進全 gate(它們一定紅;清單在 `.dlm/pending-features.json`,由 dlm 維護、
   範本的 `cucumber.js` 讀它),正在合併的節點自己的場景照跑。
   等你或 Critic 決定的期間主線若前進(程式碼有變),合併前在新主線上重跑一次,紅了就退回。
   合併用 `--no-ff`,分支留 `dlm-archive/<d-id>` 標籤後刪除。
8. **整合點**:合併後 dlm 把 `@e2e` 場景列進你的收件匣。你試用後 `confirm`;說不行就重開這個整合點。
   依賴這個整合點的節點(下一版)要等你試用說 OK 才開工(`integration.gate_next_version`,預設開)。

## DAG 的延伸

- **往下(v1 → v2 → v3)**:一版是一個 bundle(`dlm intake bundle`):這一版的節點 + 一個整合點 `I<n>`,一次批准。
  下一版的起點自動依賴上一版的整合點,所以版本之間有明確的「整合時間點」:上一版合併、你親手試過,下一版才開工。
  後面幾版的方向寫在 `docs/ROADMAP.md`,只有正在做的這一版進 DAG。
- **側向(v1.1、v1.2)**:worker 施工中發現「要先有一個小功能才能完成」→ 回報 `blocked` 附 `spawn`。
  `prereq`:父節點等子節點完成(子節點繼承父節點的依賴);`followup`:子節點排在父節點之後。
  L2 以上且子節點的 owns 在父節點範圍內 → 自動批准;否則問你。
- **共用(`shared/<名字>`)**:橫切關注(log、設定、共用步驟、契約本身)各自一個節點,擁有自己的路徑。

## 什麼時候會問你

只有 AUTONOMY.md 列的事。其他全部由 script 或 Critic 處理,並記在 ledger。

## 停機與通知

- `dlm halt` 會立刻終止還在跑的 worker(記成 `class: halted`:不算嘗試次數、不退避、worktree 不動),沙箱副本丟掉。
  `--keep-workers` 讓它們跑完。
- `notify.cmd`(dlm.config.json):有新的決定、試用、停機出現時跑一次,文字在環境變數 `DLM_NOTIFY_TEXT` 與 stdin。
  例:`"notify": { "cmd": "curl -s -d @- https://ntfy.sh/<你的主題>" }`。
- Front 的 user-prompt hook 在你每次說話時,如果有事等你,會在對話裡附一行【dlm】提醒。

## 當機與重跑

每一步都由 ledger 狀態決定,所以 tick 中途被殺掉,下一次 tick 會從同一個狀態接著做:
已合併但沒記帳 → 偵測到分支已在主線裡就補記;派工記了但 worker 沒起來 → 兩分鐘後判失敗重派;lease 到期 → 終止並重派。

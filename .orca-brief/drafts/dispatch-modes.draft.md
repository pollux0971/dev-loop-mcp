# Dispatch modes 草稿

> 草稿狀態：本檔定義 ADR-016 的可執行派工格式，尚未安裝到規則層或啟動任何 worker。

## 核心模型

分區開發、分區整合、全局整合是一次 dispatch 的 `mode`，不是三個有獨立決策權的角色。每個 task 只允許一個 mode；ARIA 是唯一 scheduler，負責建立 worktree、綁定 task、檢查寫入範圍、接收結果與派發後續修復。

Mode 只決定任務的關注點與可寫範圍。它不能改變來源規格、批准新功能、放寬 gate、修改硬約定或把 worker 變成合併者。

## 工單 schema

```yaml
task_id: TASK-<id>
dispatch_id: DISP-<id>
mode: region-development | region-integration | global-integration
objective: <單一可驗證成果>
authority:
  source: <L3 feature / ADR / user decision / approved repair request>
  ids: [<scenario, ADR, decision, phase, integration point>]
base_ref: <commit>
worktree: <Orca worktree selector>
inputs:
  required: [<paths>]
  read_only: [<paths>]
allowed_paths: [<逐條列出的可寫路徑或窄 glob>]
forbidden_paths: [<明列禁區>]
acceptance:
  scenarios: [<scenario IDs>]
  commands: [<可重跑命令>]
  manual: [<需由誰確認的項目>]
constraints:
  cross_region_imports: deny | approved-public-only
  may_edit_tests: false
  may_edit_contracts: false
  may_edit_rule_layer: false
  may_merge: false
  may_push: false
report:
  path: .orca-brief/REVIEW.md
  required_fields: [observations, changed_paths, commands, raw_results, autonomous_judgments, open_issues]
done_when: <成功與失敗都可機械判定的結束條件>
```

派工前，ARIA 必須把 `allowed_paths` 展開到足以審核的粒度。`allowed_paths` 未列出的路徑一律視為不可寫；`forbidden_paths` 用來強調高風險禁區，不能反向推論其他路徑可寫。

## Mode 邊界

### `region-development`／分區開發

**責任**：完成單一 capability 的單一 phase 實作。它適用於任何階段；Wave 0 額外要求禁止跨資料夾 import。

**可寫**：工單明列的該分區實作檔，以及該分區自有 stub。

**不可寫**：其他分區、`*.test.*`、`features/steps/**`、Gherkin、共用檔、roadmap、ADR、規則層、contracts。不得 merge 或 push。

**越界處理**：若需要另一分區、共用檔、測試或契約變更，停止該越界部分，記錄最小重現與受影響 scenario，交由 ARIA 分流。其餘仍在 allowlist 內且不依賴該問題的工作可以繼續。

### `region-integration`／分區整合

**責任**：在指定 integration point 內，使用已批准的公開介面接通一條跨區流程，或把 Wave 0 stub 替換成權威實作。

**可讀**：所涉分區的公開介面、contracts、對應 feature／integration 規格。

**可寫**：工單明列的 composition、adapter 或 integration-seam 實作檔。沒有明列的整合縫即不可寫。

**不可寫**：任何來源分區的內部實作、測試、規格、共用檔、規則層、contracts。不得 merge 或 push。

**越界處理**：若根因在來源分區，交付原始錯誤、呼叫路徑、最小重現、預期公開行為與受影響 integration scenario。ARIA 派回該分區的 debug／development task；原 integration task 保持 blocked 或處理其他獨立接線。

### `global-integration`／全局整合

**責任**：在合併後的完整系統上驗證 `@e2e`、`@regression`、所有 standalone 與完整 gate，定位跨區退化。

**預設可寫**：只有 worktree-local 報告。

**例外可寫**：若確有全局 composition layer，ARIA 可在工單中指定唯一落點；該例外不擴及任一分區內部。

**不可寫**：分區內部、測試、規格、規則層、contracts。不得為讓結果變綠而改考卷，不得 merge 或 push。

**越界處理**：將每個問題拆為分區修復或分區整合 task，保留原始重現證據。全部修復回來後重新跑完整驗證；最終由 NOVA 在 main 複驗，人工 `@e2e` 仍由使用者確認。

## 共通執行規則

1. 啟動前核對 `base_ref`、權威來源與目標 scenario；缺任何一項就向 ARIA 回報，不自行補需求。
2. 開始時輸出將讀取與寫入的路徑清單；若實際需求超出 allowlist，先上報。
3. Dev/integration worker 只寫實作；測試由 reviewer 按既有分工處理。
4. 每個自主判斷列入 `autonomous_judgments`，交付 reviewer 做反向驗證。
5. 驗證結果附命令、exit code 與關鍵原始輸出；不能只寫「測試已通過」。
6. 完成只代表 worker 的工單完成，不代表 phase done、integration accepted、已合併或已 push。
7. Branch diff 出現 allowlist 外的修改時，ARIA 退回並要求清理；不得用擴大 allowlist 追認未經批准的改動。

## 回報 envelope

```text
TASK-ID / DISPATCH-ID / MODE:
WORKTREE / BASE / HEAD:
結果: worker_done | blocked | escalation
【驗】實際變更路徑:
【驗】驗證命令、exit code、關鍵輸出:
【驗】未通過項目:
【推】根因或技術判斷:
自主判斷清單:
越界需求與受影響範圍:
建議下一個 owner / mode:
報告位置:
```


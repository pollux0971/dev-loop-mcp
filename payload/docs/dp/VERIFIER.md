# Verifier:讓小模型審大模型

原則:**能用 script 判的絕不交給模型;交給小模型的每一題都窄到它答得好,而且它只能否決。**

## script 檢查(確定性)

| 檢查 | 什麼時候 | FAIL 條件 |
|---|---|---|
| worktree-clean | 每棒 | 有未 commit 的變更 |
| sandbox-escape | 每棒 | worker 在沙箱副本裡碰了 `.git`、`.dp/`、`node_modules`、建了 symlink,或根目錄 node_modules 在施工期間被改 |
| paths | 每棒 | 這一棒改到 allowed_paths 以外或 forbidden_paths |
| report | 每棒 | `done` 但沒有任何附證據的宣稱 |
| evidence | 每條附證據的宣稱 | dp 用同一條指令以 argv 重跑(不經 shell),退出碼不同。指令不在 `verify.rerun_allow`、含英數與 `._/:=@+-` 以外的字元、或指向 worktree 外 → ABSTAIN(不執行);但這一棒的 acceptance 已由 dp 重跑通過時,改記 SKIPPED(只是多說的話沒驗,不升級問你)。FAIL 不附輸出 |
| acceptance | 有 accept 指令時 | 測試棒:不是紅的,或紅的原因是語法錯誤 / 步驟沒綁定 / pending;其他棒:不是綠的 |
| dry-run | 測試棒與 test-fix 棒(設了 `verify.dry_run_cmd`) | gherkin 有步驟沒綁定、ambiguous(看摘要行,不信退出碼) |
| mutation | 最後一棒(設了 `verify.mutation.cmd`) | 這一棒改到的實作檔 mutation 分數低於門檻(一般 `min` 預設 50,strict 節點 `min_strict` 預設 70):strict 判 FAIL,其他 ABSTAIN。沒有單元測試 import 改到的檔時:整合棒 SKIPPED(組合層由整合驗收把關),其他棒 ABSTAIN |
| standalone | 實作/整合棒 | 節點的 standalone 指令非 0 |
| stubs / regression-standalone | 整合棒 | 正式碼仍 import `__stubs__`;依賴節點的 standalone 壞了 |

paths、worktree-clean 或 sandbox-escape FAIL 時,後面會執行程式的檢查(acceptance、evidence、standalone…)一律不跑,
記一筆 `execution SKIPPED`。會執行程式的檢查都在一份用完即丟、沒有 .git 的副本上跑(見 SECURITY.md)。

最後一棒另外在「main + 分支」的臨時樹跑 `gates.chain`,並記下當時的 `main_sha`;
合併前主線的程式碼若已經變了(只有 dp 狀態檔變動不算),在新主線上重跑,紅了就退回。

## 小模型窄題

| 題目 | 輸入(都有上限) | 問什麼 |
|---|---|---|
| claim-supported | 一條宣稱 + dp 自己重跑的輸出 | 輸出有沒有推翻這條宣稱 |
| scenario-honesty | gherkin 裡的具體值 + 一個改到的實作檔(太長就依行切段,每段各問一次) | 程式是不是對這些值特別處理(作弊);照規格輸出的訊息、標籤不算 |

- v4:scenario-honesty 不再是「每個場景 × 截斷的 diff」(v3 實測 90 題 71 題棄權:關鍵函式常被截掉)。小模型看得到完整函式,呼叫次數跟檔案大小走。
- 每題用兩種問法各問一次(`prompts/verifier/<題>.a.md`、`.b.md`),答案不同 → ABSTAIN。
- 輸入超過 `max_input_chars` → 直接 ABSTAIN,不讓小模型讀長 context。
- 呼叫失敗、逾時、輸出不是合法 JSON → ABSTAIN,絕不當成沒問題。
- 輸出只有 FAIL / ABSTAIN / NO_OBJECTION。沒有 PASS。

## 設定

`dp.config.json` 的 `agents.verifier`:
- `backend: "cmd"`:任意指令,prompt 從 stdin 進、JSON 從 stdout 出。`dp setup` 預設用
  `claude -p --model haiku --tools "" --no-session-persistence`(小模型、不給任何工具)。
  (v4.0 的 `backend: "http"`(Ollama 等 OpenAI 相容端點)實跑沒用到,v4.1 拿掉了;要用本機模型時包一支讀 stdin 的小指令接 cmd。)
- `backend: "none"`:只跑 script 檢查;模型題全部 SKIPPED,inbox 會提醒。這時 `scenario-honesty` 的 SKIPPED 在路由上視同
  ABSTAIN(帳本照實記 SKIPPED):有 gherkin 的最後一棒不自動合併,交 Critic 或你。mutation 達標時不升級
  (測試抓得到改壞的實作,「寫死測試值」已經被機器排除)。

## 怎麼知道小模型可不可信

`dp stats` 列每一題的 FAIL / ABSTAIN / NO_OBJECTION 次數與 Critic 的判決分布。
ABSTAIN 比例長期很高 → 模型太小或題目太寬,換模型或收窄題目;FAIL 常被 Critic 推翻 → 題目措辭有問題,改模板。
改模板是改規則層,要你批准。

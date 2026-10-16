# v2 架構

這份文件寫給維護範式的人。使用者與 agent 讀 `payload/` 裡的東西就夠了。

## 一句話

**事實只放一個地方、由 script 寫入;LLM 只拿到它那一棒需要的切片,只能產出檔案;每一個「完成」都由不讀作者敘述的機器重新驗過。**

## 為什麼要改(v1 的結構性問題)

v1 的規則本身大多是對的,問題在於規則靠 agent「讀了並記得」才有效:

- 同一件事有好幾個真相來源(FEATURE.md 的 phase 表、NEXT.md 的 gate、roadmap、standalone.json、owners.json、
  gitignore 的 REVIEW.md、MAILBOX),靠人或 agent 手動同步,漂移了也沒人知道。
- 必讀規則約 475KB(PITFALLS 110KB、07-practices 83KB、decision-map 49KB…)。每個 agent 都付一樣重的 context 稅,
  規則之間互相矛盾的機會隨長度增加,長 context 裡「記得有這條規則」本身就不可靠。
- 驗收者讀作者的 REVIEW / 回報,容易被說服;「完成了」常常只是一句話。
- 串接靠常駐 session 與終端機送字(P-39、P-45、P-54 那一類),需要人盯多個視窗。
- 安裝有兩條管線(npx 與 sync-gates.sh),範本自己的東西會漏進 consumer(P-95、P-96)。

v2 的做法是把這些從「規則」改成「結構」:不是叫 agent 小心,而是讓錯的事情做不出來、或做了會被機器抓到。

## 資料模型

| 檔 | 內容 | 誰寫 | 為什麼 |
|---|---|---|---|
| `dag.json` | 節點:id、kind、intent、owns、gherkin、accept、依賴、parent/relation | 只有 dp(intake 批准、子節點批准、契約 bump、遷移) | 結構只有一份 |
| `ledger/events.jsonl` | 所有事件,只 append | 只有 dp(持鎖、逐型別 schema、actor 權責表) | 歷史與授權可追溯;狀態從這裡重播 |
| `ledger/dispatch/<d>/` | 工單、完整 prompt、report、驗證結果、log 尾巴、Critic prompt | 只有 dp | 任何時候都能看到模型當時看到什麼 |
| `ledger/proposals/` | intake 提案 | dp | 批准前不動 DAG |
| `STATUS.md`、`DECISIONS.md`、`standalone.json` | 產生檔 | `dp render`(tick 自動) | 給人看;重新產生 ≠ 磁碟 → `dp check generated` 紅 |
| `contracts/` | 可執行 schema + valid/invalid fixture + VERSION | `shared/contracts*` 節點;major 由你批准 | 契約有陽性對照 |

**狀態不存,只重播。** 節點狀態(todo / in-progress / review / done / blocked / stale)由 `state.mjs` 從事件推出,
所以不存在「dag 說 done、帳本說 in-progress」這種矛盾。

`contract_bump` 事件型別保留給舊帳本重播(v4.1 拿掉了 `dp contract bump` 指令)。權責表在 `schemas.mjs` 的 `EVENT_ACTORS`,
`contract_bump` 只能經 `dp contract bump` 且要引用一個使用者批准的決定。權責表在 `schemas.mjs` 的 `EVENT_ACTORS`,
寫入時檢查,`dp check ledger` 也會重驗。

## 一次 tick

```
preflight   根目錄在 main、除了 dp 管的檔沒有未 commit 變更、dag 合法;否則什麼都不做
apply       已批准的 intake 提案寫進 DAG
harvest     結束的 worker:讀 report → 驗 schema → 複製進 ledger → worker_done / worker_blocked / worker_failed
verify      script 檢查 + 小模型窄題 → verify 事件(FAIL → 退回;退回時 worktree 回到這次嘗試之前,留 dp-rejected 標籤)
gates       最後一棒:在 main+分支 的臨時樹跑 gates.chain
route       依自治等級:自動合併 / 交 Critic / 問使用者
merge       --no-ff,留 dp-archive 標籤,刪 worktree 與分支;整合點發 e2e_request
decisions   套用使用者或 Critic 的決定
dispatch    算 snapshot → 依優先序(解鎖下游數)挑 → 開 worktree、同步主線(--no-ff)→ 組 prompt → 啟動 headless worker
commit      render 產生檔,commit ledger 與產生檔
```

每一步的「要不要做」都由 ledger 狀態決定,所以當機後重跑得到一樣的結果:已合併但沒記帳 → 偵測分支已在主線,補記;
派工記了但 worker 沒起來 → 兩分鐘後判失敗;worker 還在跑 → 不動。測試:`test/e2e-paths.test.mjs` 的兩個冪等案例。

## 一個節點的棒(legs)

| kind / 情境 | 預設棒 | 每棒寫得到 | 驗收 |
|---|---|---|---|
| phase | test → dev | test:owns 內的 `*.test.*`、`features/steps/<能力>*`;dev:owns,不含測試與 gherkin | test 必須紅,dev 必須綠 |
| integration | integrate | owns(組合層) | 綠、不 import `__stubs__`、依賴的 standalone 回歸 |
| shared | dev | owns | 綠(有 accept 時) |
| 測試寫錯時 | test-fix → 原棒重來 | test-fix:測試與步驟 | 實作棒回報、Critic 或你確認後才走 |

「worker 不能改自己的考卷」在 v1 是規則,在 v2 是 `allowed_paths` / `forbidden_paths` + paths 檢查。

**驗的是整棒的累積改動**:從這一棒的起點沿 first-parent 走、只算非 merge commit(`legDiff`)。所以被 blocked 前先 commit
的半成品也要過檢查,同步主線的 merge 不算 worker 的。被退回的嘗試會先存標籤、再把 worktree 退回那次開始前,
越界的改動不會跟著下一次嘗試混進主線(這兩點是 v2 測試過程中抓到的漏洞,見 CHANGELOG)。

## 防幻覺的六個形狀,各用什麼擋

| 形狀 | v2 的結構 |
|---|---|
| 宣稱做了但沒做 | report 的 claim 必須附指令與退出碼;dp 用同一條指令重跑(只跑白名單),對不上就退回 |
| 讀錯狀態 | 沒有 agent 讀 markdown 狀態;dp 讀 snapshot(機器算好的結論 + 理由),worker 讀自己的工單 |
| 自己補值 | 未填 placeholder 拒絕送出;`dp check placeholders`;不確定要標 unverified |
| 被作者說服 | Verifier 與 Critic 看不到 worker 的敘述,只看重跑輸出、diff、規格 |
| 規則衝突/遺忘 | 規則檔有體量上限(`dp check rule-size`);規則矛盾候選報告;細節移到參考文件 |
| 驗收自己失效 | `dp check controls`:每支檢查拿已知壞樣本,抓不到就紅;契約 invalid fixture 要「因為對的原因」被擋 |

## 小模型審大模型

Verifier 的設計是不對稱的:**它只能否決,不能放行**。放行靠的是 script 檢查全過;小模型只負責在它答得好的窄題上說「不對」。

- 題目窄:一條宣稱 + dp 自己重跑的輸出;一個場景 + 實作 diff(問「是不是對測試值寫死」)。
- 輸入有上限,超過直接 ABSTAIN。
- 兩種問法各問一次,不一致 → ABSTAIN。
- 呼叫失敗、非 JSON、回了 PASS → ABSTAIN。
- ABSTAIN 依自治等級交 Critic(大模型)或你。

所以小模型的錯誤只會造成「多問一次」,不會造成「壞東西進主線」。`dp stats` 讓你看到每題的 FAIL/ABSTAIN 分布,
決定模型夠不夠用。

## prompt

固定五層(規則 → 工單 → 資料 → 輸出格式 → 提醒),資料一律圍欄並聲明不是指令,`</data>` 會被跳脫。
不送整張 DAG;每個角色有自己的切片。每份送出的 prompt 都存在 `ledger/dispatch/`。細節:`payload/docs/dp/PROMPTS.md`。

## 安裝

一條管線:`dp init` / `dp upgrade`,用 `.dp-install.json` 的 sha 判斷所有權。seed-only 的檔(你的專案內容)只建一次;
受管的檔沒被你改過才會更新;任何一個衝突 → 整批不寫。範本自己的東西(`tools/` 以外的 repo 內容、`test/`、`docs/`)
根本不在 `payload/`,結構上不會漏進 consumer。

## 刻意沒做的

- **不做 OS 層沙箱**:dp 是事後檢查;worker 在不含 `.git` 的副本裡跑,更強的隔離靠把整個專案放進容器或 CLI 權限模式(`payload/docs/dp/SECURITY.md`)。
- **不用 YAML**:dag 只有 script 寫,JSON 沒有解析歧義,也不需要依賴。
- **不做常駐 agent 之間的訊息**:所有 LLM 都是一次性 headless 呼叫,輸入是檔案,輸出是檔案。
- **派工順序不用 LLM**:優先序是解鎖下游數。v4.0 的選配 Manager 三次實跑都沒用到,v4.1 拿掉了。

## 目錄

```
tools/          dp CLI(零依賴 Node ≥ 20),會被安裝進 consumer
  dp.mjs
  lib/          ledger、dag、state、snapshot、orchestrator、verify/、prompt、intake、install、render、checks…
payload/        dp init 寫進 consumer 的檔(規則、prompts、skills、docs/dp、contracts 範例、v1 gate 包)
test/           node --test;假 worker / 假 agent / 假小模型在 fixtures/
docs/           本檔、ADR-021、v1 歸檔
```

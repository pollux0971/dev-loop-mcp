# 平行與整合策略

這份文件解釋 roadmap 為什麼長那樣。讀完你就知道每個 phase 的順序不是隨便排的。

## 兩個要求,一個答案

你的兩個要求看起來矛盾:

- 一開始所有資料夾的第一階段要能**完全平行**
- 每次整合都要是**完整可用的系統**

平行意味著彼此不知道對方存在;可用意味著彼此要接得起來。答案是把「接口」和「實作」分開:
**接口先凍結(contracts/),實作各自平行,整合只是把 stub 換成真的。**

## 為什麼 Wave 0 真的能平行

Wave 0 是所有資料夾的 phase-1 同時開工。能平行的三個條件:

**一、契約已凍結。** `contracts/types.md` 定義了所有跨模組的型別與檔案格式。
沒有人需要等別人決定「某個核心資料型別長什麼樣」。

**二、每個功能只依賴 contracts,不依賴彼此。**
需要別人的能力時,用 contract 定義的介面 + 自己的假實作:

| 功能 | 需要什麼 | Wave 0 怎麼辦 |
|---|---|---|
| {{FEATURE_EXAMPLE_1}} | {{DEPENDENCY_EXAMPLE_1}} | (範例:重播預錄的外部呼叫結果,不真的呼叫) |
| {{FEATURE_EXAMPLE_2}} | {{DEPENDENCY_EXAMPLE_2}} | (範例:三個依賴各寫一個最小 stub + 記憶體版檔案系統吃 fixture) |
| {{FEATURE_EXAMPLE_3}} | {{DEPENDENCY_EXAMPLE_3}} | (範例:自己寫最小版驗證邏輯,整合後換成權威實作) |

**三、共用 fixture。** `contracts/fixtures/` 是**真的檔案**,不是規範——一組合法的最小資料集、
一組刻意壞掉的資料、預錄的外部呼叫回應。每個功能第一天就有東西可以吃,不必自己造假資料。
整合時大家對「某筆固定測試資料長什麼樣」的理解一致。

**一個例外:組合層。** 如果某個能力的工作就是把其他模組串起來,它在被串的東西存在之前
無法獨立,硬造一個吃 stub 的版本等於寫兩次。所以它不參與 Wave 0,phase-1 直接排在某個
整合點裡。**遇到類似的情況比照辦理**:在 FEATURE.md 說明理由、記一筆 ADR,不要為了湊規則
而製造重工。

## 代價:短暫的重複

Wave 0 期間會有幾份重複的東西——每個需要外部依賴的功能都有自己的假實作,
有些驗證邏輯會被實作兩次。這是**刻意的**:

> 一點重複,遠比一個依賴鏈便宜。

依賴鏈的成本是「A 沒做完 B 就不能開始」;重複的成本是整合時刪掉幾十行。後者便宜太多。

驗收時會列出這些重複,整合時逐一移除。

**其中一份重複可能意外地有價值**:如果兩個獨立寫的驗證邏輯對同一份 fixture
算出不同的結果,那就抓到了契約的歧義。這種檢查**只有在有兩份獨立實作時才做得到**,
錯過就沒了。

## 為什麼每次整合都是完整系統

不做「整合到一半」。每個 integration 的驗收條件都是一句**使用者做得到的事**:

| 整合 | 你做得到什麼 |
|---|---|
| I1 | {{I1_CAPABILITY}} |
| I2 | {{I2_CAPABILITY}}★ 通常是「關鍵」整合點——系統開始有日常價值 |
| I3 | {{I3_CAPABILITY}} |
| ... | ... |

**中間某個整合點是關鍵**:那時系統就已經有價值了。之後每一個整合都是讓它更好用,
不是讓它「終於能用」。這代表如果專案在任何一個整合點停下來,你手上都有一個能用的東西。

## 每個資料夾的功能單獨可跑

每個資料夾在 `FEATURE.md` 裡登記一行**單獨執行**指令,寫進 `standalone.json`。
這件事的價值不只是「方便 debug」,它是一個**耦合檢測器**:如果某次整合之後,
某個原本能單獨跑的功能突然跑不動了,代表有人偷偷加了不該有的依賴。

## 整合的實際做法

1. 讀該整合點在 roadmap 的段落,確認所有需要的 phase 都 `done`
2. 檢查 Wave 0 的重複是否已經移除(見上面「代價」一段)
3. 跑該整合點的 gherkin(`@e2e` 與 `@regression`)
4. 跑所有功能的單獨執行指令,不只這次整合涉及的
5. 把 `@e2e` 場景原文貼給使用者,問「你做得到嗎」——**這一步不能被測試代替**

細節見 `.claude/skills/integration-check/SKILL.md`。

## 多 session 分工(ADR-018)

單人或單 session 帶多個 worktree 時,上面幾節的流程就夠。專案規模大到協調者一個人接棒會變瓶頸時,
可以拆成 4 個常駐 session——**這是規模到了才開的選項,不是每個專案的預設**。核心原則:
「**決定下一棒 ≠ 執行下一棒**」,協調者保有全部排程決定權,新增的兩個角色只執行協調者事先寫死的決定。

### 拓撲

| 角色 | 職責 | 不做 |
|---|---|---|
| 協調者(ARIA) | 唯一排程者、唯一 merger:寫工單並在工單尾**寫死鏈規格**、決定派誰、組批、`merge --no-ff` 進 main(**不 push**,push 仍是技術顧問,見 AGENTS.md「做決定時」表) | 鏈內接棒的執行、清樹的執行、技術裁決 |
| 技術顧問 | 裁決(契約/介面/gate 例外/`@manual and not @e2e`)、合併後在自己 worktree 對 main 獨立重跑全 gate、通過後 push origin、merge 證據抽查、WIP/漂移監督、規則層變更的執行者 | 不寫實作、不改 worker 分支、不派工 |
| 接線 agent | 偵測 worker 交件(讀終端結論行與 `.report`/`.review` 檔,不用 mailbox),**只照工單鏈規格**開下一棒;卡互動選單就解除或回報 | 不決定鏈的內容、不排序、不合併、不清樹、不改鏈規格;鏈規格沒寫的情況一律回報協調者 |
| 整合/清樹 agent | 把候選分支合到最新 main 的**臨時樹**跑全 gate + 觸及資料夾所有 done phase(`setsid nohup` + done 檔),紅就隔離是哪一支;**照 `docs/07-practices.md` (at)** 清閒置 worktree,刪前打 `archive/<branch>` tag | 不派工、不合併、不 push、不改任何分支內容;ledger 之外的 worktree 不動 |

產品 PM 不另開常駐 session,仍是 skill 入口;前端顧問不設。詳見 ADR-018。

### 通訊規則

session↔session 用平台提供的訊息機制;worker→session 不依賴平台信箱或協調 API,worker 只 commit + 終端印
`REVIEW VERDICT: PASS|RETURN <報告路徑>`;禁止 session 互相阻塞等待;worker 禁 `git push origin`。
接線 agent **只接棒不合併**——末棒 PASS 就通知協調者來 merge。

### 迴圈時段(範例,各專案自行錯開)

各常駐 session 使用平台排程能力,不用特定介面:協調者 :04/:19/:34/:49、整合/清樹 :11/:26/:41/:56、
接線 agent 以監控機制每 2–3 分鐘巡檢 + :08/:23/:38/:53、技術顧問 :17/:37/:57。

### 在製品上限

活躍 agent ≤ `{{ACTIVE_AGENT_CAP}}`(預設 12);未合入交付物 > `{{UNMERGED_CAP}}`(預設 10)就停派新節點、產能轉整合。

### 鏈規格格式(協調者填在工單尾,接線 agent 只照此執行)

鏈規格跟 `docs/templates/TASK.md.template` 的「當場取數」原則一致:**不寫死 ADR / DECISIONS_NEEDED 編號、
不寫死鏈長度**,只寫「取數的方法」——下一個編號、下一棒是誰,永遠在寫入的那一刻現算,不在排程的那一刻算。

```yaml
# 鏈規格(工單尾,協調者填)
chain:
  - leg: 1
    role: test           # 測試 agent:先寫紅
    model: <當場依 §2a mode 選定的模型>
    allowed_paths: [<逐條列出>]
    done_when: "cucumber 對應場景跑起來是紅的(不是報錯),且斷言訊息指向缺的實作"
    next: "commit 後終端印 REVIEW VERDICT: PASS,交線給棒次 2"
  - leg: 2
    role: dev             # 開發 agent:寫綠
    model: <同上>
    allowed_paths: [<逐條列出>]
    done_when: "npm run check:all 對應這批場景全綠,diff 只出現 allowed_paths"
    next: "commit 後終端印 REVIEW VERDICT: PASS,交線給棒次 3(非作者審核)"
  - leg: 3
    role: review           # 非作者審核:在合併到最新 main 的臨時樹上跑全 gate
    model: <同上>
    allowed_paths: []      # 審核不改實作,只跑檢查與寫報告
    done_when: "臨時樹全 gate 綠 + 觸及資料夾所有 done phase 場景綠"
    next: "終端印 REVIEW VERDICT: PASS 且無下一棒 → 接線 agent 通知協調者收批,不自行合併;RETURN → 依鏈規格退回對應棒次"
# 鏈長度依工單實際需要增減,不是固定 3 棒;上面只是最小範例
```

接線 agent 讀到某一棒印出 `REVIEW VERDICT: PASS` 且鏈規格上還有 `next` 就照著開下一棒;
印出 `RETURN` 或鏈規格没寫清楚下一步,一律停下回報協調者,不自行判斷。

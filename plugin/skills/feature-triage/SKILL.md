---
name: feature-triage
description: 產品 PM 的內部 A/B/C/D/E 新需求分流 workflow。只由 product-pm 在整理 L0/L1 後呼叫；使用者提出新功能、產品想法或要求 feature workflow 時一律先啟動 product-pm，本 skill 不直接與 product-pm 競爭使用者入口。
---

# feature-triage — 產品 PM 的內部分流 workflow

## 路由契約（優先權寫死）

1. 使用者提出新功能、需求調整、產品想法或要求 feature workflow 時，唯一使用者入口是 `product-pm`。
2. 本 skill 只接受 `product-pm` 整理後的需求 envelope，不自行建立另一段 PM 對話或平行提案。
3. 若路由器同時命中 `product-pm` 與本 skill，**只啟動 `product-pm`**；由它在同一條產品對話內呼叫本 workflow。
4. 本 skill 負責分類、產生 L2 提案與確認後寫入 L3；`product-pm` 負責主持訪談、呈現提案、找到適格批准者並把 L3 交給協調者。

## 權威階梯

| 層級 | 產物 | 權威 |
|---|---|---|
| L0 探索證據 | party transcript、brainstorm、研究摘錄 | 只證明討論與觀察，不可派工 |
| L1 PM 綜整 | product brief、PRD、候選 capability、未解問題 | 本 workflow 的上游輸入，不可直接改權威規格 |
| L2 feature 提案 | A/B/C/D/E 分流、目標 phase、gate、草擬 scenarios、衝突清單 | 待適格批准者確認；不可寫檔或派工 |
| L3 已批准規格 | 已確認並寫入的 `.feature`、`FEATURE.md`、`NEXT.md` 及必要索引／roadmap | 可交協調者納入開發 DAG；硬約定仍以 contracts 與 ADR 為準 |

L2→L3 的唯一界線是本 workflow 的確認 gate。L0/L1 的檔案存在、技術顧問的可行性意見或 PM 的建議都不能取代確認。

需求:

> 使用者給的輸入

<!-- CLAUDE-ONLY-BEGIN -->
Claude Code 會以 `$ARGUMENTS` 帶入上面的使用者給的輸入。
<!-- CLAUDE-ONLY-END -->

輸入應包含 `PROPOSAL-ID`、使用者原話、L0/L1 來源、產品目標、已知範圍、【驗】事實、【推】假設與未解問題。缺少會改變分類的欄位時，把缺口回給產品 PM；不要直接另開一條使用者對話。

判斷需求落在哪裡，然後由產品 PM **提案、取得確認、再寫檔**。未經確認不得寫入任何檔案或交付協調者派工。

## 第一步:讀取現況

不要跳過,判斷品質取決於此:

1. `contracts/types.md` 全部——**最重要**,決定這個需求是否需要動契約
2. `docs/02-decision-map.md` 每筆 ADR 的 Decision
3. `docs/01-roadmap.md` 的「現況」與「未排程」
4. `features/README.md` 索引
5. **每一個** `features/*/FEATURE.md` 的「範圍」與「不在範圍」
6. 目前階段若是 Wave 0,額外讀 `docs/05-parallel-and-integration.md`

## 第二步:拆解

把需求拆成獨立**能力**:可以用一句「系統能夠 ___」描述、可以獨立驗收。
一句話一個能力就不要硬拆;「A 而且 B 而且 C」就拆三個分別判斷。

## 第三步:判定(按順序,命中第一個就停)

### E · 需要動硬約定 → 先問

命中:需要改**磁碟格式**(核心實體、狀態檔、目錄結構)、新的跨模組任務常數、
改路由表、改既有 fixture。

只有硬約定才走這一支(見 `docs/02-decision-map.md` ADR-010)。改記憶體介面
(依你專案的軟約定章節,例如某個計算結果的型別、核心函式簽章、檔案系統抽象介面)
是軟約定,跑測試更新文件就好,**不要因為它而中斷分流**。

硬約定的處理:

1. 明確說要改契約的哪一節
2. 列出哪些已完成或進行中的 phase 需要重驗
3. 提醒:已產生的資料可能要遷移——這通常才是真成本
4. 由產品 PM 問使用者「要改嗎?還是有辦法在現有格式下做?」
5. 要改 → 先走 decision-record → 再回來重跑分流

先想想能不能不改。多數「需要新欄位」其實是模組內部的事。

### C · 與既有決策衝突 → 不寫,問使用者

命中:與 `00-design.md` 的明確設計、或任何 `accepted` ADR 矛盾。

例(請換成你專案自己的 ADR 與規則):「這個提案繞過了某個已定案的核心演算法」→
違反某條產品層 ADR。「這個提案讓 Wave 0 的某個功能直接呼叫另一個功能的內部函式」→
違反 `docs/02-decision-map.md` ADR-004(Wave 0 平行、禁止跨資料夾 import)。

處理:列出衝突的 ADR 編號，由產品 PM 問使用者「要推翻嗎?」。要的話先使用 decision-record 產生 superseding ADR。

### D · 跨功能 → 拆,再各自判定

命中:一個能力需要改 2 個以上既有資料夾的 gherkin。

回第二步拆更細。真的拆不開(例如兩個 UI 表面之間的同步互動)就當新資料夾(B),
並在 FEATURE.md 依賴欄列出所有涉及的功能。

### A · 編輯既有資料夾

命中:完全落在某個 `FEATURE.md` 的「範圍」內,且不在「不在範圍」內。

測試:把這個能力加進該 FEATURE.md 的「一句話」後面,句子還通順嗎?

放哪個 phase:
- 有 `todo` / `ready` 且內容相關的 phase → **加場景進去**
- 相關 phase 已 `in-progress` / `done` → **新增 phase**,編號接續
- 沒有相關 phase → 新增 phase

**新增 phase 時必須同時決定它的 gate**,寫進該資料夾的 `NEXT.md`:
自身 gate(前一個 phase)、整合 gate(要不要等某個 IN)、契約 gate(有無待決事項)。

### B · 新資料夾

命中(任一):
- 不落在任何 FEATURE.md 的範圍
- 需要新的資料模型、新視窗、新 UI 表面
- 需要新的外部依賴
- 明確落在某個「不在範圍」且該段落沒指向其他資料夾

例:「某個明確標記為 v1 不做的能力」→ 對應 ADR 說 v1 不做,不是衝突,是不在範圍 → B。
例:「一個完全沒有資料夾涵蓋的新能力」→ B。

**新資料夾的 phase-1 必須符合 Wave 0 的規則**——只 import contracts、能單獨跑、吃 fixture。
即使現在已經過了 Wave 0 也一樣,這是保持模組獨立的機制(見 ADR-005)。

## 確認由誰做(來源 nightmare-assault,跟 `AGENTS.md`「做決定時」表對齊)

產品 PM 負責把 L2 提案送給正確的確認者。不是每個提案都要等使用者:

- **A(編輯既有資料夾)且符合准入三條**(命中既有 FEATURE.md 範圍、不落在「不在範圍」、不需要動契約)
  → 提案給**技術顧問**確認即可,不必等使用者——這件事本身落在決策權表「技術取捨」那一列。
- **B(新資料夾)、或任何被判成新功能 / 新需求的提案** → 一律等**使用者**確認,即使技術顧問已經覺得
  提案很合理也不能代替使用者拍板——這是決策權表「新功能、新需求」那一列,feature workflow 本身不能跳過它。
- C / D / E 依原本第三步的判定各自處理(C、E 本來就已經是「先問人」的路徑)。

**技術顧問 30 分鐘沒回應時**:**不要**代替他確認、也**不要**寫任何檔案——先去做其他 ready 的工作,
不要讓這張提案卡住整個迴圈,也不要因為等待而自己選一個方向往前走(來源 nightmare-assault,
commit e22d45c0)。等顧問回應後再回來走「確認後寫檔」。

## 第四步:輸出 L2 提案(不寫檔)

```
## 分流提案

需求:(重述)
目前階段:Wave 0 / I2 / …

拆解為 N 個能力:

### 能力 1:(一句話)
判定:A 編輯既有 / B 新資料夾 / C 衝突 / D 跨功能 / E 動契約
理由:(引用哪個 FEATURE.md 的哪一段、或哪個 ADR、或契約的哪一節)
目標:features/NN-name/phase-N.feature(既有或新建)
建議階段:Wave 0 / IN / 未排程
Gate:自身 …;整合 …;契約 …
單獨執行:(若是新資料夾,這個能力怎麼單獨跑?寫得出來才是好的切法)
變異門檻:嚴格 / 標準 / 寬鬆

草擬場景(標題,3–6 個,英文):
- Scenario: …
- Scenario: …
- @manual Scenario: …

### 能力 2:…

---
確認後我會:
1. 寫入 / 修改上述 .feature(英文)
2. 更新 FEATURE.md 的 phase 表
3. 更新 NEXT.md 的 gate
4. (新資料夾)從 _template 建立三個檔(`phase-1.feature.template` 要改名成 `phase-1.feature`)、更新 features/README.md、更新 roadmap
5. (有取捨)寫 ADR
6. 回報變更清單

要調整哪裡?或說「確認」。
```

**由產品 PM 呈現提案並停下來等回覆。** 沒有回覆不等於批准；等待期間可以處理其他不依賴本提案的產品探索。

## 第五步:確認後寫入 L3

1. **寫 gherkin**,英文,遵守 `features/README.md` 慣例。場景要完整可執行,不是只有標題,每個 3–6 步。
2. **更新 FEATURE.md**:phase 表加一行。新資料夾要從 `_template/FEATURE.md` 複製並填滿每一段——
   「範圍」與「不在範圍」要具體到下次 feature workflow 能拿來判斷,「單獨執行」要是真能跑的指令。
3. **更新 NEXT.md**:新 phase 的 gate 三類都要寫,以及「gate 未滿足時該做什麼」——
   這段最有價值,它防止之後有人在等待時瞎猜介面。
4. **新資料夾額外**:`features/README.md` 索引加一行(含單獨執行指令);
   `docs/01-roadmap.md` 的未排程表或某個整合點加一行。
5. **ADR**:分流過程做了「可以這樣也可以那樣」的選擇就寫一筆。純機械歸類不用。
6. **回報**:列出所有新增與修改的檔案路徑,一行一個。
7. **交付協調者**:附 `PROPOSAL-ID`、批准來源、目標 phase 與 gate；只有 L3 可以進入開發 DAG。

## 禁止事項

- 不寫程式碼,只產生規格
- 不修改 `contracts/` 任何檔案
- 不修改 `docs/00-design.md`
- 不修改 `done` 狀態 phase 的 `.feature`
- 未確認前不寫任何檔案
- 不直接承接使用者的新需求；先路由到 `product-pm`
- 不把 L0/L1 素材、PM 建議或技術可行性意見當成 L3 批准
- 不把「不確定放哪」硬歸到某個資料夾——列兩個候選讓使用者選
- 不產生無法單獨執行的新資料夾

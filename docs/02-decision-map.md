# Decision Map

所有有取捨的決定,ADR 格式,只增不刪。被推翻的標 `superseded`,不刪除——
決策地圖的價值就在於看得到「當初為什麼這樣想、後來為什麼改」。

新增用 `/decide`。

## 怎麼讀

- **Status**:`accepted` 生效 / `superseded by ADR-XXX` 被推翻 / `proposed` 待確認
- **Context** 當時的情況與限制 · **Decision** 決定了什麼 · **Alternatives** 沒選的
- **Consequences** 好處與代價 · **Related** 相關 ADR 與 feature
- 標「來源:範式」的 ADR 是這套開發範式本身的決策,不是你這個專案的產品決策——
  它們解釋「為什麼流程長這樣」,不需要因為你的產品不同而重新論證,除非你真的想推翻它

（1.4.0 拿掉了這裡原本的依賴圖 mermaid 區塊——三個採用專案都沒用過它,`docs/03-agile-workflow.md`
「最小模式」本來就把它列在「可以先關掉的」清單裡。ADR 之間的依賴關係讀各筆下方的 **Related** 欄,
不需要另外畫圖維護。）

---

## ADR-001 · 用 Gherkin 當驗收規格與測試

- **Status**: accepted · {{TODAY}} · 來源:範式
- **Context**: 需要一種「規格即測試」的機制,讓「做完了」有明確、可自動驗證的定義,而不是憑感覺。
- **Decision**: 每個 phase 一個 `.feature`,cucumber 執行。人眼才能判斷的場景標 `@manual`。沒有 gherkin 不開工。
- **Alternatives**: 只寫單元測試(規格散落在測試斷言裡,新人或 AI 看不出「為什麼」);先寫文件需求規格再寫測試(兩份東西容易脫節)。
- **Consequences**: 多一層要維護的檔案。換來的是規格與測試是同一份東西,不會脫節。
- **Related**: ADR-002, ADR-013, features/README.md

## ADR-002 · features/ 按能力切,不按里程碑切

- **Status**: accepted · {{TODAY}} · 來源:範式
- **Context**: 一個能力常常橫跨多個開發階段;如果按階段(里程碑)切資料夾,同一個能力的 gherkin 與程式碼會散落在好幾個地方。
- **Decision**: 一個能力一個資料夾,內含多個 phase。roadmap 負責把這些能力對應到 wave / integration 的時間軸上。
- **Alternatives**: 按里程碑切(`milestone-1/`、`milestone-2/`……);按技術層次切(`backend/`、`frontend/`)。
- **Consequences**: 資料夾結構穩定,不會因為排程調整而重新搬檔案。代價是「這個里程碑要做什麼」要另外查 roadmap,不能只看資料夾列表。
- **Related**: ADR-001, ADR-003

## ADR-003 · 新增 contracts/ 凍結層

- **Status**: accepted · {{TODAY}} · 來源:範式
- **Context**: 想要多個功能從一開始就能完全平行開工。平行的唯一障礙是「A 需要 B 的型別才能動」。
- **Decision**: 抽出 `contracts/`:所有跨模組型別、檔案格式、函式簽章、路由表、fixture 規範。Wave 0 開始後凍結,修改硬約定需要 ADR 並列出要重驗的 phase。
- **Alternatives**: 讓某個「基礎」功能先做完當前置(那樣就沒有平行);每個模組自己定義介面,整合時協調(整合會撞成一團)。
- **Consequences**: 多一層要維護。改契約成本高——這是刻意的。換來多個資料夾真正平行開發的可能性。
- **Related**: ADR-002, ADR-004, ADR-010, contracts/

## ADR-004 · Wave 0:所有 phase-1 完全平行,禁止跨資料夾 import

- **Status**: accepted · {{TODAY}} · 來源:範式
- **Context**: 想要第一階段完全平行,但平行開發最容易被「其實我需要另一個資料夾還沒寫完的東西」悄悄破壞。
- **Decision**: 每個資料夾的 phase-1 只能 import `contracts/` 與自己的目錄。需要別人的能力就用 contract 介面 + 自己的 stub。這條由邊界檢查腳本強制執行。
  一個例外:**組合層**(把其他模組串起來的薄薄一層)在被組合的東西存在之前無法獨立,硬造一個吃 stub 的版本等於重工——這種能力可以不參與 Wave 0,但要在 `FEATURE.md` 說明理由並記一筆 ADR。
- **Alternatives**: 允許依賴但排順序(那就不是平行了);只讓部分資料夾平行(複雜度不減、好處減半)。
- **Consequences**: 多個資料夾可同時開工。代價是 Wave 0 有重複(見 ADR-006)。
- **Related**: ADR-003, ADR-005, ADR-006

## ADR-005 · 每個功能必須能單獨執行,整合後仍然要能

- **Status**: accepted · {{TODAY}} · 來源:範式
- **Context**: 沒有一個永遠有效的耦合檢測器,模組會在整合過程中不知不覺黏死。
- **Decision**: 每個 `FEATURE.md` 有「單獨執行」段落,寫一行可複製的指令,並登記進 `standalone.json`。`/phase-done` 實際執行它。整合後仍須能跑——這是刻意的耦合約束。
- **Alternatives**: 只在 Wave 0 要求(那整合後模組會慢慢黏死)。
- **Consequences**: 每個模組要有 CLI 或等價的獨立入口,是額外工作。換來的是模組永遠可以單獨 debug,以及一個永遠有效的耦合檢測器。
- **Related**: ADR-004

## ADR-006 · 接受 Wave 0 的重複,整合時移除

- **Status**: accepted · {{TODAY}} · 來源:範式
- **Context**: 平行的代價是幾份重複的 stub / 假實作(例如每個需要外部服務的功能各自寫一份 fake)。
- **Decision**: 接受。每個 `FEATURE.md` 有「Wave 0 的重複」表,列出東西、位置、在哪個整合點移除。整合驗收時逐一檢查是否真的移除。
- **Alternatives**: 為了避免重複而排順序(等於放棄平行)。
- **Consequences**: 一點重複遠比一個依賴鏈便宜。額外好處:兩份獨立實作對同一份 fixture 算出不同結果,就代表契約有歧義——這種檢查只有在有兩份獨立實作時才做得到,錯過就沒了。
- **Related**: ADR-004

## ADR-007 · 每個整合點都必須是完整可用的系統

- **Status**: accepted · {{TODAY}} · 來源:範式
- **Context**: 「整合到一半」的系統是專案風險的主要來源之一——如果專案在某個時間點被迫停下,手上最好有個能用的東西。
- **Decision**: 每個整合點的驗收 gherkin 都必須有至少一個 `@e2e` 場景描述「一個人從頭到尾做完一件有意義的事」。寫不出這樣的場景,代表整合點切錯了,要重切。每個整合檔另有 `@regression` 場景驗證前一個整合點沒被弄壞。
- **Alternatives**: 按技術層次整合(先全部後端再全部前端)——那樣中間好幾個月沒有可用的東西。
- **Consequences**: 第一個整合點通過之後系統就有價值。專案在任何整合點停下來,手上都有能用的東西。代價是整合點的切法受限,不能純粹按技術方便切。
- **Related**: ADR-003, ADR-008, docs/integration/

## ADR-008 · 每個資料夾用 NEXT.md 管理 gate

- **Status**: accepted · {{TODAY}} · 來源:範式
- **Context**: 需要在資料夾層級告訴協作者(人或 AI)「下一步是什麼、什麼時候可以開始」,而不是只在全域的 roadmap 裡集中管理。
- **Decision**: 每個資料夾一個 `NEXT.md`:目前狀態、下一個 phase 的 gate(自身 / 整合 / 契約三類)、gate 未滿足時該做什麼、完成後解鎖什麼。排程時讀它決定 ready,不手動改狀態。
- **Alternatives**: 只在 roadmap 集中管理(在資料夾內工作時看不到);只靠 `FEATURE.md` 的依賴表(說得出「等什麼」但說不出「現在該做什麼」)。
- **Consequences**: 「gate 未滿足時該做什麼」是最有價值的段落——它防止協作者在等待時瞎猜介面、寫出要重寫的程式。
- **Related**: ADR-007

## ADR-009 · 導入 mutation testing 並分三級門檻

- **Status**: accepted · {{TODAY}} · 來源:範式
- **Context**: 行覆蓋率抓不到「執行到但沒驗證」的測試。專案裡通常有一部分邏輯(排程、計分、驗證、路徑防護一類)算錯的代價是延遲很久才被發現。
- **Decision**: 用 Stryker(或等價工具)。三級門檻:嚴格(核心純函式與安全邊界)、標準(有 IO 或外部依賴的邏輯)、寬鬆(adapter、CLI、UI 元件,不強制)。驗收前必跑。
- **Alternatives**: 只用行覆蓋率(抓不到「執行到但沒驗證」);全專案統一門檻(對 UI 追高分沒有意義,會浪費時間)。
- **Consequences**: 驗收變慢。換來核心邏輯的信心。明確禁止「為衝分數寫斷言」——那會在重構時變成阻力。
- **Related**: ADR-011, .claude/skills/mutation-testing/

## ADR-010 · 契約分硬約定與軟約定

- **Status**: accepted · {{TODAY}} · 來源:範式
- **Context**: 把整份契約都凍死太重——型別改了編譯器會抓、測試會抓,走 ADR 是儀式不是保護。但磁碟格式改了會讓已產生的資料失效,需要更審慎的流程。
- **Decision**: **硬約定**(磁碟格式、跨模組共用的任務常數與路由表)改動需要 ADR。**軟約定**(記憶體介面、函式簽章)改了跑測試、更新契約文件、commit 說明理由即可。
- **Alternatives**: 全凍(太重);全不凍(協作者跨 session 會漂移)。
- **Consequences**: 改函式簽章不再是一場儀式。磁碟格式仍然受保護。契約升版遵照語意化版本。
- **Related**: ADR-003, contracts/README.md

## ADR-011 · 只有嚴格級的變異門檻是硬性的

- **Status**: accepted · {{TODAY}} · 來源:範式
- **Context**: 讓驗收在任何變異測試門檻未達標時都擋住,對 UI 與 adapter 這類程式碼是浪費時間。
- **Decision**: **嚴格級未達 → 擋住驗收**,因為那些模組算錯的代價是延遲很久才顯現。**標準級未達 → 回報但不擋**,由使用者決定要不要處理。**寬鬆級 → 不跑。**
- **Alternatives**: 全部硬性(拖慢驗收速度);全部軟性(核心邏輯的測試品質會鬆掉)。
- **Consequences**: 驗收變快。代價是標準級模組的測試品質靠自律。這個取捨是刻意的:嚴格級涵蓋了所有「錯了會靜默」的地方。
- **Related**: ADR-009

## ADR-012 · 流程分核心與選配,可以只用核心

- **Status**: accepted · {{TODAY}} · 來源:範式
- **Context**: 這一整套流程(契約、gherkin、Wave 0、NEXT.md、sprint、mermaid 依賴圖、分級變異測試……)對小團隊或個人加 AI 配對開發來說偏重,重到會被放棄。
- **Decision**: 明確區分**核心**(契約、gherkin、phase 驗收的測試與單獨執行檢查)與**選配**(sprint 檔、整合驗收的完整清單、decision map 的 mermaid 圖、標準級變異測試)。`03-agile-workflow.md` 的「最小模式」段落說明只用核心怎麼跑。
- **Alternatives**: 全部必做(會被放棄);刪掉選配的部分(專案長大時會後悔)。
- **Consequences**: 流程是為了保護你不犯已知的錯,不是為了被遵守而存在。用不到就關掉,需要時再開。
- **Related**: ADR-007, docs/03-agile-workflow.md

## ADR-013 · gherkin runner 的 TypeScript 載入方式要明確決定,不要留給預設值猜

- **Status**: accepted · {{TODAY}} · 來源:範式
- **Context**: 用 TypeScript 寫 cucumber 的步驟定義時,ESM + TypeScript 的載入方式(ts-node / tsx / 先編譯)有好幾種選項,選錯或設定檔格式錯了,錯誤訊息往往是「所有 step 都是 undefined」,很難第一時間定位到是設定問題而不是步驟寫錯。
- **Decision**: 用 `tsx` 的 `--import` ESM loader。驗收腳本前綴 `NODE_OPTIONS=--import=tsx`;runner 設定檔(如 `cucumber.js`)的 `paths` / `import` / `tags` 要照著官方 schema 寫在頂層,不要多包一層物件——多包一層會讓設定被安靜忽略,不會報錯,只會讓所有步驟變成 undefined。步驟檔之間互相 import 用 ESM 慣例(`./_world.js`,執行時對應到 `.ts`)。
- **Alternatives**: ts-node/esm(維護較慢、ESM 支援不穩);先編譯再跑(多一步建置)。
- **Consequences**: 整個 repo 的 TypeScript 執行只有一條路。換平台(例如要在 Windows 上跑)時,`NODE_OPTIONS=` 這種前綴語法可能要改用跨平台寫法,到時再處理。
- **Related**: ADR-001, features/steps/README.md

## ADR-014 · Wave 0 平行開發的落點與共用檔歸屬

- **Status**: accepted · {{TODAY}} · 來源:範式
- **Context**: 多個 phase-1 各開一個 git worktree 同時做時,互踩只會發生在共用檔與同一個目錄,所以要在分叉前定好,而不是撞到了才處理。
- **Decision**:
  1. 落點表要在一個固定的地方(例如 `packages/core/README.md`),邊界檢查腳本的 OWNERS 表是同一份表的程式版。每個功能一個自己的原始碼子目錄(含自己的 stub)。
  2. 如果有共用的展示層 / UI 元件庫,明確指定 Wave 0 期間由哪個功能擁有,其他功能在對應的整合點之前不 import 它。
  3. **共用檔只有協調者改**:`package.json`、lock 檔、`tsconfig.json`、runner 設定檔、`standalone.json`、`features/steps/_world.ts`、`features/steps/common.steps.ts`、roadmap、本檔。worker 把需求寫在自己 `FEATURE.md` 的「待協調」段。
  4. **出現在兩個以上資料夾的 gherkin 句子只在 `common.steps.ts` 定義一次**;只用在 `@manual` 場景的句子不定義(cucumber 對重複定義會報錯,這是刻意利用來強制統一措辭)。
  5. 所有依賴一次裝在 root(workspaces hoisting),worktree 只跑 `npm ci`,不動 lock。
  6. 合併順序與合併後的檢查清單要先講好(通常是:產出 fixture / 契約可執行版本的能力先合併,其餘隨到隨合;每次合併後跑邊界檢查、單元測試、standalone 驗收、standalone 檢查腳本)。
- **Alternatives**: 各 worktree 自己加依賴與 workspace(lock 檔幾乎必衝);允許兩個功能同時寫同一個共用元件庫(同檔互踩)。
- **Consequences**: worker 的自由度小一點,但合併幾乎不會衝突。「WIP ≤ 2」的建議在 Wave 0 期間可以暫時放寬(因為 Wave 0 的並行不是同一個人同時做,而是多個角色/多個 worktree),Wave 0 之後恢復。
- **Related**: ADR-004, ADR-005, ADR-006, packages/core/README.md(如果是 monorepo), scripts/check-boundaries.ts

## ADR-015 · BMAD skill 逐支分類(吸收 / 改寫後吸收 / 不吸收 / 衝突需裁決)

- **Status**: proposed
- **Context**: 【驗】使用者在 `DECISIONS_NEEDED.md` #1 批示先產出 BMAD 29 支 skill 的逐支分類，再決定是否修改規則層。【驗】BMAD 的 29 支 skill 同時包含上游需求塑形、另一套規格與 sprint 狀態、named-agent persona、單一 workflow 內的實作/測試/審核，以及多代理 review；本範式已用 `contracts/`、`FEATURE.md`、`NEXT.md`、Gherkin、既有角色與 gate 定義自己的權威鏈。需要先區分哪些能力可直接補強流程、哪些必須映射到既有權威、哪些只是重疊、哪些會改變規則或硬約定。
- **Decision**: 提議依下表分類。表內對 BMAD 行為的描述來自逐支 `SKILL.md` 與相關 manifest 的檢閱【驗】；「吸收方式」是待使用者審閱的技術提案【推】，本 ADR 尚未授權安裝或修改任何 skill。
- **Revision note (2026-09-10)**: 【驗】`DECISIONS_NEEDED.md` #2 已批准產品 PM 與三種 dispatch mode 的組織架構，因此最初以「本範式不新增角色」統一排除 persona wrapper 的前提已部分失效。本次只重算五支 `bmad-agent-*` 的分類與理由；各列保留原提案理由作歷史紀錄，安裝或修改規則層仍待另行批准。

| skill | 類別 | 一句話理由 | 若「改寫後吸收」則寫要改什麼 |
|---|---|---|---|
| `bmad` | 改寫後吸收 | 【驗】manifest 驅動的技能發現與下一步路由能解決技能入口分散，但原路由以 `_bmad` module knowledge 與 BMAD artifact 為權威。 | 改讀本範式的 roadmap、`FEATURE.md`、`NEXT.md`、Gherkin 與 gate；保留動態發現，移除 setup/update/doctor 與 BMAD-only artifact 假設。 |
| `bmad-advanced-elicitation` | 吸收 | 【驗】只對近期輸出做可選的結構化反思，且必須由使用者接受後才套用，不改動既有權威。 | — |
| `bmad-agent-analyst` | 不吸收 | **(2026-09-10 修訂)** 【推】analyst 的研究與需求觀點可作為 PM 發起的 party roster 席位，底層 research/brief workflow 已能獨立提供能力，無須建立另一個使用者入口或常駐批准角色。**原提案理由（已被本修訂取代，保留留痕）**：【驗】它是 analyst persona 與底層 research/brief skill 的 menu 包裝；本範式不新增角色，能力可直接由對應 workflow 提供。 | — |
| `bmad-agent-architect` | 不吸收 | **(2026-09-10 修訂)** 【推】architecture/readiness 的判斷權已屬技術顧問；它可作 party 的諮詢觀點，但若成為常駐 persona 會形成第二套技術裁決入口。**原提案理由（保留留痕）**：【驗】它是 architecture/readiness 的 persona 路由，與既有技術顧問職責重疊，另設 Winston 會形成第二套技術權威。 | — |
| `bmad-agent-dev` | 改寫後吸收 | **(2026-09-10 修訂)** 【推】可重用其 activation/menu chassis 作為所有實作 session 的共同外殼；分區開發、分區整合、全局整合由 ARIA 在每張 dispatch 注入 mode，不變成三個常駐角色。**原提案理由（已被本修訂取代，保留留痕）**：【驗】它是 build/QA/review/sprint/retro 的 persona 路由，且其 test-first 開發者可同時碰測試，與既有 dev/test 分工重疊。 | 移除 Amelia/BMAD 品牌、`_bmad`/`uv` resolver、story/sprint 狀態與自行選單派工；只接受 ARIA 的結構化 dispatch，以 `mode`、`allowed_paths`、`forbidden_paths`、驗收條件和回報位置限制工作；不得修改測試、規則層、共用檔、合併或 push。 |
| `bmad-agent-pm` | 改寫後吸收 | **(2026-09-10 修訂)** 【驗】產品 PM 已由 `DECISIONS_NEEDED.md` #2 批准為使用者的產品入口；原 skill 的訪談、需求探索、小步驗證與 menu chassis 可作骨架，但 PM 不取得新功能批准權或排程權。**原提案理由（已被本修訂取代，保留留痕）**：【驗】它主要把 PRD、epics、readiness、correct-course 包進 PM persona；底層 workflow 可保留，新增 PM 決策角色沒有額外能力。 | 移除 John/BMAD 品牌、`_bmad`/`uv` resolver 與 BMAD planning-artifact 權威；主入口改為 `/feature`，brainstorm/party 只產上游素材；新功能仍由使用者批准，ARIA 是唯一 session/worktree scheduler，技術可行性送 NOVA。 |
| `bmad-agent-ux-designer` | 不吸收 | **(2026-09-10 修訂)** 【推】UX 可作 PM party roster 的觀點來源，實際設計產物由已列「改寫後吸收」的 `bmad-ux` workflow 產出；建立另一個常駐使用者入口會分散 PM 對產品意圖的保管責任。**原提案理由（已被本修訂取代，保留留痕）**：【驗】它只以 Sally persona 路由 `bmad-ux`；UX 能力可由 workflow 提供，無須增加角色與批准權。 | — |
| `bmad-architecture` | 改寫後吸收 | 【驗】精簡 architecture spine 有助平行單元保持一致，但其 invariant contract 可能與 `contracts/` 和 ADR 權威重疊。 | 將架構輸出定位為提案；硬約定走使用者批准與 ADR，既有決策寫回 decision map，不能另立更高權威。 |
| `bmad-brainstorming` | 吸收 | 【驗】它在開工前擴展與整理構想，產物不自動成為需求或實作授權。 | — |
| `bmad-build` | 改寫後吸收 | 【驗】它把澄清、規劃、實作、review、驗證串成可恢復流程，但把多種責任放在同一 workflow。 | 入口改成已批准 phase/Gherkin；dev 不改測試與共用檔，在獨立 worktree 實作，獨立 reviewer 與 main `check:all` 才能收尾。 |
| `bmad-build-auto` | 改寫後吸收 | 【驗】它提供無人值守的一次 build iteration，適合成為被協調者派發的 worker 協定，但原狀態與回復流程使用 BMAD spec/story artifact。 | 只接受明確工單與獨立 worktree；沿用本範式角色禁區、回報格式、失敗留痕與 gate，不寫 BMAD sprint/spec 狀態。 |
| `bmad-code-review` | 改寫後吸收 | 【驗】平行獨立 reviewer 能補強審核，但原流程的 reviewer 選擇、輸出與 BMAD build triage 尚未接上本範式 gate。 | reviewer 限定既定模型/effort；逐項附可重跑證據，加入反向驗證與越界檔檢查，結果回到現有 REVIEW/phase/integration 流程。 |
| `bmad-correct-course` | 改寫後吸收 | 【驗】跨產物評估重大變更有用，但它以 PRD/epic/architecture/UX 與 sprint change proposal 為主要座標。 | 改以 contracts、ADR、roadmap、`FEATURE.md`、`NEXT.md`、`.feature` 做 impact map；新功能、硬約定與規則層一律送使用者裁決。 |
| `bmad-create-epics-and-stories` | 改寫後吸收 | 【驗】需求切片與 acceptance criteria 有用，但 epic/story 不是本範式的能力/phase 權威。 | 將 epic/story 映射為 capability folder 與 phase，acceptance criteria 必須轉成先行 `.feature`，建立檔案前沿用 `/feature` 的提案確認。 |
| `bmad-customize` | 衝突需使用者裁決 | 【驗】它的核心輸出是 `_bmad/custom/` 下的 skill/agent 行為 override；是否建立可繞開目前規則層審批與單一來源的新覆寫層，屬使用者決策。 | — |
| `bmad-deep-recon` | 吸收 | 【驗】它以可追溯來源支援市場、技術、競品、使用者聲音或選型決策，不自行批准產品或契約變更。 | — |
| `bmad-forge-idea` | 吸收 | 【驗】它在投入實作前壓力測試未成熟想法，產物可留作 `/feature` 的上游輸入而不改 gate。 | — |
| `bmad-party-mode` | 改寫後吸收 | 【驗】多 persona 圓桌與可選獨立 agent 是可重用的多代理討論機制，但原 named-agent roster 沒有本範式的權責限制。 | persona 只提供觀點；決策仍依 coordinator/advisor/user 表，worker 使用指定模型與 high effort，長產物落檔且不以終端互相 wait。 |
| `bmad-prd` | 改寫後吸收 | 【驗】PRD 能補足需求探索，但若直接成為下游實作依據會與 Gherkin 規格權威分叉。 | PRD 明定為上游素材；新增/變更 scope 由使用者批准，所有可實作需求經 `/feature` 落成 capability、phase 與 `.feature`。 |
| `bmad-prfaq` | 吸收 | 【驗】Working Backwards 是開工前的產品概念壓力測試，輸出不必取代契約或 Gherkin。 | — |
| `bmad-product-brief` | 吸收 | 【驗】互動式 brief 可補 `/feature` 前的需求塑形，且本身可保持為非權威的規劃素材。 | — |
| `bmad-project-context` | 衝突需使用者裁決 | 【驗】它的核心工作是建立、改寫或稽核 `AGENTS.md` 並可能修正其他 instruction file；這直接進入使用者保留批准權的規則層。 | — |
| `bmad-qa-generate-e2e-tests` | 改寫後吸收 | 【驗】API/E2E 自動化能力有用，但原流程針對已實作功能事後產生測試，與 Gherkin 先行及 dev/test 分權不一致。 | 由 test agent 依既有 `.feature` 寫步驟與測試紅燈；不新增需求、不改考卷以遷就實作，接入 `accept`、`@e2e` 與反向驗證。 |
| `bmad-retrospective` | 改寫後吸收 | 【驗】以 diff、commit、測試與規格來源化回顧能留下學習，但 epic verdict/sprint-status 不能取代 phase/integration 驗收。 | 輸入改為 phase/integration 與本範式證據；行動項目送 `PITFALLS.md`/ADR/待辦，acceptance 不覆蓋人工 `@e2e` 或既有 gate。 |
| `bmad-review` | 改寫後吸收 | 【驗】可組合的 code/doc review lens 有增益，但 adversarial lens 強制至少十項 findings 會鼓勵噪音，且輸出未使用本範式宣稱標記。 | 取消 findings 配額；只報可定位、可重跑項目，標示【驗／推／未驗】，並遵守規則層與 worker 分支只讀邊界。 |
| `bmad-spec` | 衝突需使用者裁決 | 【驗】它明定 `.memlog.md` 是 decision-of-record、`SPEC.md`/companions 是 machine contract，另產生 `stories.yaml`；這與 contracts、ADR、FEATURE/NEXT、Gherkin 的既有權威直接競爭。 | — |
| `bmad-sprint-planning` | 不吸收 | 【驗】本專案已有同名 sprint skill，並以 roadmap、`FEATURE.md`、`NEXT.md` 判定 ready；再引入 `sprint-status.yaml` 會建立重複狀態來源。 | — |
| `bmad-ux` | 改寫後吸收 | 【驗】`DESIGN.md`/`EXPERIENCE.md` 可補足 UI 規劃，但其雙 spine 不應自行批准功能、行為或凌駕 Gherkin。 | 將兩份文件列為設計 companion；行為、狀態與 journey 轉成 `.feature`，新增 scope 送使用者批准，人工觀感仍走既有驗收。 |
| `bmad-walkthrough` | 吸收 | 【驗】它只引導人類理解變更、查看風險與實際操作測試，不替代自動 gate 或接受決策。 | — |

- **Consequences**: 【推】若使用者接受此分類，第一波可先加入 7 支低衝突的上游／輔助能力；13 支需先完成權威映射、角色分權或 gate 接線；6 支不建立獨立 skill；3 支暫停至使用者決定規則與 machine-contract 邊界。【推】好處是保留 BMAD 的需求塑形、多代理與 evidence workflow，同時維持 contracts/Gherkin/ADR/phase gate 的單一權威；代價是不能直接整包安裝，部分 BMAD 更新需人工重做 adaptation。【驗】在本 ADR 仍為 `proposed` 時，不修改 `CLAUDE.md`、`.claude/skills/`、`contracts/`，也不啟動 worker。
- **Revision consequence (2026-09-10)**: 【推】本次重算後的現行統計為 7 支「吸收」、15 支「改寫後吸收」、4 支「不吸收」、3 支「衝突需使用者裁決」；此統計取代上一行保留的 13／6 初版統計。兩支新增的「改寫後吸收」只代表草案方向，未授權安裝；共同 activation chassis 與 mode 注入會增加 dispatch schema、allowlist 檢查及角色邊界維護成本。
- **Related**: ADR-001, ADR-003, ADR-004, ADR-007, ADR-012, ADR-014, DECISIONS_NEEDED #1
- **Revision related (2026-09-10)**: ADR-016, DECISIONS_NEEDED #2

---

## ADR-016 · 開發模式的組織架構與 dispatch mode 邊界

- **Status**: accepted · 2026-09-10
- **Context**: 【驗】使用者在 `DECISIONS_NEEDED.md` #2 批准四條組織架構條件：使用者只需透過產品 PM 處理產品需求、透過技術顧問處理開發決策；其餘 session/worktree 由協調者統一管理。若 PM、協調者、技術顧問與開發 session 都能自行批准需求或建立 worker，會出現多個排程者與互相矛盾的權威；若「分區開發／分區整合／全局整合」被設成三個新的決策角色，也會讓一次派工同時攜帶不清楚的權限。
- **Decision**:
  1. **產品入口與批准權**：產品 PM 是使用者的產品入口，負責訪談、需求探索、整理產品意圖與主持 `/feature`；新功能、新需求、產品範圍變更與既有產品決策衝突仍由使用者批准。技術顧問是使用者的開發決策入口，負責技術取捨、介面、gate 例外與 main 上的最終複驗。
  2. **唯一排程者**：ARIA 是唯一可建立、分派、監督與回收 session/worktree 的協調者。PM 可提交探索請求，定義問題、建議 roster、預算與輸出格式，但不得自行啟動 worker；技術顧問提供裁決，不接管 worker 分支或合併流程。
  3. **三種開發單元是 dispatch mode**：每張工單只帶一個 `mode`，並明列 `allowed_paths`、`forbidden_paths`、輸入規格、完成條件、驗證指令與回報位置。Mode 改變關注點與可寫範圍，不新增批准權；超出 allowlist 的需求一律回報 ARIA 重新派工。

     | mode | 主要責任 | `allowed_paths` | `forbidden_paths` 與越界處理 |
     |---|---|---|---|
     | **分區開發** | 完成單一 capability 的單一 phase 實作；Wave 0 額外遵守禁止跨資料夾 import | 工單逐條列出的該分區實作檔與該分區自有 stub | 不改其他分區、測試、Gherkin、共用檔、roadmap、ADR、規則層與 contracts；需要跨區或共用檔時，把證據交 ARIA 另派工 |
     | **分區整合** | 在指定 integration point 接通一條已批准的跨區流程 | 工單預先指定的 composition、adapter 或 integration-seam 實作檔；可讀所涉分區的公開介面 | 不改任一來源分區的內部實作、測試、規格、共用檔、規則層與 contracts；根因位於分區內時，由 ARIA 派回該分區的 debug／開發工單 |
     | **全局整合** | 在合併後完整系統上驗證 `@e2e`、`@regression`、所有 standalone 與完整 gate，定位跨區退化 | 預設只寫 worktree-local 報告；只有工單明列唯一的全局 composition 落點時才可寫該路徑 | 不順手修分區內部、不修改測試讓結果變綠、不合併、不 push；問題拆回分區修復或分區整合工單，最後由技術顧問在 main 複驗 |

  4. **探索產物的權威界線**：PM 的 brainstorm、party-mode 與研究產物在 `/feature` 確認 gate 前都是上游素材；只有通過確認的 L3 規格才可成為開發排程輸入。權威階梯如下：

     | 層級 | 產物 | 權威與可用方式 |
     |---|---|---|
     | **L0 探索證據** | party transcript、brainstorm、研究摘錄 | 只證明討論與觀察，不可派工 |
     | **L1 PM 綜整** | product brief、PRD、候選 capability、未解問題 | `/feature` 的上游素材，不可直接改權威規格或排程 |
     | **L2 `/feature` 提案** | A/B/C/D/E 分流、目標 phase、gate、草擬 scenarios、衝突清單 | 待適格批准者確認；此時仍不可派工 |
     | **L3 已批准規格** | 已確認並寫入的 `.feature`、`FEATURE.md`、`NEXT.md` 及必要索引／roadmap | 可由 ARIA 納入開發 DAG；硬約定仍以 contracts 與 ADR 為準 |

     L2→L3 的唯一界線是 `/feature` 的確認 gate：A 類既有範圍且不改契約可由技術顧問確認；B 類新 capability／新功能、C 類推翻既有決策與 E 類硬約定必須由使用者批准。D 類先拆分後逐項重新判定。
- **Alternatives**: 讓 PM 自行開 agent team（會形成第二個 scheduler，且探索結論可能繞過 `/feature`）；把三種 mode 建成三個有獨立裁決權的 persona（同一問題可能得到三份不相容決定）；允許分區整合直接修改來源分區（失敗時無法區分整合錯誤與分區退化）；讓 party 產物直接成為 `.feature`（會略過產品與契約批准）。
- **Consequences**: 使用者只需維持產品 PM 與技術顧問兩個對話入口，所有執行 session 都有單一 scheduler、可追蹤工單與明確寫入邊界；探索能充分展開而不會暗中改變正式需求，整合失敗也能依責任區域退回。代價是 ARIA 會成為排程瓶頸；PM 發起探索後需多一次移交；分區整合發現來源缺陷時不能就地修復，會增加一輪工單；全局整合預設只驗證，修復鏈較長；每張 dispatch 都必須維護 allowlist、證據與回報 envelope。
- **Related**: ADR-001, ADR-004, ADR-007, ADR-015, DECISIONS_NEEDED #2

---

## ADR-017 · 人工驗收依場景 tag 分流

- **Status**: accepted · 2026-09-10
- **Context**: 【驗】使用者在 `DECISIONS_NEEDED.md` #4 選擇 A：觀感／品質由技術顧問判定，端到端「你做得到嗎」由使用者確認。【驗】裁決前，`CLAUDE.md` 將 `@manual` 與 `@e2e` 的人眼確認都交技術顧問，`.claude/skills/autopilot/SKILL.md` 則把兩者都交使用者，形成既有衝突。NOVA 以文字搜尋找到兩條原文，並從 `git diff` 的 context 確認衝突不是本輪規則層變更新增；ARIA 隨後獨立重跑文字搜尋與 diff context，得到相同結果。方向裁決後仍需處理同一場景同時帶 `@e2e @manual` 時的雙重命中，否則流程會產生兩位最終確認者。
- **Decision**:
  1. 任何帶 `@e2e` 的場景，即使同時帶 `@manual`，都由**使用者**做最終「你做得到嗎」確認；協調者必須附場景原文與檔案路徑。自動測試、技術顧問或其他角色都不能代替這項確認。
  2. 只有 `@manual and not @e2e` 的場景才由**技術顧問**做觀感／品質判定。技術顧問必須留下逐項依據與發現：phase 驗收寫進該次驗收報告，整合驗收寫進 `docs/integration/<IN>-REVIEW.md`。
  3. 自動場景與 gate 沿用原流程，不因本次分流改變執行者或通過條件。機械路由的優先順序固定為「先判 `@e2e`，其餘 `@manual` 才交技術顧問」，不能依模型當場解讀場景語意。
  4. `CLAUDE.md`、`autopilot`、`phase-acceptance` 與 `integration-check` 必須使用上述同一規則；`dev-worker` 維持引用 `CLAUDE.md` 決策權表，不複製另一份權責定義。
- **Alternatives**: 所有人工場景都交使用者(會把觀感／品質檢查變成使用者的日常負擔)；所有人工場景都交技術顧問(會讓技術角色代替使用者判斷端到端是否真的可用)；只用「觀感」與「端到端」的自然語意分流、不定 tag 優先權(雙重命中時仍會產生歧義)。
- **Consequences**: `@e2e` 保留使用者對完整可用性的最終決定權，日常觀感／品質檢查則由技術顧問承接並留下證據；協調者可直接用 tag 算出確認者，不必臨場猜測。代價是規格作者必須正確標記場景，四處規則文字需同步維護；人工確認未完成前仍不能把 phase 或整合點標成完成。
- **Related**: ADR-001, ADR-007, ADR-016, DECISIONS_NEEDED #4, `.claude/skills/phase-acceptance/SKILL.md`, `.claude/skills/integration-check/SKILL.md`

---

## 待決(不影響開工)

| 項目 | 需在何時前決定 | 阻擋什麼 |
|---|---|---|
| {{PENDING_DECISION_1}} | {{PENDING_BEFORE_1}} | {{PENDING_BLOCKS_1}} |
| {{PENDING_DECISION_2}} | {{PENDING_BEFORE_2}} | 無 |

這張表是給你的專案自己的待決事項用的,上面兩列只是範例,可以直接刪掉重寫。
規則:**待決事項不阻擋開工**,只阻擋某個明確標出來的 phase——如果一個待決事項
擋住了大半個專案,它其實已經不是「待決」而是「該現在就決定」,回去問使用者。

## 已推翻

(目前無。被推翻的 ADR 保留在上方並標 `superseded by ADR-NNN`,這裡列索引:
`- ADR-XXX 被 ADR-YYY 推翻:一句話原因`)

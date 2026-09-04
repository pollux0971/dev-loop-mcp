# 開發範式模板

一套「契約先凍結、gherkin 即測試、Wave 0 平行開發、整合點永遠是完整系統」的
專案骨架。抽自一個實際跑過一輪 Wave 0 平行開發的專案(桌面應用 + LLM 內容生成,
細節見 `CHECKLIST.md` 的例子欄),把**流程與結構**留下,把**產品細節**換成 `{{PLACEHOLDER}}`。

## 這是什麼、不是什麼

**是**:一套文件骨架 + 兩個 TypeScript 腳本(邊界檢查、單獨執行檢查)+ 六個 Claude Code skill。
落地後你會有 `contracts/`、`features/`、`docs/`、`.claude/skills/` 這些東西,馬上可以開始寫
第一份契約與第一個 `.feature`。

**不是**:不是某個技術棧的專案模板(不綁定前端框架、不綁定雲端 provider)。
`package.json`、`cucumber.js`、`vitest.config.ts`、`stryker.config.json`、`tsconfig.json`
這幾個檔案照抄了原專案的版本作為**可用的起點**,但工具鏈(TypeScript + vitest + cucumber
+ stryker)是這套範式的一部分,不建議換掉——其他文件講的流程都假設這四個工具存在。

## 核心原則(落地前務必理解)

1. **契約先凍結,再平行。** `contracts/types.md` 分硬約定(改需 ADR)與軟約定(改了跑測試就好)。
   平行開發的唯一障礙是「A 需要 B 的型別才能動」,契約把這個障礙拿掉。
2. **一個資料夾一個能力,一個能力切多個 phase,一個 phase 一個 `.feature`。**
   Gherkin 是規格也是測試,沒有 gherkin 不開工。
3. **Wave 0 完全平行。** 所有能力的 phase-1 只 import contracts 與自己的目錄,
   需要別人就寫 stub,接受短暫重複,整合時再移除。
4. **每個整合點都是完整可用的系統。** 不做「整合到一半」,每個整合檔至少有一個 `@e2e`
   場景描述「一個人做得到什麼」。
5. **每個功能單獨可跑。** `standalone.json` 是驗收時實際執行的來源,不是文件。
6. **ADR 只增不刪。** 「A 或 B」先查決策地圖,沒決定過才問人。
7. **變異測試分三級,只有嚴格級是硬門檻。** 不要對所有程式碼一視同仁地追高分。
8. **流程分核心與選配,可以先關掉選配的部分。** 見 `docs/03-agile-workflow.md` 的「最小模式」。

**既有專案要切換過來的,先讀 `docs/06-brownfield.md`**——第一週的順序跟 greenfield 不同。

落地前先掃一遍 `PITFALLS.md`——那是兩個專案實際踩過的坑,每條都對應一個檔案裡的防線;新專案踩到新坑就補一條並同步改 template。

想知道「為什麼這樣設計」而不是「怎麼用」,讀 `docs/02-decision-map.md` 裡標「來源:範式」
的 ADR——那些是這套範式本身的決策紀錄,寫這些規則的人當初也是這樣一條一條踩出來的。

## 5 步驟落地到新專案

### 步驟 0:複製

把整個 `template/` 資料夾的內容複製到新 repo 的根目錄(包含隱藏的 `.claude/`):

```bash
cp -r template/. /path/to/new-repo/
cd /path/to/new-repo
git init   # 如果還沒有
```

複製完 `template/` 這層目錄本身就不需要了。

### 步驟 1:填 `CHECKLIST.md`

打開 `CHECKLIST.md`,表格裡列出每一個 `{{PLACEHOLDER}}`——在哪個檔案、填什麼、原專案的例子
長什麼樣。**逐一填完,不要留著 `{{}}` 進到下一步**,否則型別檢查與腳本會直接壞掉
(`package.json` 的 `name`、`.env.example` 的變數名之類是機械性替換,漏了不會立刻報錯,
但會在你以為填好了的地方留一個地雷)。

驗證:`grep -rn '{{' .` 在新 repo 根目錄應該回傳空。

### 步驟 2:寫 `contracts/types.md` 與 fixtures,然後凍結

這是**唯一需要在開工前定案**的東西。把你的資料格式、跨模組型別寫進 `contracts/types.md`,
分清楚哪些是硬約定(磁碟格式,改了要 ADR)、哪些是軟約定(記憶體介面,改了跑測試就好)——
`contracts/README.md` 有分層的判準。同時在 `contracts/fixtures/` 放**真的檔案**,不是規範:
最小可用的合法樣本、至少一個刻意壞掉的樣本(附 `EXPECTED.md` 答案卷)。

寫完問自己:「十個不同的功能,看著這份契約,會不會對同一個型別長出不同的理解?」
如果會,契約還不夠具體。

**這一步定案之後,硬約定就凍結了**——不是說不能改,是改了要走 `/decide`。

### 步驟 3:用 `/feature` 開第一批資料夾,寫 phase-1 gherkin

依你的領域拆出能力(每個能力一句「系統能夠 ___」描述、能獨立驗收),對每個能力跑
`/feature <描述>`。它會提案該開新資料夾還是加進既有的,**先看提案再確認**。
確認後它會從 `features/_template/` 建立 `FEATURE.md`、`NEXT.md`、`phase-1.feature`。

每個 phase-1 的 `.feature` 應該:只依賴 contracts 與自己的目錄、有一個「單獨跑起來會怎樣」
的場景、需要別人的能力就用 stub(寫進 FEATURE.md 的「Wave 0 的重複」表)。

### 步驟 4:Scaffold commit

**在分叉成多個 worktree 平行開發之前**,先在 main 上做一次完整的骨架 commit
(這是原專案 ADR-035 的教訓:分叉之後才發現共用檔沒裝好,worker 會互踩)。
這次 commit 至少要包含:

- [ ] `package.json` 的 workspaces(如果是 monorepo)與 `name` 已改好
- [ ] 所有 devDependencies 一次裝齊,`npm install` 跑過,**lock 檔案已 commit**
- [ ] `npm run boundaries`、`npm run standalone`、`npm run test`、`npm run accept`
      這幾個腳本都能執行(即使因為還沒有程式碼而回報「沒有東西可測」也算過,
      不能是指令本身找不到或炸掉)
- [ ] `cucumber.js` 的 `paths` 已經指到你的 `features/` 與 `docs/integration/`
- [ ] `features/steps/_world.ts` 與 `common.steps.ts` 就位,通用步驟只定義一次
- [ ] `scripts/check-boundaries.ts` 的 `OWNERS` 表填好每個 Wave 0 能力的落點
- [ ] `standalone.json` 每個 Wave 0 能力都有一行(先寫預期指令,即使還跑不起來也要列出來,
      這樣 `/phase-done` 才知道要驗什麼)
- [ ] `docs/01-roadmap.md` 的 Wave 0 表與各 `features/*/FEATURE.md` 對得起來

之後每個 worktree 只跑 `npm ci`,不再動這些共用檔——共用檔只有協調者改
(見下面的角色分工)。

### 步驟 5:開 worktree 派工

Wave 0 的每個 phase-1 一個 worktree,可以同時開工,順序自由。角色分工:

| 角色 | 負責 | 不做的事 |
|---|---|---|
| **協調者**(coordinator) | 開 worktree、依 gherkin 派工、找獨立審核者複查、合併進 main、統一改共用檔與 ADR 編號 | 不自己寫實作 |
| **技術顧問 / 審核**(advisor-reviewer) | 做設計判斷、回答協調者的問題、在 main 跑完整檢查、通過後 push | 不直接改 worker 的分支 |
| **開發 worker**(dev) | 只寫實作 | **不新增不修改 `*.test.ts` 與 `features/steps/**`**,可以跑測試但不能改;不 push;共用檔不動,需求寫進自己 `FEATURE.md` 的「待協調」段 |
| **測試 agent**(test) | 照 `.feature` 先寫步驟檔與單元測試(紅),交給 dev 做綠;變異不足也由它補 | 不寫實作程式碼 |

審核時的機械檢查(擋掉 worker 碰了不該碰的檔案):

```bash
git diff --name-only main...<branch> | grep -E '\.test\.ts$|^features/steps/'
```

有輸出就退回。這條規則的理由:測試是規格的一部分,worker 改測試等於自己改考卷。

分工背後還有一條經驗:**便宜的模型做機械工作**(寫碼、跑驗證、填表格),
**貴的模型只做判斷**(要不要動契約、gate 卡住時該不該例外、審核有沒有漏洞)。
把兩者混在同一個 session 裡做,會讓貴模型花時間做機械工作,便宜模型做超出能力的判斷。

合併回 main 之後,依序跑 `boundaries`、`test`、`accept:standalone`、`standalone`,
確認新合併的東西沒有破壞其他人。

## 之後呢

Wave 0 全部 `done` 之後用 `/integrate I1` 做第一次整合驗收。之後嚴格依序:`I1 → I2 → …`,
每個整合點通過才能開下一個。整合的節奏、gate、驗收清單見 `docs/03-agile-workflow.md`
與 `.claude/skills/integration-check/SKILL.md`。

## 常見問題

**要不要照抄 `contracts/README.md` 的軟硬分層?**
建議照抄分層邏輯(磁碟格式硬、記憶體介面軟),但章節編號要換成你自己的。
不要把整份契約都凍死——那是原專案 v1.0 犯過的錯,後來用 ADR-029 修正。

**Wave 0 一定要平行嗎?一個人也要開好幾個 worktree?**
不用。平行的意思是「順序自由」,不是「一定要同時做」。一個人依序做完十個 phase-1
也完全符合這套範式,差別只在於協調者/worker 的分工變成自己跟自己對話。

**六個 skill 都要嗎?**
`decision-record` 與 `phase-acceptance` 建議一定留著——決策留痕與驗收把關是核心中的核心。
其他四個依專案規模取捨,`docs/03-agile-workflow.md` 的「最小模式」段落有列出可以先關掉什麼。

**契約決定了之後想改怎麼辦?**
硬約定改動一定要走 `decision-record`,列出哪些已完成的 phase 需要重驗、
已經產生的資料要不要遷移——這通常才是真正的成本,不是改型別本身。
軟約定改了跑測試、更新 `contracts/types.md`、commit 說明理由即可,不用整套流程。

**我的專案沒有 LLM / 沒有桌面 UI / 沒有跨平台,一堆東西看起來不適用怎麼辦?**
這套範式的骨頭是「契約 + gherkin + Wave 0 + 整合點 + ADR」,跟你做什麼產品無關。
`CLAUDE.md` 與 skill 裡凡是提到「LLM」「golden run」「router」之類的地方都只是範例,
看不懂就直接刪掉那一條,不影響其他部分運作。

**為什麼工具鏈是 TypeScript + vitest + cucumber + stryker,可以換嗎?**
可以換,但要知道換掉什麼:`vitest` 換成任何單元測試框架都行;`cucumber` 換掉的話
`features/steps/_world.ts` 的 helper 要重寫成對應框架的 hook;`stryker` 目前只有
JS/TS 生態成熟,換語言的話變異測試門檻這個機制建議保留,工具另外找。

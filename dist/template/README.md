# 開發範式模板

> **這個 repo 的家:`/data/python/dev-paradigm`(2026-09-06 起)。** 之前它住在 `llm_learning-cards` 的
> `template/` 子目錄(分支 `template/dev-paradigm`),用 `git subtree split` 連歷史搬出來;
> 版本 tag 改叫 `vX.Y.Z`(原 `template/vX.Y.Z`)。CHANGELOG 裡 1.5.0 以前提到的 commit sha 是**原 repo** 的,
> 在這裡查不到,以 tag 為準。consumer 的 `TEMPLATE_DIR` 改指這裡;守門的 `--check` 是自包含的,已裝的檔不用重 sync。
> 在這裡跑模板自己的測試:`npm install`(`.npmrc` 已設 legacy-peer-deps,vitest 4.1 踩 npm 10.9 的 bug)→
> `bash scripts/sync-gates.test.sh` + `npm run test:scripts` + `bash scripts/verify-against.sh <consumer>`。

一套「契約先凍結、gherkin 即測試、Wave 0 平行開發、整合點永遠是完整系統」的
專案骨架。抽自一個實際跑過一輪 Wave 0 平行開發的專案(桌面應用 + LLM 內容生成,
細節見 `CHECKLIST.md` 的例子欄),把**流程與結構**留下,把**產品細節**換成 `{{PLACEHOLDER}}`。

## 這是什麼、不是什麼

**是**:一套文件骨架 + 一組可同步的 TypeScript 守門腳本(包含邊界、單獨執行與一致性檢查)+ Claude Code skill。
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
9. **沒有陽性對照的 gate 不算 gate。** 見證器、marker gate、計數類檢查旁邊都要放一個「故意壞掉的
   必須被讀到」的樣本——量尺可以在完全不報錯的情況下讀到錯的東西,沒有陽性對照看不出來。
   細節見 `docs/07-practices.md` (a)。

**既有專案要切換過來的,先讀 `docs/06-brownfield.md`**——第一週的順序跟 greenfield 不同。

**三個採用專案回報的做法,收在 `docs/07-practices.md`**——每條都有做法、為什麼、證據、怎麼落地,
不是口號清單;裡面也記了三個專案都刻意不遵守的範式條文,以及範式怎麼因此調整。

落地前先掃一遍 `PITFALLS.md`——那是兩個專案實際踩過的坑,每條都對應一個檔案裡的防線;新專案踩到新坑就補一條並同步改 template。

想知道「為什麼這樣設計」而不是「怎麼用」,讀 `docs/02-decision-map.md` 裡標「來源:範式」
的 ADR——那些是這套範式本身的決策紀錄,寫這些規則的人當初也是這樣一條一條踩出來的。

## 版本

`VERSION` 是模板版本(semver),`CHANGELOG.md` 記每版動了什麼。專案的 `CLAUDE.md` 記「採用模板 vX.Y.Z」;
之後模板升版,在模板 repo 裡用 `git diff v<採用版>..v<新版> --stat` 看差異決定要不要跟
(1.5.0 以前的 tag 叫 `template/vX.Y.Z`,見檔頭說明)。
三個專案用同一套東西,沒有版本一週後就是三套。

守門腳本用 `scripts/sync-gates.sh <你的 repo 根>` 複製進去(檔頭會寫來源版本),CI 才自包含;升版重跑一次,`--check` 可放進 CI 抓手改。不要直接呼叫模板路徑(CI 與別台機器沒有它)。sync 若印「已存在且沒有 SOURCE 標頭」就是它撞到你們自己寫的同名檔,它不會蓋、也一個檔都沒寫:把你們的檔改名 `<base>.local.<ext>`(例如 `check-boundaries.local.test.ts`)再跑一次(1.5.0,P-85)。

`boundaries.allow.json`、`boundaries.owners.json` 這兩份是專案自己的設定(見 `scripts/README.md`),sync 只在目標不存在時建一次,之後永遠不覆蓋——升版不會把你填好的落點表洗掉。

**單一入口:`npm run check:all`。** 合併前、CI 裡、`/phase-done` 收尾,都跑這一個指令,不要各自
背一串 `&&` 串起來的 npm script 名字。它讀 `scripts/gates.config.json` 的 `chain` 陣列(依序執行的
npm script 名字清單),沿路每一項都要在 `package.json` `scripts` 裡真的存在,不存在就算失敗——
新加一支守門,永遠是「先掛 npm script,再寫進 `chain`」,不是反過來。`gates.config.json` 認得的
頂層鍵有哪些,以 `scripts/_root.ts` 匯出的 `KNOWN_GATES_CONFIG_KEYS` 為準(不在這裡重複列一份會
漂移的清單);不在清單裡的頂層鍵,整份設定檔會被判定為「不認識的鍵」而失敗(S9)。

⚠️ **consumer 自己加的守門需要設定時,不要改 `KNOWN_GATES_CONFIG_KEYS`**——那份清單在模板檔裡,
改了就是手改模板檔,下次 sync 會跟你打架。**讓那支守門自帶一份設定檔**,先例是
`check-doc-rot.ts` 的 `doc-rot.blacklist.json`(P-94;1.7.0 以前這裡寫的是「把鍵名加進那份清單」,
那句話讓一個 consumer 的 worker 真的去手改了 `_root.ts`)。只有**模板本身**新增守門時,
才由模板維護者把鍵名加進 `KNOWN_GATES_CONFIG_KEYS`。

`check:doc-rot` 出貨時預設是 **report 模式**(`gates.config.json` 沒填 `docRot.mode` 就是
`"report"`):命中黑名單會全部印出來、`gate=doc-rot result=FAIL` 標記照印,但不擋 exit code。
第一次同步進來,先把觸發清單當 triage list 看,逐項確認完(哪些是真的問題、哪些是合理例外要收進
`docRot.exclude`)之後,再加 `"docRot": { "mode": "enforce" }` 切回會擋的行為——新守門第一版
幾乎必然抓到規則沒想到的合理例外,見 `PITFALLS.md` P-71。

`scripts/hooks/pre-commit`(S12)擋住「突變測試進行中被 commit」這件事,`sync-gates.sh` 只把它
同步進 `<安裝目錄>/hooks/pre-commit`,**不會自動裝進 `.git/hooks/`**(git hooks 不受版本控制)。
同步完印出的 `hook:cp <安裝目錄>/hooks/pre-commit .git/hooks/pre-commit && chmod +x ...` 那行照做
即可裝上;不裝也不影響其餘守門,只是少了「commit 那一刻」這道防線(`scripts/py/mutate.py` 自己的
`.mutate.lock` 仍然在**啟動**那一刻擋住同時跑第二個 mutate.py)。

**出版規則:沒有對至少一個 consumer 跑過 `scripts/verify-against.sh <consumer repo 根>` 不打 tag。**
這支腳本把模板版每支 `check-*.ts` 跟那個 consumer repo 已裝的同名檔各跑一次,比退出碼、
輸出、旗標清單三件事,列出差異——這是出版前的機械檢查,不是取代人的判斷。差異逐項標
「刻意改進」還是「迴歸」,寫進那一版的 `CHANGELOG.md` 條目;consumer 還沒裝任何守門腳本
(例如全新模板、第一次落地)則只跑模板版本身,做退出碼與 0 目標守衛檢查,不算漏做這一步。

**採用節奏**:consumer 鎖定一版一次驗到底;每個整合點最多升一次,除非某版修的是正擋著你的
迴歸;驗一半的結果比沒驗更危險(專案 B 原話)。模板端出版節奏:只在 consumer 回報或整合點
出版。

## 5 步驟落地到新專案

### 步驟 0:落地

**用 npx(建議)。** 需要能讀取私有 repo `pollux0971/dev-paradigm`(git 已設好 SSH 或 credential):

```bash
mkdir my-project && cd my-project
git init
npx github:pollux0971/dev-paradigm#npx-v1.7.4 init .
```

- 版本號換成你要採用的那一版;發布版的 tag 一律是 `npx-v<版本>`(`git ls-remote --tags` 看得到)。
- **只支援全新專案**(空資料夾,或剛 `git init` 的 repo)。
- **不會**執行 `npm install`、**不會** `git init`——這兩步留給你,init 失敗時才不會混進不可回復的副作用。
- 撞到已存在的同名檔時**一個檔都不寫**,把衝突全部列出來後結束(沒有 `--force`)。
- **重跑 init 是安全的**:沒改過的檔不動;**init 裝好之後你改過的檔,再跑 init 會列為衝突、一個字都不蓋**(`npx-v1.7.1` 有會蓋掉修改的 bug,請不要用那一版,見 CHANGELOG 1.7.2)。
- 想先看會建立哪些檔:加 `--dry-run`。`--help` 看全部選項。

**沒有 npx 權限時**,clone 下來直接跑同一支 CLI(效果相同):

```bash
git clone https://github.com/pollux0971/dev-paradigm.git
node dev-paradigm/package/src/cli.mjs init my-project
```

⚠️ **不要用 `cp -r` 複製整個模板 repo。** 那會把模板**自己的**東西一起帶進你的專案——協調紀錄
(`.orca-brief/`)、上游的收件匣(`DECISIONS_NEEDED.md` 裡是模板本身的待裁事項)、npx 發布殼(`package/`)。
init 只落地 consumer 該拿到的那一份,收件匣也是空白的。

落地完成後**直接從步驟 1 開始**。

### 步驟 1:使用者親口填「做決定時」那張表,然後填 `CHECKLIST.md`

先做 `CLAUDE.md` 的「做決定時」表:誰定什麼、什麼才問使用者——**由使用者本人改、本人 commit 進 main**。
這是三個專案都證明過的第一步:沒有它,協調者對任何轉述的「使用者說」都會正確地拒絕,切換會停兩三次。
同時把 `DECISIONS_NEEDED.md` 放到根目錄。然後才填 CHECKLIST。


打開 `CHECKLIST.md`,表格裡列出每一個 `{{PLACEHOLDER}}`——在哪個檔案、填什麼、原專案的例子
長什麼樣。**逐一填完,不要留著 `{{}}` 進到下一步**,否則型別檢查與腳本會直接壞掉
(`package.json` 的 `name`、`.env.example` 的變數名之類是機械性替換,漏了不會立刻報錯,
但會在你以為填好了的地方留一個地雷)。

驗證(應該回傳空):

```bash
grep -rlF '{{' --exclude-dir=node_modules --exclude-dir=.git \
  --exclude=CHECKLIST.md --exclude=CHANGELOG.md --exclude=PITFALLS.md \
  --exclude=README.md --exclude=07-practices.md .
```

排除的那 5 份是**在文字裡介紹或引用** placeholder 的文件(`CHECKLIST.md` 本身就列著每一個),
不是要填的地方。1.7.0 以前這裡寫的是 `grep -rn '{{' .`——**那個指令永遠不可能回傳空**
(`CHECKLIST.md` 自己就有幾十行 `{{`),照做的人會以為自己永遠沒填完。

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
- [ ] `scripts/boundaries.owners.json` 的 `owners` 填好每個 Wave 0 能力的落點(**不是** `scripts/check-boundaries.ts`——那是受 sync 管理的守門檔,改了 `--check` 會紅)
- [ ] `scripts/gates.config.json` 加上 `chain`(例:`["typecheck", "test", "boundaries", "standalone"]`),`npm run check:all` 最後一行是 `gate=all result=PASS`
- [ ] `standalone.json` 每個 Wave 0 能力都有一行(先寫預期指令,即使還跑不起來也要列出來,
      這樣 `/phase-done` 才知道要驗什麼)
- [ ] `docs/01-roadmap.md` 的 Wave 0 表與各 `features/*/FEATURE.md` 對得起來

之後每個 worktree 只跑 `npm ci`,不再動這些共用檔——共用檔只有協調者改
(見下面的角色分工)。

### 步驟 5:開 worktree 派工

Wave 0 的每個 phase-1 一個 worktree,可以同時開工,順序自由。**每張工單照
`.orca-brief/TASK.md.template` 的形狀寫**(第 0 件事確認模型、絕對不能碰的用路徑列舉、
每項驗收自帶反向驗證、要求 worker 自己 grep 不信任何人的列舉、回報格式含「工單哪裡說不通」)
——這是專案 B 實戰用出來的形狀,每一段都對應一次沒寫它就出事的紀錄,見
`docs/07-practices.md` (i)。角色分工:

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

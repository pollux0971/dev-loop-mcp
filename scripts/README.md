# scripts/ — 守門腳本

`check-boundaries.ts`、`check-standalone.ts`、`check-doc-links.ts`、`check-phase-coverage.ts`、
`check-step-dup.ts`、`check-gherkin-dup.ts`、`check-dry-run.ts`、`check-module-cast.ts`(後兩支 1.6.0,
P-86 / P-88)是掃描器,`_root.ts` 是它們共用的 repo 根解析,
`sync-gates.sh` 把這些程式複製進目標 repo。`verify-against.sh <consumer repo 根>
[--consumer-dir <子目錄>]` 是出版前的機械檢查:把模板版每支 `check-*.ts` 跟那個 consumer
已裝的同名檔各跑一次,比退出碼、輸出、旗標清單三件事——出版規則見 `README.md`
「版本」段。consumer 的守門安裝目錄怎麼找(CHANGELOG 1.3.2 (B)):`--consumer-dir` 明講,
否則依序找 `<consumer>/scripts/`、`<consumer>/features/scripts/`、再不然掃
`find <consumer> -name _root.ts -maxdepth 4` 找到的第一個目錄;四層都沒有才算「consumer
未裝守門」,不是只認 `scripts/`。

`sync-gates.sh` 寫進每個檔案的 SOURCE 標頭現在帶著 `sha256=<檔身雜湊>`(CHANGELOG 1.3.2
(D)),`--check` 靠重算這個雜湊做自我一致性檢查(有沒有在同步之後被手改過),**不需要讀
`$TEMPLATE_DIR`**——sync(寫入新內容)才需要模板路徑,`--check` 只需要問已安裝的檔案
自己「有沒有被動過」,答案就寫在檔案自己身上,所以能在沒有模板 checkout 的 CI 環境單獨跑。

`sync-gates.sh` 也會同步四類「受管非守門檔」: `.claude/skills/*/SKILL.md`、
`.agents/skills/*/SKILL.md`、`docs/templates/TASK.md.template` 與 `scripts/py/.gitignore`。
它們不用 SOURCE 標頭,而是用跟 `npx init` 共用的 `.npx-init-manifest.json` 裡的檔案雜湊判斷
所有權;檔案不存在就建立,manifest 記錄相符就能在升版時覆蓋,內容被使用者改過就衝突。受管檔
採先掃後寫,只要有一個衝突,整支 `sync-gates.sh` 都會 `exit 1`,連 `.ts`/`.py` 守門腳本也不會
落地,不會只跳過那一個檔案。

每支掃描器結尾都會印一行機器可讀標記 `gate=<name> result=PASS|FAIL scanned=<N>`(CHANGELOG
1.3.2 (C)),`<name>` 是 `boundaries` / `doc-links` / `gherkin-dup` / `phase-coverage` /
`standalone` / `step-dup` / `dry-run` / `module-cast`(以及 `all` / `doc-rot` / `known-defects` /
`next-gates` / `phase-status`)之一,`<N>` 是這次掃到的目標數。`verify-against.sh` 靠這行標記
(加上退出碼必須是 0 或 1)判斷一次執行「算不算數」——見該腳本檔頭「執行有效性」段,這是
CHANGELOG 1.3.2 (C) 修的迴歸:退出碼 127(command not found)以前會被誤判成「✓ 通過」。

## 語言選集與 `--prune`(CHANGELOG 1.3.4 (1))

`sync-gates.sh` 不再無條件同步 Python 版工具(`scripts/py/*.py`)——舊版每次同步都塞進
目標 repo,即使那是個純 TypeScript 專案,多裝一條沒人用得到的路。現在先決定「這次要同步
哪些語言」(印一行「選集 <清單>(<依據>)」),依序:

1. `--lang ts,py` 旗標(逗號分隔)。
2. 目標安裝目錄或 `<目標 repo 根>/scripts/` 的 `gates.config.json` 裡 `sync.languages` 陣列
   (見下「程式與設定分開」段的欄位說明)。
3. 自動偵測:目標 repo 根有 `pyproject.toml` / `setup.cfg` / `requirements*.txt`,或排除
   `node_modules`、`.git`、本次安裝目錄本身之後找得到任何 `*.py` → 含 `py`;否則只有 `ts`。

`ts` 永遠在選集裡,不管走哪一條——沒有「純 Python 專案」這種概念,`.ts` 守門(數量以本目錄
目前的 check-*.ts 為準,不寫死)是核心。

加 `--prune`:同步完成後掃安裝目錄(含 `py/`),把**有 SOURCE 標頭、但所屬語言不在本次
選集內**的檔案列出來刪掉(該語言的目錄清空後也一併刪除);**沒有 SOURCE 標頭的檔案一律
不碰**。不加 `--prune` 就只同步、不清舊檔——語言選集從 `py` 改回 `ts` 之後,`scripts/py/`
會留在原地,直到有人加 `--prune`。

`--check` 現在掃安裝目錄(含 `py/`)底下**所有檔案**(設定檔 CONFIG_FILES 除外,那些檔案
固定印「你的設定檔,不比對」),**第一行符合 `SOURCE: template v` 的才拿去比對**;不符合的
一律印「(非模板檔,略過)」,預設不印,只有 `--verbose` 才印。舊版用 `check-*.ts` 這個檔名
glob 列舉,會吃到專案自己寫的 `check-*.test.ts`(沒有 SOURCE 標頭)並要求它也符合標頭格式,
逼專案要嘛改檔名迎合守門、要嘛容忍常態紅燈(PITFALLS P-52)——新版靠**自己留下的標記**認
自己裝的東西,不靠檔名猜(同一個道理見 PITFALLS P-33「守門對著代理指標」)。sha256 自我
一致性、HOTFIX 例外邏輯不變。

## 型別驗證

模板的型別驗證用**採用專案最嚴的 tsconfig**(`strict`、`exactOptionalPropertyTypes`、
`noUncheckedIndexedAccess`),不是模板自己一份寬鬆的 tsconfig——寬鬆版會放過採用專案編譯
不過的程式碼,等 consumer 真的 `sync-gates.sh` 進去才炸(專案實測:`check-phase-coverage.ts`
的 `loadGatesConfig` 在 `exactOptionalPropertyTypes: true` 下 TS2375,可選欄位被顯式指派
`undefined`)。跑法:

```bash
NODE_PATH=<採用專案根>/node_modules npx tsc --noEmit \
  --module esnext --moduleResolution bundler --target es2022 \
  --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess \
  --types node --skipLibCheck scripts/*.ts
```

`NODE_PATH` 指到一個裝了 `@types/node`(與其他型別套件)的 `node_modules`——模板自己沒有
`package.json` / `node_modules`,借用已採用這套範式的專案的即可,那份 tsconfig 本來就是
「最嚴」的參考基準。全部 `scripts/*.ts` 都要在這組旗標下無錯誤。

`py/mutate.py` + `py/test_mutate.py` 是定向反向驗證工具的 **Python 版**(來源專案 C,模板
1.3.1 收入,用法與規格對應見 `py/README.md` 與 `docs/07-practices.md` (e))。`sync-gates.sh`
把它們同步到目標 repo 的 `scripts/py/`,同樣每次同步覆蓋、靠版本標頭防漂移——只是標頭語法
用 `#`(Python 註解)不是 `//`。TS 版(`mutate.ts`)尚未落地。

## 程式與設定分開

三支掃描器的**程式**(`.ts` / `.sh`)跟着模板走版本、被 `sync-gates.sh` 覆蓋更新;
它們讀的**設定**是專案自己的東西,`sync-gates.sh` 只在目標不存在時建一次,之後
永遠不覆蓋:

**找設定檔的順序**(CHANGELOG 1.3.2 (A);env 優先權見 CHANGELOG 1.3.4 (3)):
0. 環境變數 `GATES_CONFIG_DIR`(若設且該目錄存在)。
1. 呼叫端腳本**自己所在的目錄**(`import.meta.dirname`——`sync-gates.sh` 把腳本裝到哪裡,
   設定檔通常也跟著裝在哪裡,例如 cucumber 設定不在根目錄的專案常把整套裝進
   `features/scripts/`)。
2. `<ROOT>/scripts/`。

舊版只認第 2 步,腳本裝在別處時設定檔就永遠讀不到——不會報錯,只會安靜套用內建預設或觸發
自動偵測,像是設定死掉了一樣(採用專案實測的迴歸)。第 0 步是後來加的:`verify-against.sh`
直接對模板路徑下的 `.ts` 執行(不經 `sync-gates.sh` 複製),此時「腳本自己所在的目錄」
(第 1 步)是模板自己的 `scripts/`——裡面放的是給新專案抄的佔位設定,對 boundaries 這種
硬性設定,永遠讀到模板的佔位 `boundaries.owners.json`,對 consumer 的真實落點表永遠比出
「差異」。`GATES_CONFIG_DIR` 讓呼叫端明講「這次設定要去哪裡找」,不受「腳本實際放在哪個
目錄」影響——`verify-against.sh` 跑模板版 `check-*.ts` 時會設成 consumer 的守門安裝目錄。
必要設定(`boundaries.owners.json`)三處都找不到會印「設定檔未找到於 <搜尋過的路徑>」並
exit 1;選填設定(`boundaries.allow.json`、`gates.config.json`)三處都找不到就靜默套用
預設,不印訊息。

- `boundaries.allow.json` — 允許的跨界例外邊(`{from, to, reason}` 陣列)。
- `boundaries.owners.json` — `check-boundaries.ts` 的落點表跟掃描範圍,格式:

  ```json
  {
    "owners": [["packages/contracts/", "contracts"], ["contracts/", "contracts"]],
    "glue": ["infra", "steps"],
    "aliases": [["@contracts/", "packages/contracts/src/"]],
    "scanDirs": ["packages", "apps", "scripts"],
    "contractsOwner": "contracts"
  }
  ```

  - `owners`:落點前綴 → 擁有的功能,順序有意義(先比對較長的前綴)。
  - `glue`:這些擁有者可以 import 任何東西,不當作來源檢查(通常是 `infra`、`steps`)。
  - `aliases`:tsconfig paths 對映,依你的專案調整。
  - `scanDirs`:要掃描的根目錄。
  - `contractsOwner`:對到這個擁有者的 import 一律放行(不算跨界)。

  這份檔在上面兩個搜尋路徑都不存在,`check-boundaries.ts` 會印「設定檔未找到於 <兩個路徑>」
  並 exit 1、印出上面這份範例——這是硬性要求的設定,不是「留空也能跑」。落點表如果你也在
  別處維護一份人類可讀的版本(例如 `packages/core/README.md`),那份表要跟這裡同步。

- `gates.config.json` — `check-phase-coverage.ts`、`check-doc-links.ts`、`check-gherkin-dup.ts`
  讀的設定:

  ```json
  {
    "cucumberCwd": ".",
    "phaseCoverage": {
      "runTimeoutMs": 600000
    },
    "docLinks": {
      "skipSegments": [],
      "skipPrefixes": []
    },
    "gherkinDup": {
      "allow": [
        {
          "scenario": "Every standalone entry point still runs",
          "onlyUnder": "docs/integration/",
          "reason": "每個整合點各自重跑一次 standalone 回歸(ADR-024)"
        }
      ]
    }
  }
  ```

  - `cucumberCwd`:cucumber 的執行目錄,相對 ROOT。這份檔**不存在也能跑**——
    `check-phase-coverage.ts` 會退回自動偵測(ROOT 有 `cucumber.js` 等設定檔就用
    ROOT;否則掃 ROOT 的直接子目錄找第一個含 cucumber 設定的目錄),都偵測不到
    才 exit 1。多數專案(cucumber 設定在 repo 根)不需要這份檔。**這個欄位一旦填了、
    卻指向不存在的目錄,是 exit 1,不會退回自動偵測**——設定了但指錯路徑,跟根本沒
    設定是兩回事,前者不能被自動偵測靜默救回(那會讓設定看起來有效但其實從沒被套用過)。
  - `phaseCoverage.runTimeoutMs`:`--run`(段二,真跑)對**每個** phase 檔各自套用的
    逾時毫秒數,預設 `600000`(10 分鐘)。這份檔不存在,或存在但沒填這個欄位,就用
    預設值。逾時時 exit 1,訊息說「逾時」,不是「找不到 N scenarios」——逾時代表這個
    phase 真跑起來卡住了,不代表 tag 掛錯或場景數是 0,這是兩種不同的病,訊息要分得
    出來。什麼時候需要調高:某個 phase 的場景本身就跑得慢(例如打真實外部服務、跑
    大量資料),預設 10 分鐘不夠。段一(dry-run)不受這個欄位影響,固定 60 秒逾時。
    `--run` 預設只真跑 `features/<folder>/FEATURE.md` 狀態是 `done` / `in-progress` 的
    phase,其餘只 dry-run(CHANGELOG 1.3.2 (E));`--run-phases <folder>/phase-N,...`
    旗標手動蓋過這個規則,指定確切要真跑哪幾個 phase。
  - `gherkinDup.allow`:`check-gherkin-dup.ts` 允許的刻意重複場景組(CHANGELOG
    1.3.2 (2)),陣列,每個條目 `{ scenario, onlyUnder?, reason }`。一個重複組要套用
    某條 allow,三個條件都要成立:組裡**每個**場景名稱都等於 `scenario`;有給
    `onlyUnder` 時,組裡每個場景所在檔案路徑都要以它開頭(相對 ROOT);`reason` 是
    非空字串。三個都成立才印「允許」不算紅;`reason` 空或缺,這條 allow 無效,命中時
    印警告、該組照常判紅。範例已經寫在上面 JSON 裡(對應每個整合點各自重跑一次
    standalone 回歸的合法重複,ADR-024)。這份檔不存在就沒有任何 allow 條目。
  - `docLinks.skipSegments` / `docLinks.skipPrefixes`:`check-doc-links.ts` 的排除清單,
    **追加**到內建預設,不是取代。內建預設是
    `skipSegments = [node_modules, .stryker-tmp, dist, .git, target, .svelte-kit, archive]`、
    `skipPrefixes = [.claude/worktrees, contracts/fixtures]`。專案自己的建置產物目錄
    (例如某個少見的打包輸出目錄名)加在這裡,不必改 `check-doc-links.ts` 本體。
    這份檔不存在,或存在但沒填 `docLinks`,就只用內建預設。實際生效的排除清單會印在
    `check-doc-links.ts` 輸出的第一行。
  - 什麼時候需要填(`cucumberCwd`):cucumber 設定不在 repo 根,而是在某個 workspace
    package 底下(例如 `features/cucumber.js` + `features/node_modules/.bin/cucumber-js`),
    自動偵測掃到的又不是你要的那個目錄時,直接寫死 `"cucumberCwd": "features"`
    比每次都靠自動偵測穩定。也可以用 `--cwd <dir>` 旗標一次性覆蓋(優先權比這份
    設定檔高)。
  - `moduleCast.scanDirs`(選填,1.6.0,P-88):`check-module-cast.ts` 要掃的目錄(相對 ROOT
    的陣列),沒填就是 `["features/steps"]`。steps 目錄不在預設位置的專案(例如 `tests/steps/`)
    填這個;填了空陣列算設定錯(exit 1),不是「不掃」。掃到 0 個 `.ts` 檔一樣 exit 1(掃描器壞了)。
  - `cucumberCwd` 也給 `check-dry-run.ts` 用(1.6.0,P-86):`npm run accept:dry` 現在是
    `tsx scripts/check-dry-run.ts --tags 'not @manual'`,它自己跑 `cucumber-js --dry-run --format summary`
    再讀摘要行——`N scenarios (...)` / `N steps (...)` 裡 undefined / ambiguous / failed 任一桶 ≥ 1 就
    exit 1,0 個場景也 exit 1;cucumber 對這些狀態的退出碼是 0(`--strict` 也是),所以**不信它的
    exit 0,只信它的 exit 非 0**。`--` 之後的參數原樣附給 cucumber-js。
  - `dryRun.tags`(選填,1.6.0):`check-dry-run.ts` 段 A(驗收集合)用的 tag 運算式,要跟驗收 job
    的一致(例如 `"not @manual and not @todo"`);`--tags` 旗標優先。**兩段**:段 A 用這條 tag 跑,
    undefined / ambiguous 都紅;段 B 不帶 tag 再跑一次全集,只看 ambiguous——撞名跟 tag 無關,
    被 tag 排除的 todo 場景一旦排進來就炸;而 todo 場景裡刻意還沒定義的步驟(規格上的「還沒做」)
    在段 B 不算。沒帶任何 tag 時段 B 略過(跟段 A 是同一次執行)。
  - `sync.languages`(選填,CHANGELOG 1.3.4 (1)):`sync-gates.sh` 這次要同步哪些語言的
    掃描器,例如:

    ```json
    { "sync": { "languages": ["ts"] } }
    ```

    填了就固定用這個清單(優先權比自動偵測高,比 `--lang` 旗標低),不填就交給
    `sync-gates.sh` 自動偵測(見上「語言選集與 `--prune`」段)。`ts` 不寫也會自動補上。
    **模板出貨的預設 `gates.config.json` 不含這個欄位**——寫死一個語言集合會蓋掉自動
    偵測,對第一次落地、還沒人手動填過設定的新專案不是好預設;要固定選集,自己在專案的
    `gates.config.json` 加這個區塊。

`standalone.json`(repo 根,不在 `scripts/` 底下)不是模板的「設定檔清單」的一部分,
它本來就是每個專案自己寫的 manifest;但同一個道理適用——`check-standalone.ts`
只讀它,不會被 sync 動到。每個條目可以選填 `"cleanup": ["./tmp-learning"]`,
執行前後各清一次,不必在程式裡寫死暫存目錄名稱。

## 為什麼要這樣分

三個採用這套模板的專案,落點表、允許例外、暫存目錄名字都不一樣。以前這些寫死在
`.ts` 裡,模板升版、`sync-gates.sh` 一跑,專案填好的東西就被模板的範例蓋掉。
分開之後,程式永遠跟版本、設定永遠跟專案。

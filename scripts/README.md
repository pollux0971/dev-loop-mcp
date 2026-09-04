# scripts/ — 守門腳本

`check-boundaries.ts`、`check-standalone.ts`、`check-doc-links.ts`、`check-phase-coverage.ts`、
`check-step-dup.ts`、`check-gherkin-dup.ts` 是掃描器,`_root.ts` 是它們共用的 repo 根解析,
`sync-gates.sh` 把這些程式複製進目標 repo。`verify-against.sh <consumer repo 根>` 是出版前的
機械檢查:把模板版每支 `check-*.ts` 跟那個 consumer 已裝的同名檔各跑一次,比退出碼、輸出、
旗標清單三件事——出版規則見 `template/README.md`「版本」段。

## 程式與設定分開

三支掃描器的**程式**(`.ts` / `.sh`)跟着模板走版本、被 `sync-gates.sh` 覆蓋更新;
它們讀的**設定**是專案自己的東西,`sync-gates.sh` 只在目標不存在時建一次,之後
永遠不覆蓋:

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

  這份檔不存在,`check-boundaries.ts` 會 exit 1 並印出上面這份範例——這是硬性要求
  的設定,不是「留空也能跑」。落點表如果你也在別處維護一份人類可讀的版本(例如
  `packages/core/README.md`),那份表要跟這裡同步。

- `gates.config.json` — `check-phase-coverage.ts` 與 `check-doc-links.ts` 讀的設定:

  ```json
  {
    "cucumberCwd": ".",
    "docLinks": {
      "skipSegments": [],
      "skipPrefixes": []
    }
  }
  ```

  - `cucumberCwd`:cucumber 的執行目錄,相對 ROOT。這份檔**不存在也能跑**——
    `check-phase-coverage.ts` 會退回自動偵測(ROOT 有 `cucumber.js` 等設定檔就用
    ROOT;否則掃 ROOT 的直接子目錄找第一個含 cucumber 設定的目錄),都偵測不到
    才 exit 1。多數專案(cucumber 設定在 repo 根)不需要這份檔。
  - `docLinks.skipSegments` / `docLinks.skipPrefixes`:`check-doc-links.ts` 的排除清單,
    **追加**到內建預設,不是取代。內建預設是
    `skipSegments = [node_modules, .stryker-tmp, dist, .git, target, .svelte-kit, archive]`、
    `skipPrefixes = [.claude/worktrees, contracts/fixtures]`。專案自己的建置產物目錄
    (例如某個少見的打包輸出目錄名)加在這裡,不必改 `check-doc-links.ts` 本體。
    這份檔不存在,或存在但沒填 `docLinks`,就只用內建預設。實際生效的排除清單會印在
    `check-doc-links.ts` 輸出的第一行。
  - 什麼時候需要填:cucumber 設定不在 repo 根,而是在某個 workspace package
    底下(例如 `features/cucumber.js` + `features/node_modules/.bin/cucumber-js`),
    自動偵測掃到的又不是你要的那個目錄時,直接寫死 `"cucumberCwd": "features"`
    比每次都靠自動偵測穩定。也可以用 `--cwd <dir>` 旗標一次性覆蓋(優先權比這份
    設定檔高)。

`standalone.json`(repo 根,不在 `scripts/` 底下)不是模板的「設定檔清單」的一部分,
它本來就是每個專案自己寫的 manifest;但同一個道理適用——`check-standalone.ts`
只讀它,不會被 sync 動到。每個條目可以選填 `"cleanup": ["./tmp-learning"]`,
執行前後各清一次,不必在程式裡寫死暫存目錄名稱。

## 為什麼要這樣分

三個採用這套模板的專案,落點表、允許例外、暫存目錄名字都不一樣。以前這些寫死在
`.ts` 裡,模板升版、`sync-gates.sh` 一跑,專案填好的東西就被模板的範例蓋掉。
分開之後,程式永遠跟版本、設定永遠跟專案。

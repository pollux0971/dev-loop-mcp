# stacks/:技術棧包

dlm 的核心(`tools/lib`、`payload/`)不認得任何語言、測試框架或套件管理器。跟某個技術棧綁在一起的東西都放在這裡,一個技術棧一個資料夾。
裝進專案時,每個技術棧的宣告會裝到 `tools/stacks/<名稱>/`;範本只在新專案(`dlm init --stack <名稱>`)裝到專案根目錄。

專案用哪一個:`dlm.config.json` 的 `project.stack`。沒寫的話,第一個 `detect` 裡的檔都存在的技術棧就是它(4.11 以前的專案靠這個維持原本行為);
`none` = 只用核心(測試指令自己寫在 `gates.commands`,每個節點自己寫 `accept`)。

## 一個技術棧有什麼

| 檔 | 必要 | 內容 |
|---|---|---|
| `stack.json` | 是 | 宣告。core 只讀下面這些欄位 |
| `rules.md` | 否 | 接在 worker 規則後面的技術棧規則(算規則層,受 `limits.rules_bytes` 限制,改它要使用者批准) |
| `checks.mjs` | 否 | 測試類的棒(characterize、test、test-fix)額外跑的檢查:`export function testLegChecks({ ex, wt, changed, config, lib })`,回傳 `[{ check, outcome, detail }]`。不要 import `tools/lib` 的東西,要用的工具從 `lib` 拿(`r`、`tail`、`matchAny`、`readJson`) |
| `template/**` | 否 | 新專案的範本,原樣裝到專案根目錄 |

`stack.json` 的欄位:

- `detect`:這些檔都在根目錄時,沒寫 `project.stack` 的專案會被認成這個技術棧。空陣列 = 永遠不會被偵測到(python 就是這樣:4.12 以前的專案不會突然換技術棧)。
- `defaults`:蓋在核心預設上的設定(例 `gates.chain`、`verify.dry_run_cmd`、`verify.mutation.cmd`、`verify.typecheck_cmd`)。專案自己的 `dlm.config.json` 再蓋在它上面。
- `add.rerun_allow`:加進可重跑的證據指令前綴(Critic 也只能跑這些)。`add.forbidden`:加進 worker 不能改的 gate 定義檔(只有列出它的 shared 節點能改)。
  `add.tests`:加進 `paths.tests` 的測試檔 glob(實作棒不能改;python = `**/test_*.py`、`**/*_test.py`)。
- `add.bad_red`(4.12):`[{ pattern, why }]`,測試棒的紅符合這些正規式時算「紅的原因不對」,退回(python = pytest-bdd 的 `StepDefinitionNotFoundError`、`IndentationError` / `TabError`)。找不到實作模組永遠算正常的紅,不要寫進來。
- `defaults.deps`(4.12):依賴資料夾。
  - `dirs`:根目錄的資料夾名(node-ts = `node_modules`,python = `.venv`)。每個副本裡都是指回根目錄的 symlink、不複製;派工前後比對指紋;worker 在副本裡寫到它底下就退回。核心預設 `['node_modules']`,`none` 專案行為不變。
  - `install`:合併樹怎麼裝一份乾淨的依賴:`{ lockfile, argv, label, out_of_sync, out_of_sync_note, hint }`。`null` = 用 symlink。node-ts = `npm ci --offline --ignore-scripts`。
  - `setup`:`dlm setup` / `doctor` 在資料夾不存在時提議的指令:`{ when: { file, keys? }, dir, cmd, retry?, label, commit_files? }`(`setup` 的題目 id 一律是 `npm_install`)。
  - `judge_env`:dlm 要判定結果的每一次執行(驗收副本、證據重跑、合併 gate、基線、Critic)加的環境變數,`{tmp}` = 每次一個新的暫存目錄,跑完刪掉。python 用 `PYTHONPYCACHEPREFIX={tmp}`:指紋不算 `.pyc`,這樣偷放在 `.venv` 裡的 `.pyc` 也不會被讀到。worker 自己的執行不加。
- `gitignore`(4.12):`dlm init --stack <名稱>` 在第一次 commit 前補進 `.gitignore` 的行(python = `.venv/`、`__pycache__/`、`.pytest_cache/`)。
- `accept_cmd`:節點沒寫 `accept` 時的預設驗收指令(`{gherkin}` 換成 gherkin 路徑)。`accept_probe`:`{ file, keys? }`,既有專案只在探到時才用 `accept_cmd`(有 `keys`:那個 JSON 檔的某個鍵有非空的值;沒有 `keys`:檔案存在)。探不到時,`accept_cmd` 的前綴也不算證據指令。
- `layout`:新專案的程式該放哪(`workspaces`、`unit_tests`、`hint`),提案的 owns 不在裡面時 intake 會提醒。

## 現有的技術棧

| 名稱 | 內容 | 依賴資料夾 |
|---|---|---|
| [`node-ts`](node-ts/README.md) | TypeScript / vitest / cucumber-js / stryker,npm workspaces | `node_modules`(合併樹 `npm ci --offline`) |
| [`python`](python/README.md) | Python 3.10+ / pytest / pytest-bdd | `.venv`(symlink;判定時設 `PYTHONPYCACHEPREFIX`) |

## 加一個技術棧

照 `node-ts/` 的形狀開一個資料夾,至少寫 `stack.json`;再用 `dlm init <dir> --stack <名稱>` 建一個專案實際跑一輪。

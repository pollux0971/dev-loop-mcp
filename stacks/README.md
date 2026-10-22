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

- `detect`:這些檔都在根目錄時,沒寫 `project.stack` 的專案會被認成這個技術棧。
- `defaults`:蓋在核心預設上的設定(例 `gates.chain`、`verify.dry_run_cmd`、`verify.mutation.cmd`、`verify.typecheck_cmd`)。專案自己的 `dlm.config.json` 再蓋在它上面。
- `add.rerun_allow`:加進可重跑的證據指令前綴(Critic 也只能跑這些)。`add.forbidden`:加進 worker 不能改的 gate 定義檔(只有列出它的 shared 節點能改)。
- `accept_cmd`:節點沒寫 `accept` 時的預設驗收指令(`{gherkin}` 換成 gherkin 路徑)。`accept_probe`:既有專案只在這個 JSON 檔的這個鍵存在時才用 `accept_cmd`。
- `layout`:新專案的程式該放哪(`workspaces`、`unit_tests`、`hint`),提案的 owns 不在裡面時 intake 會提醒。

## 加一個技術棧

照 `node-ts/` 的形狀開一個資料夾,至少寫 `stack.json`;再用 `dlm init <dir> --stack <名稱>` 建一個專案實際跑一輪。

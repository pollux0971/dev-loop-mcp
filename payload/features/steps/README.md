# steps/ — 步驟定義

Cucumber 的步驟定義。**先讀 `_world.ts` 再寫新的**——它定義了所有步驟共用的狀態容器。

## 檔案分工

一個功能一個檔:`ingest.steps.ts`、`search.steps.ts`……
整合用的放 `integration.steps.ts`。

同一句步驟在不同 feature 出現時**共用同一個定義**。cucumber 會對重複定義報錯,
這是好事——它逼你統一措辭。但注意 `cucumber --dry-run` 對 ambiguous / undefined 的**退出碼是 0**
(P-86),所以合併門檻用的是 `npm run accept:dry`(1.6.0 起會讀摘要行判紅)與 `npm run check:steps`,
不是裸的 dry-run。

## 寫步驟的原則

- **Given 設定狀態,When 做一件事,Then 只斷言**。Then 裡面不要有副作用
- **步驟措辭跟著 feature 檔走**,不要為了方便改 feature 的英文
- **參數用 cucumber expression**:`the person types {string}`,不要用正規表示式除非必要
- **不要在步驟裡寫商業邏輯**。步驟只是薄薄一層轉接,邏輯在核心套件裡
- **一個步驟可以呼叫另一個嗎?** 可以但少用。三層以上就該重構
- **呼叫實作用具名 import**(`import { computeDue } from '…'`),**不要**
  `import * as core … ; const api = core as unknown as { … }`——那會讓 typecheck 跟 grep 對
  「實作把那個函式刪了」同時瞎掉,只有真跑到那個場景才炸(`PITFALLS.md` P-88;
  `npm run check:module-cast` 會擋)。型別對不上就修契約或加 adapter,不要用轉型蓋過去
- **不要照抄別的 steps 檔的句子當自己的定義**,即使你的 feature 還沒用到那句:
  `npm run check:steps` 對**定義清單本身**找重複,feature 沒用到的重複一樣紅(P-87)。
  你需要那句就直接用(它已經有定義了),不需要再定義一次

## 通用步驟:`common.steps.ts`(只有 `shared/steps` 節點改)

同一句話在兩個以上的資料夾出現,cucumber 會對重複定義報錯,所以只能定義一次。
Wave 0 已經在 `common.steps.ts` 定義好的句子(**worker 不要再定義**):

| 句子 | 你的 When 要做什麼 |
|---|---|
| `it exits with status {int}` | 呼叫 `this.runStandalone()` 或 `this.runCommand(cmd)` |
| `the standalone dev command is run` / `the server starts` | 不用做,通用步驟會啟動再關掉 dev server |
| `today is 2026-01-01`(有無引號皆可) | 讀 `this.today` |
| `it makes no model call` / `no model call is made` / `no network request is made` / `no network connection is attempted` / `no network request leaves the machine` | 你的 fake 把呼叫推進 `this.llmCalls` / `this.networkRequests` |
| `the original object is unchanged` / `a new object is returned` | 呼叫前 `this.trackInput(input)`,回傳值放 `this.lastResult` |
| `the result is <X>`(含 `a pass` / `a failure`) | 把結果放 `this.lastResult`;不是原始值就設 `this.resultText` |
| (規則)`the result is …` **整個前綴**屬於 common:它是 catch-all(`{}` 吃到行尾),任何以它開頭的新句子都會撞。要斷言結果用具體名詞(`the verdict is …`、`the due list has …`),不要以 `the result is` 開頭(來源專案撞過兩次) | | | |

上面這張表是**範例集**,不是完整清單——依你的專案實際需要調整。原則不變:
只用在 `@manual` 場景的句子不要定義(自動測試會跳過它們,定義了只會跟別人撞)。

規則:
- 你需要新的通用句子:先定義在自己的 `features/steps/<能力>.steps.ts`;兩個能力都要用時,在 report 的 `ticket_problems` 提出,由 `shared/steps` 節點收進 `common.steps.ts`
- feature 檔的第一行 tag(例如 `@ingest`,就是能力名)會被 `standaloneKey()` 用來找 `standalone.json` 的 key,不要改

## TypeScript 載入(見 `docs/02-decision-map.md` ADR-013)

`npm run accept` 用 `NODE_OPTIONS=--import=tsx cucumber-js`。步驟檔之間的 import 寫 `./_world.js`
(ESM 慣例,tsx 會對應到 `.ts`)。

## 這個專案的技術棧:node-ts(TypeScript / vitest / cucumber-js)

- 步驟定義放 `features/steps/<能力>.steps.ts`,先讀 `features/steps/README.md` 與 `_world.ts`。
- 步驟定義檔不要在檔頭靜態 import 還不存在的實作,改在步驟裡 `await import('../../packages/x/src/index.js')`,而且**路徑要寫字面字串**:
  檔頭 import 失敗會讓整個檔載入不了(dry-run 判「紅的原因不對」);變數路徑會讓 mutation 認不出哪個測試在測哪個檔。兩者都會被退回。
- 測試棒寫的檔也要過 `tsc`(`exactOptionalPropertyTypes` 開著:可選欄位不要明寫 `undefined`)。找不到實作模組的錯誤不算。
- 證據指令例:`npm run accept -- <gherkin>`、`npm test`、`npx vitest run <檔>`、`node --test`。不要加 `NODE_OPTIONS=…` 這類前綴。
- 不要碰 `node_modules`,不要改 `package.json`、`tsconfig.json`、`scripts/**`(gate 定義檔)。

# node-ts

TypeScript + vitest(單元測試)+ cucumber-js(gherkin 驗收)+ stryker(變異測試),npm workspaces(`packages/*`、`apps/*`)。

- `template/`:新專案的 package.json、tsconfig、vitest / cucumber / stryker 設定、`scripts/*.ts` gate 腳本、`features/steps/` 的共用步驟。
- `checks.mjs`:測試類的棒寫的檔要過 `tsc`(找不到實作模組的錯誤不算);測試裡的 `import()` 要寫字面路徑。
- `rules.md`:給 worker 的 TypeScript / cucumber 寫法規則。

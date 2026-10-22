# features/ — 規格(gherkin)

每個能力一個資料夾,每個版本一份 gherkin:`features/<能力>/v1.feature`、`v2.feature`、側向子功能 `v1.1.feature`。
能力與版本的結構在 `dag.json`,**不在這裡**;這裡只放規格本身。

- 新功能:在單一窗口描述 → Front 用 intake skill 跟你把 gherkin 寫到可以批准 → 你說好 → `dlm` 寫進來。
- gherkin 是施工者的考卷:測試棒依它寫測試,實作棒讓它變綠,**兩者都不能改它**。要改規格,回到單一窗口。
- 樣板:`_template/v1.feature.template`(副檔名是 `.template`,不會被測試框架掃到)。
- 標籤:`@standalone` 單獨執行、`@manual` 需要人判斷、`@e2e` 只出現在整合點(`docs/integration/`),是你親手試用的清單。
- 步驟定義在 `steps/`,每個能力一個檔;寫法看技術棧(node-ts:`steps/README.md`)。

# docs/integration/ — 整合點

每個整合點(DAG 裡 `kind: integration`,id `I<n>`)一份 gherkin:`i<n>.feature`,從 `i1.feature.template` 複製。
規則:

- 至少一個 `@e2e` 場景:整合點合併後,`dp` 會把它們列進你的收件匣,請你親手試用。未確認只擋發佈,不擋開發。
- 整合棒只寫組合層(節點的 `owns`),不改來源能力的內部;接通後正式碼不可再 import `__stubs__`(Verifier 會掃)。
- 每個整合點都重跑一次所有 standalone(回歸)。

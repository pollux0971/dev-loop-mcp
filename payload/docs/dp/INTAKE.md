# Intake:新功能、既有專案

不管哪種來源,同一個入口,同一個規則:**先提案,你批准,dp 才寫進 DAG**。提案在 `ledger/proposals/`,決定 ref 是 `node:<提案id>`。

## bundle(一整個版本,v4)

`dp intake bundle --spec v2.json`。檔案格式:

```json
{ "release": "v2", "goal": "這一版使用者能做什麼", "roadmap": "# 路線圖\n…(選填,存成 docs/ROADMAP.md)",
  "nodes": [ { "id": "ledger/v2", "...": "同 feature 的 spec", "gherkin_file": ".dp/intake/ledger-v2.feature" },
             { "id": "I2", "kind": "integration", "depends_on": ["ledger/v2"], "gherkin_text": "…@e2e…" } ] }
```

- 一定要有一個整合點,而且依賴這一版所有其他節點(真的不需要就寫 `no_integration_reason`)。
- 這一版裡沒有內部依賴的節點,自動加上「上一版的整合點」當依賴。
- 一個提案、一個決定:使用者一次批准整版。

## feature(單一節點)

`dp intake feature --spec spec.json --gherkin x.feature`。spec 欄位:`id`(`<能力>/v1`、整合點 `I1`、共用 `shared/<名字>`)、
`title`、`intent`(≤300 字)、`owns`、`depends_on`、可選 `standalone`、`release`、`accept`(預設 `npm run accept -- <gherkin>`;範本的步驟是 TypeScript,直接 `npx cucumber-js` 載入不了)、`tier`、`pipeline`。
`shared` 節點沒有預設的 gherkin 路徑:要機器驗收就自己寫 `gherkin` 與 `accept`,不然不要附 gherkin。

## 既有專案(brownfield,v4.5)

`dp setup` 選 Brownfield 後,`project.mode = "brownfield"`,gate 跑專案自己的測試指令(`gates.commands`,例 `{"test": "python3 -m pytest -q"}`)。
接手時跑一次 `dp onboard`:測試基線(`docs/dp-baseline.json`)、`docs/AS-IS.md` 草稿、ROADMAP v0。之後的規則:

- **測試基線**:合併前的 gate 紅了,但失敗的測試全都在基線裡 → 算通過(主控台顯示 ≈)。多一個不在基線的紅就擋。
  看得懂的輸出:pytest、unittest、go test、cargo test、node --test、vitest、jest、cucumber;看不懂的一律當紅。
- **characterize 棒**:節點的 `owns` 涵蓋主線上已有的程式檔時,提案自動加
  `"characterize": { "targets": [既有檔], "tests": [釘住它們的測試檔], "cmd": "只跑這些測試的指令" }`,pipeline 變成
  `characterize → test → dev`。characterize 棒只能寫 `tests`、不能改任何原始碼,`cmd` 必須在現在的程式上綠;
  之後每一棒都不能改這些測試,實作棒還要讓 `cmd` 維持綠。一次最多 10 個檔;`"skip": "理由"` 可以不釘。
- **accept 與 tests**:沒有 `accept` script(範本的 cucumber)的專案,節點要自己寫 `accept`(專案的測試指令,只跑這個節點的測試),
  建議也寫 `tests`(這個節點的測試檔 glob)。gherkin 仍是規格,測試棒照每個場景各寫一個測試。
- 不是 Node 的既有專案(沒有 package.json)`dp init --existing` 不裝範本的 TypeScript 工具鏈(package.json、tsconfig、scripts/*.ts…)。

匯入別的 repo(import)在 v4.1 拿掉了(實跑沒用到),v4.5 也沒有加回來。

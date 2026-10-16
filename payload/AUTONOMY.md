# 自治等級

在 `dp.config.json` 的 `autonomy.level` 設定。`dp` 依等級決定每件事送去哪裡(機械實作在 `tools/lib/autonomy.mjs`)。

| 等級 | 合併 | Verifier 沒把握(ABSTAIN) | 側向子節點(v1.x) | 一般決定 |
|---|---|---|---|---|
| L0 | 每次問你 | 問你 | 問你 | 問你 |
| L1(預設) | script 全過且 Verifier 無異議就自動 | 問你 | 問你 | 問你 |
| L2 | 同 L1 | 交 Critic,Critic 沒把握再問你 | 範圍在父節點之內就自動批准,否則問你 | 問你 |

`tier: strict` 的節點、沒有 `accept` 的 `shared/*` 節點:任何等級都要第二意見(L2+ 交 Critic,否則問你)。
Verifier 模型沒設定(`backend: none`)時,有 gherkin 的最後一棒視同 ABSTAIN。`gates.chain` 沒有測試類 script 時,L1 以上不執行。
worker 在沒有 .git 的副本裡施工,但程式以你的身分在這台電腦上執行;L2 會自動合併這樣跑過的程式(見 docs/dp/SECURITY.md)。

## 永遠只有你能決定

- 新的頂層功能、新版本(vN)、任何 `dp intake` 提案
- 契約 major 變更、規則層(AGENTS.md / AUTONOMY.md / prompts / skills)變更
- 預算上限與自治等級本身
- 整合點的 `@e2e` 試用確認(未確認只擋發佈,不擋開發)
- `resume`(停機後恢復)

每個決定都記在 ledger,附你的原話(Front 轉達時沒附原話,也會記下來)。`DECISIONS.md` 看得到。

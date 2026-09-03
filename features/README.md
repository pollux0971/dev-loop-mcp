# features/

一個資料夾 = 一個**能力**(見 `docs/02-decision-map.md` ADR-002)。資料夾內按 phase 切,
每個 phase 一個 `.feature`。

## 索引

| # | 功能 | 一句話 | Phases | Wave 0 單獨執行 |
|---|---|---|---|---|
| 01 | {{FEATURE_NAME_1}} | | | `{{STANDALONE_CMD_1}}` |
| 02 | {{FEATURE_NAME_2}} | | | `{{STANDALONE_CMD_2}}` |

精確狀態看各 `FEATURE.md` 的 phase 表。下一步由各 `NEXT.md` 決定。
單獨執行指令的權威來源是根目錄的 `standalone.json`,上表只是方便閱讀。

如果有組合層(把其他模組串起來的薄薄一層),它通常沒有 Wave 0 的 phase-1——
組合層在被組合的東西存在之前無法獨立(見 ADR-004 的例外條款)。

## 資料夾結構

```
NN-name/
├── FEATURE.md        範圍、不在範圍、依賴、技術棧、單獨執行、phase 表、Wave 0 的重複
├── NEXT.md           ★ 目前狀態、下一個 phase 的 gate、gate 未滿足時該做什麼
├── phase-1.feature   Wave 0,必須完全獨立
└── phase-N.feature
```

新資料夾從 `_template/` 複製,**三個檔都要**;`phase-1.feature.template` 複製後改名成 `phase-1.feature`(樣板用不同副檔名是為了不被 cucumber 掃到,P-07)。

## phase-1 的原則

Wave 0 的 phase-1 應該:

1. **只 import `contracts/`** 與自己的目錄。這條由 `npm run boundaries` 檢查,是唯一硬性的
2. **能單獨跑**,指令在 `standalone.json`
3. **只吃 `contracts/fixtures/`**
4. **需要別人的能力就用 stub**,在 FEATURE.md 的「Wave 0 的重複」列出來

例外是允許的,但要在 `FEATURE.md` 說明理由,並在 decision map 記一筆。

## 狀態

| 狀態 | 意思 |
|---|---|
| `todo` | 有 gherkin,gate 未滿足 |
| `ready` | gate 滿足,可挑進 sprint |
| `in-progress` | 本 sprint 在做 |
| `done` | 通過 `/phase-done` |
| `blocked` | 卡住,原因在 NEXT.md |

建議讓 `/sprint` 與 `/phase-done` 維護狀態,這樣 gate 計算才會正確。
手動改也不會壞掉,只是下次 `/sprint` 可能給出奇怪的建議。

## Gherkin 慣例

全英文,cucumber 預設語言,不需 language 標頭。

檔頭第一行是 tags:

```gherkin
@wave0 @{{FEATURE_TAG}} @phase-1 @standalone
```

| Tag | 意思 |
|---|---|
| `@wave0` / `@i1`..`@iN` | 屬於哪個階段 |
| `@<feature-name>` | 哪個資料夾 |
| `@phase-N` | 哪個 phase |
| `@standalone` | 不需要其他模組,`npm run accept:standalone` 會跑 |
| `@manual` | 人眼確認,自動測試跳過 |
| `@llm`(如果有外部呼叫成本) | 需要真的雲端呼叫,會花錢 |

規則:

- 一個場景只驗一件事
- 步驟用使用者看得懂的語言,不寫實作細節(不寫 "calls function X",寫 "runs the validator")
- **能力層用模組的口吻,整合層用使用者的口吻,同一件事兩種句子。** 例:能力層 `the world model lists the key among held items`,
  整合層 `the key is in the player's possession`。判準是**後端是不是同一個**:整合層走真的管線 / harness,能力層直接呼叫模組,
  後端不同就不能共用句子——共用會逼步驟定義裡藏一個 if,能力層綠了整合層那邊其實沒驗到(P-04 的形狀)。
  後端真的相同的句子(退出碼、「沒有模型呼叫」、直接呼叫的純函式)才進 `common.steps`
- **gherkin 裡的枚舉字要跟 `contracts/types.md` 一模一樣**(phase、verdict、狀態這類),不在步驟定義裡做對映;
  feature 檔就是契約的測試
- 多個變體用 `Scenario Outline` + `Examples`
- 場景名稱是一句敘述,不加編號
- 每個 phase-1 的第一個場景應該是「單獨跑起來會怎樣」

## 步驟定義

`steps/`,依功能分檔。同一句步驟在不同 feature 出現時共用同一個定義。

## 一個 phase 的大小

小團隊 1–3 天內做完。超過就拆,少於半天就併。

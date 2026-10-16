# contracts/ — 跨模組約定(可執行)

平行開發的支點:兩個功能要能同時開工,唯一的障礙是「A 需要 B 的格式」。先把格式定案,障礙就消失。
v2 的契約**是可執行的**:`schema/*.schema.json` 是唯一正本,`dp check contracts` 用 fixture 驗它。

## 版本

`VERSION` 是契約的 major。節點用 `contracts@<major>` 表示依賴。major 變更只有使用者能批准:
在單一窗口提出 → 使用者批准 → 改 `VERSION`(v4.1 拿掉了 `dp contract bump`,第一次真的要升 major 時再加回來;
它會把已完成且依賴舊版的節點標成 `stale` 重驗,帳本仍讀得懂舊的 `contract_bump` 事件)。
實際改 schema 的工作由 `shared/contracts*` 節點做(它是唯一能寫 `contracts/` 的節點)。

## 硬 / 軟

判準一句話:**碰到磁碟或線路的就是硬**(檔案格式、存檔、跨程序 JSON、gherkin 裡出現的枚舉值)。硬的放進 `schema/`,
改了要 bump。只存在記憶體的介面(函式簽章)是軟的,由型別系統與測試守,不進這裡。

## 檔案

| 路徑 | 內容 |
|---|---|
| `schema/<名字>.schema.json` | JSON Schema 子集(支援的關鍵字見 `tools/lib/schema.mjs`;不支援的關鍵字會直接報錯,不會被默默忽略) |
| `fixtures/valid/<名字>/*.json` | 必須通過的真實樣本,各模組測試直接拿來用 |
| `fixtures/invalid/<名字>/*.json` | 必須被擋的樣本(陽性對照) |
| `fixtures/invalid/<名字>/EXPECTED.json` | 每個壞樣本「應該因為什麼被擋」;被擋的原因不對也算失敗 |

每份 schema 至少一個 valid、一個 invalid。沒有陽性對照的契約檢查不算檢查。
`example.schema.json` 是示範,換成你的第一份真契約後刪掉它和它的 fixture。

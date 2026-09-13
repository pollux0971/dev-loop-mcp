# Sprints

每週一個檔案,由 `/sprint` 產生,檔名 `YYYY-Wnn.md`(ISO 週)。

## 範本

```markdown
# Sprint YYYY-Wnn

## 階段
Wave 0 / I2 / …

## 目標(一句話)

## 本週 phase
| Phase | 狀態(開始時) | 預估 | 變異門檻 | 備註 |
|---|---|---|---|---|

## Carry over(上週未完成)

## @manual 場景確認清單
- [ ] {{FEATURE_FOLDER}}/phase-1 · (場景標題)

## 單獨執行檢查
- [ ] `{{STANDALONE_COMMAND_EXAMPLE}}` 能跑

## Retro(週五填)
- 哪個 phase 比預期難?
- 為什麼?
- 下週要改估法或拆法嗎?
- 有沒有發現契約缺東西?(Wave 0 特別要問)
- 這週有沒有改過對輸出品質有影響但測試抓不到的東西(例如 prompt)?改了有跑對應的品質檢查嗎?
```

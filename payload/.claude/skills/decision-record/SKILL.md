---
name: decision-record
description: 把一個已經被使用者批准的架構決定寫成 ADR。只在 ledger 裡已有對應 decision 事件時使用。
---

# ADR

檔名 `docs/adr/ADR-<編號>-<短名>.md`,編號 101 起。一個決定一個檔,寫完不改內容;被取代時新開一份並互相連結。

```
# ADR-<編號> · <標題>
- Status: accepted | superseded by ADR-xxx
- Decision: ledger `<ref>`(seq <n>),使用者原話:「…」
## 背景   (一段:什麼情況逼出這個決定)
## 決定   (一句話)
## 取捨   (選了什麼、放棄了什麼、為什麼)
## 影響   (哪些節點 / 契約 / 規則要跟著變;需要重驗的列出來)
```

不要寫沒被批准的決定;沒有 ledger ref 就先回單一窗口問。

---
name: brownfield-onboard
description: 既有專案(brownfield)第一次接上 dlm 時用一次:記測試基線、讀程式寫 docs/AS-IS.md、建 ROADMAP v0。dlm.config.json 的 project.mode 是 brownfield、而且還沒有 docs/AS-IS.md 時,Front 開場先做這個。
---

# Brownfield onboard:先弄清楚現況,再加東西

目的:之後每個節點的 intent、owns、gherkin 都建立在「這個專案現在實際長怎樣」上,不是靠猜。只做一次;做完 AS-IS.md 就是現況的依據。

## 步驟

1. `node tools/dlm.mjs doctor`。「合併 gate」要是 ✓(gate 跑的是專案自己的測試指令)。不是的話請使用者在自己的終端機跑
   `node tools/dlm.mjs setup`,選 Brownfield、確認測試指令。
2. `node tools/dlm.mjs onboard`。它會:
   - 在主線的乾淨副本跑一次專案的測試,把**本來就紅**的測試記進 `docs/dlm-baseline.json`(之後合併時,紅的只要都在基線裡就不算 worker 弄壞的;
     多出一個新的紅就擋)。看不出是哪些測試紅的 gate,修好前每次合併都會擋,要跟使用者講清楚;
   - 產生 `docs/AS-IS.md` 草稿(機器寫得出來的部分:語言、測試指令、進入點、目錄、基線)與 `docs/ROADMAP.md` 的 v0「現況」;已經有的不覆蓋;
   - commit。
3. 讀程式,補 `docs/AS-IS.md` 標「待補」的段落。**只寫讀到的事實**,每一條附檔案路徑:
   - 目錄表的「在做什麼」一欄;
   - 模組與資料流:主要模組各負責什麼、資料從哪裡進來、存到哪裡、從哪裡出去;外部依賴(資料庫、API、檔案、環境變數);
   - 已知的坑:沒有測試保護的地方、看起來像 bug 但可能有人依賴的行為、改一處會連帶壞的地方。
   整份控制在一兩頁;讀不懂的寫「不確定:…」,不要腦補。
4. 給使用者看 AS-IS.md 的重點和基線(哪些測試本來就紅),問:「這樣描述對嗎?有沒有漏掉重要的部分?」照他的話改,commit。
5. 問他接下來想加或改什麼,交給 `intake` skill(v1 從現況往上長)。

## 之後加功能時要記得(intake 會檢查)

- `owns` 寫**真的會改的檔**,不要寫 `src/**`:dlm 會替 owns 涵蓋的既有程式檔加一棒 characterize(先寫測試釘住現有行為,在現在的程式上必須綠),
  一次最多 10 個檔。不想釘(例:整個要換掉)就在節點寫 `"characterize": { "skip": "理由" }`。
- 專案沒有 cucumber 時,`accept` 要寫專案自己的測試指令只跑這個節點的測試(例 `python3 -m unittest tests/test_export.py`);
  gherkin 仍是規格,測試棒照每個場景各寫一個測試。
- 新功能**刻意**要改掉某個既有行為時,寫進 gherkin,並把那個檔從 characterize 拿掉(characterize.targets 自己列);不然實作棒會被釘住的測試擋下。
- 基線過時了(有人修好了舊的紅測試)就 `node tools/dlm.mjs baseline` 重記。

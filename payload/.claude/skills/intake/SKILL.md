---
name: intake
description: 把使用者的需求變成可批准的 DAG 提案。新版本(bundle)、單一新節點(feature)都走這裡。Front 在使用者要新東西時使用。
---

# Intake:需求 → 提案 → 使用者批准

產出永遠是一份 `dlm intake` 提案,**不是**直接寫檔。使用者說好之後 dlm 才寫進 DAG。一次問一個問題。

## feature(新功能、新版本)

整個產品先規劃成「一版一版長大」,**每一版都要能單獨跑、使用者能親手試**。不管使用者有沒有提,都照這個順序:

1. 釐清:先照 `sharpen` 用你的話重述需求、指出說太多或太少的地方,再問這東西給誰、做完能做到什麼、怎麼算成功。不要腦補。一次問一個問題。
2. 畫路線圖(先不建):把使用者要的全部功能排成 v1、v2、v3…。
   - v1 = 最小、能單獨跑、有用的一刀(通常是一條主流程 + 最少的資料)。
   - 之後每一版只加一兩件事,而且建立在上一版已經穩定的東西上。先做被依賴的(資料模型、核心計算),再做加值的(報表、匯出、同步)。
   - 每一版寫一句「這一版使用者能做什麼」。和使用者對齊路線圖,特別是「哪些不在 v1」。
3. 只把**這一版**切成節點:一個能力一個資料夾,`owns` 互不重疊,放在技術棧規定的位置(node-ts:`packages/<能力>/**`)。兩個能力要共用的格式 → 另提契約變更。
4. 每一版最後一個節點是整合點 `I<n>`(`kind: "integration"`,`depends_on` 這一版所有節點,gherkin 至少一個 `@e2e` 場景):
   那是使用者親手試用、確認這一版能用的時間點。**下一版會自動等這個整合點合併並試用過才開工**——一版一版疊,不會在不穩的地基上加功能。
5. 跟使用者一起寫 gherkin(英文 Gherkin,場景寫可觀察結果,不寫實作)。寫完**逐一驗算**每個場景裡的數字
   (總和、餘額、日期區間、排序):gherkin 是規格,算錯的話測試棒會照錯的寫,實作棒永遠做不出來。
   程式要讀的輸入檔(情境、設定、資料),在 gherkin 用 docstring 附一份**完整範例**;輸出的每個欄位寫清楚意義與單位
   (例:`pages=` 是要求的頁數還是配到的區塊範圍)。數量至少一個場景用不是 2 的冪的值,免得錯的算法剛好湊對(Weave OS 實測)。
   整合點的 gherkin 不要沿用能力 gherkin 的句子(Given/When/Then 一字不差):gherkin 執行器一句只能有一個定義,
   能力的步驟操作核心套件、整合的步驟跑命令列,同一句會綁到錯的那一個,整合點的測試棒又改不到能力的步驟檔(v4 實測)。
6. 寫一份 bundle 檔 `.dlm/intake/<release>.json`:
   ```json
   { "release": "v1", "goal": "這一版使用者能做什麼(一句)",
     "roadmap": "# 路線圖\n- v1 …(這一版)\n- v2 …\n- v3 …\n",
     "nodes": [
       { "id": "ledger/v1", "title": "…", "intent": "…(≤300 字)", "owns": ["packages/ledger/**"],
         "depends_on": ["contracts@1"], "gherkin_file": ".dlm/intake/ledger-v1.feature" },
       { "id": "I1", "kind": "integration", "title": "…", "intent": "…", "owns": ["apps/cli/**"],
         "depends_on": ["ledger/v1"], "gherkin_file": ".dlm/intake/i1.feature" } ] }
   ```
   `node tools/dlm.mjs intake bundle --spec .dlm/intake/<release>.json`。路線圖會存成 `docs/ROADMAP.md`(換了 session 也找得到)。
7. 把提案重點(這一版做什麼、不做什麼、整合點怎麼試、路線圖)給使用者看,他說好才
   `decide node:<提案id> yes --verbatim "<原話>"`。**一版只批一次**。

下一版:先讀 `docs/ROADMAP.md`,跟使用者確認方向還對(試用完常常會改),再照 3–7 提下一版的 bundle。
dlm 會自動讓下一版的起點依賴上一版的整合點。
只加一個小節點(不是新的一版)時用 `dlm intake feature --spec … --gherkin …`。
施工中發現的必要小功能(v1.1)由 worker 提 spawn,不走這裡。

## 既有專案(brownfield)

`project.mode` 是 `brownfield` 時,先讀 `docs/AS-IS.md`;還沒有就先做 `brownfield-onboard`。v1 是「現況 + 第一件要加的事」。
- 會動到既有程式的節點,先用 `blast-radius` 找出 owns 以外會壞的地方,結果拿來決定 characterize 要釘哪些檔。
- `owns` 只寫真的會改的檔(不是 `src/**`)。涵蓋到既有程式時,dlm 會在提案裡自動加 `characterize`(先釘住現有行為的測試棒,
  一次最多 10 個檔);刻意要改掉的行為寫進 gherkin,並在 `characterize.targets` 只列要保持不變的檔,整個要換掉就寫 `characterize.skip`。
- 技術棧沒有預設驗收指令的專案,每個節點都要寫 `accept`(專案的測試指令,只跑這個節點的測試),和 `tests`(測試檔放哪裡,例 `tests/test_export*.py`)。
- 提案給使用者看時,講清楚哪些既有檔會被釘住、哪些行為會改。

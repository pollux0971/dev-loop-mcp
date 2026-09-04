# 切入方式:greenfield 與 brownfield

這套範式在一個 greenfield 專案(A)誕生,兩個 brownfield 專案(B:272 張 story 的企業平台;C:823 張 story 的遊戲)在兩天內切換過來。
兩種切入的差別不在規則,在**第一週做什麼、什麼順序**。

## 一眼對照

| | greenfield(A) | brownfield(B、C) |
|---|---|---|
| 第一件事 | 寫契約並凍結 | **把「誰能定什麼」寫進 main 的 CLAUDE.md,使用者親口批** |
| 契約從哪來 | 設計問答 | **先讀程式碼裡既有的 enum / 格式**,沿用不發明第二套 |
| Wave 0 做什麼 | 每個能力 phase-1 從零寫 | **回填**:場景綁既有測試的同一入口,不重寫、不映射 |
| 第一個整合點 | I2 才是「系統真的能用」 | **已經能跑的那條路徑就是 I1**(walking skeleton 先存在) |
| 既有規格 | 無 | 封存不轉換,蒸餾 ≤200 行凍結的 00-design |
| 主要風險 | 寫了沒接(P-20) | 雙真相、規則授權不可驗證、evidence 文化殘留 |

## greenfield:照 README 的 5 步

契約 → fixtures → 每個能力的 phase-1 gherkin → scaffold commit → 分叉。I1 之前沒有一條真的路徑,所以 **@e2e @llm 那次真跑會集中暴露所有「只有真呼叫才踩到」的坑**(P-22~P-24),把它當成必經的一天,不是意外。

## brownfield:第一天的三件事(兩個專案重來都會這樣做)

1. **決策權表進 main 的 `CLAUDE.md`,使用者親口批**;同時做一次「矛盾掃描」,把舊鐵律改到跟新表一致。
   沒有這步,協調者會對顧問轉述的每一句「使用者說」正確地拒絕——B 停了三次。
2. **一個 checkout 一個 session、tag `baseline-<舊制名>`、根目錄 `.gitignore` 先擋素材檔**。三個十分鐘的事,漏了各付一小時以上(P-12、素材差點進公開 repo)。
3. **scaffold + 一個參考回填 + 它的反向驗證(檢查點在 repo 裡,P-28)**,再分叉。
   參考回填給後面每個資料夾一個能抄的形狀,比任何文件有效;挑最小、最純的那個能力當範本。

然後才是:切能力資料夾(從已經能跑的路徑倒推,8–15 個)→ 把已存在的路徑寫成 `docs/integration/i1.feature`(@e2e 就是它,@regression 收今天已能做的事)→ 分叉回填。

## 既有資產怎麼處理(最省的做法)

| 資產 | 做法 | 不要做 |
|---|---|---|
| story / epic 規格庫 | **封存不轉換**:tag,`git mv` 到 archive/,頂端 superseded 標頭;真內容蒸餾成凍結的 `00-design.md` + 產品決策唯讀表 `PD-nn`(見 00-design 頂部規則) | 一對一轉成場景——那是「Gherkin 變模板」 |
| 未完成的 story | 映射成某個資料夾某個 phase 的**素材**;映射完加 `superseded_by`,跑封存腳本(要可重跑,main 還在長) | 保留當工作單位 |
| 已完成的 story | 立刻封存,價值已在程式碼與測試裡 | 映射 |
| 既有測試 | phase-1 場景綁**同一個入口**(同一個工廠函式 / 同一個 build);FEATURE.md 放「回填對照表」(場景 → 測試檔:測試名);綁不到既有測試的行為不准進 phase-1;證明綁的是真入口 = 突變生產碼 → 場景紅 | 重寫、或綁檔案佈局(rebase 後會斷) |
| 既有 CI | 保留;單一 job 先拆成獨立 job,再加 accept job | 一顆紅燈蓋掉一切 |
| 舊規則檔 / 指令 | 頂端 superseded,內容不刪;真規則搬進新檔一節;舊指令 DEPRECATED 留一個 sprint | 直接刪(agent 的 context 裡還有它) |
| 進度表 / evidence 檔 | 整目錄封存,凍結標頭;狀態來源只留 FEATURE.md 的 phase 表 | 雙讀(舊 frontmatter + 新表)——兩個真相會漂 |
| 零內容佔位、mock 墳場、指向不存在路徑的規則 | 切換時一次清 | 留著——autopilot 會在上面「做完」東西 |
| 使用者素材(PDF、錄音、raw) | `.gitignore` 先加 | 等 `git add -A` 之後才發現 |

## 過渡期規則

- **一次切,不雙軌**:切換日起舊 frontmatter 唯讀、board 只讀 FEATURE.md;未完成的 story 在**一個 sprint** 內映射完。
- **切換在 branch 上做,產品碼與既有測試零改動**:讓「切換造成的紅」與「產品的紅」可分離;切換造成的紅由審核 agent 修測試(寫實作的不改考卷)。
- **切換期的 checklist 以 git 為準,附取數指令與日期戳,不寫死數字**——main 每小時都在動,寫死的前提幾小時就過期。
- **回滾點**:切換前 tag `safety/main-before-paradigm`。

## brownfield 特有的坑(索引,細節在 PITFALLS.md)

- 規則授權不可驗證:新規則在分支、不在 main,協調者依規則拒絕(→ 第一天第 1 件事)
- 共用 checkout 的 context 污染(P-12)
- 舊流程在切換期間繼續跑,分支要 rebase 並重驗場景仍綁得到入口
- evidence 文化殘留:RED/GREEN 段落漂亮、檢查點在 scratchpad(P-28)
- 規則檔內部矛盾:新段落疊在舊鐵律上,參考順位處理不了同一檔內的衝突
- 枚舉發明第二套:brownfield 的契約要先讀程式碼既有的 enum(C 的 verdict 沿用程式碼四值)
- 殺終端 / 清目錄用「不在新範式清單裡」當判準,會殺掉活著的舊東西——先讀 title / 先看內容

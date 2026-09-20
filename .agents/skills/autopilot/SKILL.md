---
name: autopilot
description: 讓協調者不停推進專案,把使用者當成只要成果的老闆。當使用者說「一直做」「自動推進」「不用問我」「autopilot」,或協調者被週期排程喚醒時使用。內含決策權責表(哪些自己決、哪些問技術顧問、哪些才問使用者)、每輪的固定流程、沒事可做時的維護清單、煞車條件。只給協調者用;技術顧問與 worker 不跑這個。
---

# autopilot — 協調者的自動推進迴圈

啟動方式:由協調者的排程機制週期執行。每次醒來跑一輪下面的流程,回報一段,然後睡。
<!-- CLAUDE-ONLY-BEGIN -->
Claude Code adapter:協調者 session 可執行 `/loop 15m /autopilot`。
<!-- CLAUDE-ONLY-END -->
**使用者是只要成果的老闆**:不問他技術問題,只在「權責表」寫明的三種情況才找他,而且找他時要把選項與建議一起給,讓他一句話能答。

## 0. 每輪開頭(固定,不可省)

```bash
cd <repo 根目錄> && pwd && git branch --show-current   # P-19:確認在根、在 main
git status --short --untracked-files=no | head          # 根目錄不該有「已追蹤檔案」的未 commit 變更;未追蹤的產出目錄不算
{{SPEND_CHECK_COMMAND}}                          # 今日付費 API 花費;退出碼 0 未達 / 1 已達上限(≥ 就算)/ **2 算不出來**
                                                       # 2(log 檔缺、上限變數缺或空、今日條目有壞行)→ 停所有付費工作 + 開工單 + 通知技術顧問;「不知道」不是「零」(P-47)
                                                       # 檔案還不存在(03/phase-4 未合併)→ 跳過這步,不當煞車
grep -o "ADR-0[0-9]*" docs/02-decision-map.md | sort -u | tail -1   # 目前最大 ADR 號;派工說明裡寫「ADR-下一號 = 這個+1」,worker 不自己猜
```
讀 `docs/01-roadmap.md` 現況表、所有 `features/*/NEXT.md`、`docs/sprints/<本週>.md`。

## 1. 權責表(誰決定什麼)

誰決定什麼,以 `AGENTS.md`「做決定時」表為準,本迴圈不另抄一份。這裡只補協調者在每一類要做的動作:

- **自己決的**(派工、合併、worktree、審核回合):直接做。有開 ADR-018 四常駐角色時,鏈內接棒與清樹的**執行**交接線／整合清樹 agent,決定仍是你的。
- **問技術顧問的**:通知技術顧問並等待回覆,附你的傾向;**30 分鐘沒回就照保守選項做**,記 ADR 標「待覆核」,下一輪再提。
  **保守選項的定義**:一次 `git revert` 就能整個還原的那個選項,不是「花力氣最少」的那個(P-57)。
- **問產品 PM 的**:所有使用者產品需求先交 `product-pm`;PM 可提探索請求,但 session/worktree 仍由協調者建立與監督。
  PM 呼叫內部 `feature-triage` 分流後:E / C / B → 使用者;A → 技術顧問;D 先拆分後逐項重新判定。
- **等使用者的**:放「等老闆」清單,**不擋其他工作**;PM 與協調者都不能代批。改硬約定或規則正本要附 ADR 草稿;
  `@e2e` 場景列清單(原文 + 檔案路徑);花錢超過 `{{DAILY_CAP_ENV}}` 就不跑,@llm 場景延到明天。
- **技術顧問判定的**(`@manual and not @e2e`):等他把依據寫進 phase 驗收報告或 `IN-REVIEW.md`。

## 2. 每輪流程

**在 main 上改任何檔案之前**,先對每個目前 in-progress 的分支確認它沒有同時在動同一個檔:
```bash
git diff --name-only main...<branch> | grep <要改的檔案>
```
每個 in-progress branch 都要為空才動手——這條在合併(步驟 1)、先修 main(§4)、技術顧問直接改規則層
(`AGENTS.md`「做決定時」表最後一列)都適用,不是只在收割時才查(來源 nightmare-assault,D14)。

### 2a. 三種 dispatch mode（每次派工必填）

每張實作或整合 dispatch 都要明列唯一 `mode`，不得只寫「做開發」或讓 worker 自選：

| mode | 何時用 | 可寫邊界 | 發現越界時 |
|---|---|---|---|
| `region-development` | 單一 capability 的單一 phase 實作；不限 Wave 0，Wave 0 額外禁止跨資料夾 import | 工單逐條列出的該分區實作檔與自有 stub | 交回協調者；需要跨區、共用檔、測試、規則層或 contract 時另派工 |
| `region-integration` | 在指定 integration point 接通一條已批准的跨區流程 | 只寫預先指定的 composition／adapter／integration seam；可讀所涉分區公開介面 | 不改來源分區內部；帶原始證據派回該分區的 debug／development task |
| `global-integration` | 合併後在完整系統跑 `@e2e`、`@regression`、standalone 與完整 gate | 預設 report-only；只有工單明列唯一全局 composition 落點時可寫該路徑 | 拆成分區修復或分區整合 task；不順手修內部、不改測試讓結果變綠 |

Mode 與既有 dev／test／reviewer／debug 角色是兩個維度。Dev、debug 與整合實作 session 使用 `dev-worker`；
test／reviewer 仍依原角色規則寫測試與審核，不因 mode 取得實作權。`global-integration` 預設是 verifier 工作。

派工 envelope 至少包含：`task_id`、`dispatch_id`、`mode`、單一 objective、權威來源與可解析 ID、`base_ref`、
worktree、inputs、`allowed_paths`、`forbidden_paths`、acceptance commands、`done_when`、回報位置。
`allowed_paths` 未列出的路徑一律不可寫，且永遠不能覆蓋 `AGENTS.md` 五條硬規則、決策權表或 worker 永久禁區。
Branch diff 出現 allowlist 外修改就退回，不以事後擴大 allowlist 追認。

1. **收割**:哪些 worktree 的審核回來了 → PASS 的合併(一次一個,`git checkout main && git merge --no-ff <branch>`,**不 rebase**,每個 phase 三輪 commit 的軌跡是刻意留的),合併後跑完整檢查,**單一入口**:
   ```bash
   npm run check:all
   ```
   這支腳本讀 `scripts/gates.config.json` 的 `chain`(陣列,元素是 `package.json` `scripts` 底下的名字,依序執行,
   例如 `["typecheck", "test", "boundaries", "standalone", "accept:standalone", "accept:dry", "accept:coverage",
   "check:steps", "lint:docs"]`),不再是這份 SKILL 手寫一串 `&&` 串起來的指令——**必跑清單裡的每一項都必須是
   `chain` 裡的一個名字,而每個名字都必須是 `package.json` `scripts` 裡真的存在的 npm script**,不存在會被
   `check:all` 自己判定失敗並印「不是 npm script(P-55)」,不會被誤判成「沒事」。`chain` 是空陣列或缺欄位一樣
   算失敗——「清單沒填」跟其餘掃描器的「0 目標」同一個道理,不是「沒事可做」。**清單裡的每一條都必須是 npm
   script**,手打指令放進清單等於沒人會跑(P-55)——新加守門一律先在 `package.json` 掛一個 script、加進
   `gates.config.json` 的 `chain`,並反向驗證一次(刻意弄壞,預期 ✗ exit 1;修回來,預期 ✓ exit 0)。
   同步進來但還沒被任何 script 呼叫的守門(P-64)不會被 `check:all` 跑到——用 `sync-gates.sh --check` 的接線
   檢查另外抓,不是這一步的責任。
   **跑的是 main 現在的完整檢查清單(即 `gates.config.json` 目前的 `chain`),不是分支開工時的**:分支 base 比 main 舊時,main 新加的守門在分支上不存在,合併後必須補跑。
   **合併後留一份 junit 基準**(`reports/junit/<sha>.xml`,加進 `.gitignore`,不進版控):
   ```bash
   npx vitest run --reporter=junit --outputFile="reports/junit/$(git rev-parse --short HEAD).xml"
   ```
   下次合併後跟上一份基準比對 testcase 的 **multiset**(名稱 + 次數,或 classname+name 完整限定),**不要比總數**——
   兩棵樹可能對出同一個總數卻組成不同(分支 8036+4+4、main 8036+8,總數都是 8044,實際少了四條),
   總數對得上不代表測的是同一組測試;比對時也不要用 `set(names)`,重複名稱會被集合悄悄吃掉(P-49)。
   全綠 → tag 打在**這次合併的 commit** 上、清 worktree(照 `docs/07-practices.md` (at);有開 ADR-018 整合/清樹 agent 時改成通知它清)、**立刻**通知技術顧問「驗推」——不要等累積多個合併才通知,
   也不要在通知前又往 main 疊新 commit:`git push` 推的是 HEAD 以下全部,不是「剛做的那個」,
   合併與通知之間有 commit 插進來,連那個還沒驗過的合併都會被一起推上去(P-56)。
   FAIL 的照 test→dev→review 循環派 debug session。
2. **算 ready**:照 sprint-planning 的規則讀所有 NEXT.md。三種 gate 全滿足 → ready。
3. **派工**:先依 §2a 為每張實作／整合工單選定唯一 mode、填完整 envelope，再啟動 `dev-worker`。**同開上限 = 目前 ready 集合的大小**——ready 多少個就可以開多少個,不再固定卡在某個數字
   (`docs/07-practices.md`「三個專案都刻意不遵守的範式條文」)。這個上限不是沒代價,代價由另外兩條規則吸收,
   不是靠「少開」:**一次合一條**(合併回 main 一次只處理一個 phase 的分支,不批次合併)、**同步由協調者吸收**
   (worker 的分支落後 main 時,同步這件事由協調者做,**方式是在該分支上 `git merge main`,不 rebase**——第 1 步刻意保留
   每個 phase 三輪 commit 的軌跡,rebase 會把它洗掉。**唯一例外**:分支**從未推出去**、要接到剛落地的共用檔 chore 上時
   可以 rebase,改寫的是沒人看過的歷史。1.8.0 以前這裡寫「rebase 這件事由協調者做」,跟第 1 步的「不 rebase」直接矛盾,#26)、
   **分支落後上限**(in-progress 分支落後 main 超過 `{{BRANCH_DRIFT_CAP}}` 個 commit,先同步再繼續派下一棒——落後愈多,
   合併時的衝突與漏改愈集中,見 `docs/07-practices.md`「未合入交付物與分支漂移」)、**未合入交付物上限**(做完但還沒合進 main
   的交付物超過 `{{UNMERGED_CAP}}` 條,**暫停派新工,產能轉去整合**——「ready 多少開多少」加「一次合一條」這個組合,
   不設這條會讓完工的東西排隊等收,#25)。滿載(所有 ready 都已派出)
   時不重複派工,回到 1 收割;收割不到東西就做維護清單(§3)等下一輪。**同時處於審核輪(跑變異測試)的 worktree ≤ 1**
   ——⚠️【驗,2026-09-21 上游】這條 1.8.0 曾放寬成「`{{PARALLEL_CAP}}`,檔案鎖會自己排隊」,**那個前提在本模板不成立**:
   模板從來沒出貨那把鎖(`package.json` 的 `mutate` 就是裸的 `stryker run`,有鎖的是走另一條路的 `scripts/py/mutate.py`),
   放寬的依據是**來源專案 A 自己寫的 wrapper**。沒有鎖就放寬 = 直接重演 P-34(互相 OOM、$25、殘缺分數被當驗收)。
   **補上鎖之前一律 ≤ 1**;補上之後再放寬回 `{{PARALLEL_CAP}}`,並把這段改回去。
   `{{PARALLEL_CAP}}` 是使用者自己填的數字,**協調者不猜**——同時跑幾份變異測試不會撞到彼此的 OOM 上限,
   取決於使用者的機器與帳號額度,沒有一個機器可讀的數字能推出這個上限;專案 A 填 `3`,理由是單機跑
   Stryker 時 3 份平行大約是 OOM 的臨界值,換了機器規格這個數字要重新填,不是照抄。
   **`npm run mutate` 是唯一入口**,審核與開發都只准用它——設定檔與排除清單都掛在那個 script 上,直接叫 Stryker CLI
   很容易漏掉(`--mutate` 會整個取代排除陣列,見 mutation-testing skill)。**注意它目前沒有鎖**(同上),所以「唯一入口」
   現在只保證設定一致,不保證併發安全。
   **分數要附完整指令與設定檔**(範圍、旗標、`stryker.config.json` 的路徑):同一份程式碼、不同設定檔跑出來的分數
   不能比較(TS 型別檢查開關就能造成 3 分以上的差距),不附指令與設定檔的分數不算數(P-58)。每張照角色規則:
   測試 agent 先寫紅 commit → 開發 agent 做綠 → 審核 agent(`.orca-brief/REVIEW.md` 交接)。
4. **整合點**:某個 IN 需要的 phase 全 done → **先開 `region-integration`「整合工作」工單**(P-20:roadmap 該段的整合工作欄 + 各 FEATURE.md「Wave 0 的重複」表),只把 composition／adapter／integration seam 列入 allowlist；來源分區缺陷另派回原分區。合併後開 `global-integration` 驗證工單：worker 跑可自動執行的 `@e2e`／`@regression`、所有 standalone 與完整 gate，只寫 worktree-local 報告並原文列出人工場景。worker PASS 後由協調者核對原始結果、主持 integration-check、寫入 `docs/integration/IN-REVIEW.md` 與狀態檔；`@llm` 只在預算內跑。任何 `@e2e`(即使同時帶 `@manual`)由使用者做最終「你做得到嗎」確認；其餘 `@manual and not @e2e` 的觀感／品質由技術顧問確認並在 `IN-REVIEW.md` 留下依據與發現。IN 的人工確認未完成前,gate 是「IN 通過」的 phase 維持 todo——這是刻意的,不要繞。
5. **沒有 ready 的 phase** → 做維護清單(§3),做完一項就回到 2。
6. **回報**(§5 格式),睡。

## 3. 維護清單(沒事可做時,由上往下)

1. `PITFALLS.md` 與 `docs/02-decision-map.md` 裡標「待覆核」「待辦」的項目(例如 `--deps-only` 入口)
2. 標準級模組變異分數 < 80% 的檔案(`reports/mutation/` 最近一次),補測試
3. `{{LINT_COMMAND}}` 的健檢結果,能自動修的修
4. 文件漂移:roadmap 現況表、features/README.md 索引、各 FEATURE.md phase 表三者對不上的地方。
   `npm run check:phase-status` 跑在 report 模式(S15,PITFALLS P-75),自動掃「疑似已完成但
   狀態表沒更新」「done 但場景紅」「NEXT.md 過期」三種形狀——它的命中是**分診用的線索**,
   不是停止條件:report 模式本來就不擋 exit code,協調者看到命中就當成本節的文件漂移項處理
   (更新狀態表或開工單),不要因為它印了 FAIL 就當成 §4 的煞車
5. `npm audit` 的高風險項
6. **技術顧問側「有沒有工作」六判準**(來源 nightmare-assault,commit 9745bd87):協調者的維護清單(本節
   第 1–5、7、8 項)是**先跑**的一層,技術顧問是**最後一道**檢查——協調者清單全空之後,才輪到技術顧問
   依序自己跑一遍下面六項,不是取代協調者的清單,是接在它後面:
   1. 整合點紅清單(`docs/integration/*-REVIEW.md` 裡標紅、還沒排進工單的項目)
   2. `docs/02-decision-map.md` / `DECISIONS_NEEDED.md` 裡**已批示但還沒落地**的項目
   3. 接線孤兒(P-64:同步進來但沒接線的守門)或過期的 gate 引用(P-63)
   4. 退化見證器報告裡**未標記為允許退化**的訊號(見 `docs/07-practices.md` (r))
   5. 下一個整合點需要、但還沒開工單的 phase
   6. 其餘維護類工作(標準級變異分數低、文件漂移、`npm audit` 之類,跟協調者清單重疊時共用同一份)
   **六項全部檢查過、全部是空,而且把「怎麼數出空的」那條指令記進回報**,才算「技術顧問這邊也沒有工作」——
   只憑印象說「應該沒事了」不算數,那正是這個清單本身要防的觀測塌縮(P-68)。
7. **掃最近的問題紀錄有沒有同型第三次出現**(PITFALLS 條目、REVIEW.md 的退回理由):同一種型態
   第三次出現,不當個案處理——開一張處理這個型態本身的類項目工單(加一條 gate、改一條規則、
   或做一個小工具),已發生的個案列成這張工單底下的驗收清單(`docs/07-practices.md` (k))
8. 本清單第 1–7 項裡,**同一項連續 3 輪都在清單上但沒被實際碰過** → 該項自動升級成一張正式工單
   派出去,不要繼續留在「沒事可做時再看看」的狀態——「有空再做」等於不會做,這是協調者自己
   踩過的坑(`docs/07-practices.md` 「來自專案 A 協調者的做法」)
9. 以上都空(含第 6 項技術顧問的六判準)→ **停止迴圈**(停止排程迴圈)前先做兩件事:
   - **確認每個 worktree 都 commit 過**——未 commit 的工作在 session 結束時最脆弱,一旦平台或機器重開就不見了;
     跑不完就先 commit 到分支上,不要留在工作區裡等下一輪。
   - **技術顧問那邊的對應動作**(協調者提醒即可,實際驗證由顧問做):push 前 `git log --oneline origin/main..HEAD`
     逐條驗過,不要只看 `git status` 就 push——那擋不住「合併完、還沒驗、又被別的 commit 疊上去」的情況(P-56)。
   再寫本週 sprint 檔(若有維護;autopilot 常態運作時 sprint 檔是選配,每輪回報已經是預設的進度追蹤方式),
   把「等老闆」清單整理成一則訊息給使用者

## 4. 煞車(任一成立就停下該項,其他繼續)

- 同一張工單連續 **3** 輪 FAIL → 該 phase 標 `blocked`,原因寫 NEXT.md,問技術顧問
- 當日 OpenAI 花費達上限 → 所有 @llm 工作停,非 LLM 工作繼續
- 完整檢查在 main 上紅 → **先修 main**,不派新工;修的時候若動到測試檔,**同一輪開一張 review 工單事後覆核**,每處寫「為什麼是測試錯不是實作錯」(P-49)
- 根目錄有**已追蹤檔案**的未 commit 變更,或不在 main → 停,查是誰(P-12 / P-19);未追蹤目錄(例如產出資料)不觸發,但要確認它在 .gitignore 裡
- 技術顧問 session 不在(平台的 session 清單找不到)→ 技術決策改成「**保守選項**(一次 `git revert` 就能整個還原的那個,P-57) + ADR 待覆核」,不問使用者
- 同時進行的 worktree 已達 `{{PARALLEL_CAP}}` → 不派新工,先收割
- 已有一個審核輪在跑變異測試 → 其他審核輪先做不含變異的部分,或等待;agent 看到 stryker 退出碼 137 / 144 一律重跑,絕不把當次結果當分數(P-34)
- **同一種 PITFALLS 類型第三次出現**(不論是條目本身或 REVIEW.md 的退回理由)→ 不逐案修,停下來開一張**範式級工單**
  (改 template 本體 + 加一條守門或規則),已發生的個案列成該工單的驗收清單,不繼續一個一個修(來源 nightmare-assault,`docs/07-practices.md` (k))
- **同一條規則反覆被違反** → 不要先討論「規則是不是太嚴、要不要放寬」,**先查證守門有沒有真的跑過**
  (查執行紀錄、查有沒有對應的 npm script 與接線,見 P-64);守門確實跑了、規則確實被正確執行還是反覆違反,
  才輪到問「規則要不要改」。順序反了等於用放寬掩蓋一支從沒執行過的檢查(P-61,坑16)

## 4a. 停止條件 / 不是停止條件

整個迴圈只有三種情況真的**停止**(不是「這輪先跳過」,是停止排程迴圈):

1. **全部待辦都卡在使用者級**——沒有任何協調者或技術顧問能自己做的事,權責表(§1)判下來
   全部落在「使用者決定」那一列,而且都已經放進「等老闆」清單。
2. **達到使用者指定的輪數**——使用者明講「跑 N 輪」或「跑到某個時間」,到了就停,不用自己延長。
3. **連續兩輪完整檢查紅、修不好**——不是「這輪紅了」,是連續兩輪派 debug session 都修不回全綠。

**不是停止條件**(遇到就換做別的,不等、不停):

- worker 問問題——回答問題,或者權責表判給技術顧問 / 使用者,問完之前先去做別的 ready 工作
- 缺素材(某個 fixture、某份文件還沒交)——先做不依賴那份素材的其他工作
- 在等人工確認——任何 `@e2e` 放進「等老闆」清單；`@manual and not @e2e` 交技術顧問並留證據，兩者都不擋其他工作(§6 已經寫過
  「不因為等待確認而停下其他能做的事」,這裡把它跟「停止」明確分開,避免兩者被混為一談)
- 契約收緊(硬約定要走 ADR,軟約定改了跑測試)——那是一次性的工作量,做完就繼續,不是理由停下整個迴圈
- 發現缺陷——開工單修,不是停下來等人拍板要不要修(除非缺陷本身牽涉硬約定或範圍,那走 §1 的權責表)
- 模板升版——`git diff v<採用版>..v<新版>` 看完決定要不要跟,跟不跟都不是停止理由
- 平台 runtime 掛掉——先用 `git` 與 `pgrep -af claude` 確認 agent 是不是其實還活著;活著就不重派(重派會撞成同一份工作跑兩份),改做不需要這個平台的其他工作;平台恢復後,重建剛才被吃掉的 task(不是假設它還在排程裡)
- worker 開 escalation——那是 worker 在正常求助,不是迴圈壞掉;照 §1 權責表把問題分給該回答的人,問完之前先去做別的 ready 工作
- worker 說「我不照工單做」並附實測——先看那個實測,實測站得住腳就是工單本身有錯,修工單或走 ADR,不是逼 worker 硬做或把這當成迴圈要停下來的訊號
- 工單被 superseded——舊工單作廢是進度的一部分(規格或優先序變了),照新工單繼續派工
- 變異第一次量到 40–60%——低於門檻但不是 0,是「需要補測試」的正常訊號,開工單補,不當成迴圈卡死
- `accept:dry` 的 undefined 很多——那是段一(dry-run)在做它該做的事(抓接線問題),照 P-32 的清單修 tag / 定義,不是系統性壞掉的徵兆

**把這些誤判成停止,比漏掉一個真煞車更常發生。**

判斷準則:**能想到下一步該做什麼,就不是停止條件**;真正的停止是「想不出任何一件現在能做的事」。

## 4c. 「分支上全綠、合併後紅」的三種形狀(P-49)

分支全綠**不等於**合併後全綠。除了「main 多了分支沒有的守門」(§2 步驟 1),還有三種形狀:

1. **測試把「一定在 worktree 裡跑」內建成假設** → 到 main 就**永遠紅**(路徑斷言在兩種位置本來就不同)。
   **涉及路徑的斷言要在 worktree 與 main 兩種位置各跑一次。**
2. **main 上有分支看不到的檔案被規則掃到** —— 別的 repo 的簽出(`.claude/worktrees/`)、
   協調者自己寫的文件(可能為了**描述**一個錯誤而引用那個錯誤的字串)。
   **掃描類測試的 SKIP 清單要含 `.claude/worktrees` 與其他 repo 簽出。**
3. **兩棵樹對出同一個總數,組成卻不同**(分支 8036+4+4、main 8036+8,總數都是 8044,實際少了四條)——
   **總數相等不代表測的是同一組測試**。合併前用「每一項來源」寫下預期數字,不是只寫總數;合併後
   比對 junit testcase 的 **multiset**(名稱+次數,或 classname+name 完整限定),不比總數;
   也不要用 `set(names)`——重複名稱會被集合悄悄吃掉(見 §2 步驟 1 的 junit 基準)。

**協調者為了修 main 紅燈而動測試檔**:可以先修(§4「先修 main」優先),但**同一輪必須開一張 review 工單事後覆核**,
工單裡逐處列出「為什麼是測試錯不是實作錯」。覆核者判定任一處其實是**放寬** → **退回**。

**第四種情況不是合併造成的,是輸出層混訊**(P-69):如果紅燈的數字本身很怪(main 上不存在的失敗、跟上一輪
明顯對不上),而終端輸出是經過 rtk 這類 token 節省代理層轉出來的,先懷疑輸出被另一個同機 worktree 的測試
結果混進來,不要直接當成合併造成的迴歸去找原因——用 `rtk proxy <cmd>` 重跑一次未過濾的原始指令核對,
數字對得上才繼續往「合併壞了什麼」的方向查。

**相關但不同類(順手記在這裡方便查)**:P-77(宣告要做的事——例如「這個 ADR 我來寫」——
沒有對應的 diff 也沒有工單)、P-78(同一個警告已經寫過兩次,第三個人還是照舊慣例踩雷,
警告本身不是機制)是同一個「交接動作沒有回執」家族(P-76)的另外兩種形狀,不是分支/合併
問題,但常常在同一輪回報裡一起出現。

<!-- CLAUDE-ONLY-BEGIN -->
## 4b. Claude Code / Orca 平台操作備忘(實際踩過的)

- `worker-start --worktree new-top-level` **一定要帶 `--name`**,不帶會 `invalid_argument`
- `worker-start` 只用在一個 worktree 的**第一輪**。同一 worktree 的第二、三輪(debug / 再審):
  `terminal create` → `terminal send 'claude --dangerously-skip-permissions' --enter` → 用非阻塞 `terminal read` 確認 agent prompt 已出現 → `dispatch --inject`。
  **禁止 `terminal wait`**；尚未 ready 就記下 terminal handle，自己短暫 sleep 後再 read，或留到下一輪，不阻塞在對方終端。少了啟動或就緒檢查會 `no recognized agent detected`;重用舊終端機常 `agent_unconfigured`。**永遠開新終端機**,交接靠 `.orca-brief/REVIEW.md`(gitignored,worktree 專屬,不是根目錄的追蹤檔——P-17、P-78)
- `check --wait` 可能回**已處理過的舊訊息**(`"replayed": true`),要 `--ack <deliveryId>` 再等下一則,不然空轉
- `check` 回來的訊息 `type` 是 `question`(帶 thread/msg id)時,對方在等 `reply`,不是等一則新訊息——**先 `reply --id <該訊息 id>` 再 `ack`**,順序不能顛倒(`ack` 之後那個 id 就抓不到了);`send` 送得到終端機但不會解除對方的阻塞,沒有任何錯誤訊息(P-45)
- **`send` 對已經死掉的終端機一樣回 `ok:true`**,發送端以為送到了,接收端什麼都沒收到(P-54,P-45 同族)——
  `send` 前先 `terminal show` 確認終端機還活著;收到 `terminal_handle_stale` → 開新終端機,從 `.orca-brief/REVIEW.md` 重新交接;
  送出去後對方沒反應,先懷疑終端機死了,不是先當對方在忙。對照:`SendMessage` 對過期的 session 名會明確失敗
  並附提示,那才是好的失敗
- **找 worker 一律用 worktree 路徑尾段比對,永遠不用 title**(title 是 agent 自己會改的顯示文字;找不到會被誤判成死掉而重派,P-39);每個 worktree 兩個 terminal,挑 title 不是 `user@…` 開頭的
- `orca terminal send` 的旗標是 `--terminal <handle>`(不是 `--handle`),要加 `--enter` agent 才真的收到
- 工單寫進 `<worktree>/.orca-brief/TASK.md`(未追蹤,不混進 diff);批次改工單文字後 grep 舊字串應為 0 命中(P-40)
<!-- CLAUDE-ONLY-END -->
- 開 worktree 明確指定起點(`--base-branch main` 或 `git worktree add -b <branch> <path> main`),開完驗 `git merge-base --is-ancestor main <branch>`(P-18)

## 5. 每輪回報格式(給使用者看的,越短越好)

```
[autopilot 第 N 輪 · 今日花費 $x.xx / 1.00]
合併:{{NN}}/phase-N ✓
進行中:{{NN}}/phase-N(審核)
等老闆:I1 @e2e 兩條(檔案路徑)
等顧問:I1 @manual and not @e2e 一條(檔案路徑)
決定了(ADR):NNN … — 待覆核 0
卡住:無
```

## 6. 不做的事

- 不 push(技術顧問推)
- 不改規則層檔案、`contracts/` 硬約定、`prompts/`(改 prompt 要 golden run,那是 12 的流程)
- 不在根目錄 checkout 別的分支
- 不因為「等老闆」而停下其他能做的事;也不因為想推進而繞過「IN 通過」的 gate

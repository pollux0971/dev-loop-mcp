---
name: autopilot
description: 讓協調者不停推進專案,把使用者當成只要成果的老闆。當使用者說「一直做」「自動推進」「不用問我」「autopilot」,或協調者在 /loop 裡被喚醒時使用。內含決策權責表(哪些自己決、哪些問技術顧問、哪些才問使用者)、每輪的固定流程、沒事可做時的維護清單、煞車條件。只給協調者用;技術顧問與 worker 不跑這個。
---

# /autopilot — 協調者的自動推進迴圈

啟動方式:協調者 session 執行 `/loop 15m /autopilot`。每次醒來跑一輪下面的流程,回報一段,然後睡。
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

| 情況 | 誰決定 | 怎麼做 |
|---|---|---|
| 派工順序、合併順序、worktree、審核回合 | **協調者自己** | 直接做 |
| 技術取捨:資料結構、介面形狀、規格措辭、gate 例外、要不要重跑、變異存活怎麼分類 | **技術顧問**(session `{{ADVISOR_SESSION}}`) | SendMessage 問,附你的傾向;**30 分鐘沒回就照保守選項做**,記 ADR 標「待覆核」,下一輪再提。**保守選項的定義**:一次 `git revert` 就能整個還原的那個選項,不是「花力氣最少」的那個(P-57) |
| 新功能、新需求、改「不在範圍」 | **使用者** | `/feature` 分流出提案,放進「等老闆」清單,**不擋其他工作** |
| 改 `contracts/` 硬約定、改 `CLAUDE.md` | **使用者** | 同上,附 ADR 草稿 |
| 花錢超過當日上限(`{{DAILY_CAP_ENV}}`) | **使用者** | 不跑;@llm 場景延到明天或等他加碼 |
| 人眼確認(`@manual`、`@e2e`) | **使用者** | 列清單(場景原文 + 檔案路徑),放「等老闆」清單 |

判斷「新功能」的標準用 feature-triage 的 E / C / B 三種 → 使用者;A / D → 技術顧問。

## 2. 每輪流程

**在 main 上改任何檔案之前**,先對每個目前 in-progress 的分支確認它沒有同時在動同一個檔:
```bash
git diff --name-only main...<branch> | grep <要改的檔案>
```
每個 in-progress branch 都要為空才動手——這條在合併(步驟 1)、先修 main(§4)、技術顧問直接改規則層
(§1 權責表最後一列)都適用,不是只在收割時才查(來源 nightmare-assault,D14)。

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
   全綠 → tag 打在**這次合併的 commit** 上、清 worktree、**立刻**通知技術顧問「驗推」——不要等累積多個合併才通知,
   也不要在通知前又往 main 疊新 commit:`git push` 推的是 HEAD 以下全部,不是「剛做的那個」,
   合併與通知之間有 commit 插進來,連那個還沒驗過的合併都會被一起推上去(P-56)。
   FAIL 的照 test→dev→review 循環派 debug session。
2. **算 ready**:照 sprint-planning 的規則讀所有 NEXT.md。三種 gate 全滿足 → ready。
3. **派工**:**同開上限 = 目前 ready 集合的大小**——ready 多少個就可以開多少個,不再固定卡在某個數字
   (`docs/07-practices.md`「三個專案都刻意不遵守的範式條文」)。這個上限不是沒代價,代價由另外兩條規則吸收,
   不是靠「少開」:**一次合一條**(合併回 main 一次只處理一個 phase 的分支,不批次合併)、**rebase 由協調者吸收**
   (worker 的分支落後 main 時,rebase 這件事由協調者做,不要求每個 worker 自己處理)。滿載(所有 ready 都已派出)
   時不重複派工,回到 1 收割;收割不到東西就做維護清單(§3)等下一輪。~~同時處於審核輪(跑變異測試)的 worktree ≤ 1~~
   **已放寬回 `{{PARALLEL_CAP}}`,檔案鎖排隊**(P-34):跨 worktree 的檔案鎖合併之後,變異測試會自己排隊,不再需要靠派工節流。
   `{{PARALLEL_CAP}}` 是使用者自己填的數字,**協調者不猜**——同時跑幾份變異測試不會撞到彼此的 OOM 上限,
   取決於使用者的機器與帳號額度,沒有一個機器可讀的數字能推出這個上限;專案 A 填 `3`,理由是單機跑
   Stryker 時 3 份平行大約是 OOM 的臨界值,換了機器規格這個數字要重新填,不是照抄。
   **`npm run mutate` 是唯一入口**,審核與開發都只准用它——直接叫 Stryker CLI 會繞過鎖(有測試守著)。
   **分數要附完整指令與設定檔**(範圍、旗標、`stryker.config.json` 的路徑):同一份程式碼、不同設定檔跑出來的分數
   不能比較(TS 型別檢查開關就能造成 3 分以上的差距),不附指令與設定檔的分數不算數(P-58)。每張照角色規則:
   測試 agent 先寫紅 commit → 開發 agent 做綠 → 審核 agent(REVIEW.md 交接)。
4. **整合點**:某個 IN 需要的 phase 全 done → **先開「整合工作」工單**(P-20:roadmap 該段的整合工作欄 + 各 FEATURE.md「Wave 0 的重複」表),合併後 `/integrate IN`;`@e2e @llm` 在預算內自動跑,結果貼進 `docs/integration/IN-REVIEW.md`;`@manual` 進「等老闆」清單。IN 的人工確認未完成前,gate 是「IN 通過」的 phase 維持 todo——這是刻意的,不要繞。
5. **沒有 ready 的 phase** → 做維護清單(§3),做完一項就回到 2。
6. **回報**(§5 格式),睡。

## 3. 維護清單(沒事可做時,由上往下)

1. `template/PITFALLS.md` 與 `docs/02-decision-map.md` 裡標「待覆核」「待辦」的項目(例如 `--deps-only` 入口)
2. 標準級模組變異分數 < 80% 的檔案(`reports/mutation/` 最近一次),補測試
3. `{{LINT_COMMAND}}` 的健檢結果,能自動修的修
4. 文件漂移:roadmap 現況表、features/README.md 索引、各 FEATURE.md phase 表三者對不上的地方
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
9. 以上都空(含第 6 項技術顧問的六判準)→ **停止迴圈**(`ScheduleWakeup stop`)前先做兩件事:
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
- 技術顧問 session 不在(`ListAgents` 找不到)→ 技術決策改成「**保守選項**(一次 `git revert` 就能整個還原的那個,P-57) + ADR 待覆核」,不問使用者
- 同時進行的 worktree 已達 `{{PARALLEL_CAP}}` → 不派新工,先收割
- 已有一個審核輪在跑變異測試 → 其他審核輪先做不含變異的部分,或等待;agent 看到 stryker 退出碼 137 / 144 一律重跑,絕不把當次結果當分數(P-34)
- **同一種 PITFALLS 類型第三次出現**(不論是條目本身或 REVIEW.md 的退回理由)→ 不逐案修,停下來開一張**範式級工單**
  (改 template 本體 + 加一條守門或規則),已發生的個案列成該工單的驗收清單,不繼續一個一個修(來源 nightmare-assault,`docs/07-practices.md` (k))
- **同一條規則反覆被違反** → 不要先討論「規則是不是太嚴、要不要放寬」,**先查證守門有沒有真的跑過**
  (查執行紀錄、查有沒有對應的 npm script 與接線,見 P-64);守門確實跑了、規則確實被正確執行還是反覆違反,
  才輪到問「規則要不要改」。順序反了等於用放寬掩蓋一支從沒執行過的檢查(P-61,坑16)

## 4a. 停止條件 / 不是停止條件

整個迴圈只有三種情況真的**停止**(不是「這輪先跳過」,是 `ScheduleWakeup stop`):

1. **全部待辦都卡在使用者級**——沒有任何協調者或技術顧問能自己做的事,權責表(§1)判下來
   全部落在「使用者決定」那一列,而且都已經放進「等老闆」清單。
2. **達到使用者指定的輪數**——使用者明講「跑 N 輪」或「跑到某個時間」,到了就停,不用自己延長。
3. **連續兩輪完整檢查紅、修不好**——不是「這輪紅了」,是連續兩輪派 debug session 都修不回全綠。

**不是停止條件**(遇到就換做別的,不等、不停):

- worker 問問題——回答問題,或者權責表判給技術顧問 / 使用者,問完之前先去做別的 ready 工作
- 缺素材(某個 fixture、某份文件還沒交)——先做不依賴那份素材的其他工作
- 在等 `@e2e` / `@manual` 的人工確認——那件事放進「等老闆」清單,不擋其他工作(§6 已經寫過
  「不因為等老闆而停下其他能做的事」,這裡把它跟「停止」明確分開,避免兩者被混為一談)
- 契約收緊(硬約定要走 ADR,軟約定改了跑測試)——那是一次性的工作量,做完就繼續,不是理由停下整個迴圈
- 發現缺陷——開工單修,不是停下來等人拍板要不要修(除非缺陷本身牽涉硬約定或範圍,那走 §1 的權責表)
- 模板升版——`git diff template/v<採用版>..v<新版> -- template/` 看完決定要不要跟,跟不跟都不是停止理由
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

## 4b. 平台操作備忘(Orca,實際踩過的)

- `worker-start --worktree new-top-level` **一定要帶 `--name`**,不帶會 `invalid_argument`
- `worker-start` 只用在一個 worktree 的**第一輪**。同一 worktree 的第二、三輪(debug / 再審):
  `terminal create` → `terminal send 'claude --dangerously-skip-permissions' --enter` → `terminal wait --for tui-idle` → `dispatch --inject`。
  少中間兩步會 `no recognized agent detected`;重用舊終端機常 `agent_unconfigured`。**永遠開新終端機**,交接靠 worktree 裡的 REVIEW.md(P-17)
- `check --wait` 可能回**已處理過的舊訊息**(`"replayed": true`),要 `--ack <deliveryId>` 再等下一則,不然空轉
- `check` 回來的訊息 `type` 是 `question`(帶 thread/msg id)時,對方在等 `reply`,不是等一則新訊息——**先 `reply --id <該訊息 id>` 再 `ack`**,順序不能顛倒(`ack` 之後那個 id 就抓不到了);`send` 送得到終端機但不會解除對方的阻塞,沒有任何錯誤訊息(P-45)
- **`send` 對已經死掉的終端機一樣回 `ok:true`**,發送端以為送到了,接收端什麼都沒收到(P-54,P-45 同族)——
  `send` 前先 `terminal show` 確認終端機還活著;收到 `terminal_handle_stale` → 開新終端機,從 REVIEW.md 重新交接;
  送出去後對方沒反應,先懷疑終端機死了,不是先當對方在忙。對照:`SendMessage` 對過期的 session 名會明確失敗
  並附提示,那才是好的失敗
- **找 worker 一律用 worktree 路徑尾段比對,永遠不用 title**(title 是 agent 自己會改的顯示文字;找不到會被誤判成死掉而重派,P-39);每個 worktree 兩個 terminal,挑 title 不是 `user@…` 開頭的
- `orca terminal send` 的旗標是 `--terminal <handle>`(不是 `--handle`),要加 `--enter` agent 才真的收到
- 工單寫進 `<worktree>/.orca-brief/TASK.md`(未追蹤,不混進 diff);批次改工單文字後 grep 舊字串應為 0 命中(P-40)
- 開 worktree 明確指定起點(`--base-branch main` 或 `git worktree add -b <branch> <path> main`),開完驗 `git merge-base --is-ancestor main <branch>`(P-18)

## 5. 每輪回報格式(給使用者看的,越短越好)

```
[autopilot 第 N 輪 · 今日花費 $x.xx / 1.00]
合併:{{NN}}/phase-N ✓
進行中:{{NN}}/phase-N(審核)
等老闆:I1 @manual 兩條(檔案路徑)
決定了(ADR):NNN … — 待覆核 0
卡住:無
```

## 6. 不做的事

- 不 push(技術顧問推)
- 不改 `CLAUDE.md`、`contracts/` 硬約定、`prompts/`(改 prompt 要 golden run,那是 12 的流程)
- 不在根目錄 checkout 別的分支
- 不因為「等老闆」而停下其他能做的事;也不因為想推進而繞過「IN 通過」的 gate

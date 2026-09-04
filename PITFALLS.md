# 踩坑紀錄

範式實際跑過才知道的坑。**編號只增不刪**,每條寫:症狀、為什麼、範式怎麼防、來源。
任一個使用這套範式的專案踩到新的坑,就補一條並同步修 template 對應檔案(規則:找到共同錯誤就一起改)。
判斷標準:**換一個專案還會踩到**才記;專案專屬的 bug 不記。

| # | 症狀 | 為什麼 | 範式怎麼防 | 來源 |
|---|---|---|---|---|
| P-01 | 平行 worktree 合併時 `package.json` / lock / `tsconfig` / 共用步驟檔互相衝突 | 分叉前沒定共用檔,每個 worker 各自加依賴與 workspace | 分叉前先做 scaffold commit;共用檔只有協調者改(`docs/03` 角色段、README 步驟 4) | 專案 A,Wave 0 |
| P-02 | 合併後 cucumber 報 duplicate step definition | 同一句 gherkin 在兩個資料夾出現,兩個 worker 各自定義 | 分叉前掃所有 feature 找重複句,只在 `common.steps.ts` 定義一次;只用在 `@manual` 的句子不定義;**合併門檻加 `npm run accept:dry` 看 0 ambiguous** + `check:steps`(每句**恰好一個定義**,不看在不在 common——後者是代理指標,兩個方向都會錯) | 專案 A,Wave 0 |
| P-03 | 十一個 agent 對「十個 phase」「契約 1.0.0」各自解讀 | 文件漂移:同一個事實寫在多處 | 狀態只有一個來源(`FEATURE.md` phase 表),其他地方只引用 | 專案 A,Wave 0 |
| P-04 | 測著死代碼的綠燈、測試把 git 追蹤的基準檔刪掉、瀏覽器崩潰沒被任何測試抓到 | 實作者只測自己寫的東西,不測規格要的 | 開發 agent 不碰測試;審核 agent 負責所有測試,含檔案級變異分數、真實呼叫路徑交叉比對、UI 親自起 dev server(`docs/03` 審核清單) | 專案 A,Wave 0 審核 |
| P-05 | 「WIP ≤ 2」的建議跟「全平行」互相矛盾,agent 不知道聽哪個 | 規則沒有標明例外 | 打破建議時記 ADR,不默默做(`docs/02` ADR-014 類) | 專案 A,Wave 0 |
| P-06 | 工具鏈版本打架(測試 runner 與 UI 建置工具要的底層版本不同) | 分叉後各 worktree 各自解,lock 分岔 | 分叉前在 root 一次裝齊、commit lock,worktree 只跑 `npm ci` | 專案 A,scaffold |
| P-07 | `features/_template/` 的 feature 被 cucumber 掃到,永遠 3 個 undefined | paths glob 太寬 | 樣板檔命名 `phase-1.feature.template`,複製後改名;**`cucumber.js` 的 paths 陣列不支援 `!` 負向 glob**(會原樣回顯但不生效,只有正向 glob 相加) | 專案 A,Wave 0 |
| P-08 | 所有 step 突然全部 undefined,看起來像「還沒實作」 | cucumber 11 的設定檔 `export default` 本身就是 default profile,再包一層 `default: {…}` 會被安靜忽略 | `cucumber.js` 頂層直接寫設定;額外 profile 用具名 export(見檔內註解) | 專案 A,02 worker 抓到 |
| P-09 | `cucumber-js <某個 feature 路徑>` 跑出全 repo 的場景 | cucumber 11 把命令列位置路徑與設定檔 paths **合併**,不是覆蓋 | 一律用 `npm run accept -- --tags "@<name> and @phase-<N>"` 選場景(走 npm script 才帶 loader,裸跑 `cucumber-js` 會 ERR_UNKNOWN_FILE_EXTENSION);skill 與 `standalone.json` 都不用路徑形式 | 專案 B(AI_KM)發現,專案 A 驗證 |
| P-10 | standalone 指令在步驟裡跑會假紅,手動跑卻正常 | 子程序繼承 cucumber 的 `NODE_OPTIONS=--import=tsx`,在別的 cwd 解不到 tsx | `_world.ts` 起子程序前拿掉 `NODE_OPTIONS`(`withoutNodeOptions`) | 專案 B 發現 |
| P-11 | 審核 agent 與開發 agent 同時在同一 worktree 工作,撞到未 commit 變更與 git index | 同一份 working tree 被兩個進程操作,跟檔案是否重疊無關 | 循序:審核先寫測試 commit → 開發寫實作 commit → 審核回來重跑;同一 worktree 任一時刻只有一個 agent | 專案 A,協調者 |
| P-14 | 用 `cat > <編號檔>` 建新的編號檔(工單、ADR、phase)時覆蓋了既有的檔 | 只看 `ls \| tail -1` 就假設中間號碼是空的;shell 重導向不會問 | 建檔前 `test -e` 拒絕覆寫;或編號一律由腳本發(掃現有最大號 +1 並原子建檔);ADR / feature 編號由協調者統一發 | 專案 C 調度者,已還原零損失 |
| P-15 | 審核者宣稱「檢查跑過、通過」,其實檢查根本沒成功 | 檢查指令的輸出被 `grep`/`tail` 過濾後是**空的**,審核者把「沒輸出」當成「沒問題」;實際是 parse error 被濾掉 | 檢查指令的判定只看**退出碼**與**一行明確的成功訊息**(例如 `N scenarios … passed`);過濾後空輸出一律視為失敗;宣稱通過前把那一行貼進報告 | 專案 A,技術顧問自己踩的 |
| P-16 | 規格檔(.feature)尾巴多了一行 `</content>` 之類的標記,整個 runner 對所有 feature 掛掉 | 寫檔工具把包裝標記一起寫進檔案;gherkin parser 遇到就全停,不是只停那個檔 | 改完任何 `.feature` 跑一次 `npm run accept -- --dry-run` 看 Parse error;審核清單加這條;`git diff` 看檔尾 | 專案 A,協調者的寫檔工具 |
| P-17 | 「同一個審核 session 反覆測到全過」做不到:上一輪結束後 terminal 變成不可接續,重接失敗,只能開新 session,上一輪抓到的東西丟了 | agent 平台(Orca 等)在一輪 dispatch 完成後回收 agent 狀態;session 記憶不是可靠的交接媒介 | 審核狀態寫檔不寫腦:worktree 裡的 `REVIEW.md` 記每輪發現、退回理由、下一輪要重看的清單;新 session 開場先讀它。同型:任何「靠 agent 記得」的流程都要換成「靠檔案」 | 專案 A,協調者連續兩個 phase 遇到 |
| P-18 | 新開的 worktree 分支從**舊的** main commit 分出,worker 一開工就少了別人剛合併的東西,合併時衝突或重做 | 開 worktree 的工具用它記住的 main,不是現在的 main;或 `git worktree add` 沒指定起點 | 開 worktree 一律明確指定起點:`git worktree add -b <branch> <path> main`,開完立刻 `git merge-base --is-ancestor main <branch>` 驗證;派工說明第一步是「確認自己的分支包含 main 最新 commit」 | 專案 A,協調者連續兩次 |

## 另一類:agent 對規則來源的信任(失敗是靜默的,不會報錯)

| # | 症狀 | 為什麼 | 範式怎麼防 | 來源 |
|---|---|---|---|---|
| P-19 | 審核者在 main 跑完整檢查,結果像「合併把東西弄掉了」(測試數暴跌、舊噪音回來),差點退回一個好的合併 | shell 的 cwd 從上一個指令**殘留在另一個 worktree**(審核者剛在模板 worktree 改檔),檢查跑在錯的 tree;`git log origin/main..main` 這類指令在任何 worktree 都給同樣答案,更難察覺 | 每次檢查的第一行固定是 `cd <repo root> && pwd && git branch --show-current`,報告附上這兩行;所有檢查腳本用 `import.meta.dirname` / `__file__` 定位根目錄而不是 cwd;「結果突然變差」先懷疑 cwd 再懷疑合併 | 專案 A,技術顧問自己踩的 |
| P-20 | 整合點需要的 phase 全部 `done`,`@e2e` 卻紅:主流程還在呼叫 phase-1 的舊路徑、CLI 入口還寫死「只支援 --fake」、stub 沒換成真模組 | 「phase done」只保證模組自己對;把模組**接起來**是另一件工作,沒人被派到就沒人做 | 整合點 gate 滿足時**第一件事是開「整合工作」工單**:內容 = roadmap 該 IN 段的「整合工作」欄 + 各 FEATURE.md「Wave 0 的重複」表(每個 stub 一行:換成誰、加哪條 allow 邊);e2e 關鍵路徑的接線先做、stub 替換獨立 commit;`/integrate` 的重複清除檢查是最後防線,不是第一道 | 專案 A,I1 |
| P-21 | 組合層(把幾個模組串起來的那層)一跑,某條正常路徑直接 throw;被串的模組各自 100% 變異、場景全綠 | 兩個對稱的介面不對稱:失敗的 ctx 是陣列(一次記 N 筆)、成功的 ctx 是單值,契約明明說那個階段有 N 種題型;沒有任何一層的場景寫到「N 筆都成功」 | 審核清單加「介面對稱檢查」:契約說某狀態有 N 個輸入,每個 ctx / 事件都要裝得下 N 筆;成功與失敗的場景要成對(有「答錯記兩筆」就要有「答對記兩筆」);組合層的 phase-1 要把被串模組的**每個狀態 × 每種結果**走一遍,那是它存在的目的 | 專案 A,11-review-cli 審核抓到 |
| P-22 | 第一次真的呼叫模型就壞:輸出在固定 token 上限被切斷,JSON 解析失敗(運氣好);運氣差是切在內容中間,得到一張少字的卡而測試全綠 | 所有 fake / 罐頭回應都不算 token,寫死的輸出上限、逾時、重試次數在 `@e2e @llm` 之前**等於沒測過**;adapter 把截斷的半截當正常回傳 | (1) adapter 看到 `finish_reason=length` / `stop_reason=max_tokens` 一律 **throw**,不回傳 text,log 記 `truncated:true`;(2) 輸出上限按任務給一張表,不用全域一個數;輸出跟輸入規模成比例的任務(依賴圖、批次生成)由**呼叫端**依規模算上限傳進去,表格只當 floor;(3) `@e2e @llm` 是 DoI 核心、不能被測試代替——這條就是它存在的理由;(4) 每個 CLI 入口都載入 `.env`,不是只有一個 | 專案 A,I1 第一次真呼叫 |
| P-23 | 批次生成 30 筆只出 29 筆,沒有任何錯誤訊息,事後數檔案才發現少一個 | 失敗被 `catch` 進記憶體裡的陣列,沒寫 log、CLI 沒印、退出碼是 0;規格寫「failure is reported」但沒定義 reported 是什麼 | 「reported」定義成三件事:log 一筆(帶 id 與原因全文)+ 指令印出失敗清單 + 退出碼非 0;@e2e 斷言「N 進 N 出」(every card has a question file);非確定性失敗(截斷、逾時、5xx)重試一次,確定性失敗(parse)不重試 | 專案 A,I1 第三次真呼叫 |
| P-24 | 「修一次」的修復邏輯遇到多個問題只修掉一個,剩下的照樣寫進磁碟(依賴圖丟了一條邊,另一個環還在,圖寫了、順序檔沒寫) | 規格寫「offending edge is dropped」(單數),實作照字面做一次;而且兩個互相依賴的輸出檔分開寫 | 本地純運算的修復要**迴圈到條件成立或達上限**,每一步記事件、丟哪個要確定性;互相依賴的輸出檔**同進退**(都寫或都不寫);規格裡的單數名詞在審核時要問「多個怎麼辦」 | 專案 A,I1 第三次真呼叫 |
| P-25 | 「原子寫入」實作照契約三步做(tmp → fsync → rename),審核才發現失敗會留 `.tmp` 殘檔、rename 後沒 fsync 目錄(斷電可能丟掉整個 rename);而且「壞掉的輸入檔」的錯誤跟「業務失敗」的錯誤混在一起 | 契約只寫了成功路徑;寫入保證的**失敗路徑**與**目錄 fsync** 沒人寫,實作就不做 | 寫入保證的契約要寫四步:tmp → fsync(fd) → rename → fsync(dir),任一步失敗清 tmp 再丟原錯(目錄 fsync 只吞 EINVAL);讀壞檔要有自己的錯誤型別、不覆寫不刪、退出碼非 0;審核清單加「失敗路徑有沒有測試:mock rename 失敗、呼叫順序斷言」 | 專案 A,ADR-038 審核 |
| P-26 | 新邏輯被放進另一個檔名,「刻意不併進嚴格級的那個檔」,於是只受標準級門檻 | FEATURE.md 的變異門檻寫的是**檔名**(`routing.ts` 嚴格 95%),worker 照字面理解;門檻的理由(「決定成本與離線行為」)沒被當成判準 | 門檻按**責任**訂不按檔名:FEATURE.md 寫「所有做 X 決定的程式碼」並列例子;審核清單加「新檔案做的是不是嚴格級的事」;把邏輯搬出嚴格檔要在 REVIEW.md 說理由;**開工單的人不預先指定門檻規避策略**(協調者自己在工單寫了「建議另開檔案避開嚴格門檻」,等於把錯誤前提餵給 agent),門檻由責任決定、審核輪驗 | 專案 A,03/phase-4 測試輪 |
| P-27 | 開發 agent 提報一個「已知限制,留給上層判斷」(某平台會丟某錯誤碼),協調者拿去請裁決,差點據此改契約;審核查證後診斷是錯的(錯誤碼、失敗的步驟都不對) | 「留給上層判斷」聽起來負責,但內容是憑印象寫的;沒人要求標註是查證過還是推測 | 所有提報的限制、錯誤碼、平台行為一律標【驗】(附怎麼驗的)或【推】;沒標視為【推】;審核輪對【推】必查證;裁決者對沒法在現有環境驗證的平台問題選「延到有環境時處理,先把正確診斷寫進 ADR」,不憑推測寫程式 | 專案 A,ADR-040 審核 |
| P-28 | 反向驗證的「紅」來自一支放在暫存目錄、不在 repo 裡的腳本;commit body 寫「改壞→RED→還原→GREEN」字面全符合,審核者接受;實際上 repo 裡沒有任何檢查會因為那個檔案消失而紅 | 規則「證據是炸掉那條斷言的失敗訊息」有個沒寫出來的前提:那條檢查必須 committed、別人跑得到。程式碼工單它自動成立(vitest / CI),文件工單不成立;而且一支「找不到東西可掃」的 scanner 與「全部正常」exit code 一模一樣 | (1) 反向驗證的紅必須來自 committed 且掛進 `test` / CI 的檢查,審核問一句「路徑是什麼?在 `git ls-files` 裡嗎?」;(2) 文件工單要有真的守門(markdown link checker 掛進 `test`;反引號提檔名不是連結);(3) 掃描器掃到 0 個目標就 FAIL,訊息寫「這不是很乾淨,是掃描器壞了」——空檢查永遠綠,跟真綠無法區分 | 專案 B(AI_KM)協調者,自己審核漏掉後回報 |
| P-29 | 開發 agent 在工單範圍內做的「自主設計判斷」(一個備援 clause、一個 `hasOwn` 守衛、一個檔案切分)沒有任何測試保護——手動拿掉,全套測試沒有一個變紅;同型連續三次 | 測試 agent 照 gherkin 寫紅,gherkin 沒寫到的判斷是開發 agent 自己加的,自然沒人替它寫測試;審核只看場景有沒有綠 | 審核清單固定項:**開發 agent 這一輪的每個自主判斷(REVIEW.md 列出)逐一手動破壞一次,確認至少一個測試會紅,沒有的補上再過**;開發 agent 交付時必須把自主判斷列成清單(不列的視為沒審);同型第三次即升類 | 專案 A,03/phase-4 審核(第三次) |
| P-30 | brownfield 切換停了三次:協調者對顧問轉述的每句「使用者說」都拒絕 | 新 CLAUDE.md / 決策權表在分支上、不在 main,協調者讀到的仍是舊規則;peer 轉述不算授權(這個拒絕是對的) | 第一天就把決策權表寫進 main 的 CLAUDE.md、使用者親口批;同時掃描同一檔內新舊段落的矛盾 | 專案 B |
| P-31 | 切換後 autopilot 在零內容佔位目錄、指向不存在路徑的規則、mock 墳場上「做完」東西 | brownfield 的殘骸不在新範式清單裡,但也沒人清 | 切換時一次清(刪佔位、grandfather 清單、失效規則);清之前讀內容,不用「不在清單裡」當刪除判準 | 專案 B、C |
| P-32 | 某個資料夾的場景**一個都沒跑**,驗收指令退出碼 0、輸出跟全過一樣;一個 tag 打錯字(`@retrieval` → `@retrievel`)整個資料夾消失而 CI 全綠 | tag 過濾器選到 0 個場景時 runner 視為成功;沒有任何東西要求「每個資料夾至少跑到一個」 | `check-phase-coverage`:對每個存在的 `phase-N.feature` 用它自己的 tag 單獨 dry-run,要求 N ≥ 1,掃到 0 個資料夾也紅;掛進完整檢查;反向驗證就是改錯一個 tag 字母 | 專案 B 協調者 |
| P-33 | 守門對著**代理指標**(「句子在不在 common.steps.ts」)而不是不變量(「恰好一個定義」):三個定義因其中一個在 common 而假綠,能力句被整合檔重用而假紅 | 寫守門時拿了一個好記的規則當斷言,沒問「runner 真正會炸的條件是什麼」;同型第三次(閉包檔數上限、恰好 N 個型別錯誤、這次) | 守門的斷言對著**不變量**寫:先寫下「工具自己會炸的條件」,再讓守門只檢查那個;規則性的偏好(該住哪個檔)寫成失敗訊息裡的建議,不當斷言 | 專案 B 協調者 |
| P-34 | 三個審核輪同時跑變異測試,互相把對方 OOM 掉(exit 137 / 144);agent 各自重試、降並行、誤殺自己的 shell,三個審核各花 40–84 分鐘、合計 $25;更危險的是 agent 若把殘缺結果當分數回報就是靜默假驗收 | 派工規則只管 worktree **數量**上限,不管每個在做什麼;變異測試是專案裡唯一吃重的工作 | (1) 派工層:同時處於審核輪的 worktree ≤ 1;(2) 執行層:`scripts/mutate.ts` 包一層跨 worktree 的檔案鎖(放 git common-dir 旁,殘鎖靠 pid 與時限清);(3) agent 規則:退出碼 137 / 144 一律環境問題重跑,絕不當分數;重跑仍失敗寫「變異未完成」並停 | 專案 A 協調者 |
| P-12 | 一個 session 遵守著一份「磁碟上、分支上都不存在」的 `CLAUDE.md` / 規則檔;它的 subagent 把那份規則當既成事實推理 | harness 在 session 啟動時從**工作樹**讀 `CLAUDE.md` 與 `.claude/rules/*`,不是從分支讀。共用 checkout 被另一個 session 暫時切到別的分支,這個 session 剛好在那一刻啟動;之後切回去,**已載入的 context 不會回退** | 1. 一個 session 一個 worktree,不共用 checkout(唯一的結構性解);共用的根 checkout 永遠停在 main,任何人不在上面 `git checkout` 別的分支。2. 非得共用時,切分支前先讓對方 session 結束。3. session 自保:一份會改變整個工作方式的規則檔,先 `git show <自己的分支>:CLAUDE.md` 驗證它在自己的分支上存在,再相信 system prompt 的呈現 | 專案 B 協調者(ai-km-32) |
| P-13 | `@manual` 場景人親手確認了,功能還是壞的 | 人看到的畫面走的是**退化路徑**(fallback 佔位值、兩邊都退化成同一預設值所以相等),確認本身是真的,被確認的東西是假的 | 測試與 harness 記錄「每個測試 / 每次執行走了哪條分支」(退化見證器);`@manual` 確認前先看見證器報告,退化路徑上的綠燈與確認都不算 | 專案 C(nightmare-assault),一天抓到七個 |

## 來自其他專案、建議收進範式的做法(還沒在專案 A 驗證)

| 做法 | 內容 | 來源 |
|---|---|---|
| 同型第三次即升類 | 同一型的問題第三次出現,不再當個案修,升級成範式 / 結構問題處理(記 ADR 或改 gate) | 專案 C |
| 收斂指標不用 todo 數 | 用「假玩家 / e2e 走到第幾階」(只升)與「見證器未標記的測試數」(只降)當進度,todo 數會被新單稀釋 | 專案 C |
| 新單准入只有三種 | 實玩抓到的 bug、接線孤兒(寫了沒接)、解 blocked 的前置;其他一律不收(規格凍結) | 專案 C |
| 回填對照表 | FEATURE.md 記「場景 → 測試檔:測試名」,比只靠 runner 綁定多一層可讀追溯 | 專案 B(AI_KM) |

## 還沒驗證的區域

整合層(I1 之後)的 DoI 三項、`@regression`、Wave 0 重複的移除,兩個專案都還沒實戰。先到的補這裡。

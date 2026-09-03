# 踩坑紀錄

範式實際跑過才知道的坑。**編號只增不刪**,每條寫:症狀、為什麼、範式怎麼防、來源。
任一個使用這套範式的專案踩到新的坑,就補一條並同步修 template 對應檔案(規則:找到共同錯誤就一起改)。
判斷標準:**換一個專案還會踩到**才記;專案專屬的 bug 不記。

| # | 症狀 | 為什麼 | 範式怎麼防 | 來源 |
|---|---|---|---|---|
| P-01 | 平行 worktree 合併時 `package.json` / lock / `tsconfig` / 共用步驟檔互相衝突 | 分叉前沒定共用檔,每個 worker 各自加依賴與 workspace | 分叉前先做 scaffold commit;共用檔只有協調者改(`docs/03` 角色段、README 步驟 4) | 專案 A,Wave 0 |
| P-02 | 合併後 cucumber 報 duplicate step definition | 同一句 gherkin 在兩個資料夾出現,兩個 worker 各自定義 | 分叉前掃所有 feature 找重複句,只在 `common.steps.ts` 定義一次;只用在 `@manual` 的句子不定義 | 專案 A,Wave 0 |
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

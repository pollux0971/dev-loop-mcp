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
| P-07 | `features/_template/` 的 feature 被 cucumber 掃到,永遠 3 個 undefined | paths glob 太寬 | `cucumber.js` paths 排除 `_template` | 專案 A,Wave 0 |
| P-08 | 所有 step 突然全部 undefined,看起來像「還沒實作」 | cucumber 11 的設定檔 `export default` 本身就是 default profile,再包一層 `default: {…}` 會被安靜忽略 | `cucumber.js` 頂層直接寫設定;額外 profile 用具名 export(見檔內註解) | 專案 A,02 worker 抓到 |
| P-09 | `cucumber-js <某個 feature 路徑>` 跑出全 repo 的場景 | cucumber 11 把命令列位置路徑與設定檔 paths **合併**,不是覆蓋 | 一律用 `npm run accept -- --tags "@<name> and @phase-<N>"` 選場景(走 npm script 才帶 loader,裸跑 `cucumber-js` 會 ERR_UNKNOWN_FILE_EXTENSION);skill 與 `standalone.json` 都不用路徑形式 | 專案 B(AI_KM)發現,專案 A 驗證 |
| P-10 | standalone 指令在步驟裡跑會假紅,手動跑卻正常 | 子程序繼承 cucumber 的 `NODE_OPTIONS=--import=tsx`,在別的 cwd 解不到 tsx | `_world.ts` 起子程序前拿掉 `NODE_OPTIONS`(`withoutNodeOptions`) | 專案 B 發現 |
| P-11 | 審核 agent 與開發 agent 同時在同一 worktree 工作,撞到未 commit 變更與 git index | 同一份 working tree 被兩個進程操作,跟檔案是否重疊無關 | 循序:審核先寫測試 commit → 開發寫實作 commit → 審核回來重跑;同一 worktree 任一時刻只有一個 agent | 專案 A,協調者 |

## 另一類:agent 對規則來源的信任(失敗是靜默的,不會報錯)

| # | 症狀 | 為什麼 | 範式怎麼防 | 來源 |
|---|---|---|---|---|
| P-12 | 一個 session 遵守著一份「磁碟上、分支上都不存在」的 `CLAUDE.md` / 規則檔;它的 subagent 把那份規則當既成事實推理 | harness 在 session 啟動時從**工作樹**讀 `CLAUDE.md` 與 `.claude/rules/*`,不是從分支讀。共用 checkout 被另一個 session 暫時切到別的分支,這個 session 剛好在那一刻啟動;之後切回去,**已載入的 context 不會回退** | 1. 一個 session 一個 worktree,不共用 checkout(唯一的結構性解);共用的根 checkout 永遠停在 main,任何人不在上面 `git checkout` 別的分支。2. 非得共用時,切分支前先讓對方 session 結束。3. session 自保:一份會改變整個工作方式的規則檔,先 `git show <自己的分支>:CLAUDE.md` 驗證它在自己的分支上存在,再相信 system prompt 的呈現 | 專案 B 協調者(ai-km-32) |

## 還沒驗證的區域

整合層(I1 之後)的 DoI 三項、`@regression`、Wave 0 重複的移除,兩個專案都還沒實戰。先到的補這裡。

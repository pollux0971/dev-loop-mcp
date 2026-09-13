# CHANGELOG

版本規則(semver):PITFALLS / docs / 措辭改動升 **patch**;新增或改變檔案結構、腳本、CLAUDE.md 固定段落升 **minor**;改硬規則或落地步驟升 **major**。
採用模板的專案在自己的 `CLAUDE.md` 記「採用模板 vX.Y.Z」;升版時用
`git diff <採用版 tag>..<新版 tag> -- template/` 決定要不要跟。每個版本打 tag `template/vX.Y.Z`。

## 1.7.2 — 2026-09-13

**patch,資料遺失 bug。⚠️ 不要用 `npx-v1.7.1`——請用 `npx github:pollux0971/dev-paradigm#npx-v1.7.2 init .`。**
(`npx-v1.7.1` 已經發布出去,發布版刻意不覆蓋,所以這裡明寫。只用過 sync 升版的 consumer 不受影響。)

- **init 會蓋掉使用者改過的檔,還印成功(P-98)。** 【驗】`npx-v1.7.1` 從 GitHub 實測:init → 在 `CLAUDE.md`
  加一行 → 再 init → 「✓ init 完成」、exit 0,那一行被模板原文蓋掉。根因是衝突掃描對「在安裝紀錄裡的檔」
  整個跳過,而讀安裝紀錄時把每個檔的 `sha256` 丟掉了,從來沒拿來比。
  現在:內容已是這一版 → 不動;跟安裝當時一樣(使用者沒碰)→ 可更新;都不是 → **衝突、零寫入**,訊息指名是哪個檔。
- **重跑 init 現在是真的 no-op**:內容相同的檔不重寫(原本每個檔都被 rename 一次,修改時間全變)。
- 黑箱測試新增第 5 個 gate `reinstall-preserves-user-edits`(沒改過重跑 → 零變化;改過再 init → 衝突、使用者那行還在)。
  反向驗證:把保護退回舊行為 → `init overwrote a file the user modified after install (data loss)`。
- **為什麼 1.7.1 的四個 gate 全綠還是漏掉**:conflict gate 只測「全新資料夾裡已有的同名檔」,
  沒測「init 自己裝的檔後來被使用者改」——而那是最常發生的一條路(步驟 1 就叫人去填 `CLAUDE.md`)。
  這個 bug 是發布後照 README 在真實安裝上逐條核對時,順手試「改一個檔再 init」才撞到的。
- `release-npx-branch.sh` 小修:演練不碰任何 ref(第一版演練會留本機 tag,讓「先演練再推」的流程本身卡住);
  「tag 已存在」的檢查移到建立發布 commit 之前。

## 1.7.1 — 2026-09-13

**patch。新使用者照 README 跑不完——使用者要求的 UX 檢查找到的,全部是 bug。**
**安裝方式改變**(使用者裁決:私有 GitHub、不發 npm):

```bash
npx github:pollux0971/dev-paradigm#npx-v1.7.1 init .
```

已採用的 consumer 升版動作:重 sync 一次(守門腳本沒有行為變更)。

**UX 檢查怎麼做的**:空資料夾、只看 README、照字面做,從步驟 0 跑到步驟 4,每個卡點記原始輸出。

- **README 步驟 0 的指令是壞的**:`cp -r template/. …` → `No such file or directory`。那是 repo 從
  `llm_learning-cards/template/` 搬家前的路徑。改寫成 npx(與 clone 後跑同一支 CLI 的備案),
  並明說**不要 `cp -r` 整個模板 repo**(會把模板自己的協調紀錄、收件匣、發布殼帶進去)。
- **README 完全沒提 `npx init`**,而且套件是 private,`npx pollux-dev-paradigm init` → 404。
- **我推薦的「GitHub git URL」照字面做也不行**:【驗】`npx github:pollux0971/dev-paradigm#v1.7.0 init .` →
  `could not determine executable to run`。npm 從 git 安裝讀的是 **repo 根目錄**的 package.json,而那份是
  給 consumer 的樣板(沒有 `bin`)。新增 `package/release-npx-branch.sh`:把 `npm pack` 產物放進孤立分支
  `npx-release` 的根目錄、打 `npx-v<版本>` tag;預設只演練,`--push` 才推送。
  【驗】先用本機 `git+file://` 模擬整條流程成功,才寫成腳本。
- **新專案的收件匣塞了模板自己的 12 件待裁事項**:npx 出貨的是上游那份 `DECISIONS_NEEDED.md`。
  改出貨空白骨架 `package/skeleton/DECISIONS_NEEDED.md`(manifest 新增選用 `dest` 欄位指定落地路徑)。
  黑箱測試加斷言「新專案的收件匣待批示必須是空的」;反向驗證:manifest 改回上游那份 → 紅並說明原因。
- **README 與 CHECKLIST 教的驗證指令永遠不可能回傳空**:`grep -rn '{{' .`——`CHECKLIST.md` 自己就有幾十行 `{{`。
  改成排除 5 份「在文字裡介紹 placeholder」的文件,並逐檔確認剩下的都是真正要填的地方。
- **README 叫 consumer 把自己的設定鍵加進 `KNOWN_GATES_CONFIG_KEYS`**——正是讓 consumer 的 worker 手改 `_root.ts`
  的那句話,跟 1.6.6(P-94)直接矛盾。改成「自帶設定檔」,只有模板本身新增守門才改那份清單。
- **README 升版指令**用的是舊 tag 名 `template/v…` 與不存在的 `template/` 路徑,已修。
- **`init` 結束訊息**叫人「依 README 五步驟繼續」,而步驟 0 就是那個壞掉又多餘的 `cp`;改成「從步驟 1 繼續」。
- **`--help` 印成 `✗` 錯誤、退出碼 1**;改成正常印用法、退出碼 0,並列出私有 GitHub 的安裝指令。
- **P-97 在修 UX 時當場發作**:舊 `package/dist/` 快照讓 `init` 少落地一個檔、還印成功。
  manifest 條目展開成 0 個檔改為大聲失敗(1.7.0 當時登記成「刻意不修、風險已被接住」,第二天就被推翻,見 P-97)。
- **更正 UX 報告的一項**:我原本回報「CHECKLIST 漏列 24 個 placeholder」——**錯的**。CHECKLIST 用範圍寫法
  (雙大括號包住 `ENV_VAR_1/2/3`、`CRITICAL_LOGIC_1..5` 這種寫法),我逐字比對所以對不上(P-89,這次是協調者自己)。
  〔這一句原本直接寫出帶雙大括號的範例,被 npx 黑箱測試的「placeholder 零殘留」守門擋下——CHANGELOG 會出貨給 consumer,
  文字裡的範例長得跟沒填的欄位一模一樣。同一天第二次在自己寫的字上踩到 P-89。〕
  展開範圍後重算,**真正漏列的只有 `{{FEATURE_NAME}}` 一個**,已補;CHECKLIST 也補一句說明範圍寫法。
- 出貨覆蓋名冊(1.7.0)**第一次實戰就精準抓到兩件**:上游 `DECISIONS_NEEDED.md` 不再出貨(未分類)、
  `package/skeleton/` 開始出貨(跟「`package/` 整包不出貨」的宣告打架)。分類已更新。

**沒驗證到的(誠實列出)**:填完所有 placeholder 之後步驟 2~5 能不能全綠——那需要一個真實專案的內容,沒有編造一個去測。

## 1.7.0 — 2026-09-13

**minor。** 使用者批次授權協調者自行裁決四件「純內部、可回滾、不改 consumer 介面」的提案
(`DECISIONS_NEEDED.md` 已批示 13·18·21·22)。升版動作:重 sync 一次(`_root.ts`、`check-all.ts`、
`check-gherkin-dup.ts`、`check-step-dup.ts` 有變更)。**consumer 端唯一可見的變化是 `check:all` 最後一行多了 `ran=`**,
加在行尾,既有用 `toContain` 比對前綴的斷言不受影響。

- **#18 `check-all` 摘要行加 `ran=`**:`gate=all result=FAIL scanned=19 ran=3` = `--fail-fast` 在第 3 步中止。
  原本 `check-all.ts:32` 寫的是一條叮嚀(「`scanned` 要配 `result` 一起看」)——**一句不需要存在的規則,
  是最不會腐爛的規則**,有了 `ran`,歧義本身消失。
  施工時發現標記散在 **7 個地方各自手寫**(check-all 自己 5 處 + `_root.ts` 共用的 `requireRootDir`、`failConfig` 2 處)。
  只改主要那行的話,`ran=` 會**時有時無**,解析它的人會在設定檔壞掉那一次拿不到值——那正是 P-93。
  所以 `_root.ts` 加 `setMarkerSuffix()`:需要尾欄的 gate 啟動時自己登記,共用層不特判 gate 名稱,沒登記的 gate 標記完全不變。
  【驗】新增 4 條測試涵蓋每一種結束狀態(全過 / --continue / 設定檔 JSON 壞掉 / --root 不存在);
  反向驗證:拿掉登記 → 剛好走共用路徑的那 2 條紅。
- **#13 共用排除層名冊**(`scripts/skip-dirs-roster.test.ts`):每支碰到排除邏輯的掃描器,必須**呼叫**
  `resolveSkipDirs()` 或附理由豁免。**第一次跑就抓到兩個真 bug**:`check-gherkin-dup.ts`、`check-step-dup.ts`
  各自重寫了合併邏輯,1.6.3 的 glob 硬錯對它們從沒生效——而 1.6.x 三次手動盤點都把它們標成合規(見 P-97)。已修。
- **#21 出貨覆蓋名冊**(`scripts/shipping-coverage.test.ts`):每個 tracked 檔都要能回答「它靠什麼到 consumer 手上」——
  真的出貨了 / 刻意不出貨(附理由)/ 已知缺口(**必須指向一件還在待批示的裁決**,裁決一離開待批示就紅)。
  出貨集合**不重寫展開邏輯**,而是複製 tracked 檔後**真的跑 `npm pack` 讀 tarball、真的跑 `sync-gates.sh` 看落地**。
  【驗】量到:tracked 110、npx 出貨 85、sync 出貨 31;兩個管道都沒送的 25 個,其中 2 個是真缺口
  (`.orca-brief/TASK.md.template`、`scripts/py/.gitignore`),登記指向 #23。
  反向驗證:在 `.orca-brief/` 底下加一個新檔 → 以未分類紅出來;把缺口指向已批示的裁決 → 以「欠帳不能在裁決之後繼續掛著」紅出來。
- **#22 工單樣板改預設**(`.orca-brief/TASK.md.template`):加「工單會用到的數字(一律當場取數)」與
  「把別人的東西拿進來之前,先預測會動到哪幾個檔」兩節,開頭說明為什麼是**改預設**而不是**加守門**
  (工單內容是 orca 的 task 物件,不在版控裡,所有守門結構上都看不到它)。
  施工時抓到自己一個 UX 陷阱:表格裡的指令為了 markdown 把 `|` 寫成 `\|`,**agent 讀的是原始檔,
  照抄會把 `\|` 當成字面參數,管線直接斷掉**——指令全部移出表格放進 code block,
  【驗】從原始檔照抄 (B)(C) 實跑得出 017、23。沒有新增 `{{PLACEHOLDER}}`(那兩個值在範式裡是固定的)。
- **沒做、另開 #23**:「sync 送不了非守門檔」(skill、樣板)。要讓 `.md` 帶 SOURCE 標頭得改兩個出貨管道共用的標頭契約,
  樣板搬家要改規則層引用——**兩者都超出這次授權**。
- 測試:`test:scripts` 13 檔 211 → **15 檔 247**,全綠;`sync-gates.test.sh` 全部通過。

## 1.6.10 — 2026-09-12

**patch。** 升版動作:重 sync 一次(只有 `sync-gates.test.sh` 與文件,守門腳本沒動)。

- **P-96 的修法在 1.6.9 留了一個漂移風險,1.6.10 關掉它。** 提報方更正:
  **`sync-gates.sh` 是 bash、`DEFAULT_SKIP_DIRS` 是 TypeScript 的 export,它沒辦法呼叫。**
  所以 1.6.9 是在 shell 裡**硬寫了第二份清單**——不是「接上共用層」,而是
  「**共用層跨不過語言邊界**」:兩份清單,將來會漂。
- **提報方把它改寫成一個可以被關閉的陳述**(而「應該用共用層」不能):
  「`sync-gates.sh` 的偵測排除清單與 `DEFAULT_SKIP_DIRS` 的差集不為空,而差集裡有 `.stryker-tmp`」。
  `sync-gates.test.sh` **步驟 11** 關閉它:TS 那份的每一項,bash 偵測那段都要排除到,**差集必須為空**。
  【驗】先紅後綠:拿掉 `.stryker-tmp` → `✗ 差集: .stryker-tmp`;放回去 → 綠。
- **通則:當共用層跨不過語言邊界時,替代品不是「記得兩邊都改」,是一個斷言兩邊相等的測試。**
- **P-96 補更根本的判準**:模板檔頭第 36 行**已經防過這一族的另一半**(排除「安裝目錄本身」,
  否則裝進去的 `mutate.py` 會讓偵測自我循環),**但它沒有排除「安裝目錄的複本」,而複本是自動產生的。**
  所以判準不是列目錄名(那是列實例),是:**偵測用的母體不該包含「某個別的東西的複本」**——
  沙箱、worktree、備份、`node_modules`。那四層在 consumer 那邊**每一層都被單獨處理過**,
  **而沒有人問過「它們疊起來會怎樣」。**

## 1.6.9 — 2026-09-12

**patch,bug 修復。跑過變異測試、或 repo 裡有任何凍結 worktree 的 consumer 都可能中。**
升版動作:重 sync 一次。

- **`sync-gates.sh` 的語言自動偵測不再踩進產物目錄(P-96)。** 【驗】consumer 實測:Python 偵測命中
  `.stryker-tmp/sandbox-XXXX/.claude/worktrees/agent-…/template/scripts/py/mutate.py`
  ——**變異沙箱 ▸ 臨時副本 ▸ 凍結 worktree ▸ repo 拆分前的舊模板副本,四層深**;
  而該 repo 版控裡**零個 Python 檔**。於是它裝了兩個沒人需要的 Python 檔。
  根因:偵測那一段**自己列了一份排除清單**(只有 `node_modules` 與 `.git`),沒用共用的
  `DEFAULT_SKIP_DIRS`——**P-91 的第四個實例,而這次的重複在 shell 裡不在守門裡**。
  【驗】修前印「找到 …mutate.py」,修後印「選集 ts(自動偵測:無 Python)」。
- **通則(P-96):自動偵測的母體跟掃描的母體是同一個問題,而偵測更危險**——
  掃描錯了會多報幾個假紅,**偵測錯了會改變裝什麼進去,而且裝完看起來一切正常**。
- P-96 與 P-95 是鏡像:P-95 **該送的沒送到**(落在 gitignored 的目錄);
  P-96 **不該送的送到了**(依據是 gitignored 目錄裡的東西)。
  **兩個都是「掃描的母體包含了不該包含的層」,只是方向相反。**

## 1.6.8 — 2026-09-12

**patch,只有文件。** 升版動作:重 sync 一次(守門腳本沒動)。

- **P-95 的避免方法原版寫得太窄,已修正。** 1.6.7 寫成「落點不能是 gitignored 的目錄」——
  **那只擋掉一種**。提報方更正了我引用的事實(`.orca-brief/` 是**他們**忽略、**我們**追蹤),
  而更正之後規則變得更硬:**共用的目錄名在不同 consumer 那邊可能有相反的語意,
  所以樣板的落點要用一個不會被誤解的專屬路徑,不要用任何已經在被兩邊各自使用的名字。**
  前者只擋「被忽略」;**後者擋掉「同名不同義」整類,而那類不會有任何錯誤訊息。**
- **P-95 補「同名不同義已經造成後果」**:consumer 的一個 worker 把 `.orca-brief/REVIEW.md`
  commit 進版控——**一個讀過上游慣例的 agent,會認為 `.orca-brief/` 是該進版控的地方**。
  **上游(1.6.7 修掉的那個)與 consumer 同時各自犯了一次同一個錯,原因是同一個名字。**
- **P-92 的「先問母體」補上可執行的版本**:提報方同一天踩三次,而且**三次的母體是不同維度**
  (不同 commit / 分支 vs 合併後 / 不同 repo)。**前兩次都認了,但沒有人去問「還有哪個維度」。**
  可執行版:**量完一個數字,在說它之前先問「我量的是哪一棵樹、哪一個時間點、哪一個分支」。三個維度,三十秒。**

## 1.6.7 — 2026-09-12

**patch。** 升版動作:重 sync 一次(只有文件與 `.gitignore` 變更,守門腳本沒動)。

- **模板自己把 `.orca-brief/REVIEW.md` 追蹤了 386 行,已 `git rm --cached` 並加進 `.gitignore`。**
  `PITFALLS.md` 的 P-17 與 P-78 兩處都明寫它是「gitignored,worktree 專屬」——
  **模板違反自己訂的規則,第六次**(前五次:P-83、P-84、P-93、P-94、`gates.config.json` 不能寫註解)。
  它是 npx 階段 C 合併時帶進來的。⚠️ **`.gitignore` 對已追蹤的檔無效**,所以這類錯誤不會自己消失。
- **新增 P-95:出貨的落點必須是 consumer 會追蹤的路徑。** 【驗】上游把 `.orca-brief/` 當**文件**、
  consumer 當**工作區**(整個目錄 gitignored)——**同一個目錄名,兩邊語意相反**。
  所以「把樣板加進 `sync` 複製集合」這個修法會在**出貨端看起來成功**(檔案出現、測試通過)、
  而**永遠不會進 consumer 的版控**。**落在 gitignored 的目錄等於沒出貨。**
  相關的出貨缺口(`.orca-brief/TASK.md.template`、`.claude/skills/` 都不在 `sync` 集合裡)
  在 `DECISIONS_NEEDED.md` #21,待裁決。

## 1.6.6 — 2026-09-12

**patch。** 升版動作:重 sync 一次(`_root.ts` 有變更)。

- **不認識的 `gates.config.json` 頂層鍵,錯誤訊息現在會指路(P-94)。** 原本只寫
  「打錯字?」——等於斷言「你只可能是打錯字」,把第二種情況(**我真的要加自己的 gate 設定**)
  排除在想像之外。【驗】consumer 的 worker 就因此去**手改模板的 `_root.ts`** 並留了一條 HOTFIX。
  現在訊息明說:**不要改模板的 `KNOWN_GATES_CONFIG_KEYS`**,讓那支 gate 自帶一份設定檔,
  並指出模板裡早就有的先例 `doc-rot.blacklist.json`。
- **`sync-gates.test.sh` 加步驟 10:假 consumer 試著擴充。** 步驟 1~9 驗的都是
  「裝得對不對」,**沒有一項驗「裝完之後我能不能加一支自己的東西」**。新案例:
  (a) 加自己的頂層鍵 → 必須紅,且訊息要指出正確的路與先例;
  (b) 照指路做(自帶設定檔)→ 既有 gate 照常綠。
- **通則(P-94):任何「假使用者」的測試,如果只驗『安裝/初始化』不驗『之後想多做一件事』,
  它驗的是你的出貨流程,不是使用者的處境。** 這也是 P-83/P-84/P-93 三次都由 consumer 發現的原因——
  模板的自測站在**出貨方**的位置,沒有一項站在**使用方**的位置。

## 1.6.5 — 2026-09-12

**patch,兩個 bug 修復。** 升版動作:重 sync 一次。

- **`sync-gates.sh --check` 的摘要行在有 HOTFIX 時不再說謊(P-93)。** 原本第 29 行印
  `⚠ … 有本地 HOTFIX`、第 61 行卻印 `✓ 守門內容自同步以來未被更動`,兩行直接矛盾。
  【驗】consumer 協調者用 `tail -8` 只看到 `✓`,據此下了「`check:gates` 沒有比對 `_root.ts`」
  的錯誤結論,還從那個結論反推了一個不存在的機制。現在改印
  `⚠ 守門內容有 N 處本地 HOTFIX(見上),其餘…`。
  **通則(P-93):任何「總結上面」的輸出,都要把上面每一種非乾淨狀態納入自己的判斷**——
  摘要行漏掉一種狀態,比沒有摘要行更糟,因為它讓人**停止往上看**。
- **`check-doc-links.ts` 改為委派共用的 `resolveSkipDirs()`(P-91 第三個實例)。**
  它跟 1.6.3 修掉的 `check-doc-rot.ts` 完全同型——自己重寫了 `skipDirs` 的型別檢查與合併,
  於是 1.6.3 加的 **glob 硬錯對它不生效**。
  【驗】協調者在 1.6.4 之後逐支盤點 13 支 `check-*.ts` 才發現;`check-dry-run.ts` 與
  `check-phase-coverage.ts` 也直接用 `DEFAULT_SKIP_DIRS`,但那是**找 cucumber 設定檔目錄**用的
  `CWD_SCAN_SKIP`,母體不同,**不是同一個病**(P-92 的「先問母體」)。
  **兩次都是 grep 漏掉、撞上才發現——結構解是 #13 的名冊,不是更仔細的 grep。**

## 1.6.4 — 2026-09-12

**patch,bug 修復。停在 1.6.1/1.6.2 的 consumer 建議直接升到這版。**
升版動作:重 sync 一次。

- **`check-phase-coverage.ts` 段一現在會問 phase 狀態(P-92)。** 1.6.0 把 P-86 的修法
  套進段一時漏了段二既有的 `readPhaseStatus()` 判斷,於是**每寫一個新的 `.feature`
  (狀態還是 `todo`、程式還沒寫)就讓這道 gate 紅**——而「先寫 gherkin 再寫程式」
  正是本範式的核心動作。
  【驗】專案 A 升 1.6.2 後 `accept:coverage` 紅在 16 個 phase 檔,全部 `undefined=1~15`、
  `ambiguous` 一個都沒有,那 16 個全是 `todo` 的未來 phase。
  修法:`todo`/`ready`/`blocked` 只要求「tag 比對到 ≥1 個場景 + `ambiguous`=0」,
  **不檢查 `undefined`**;`done`/`in-progress` 維持嚴格。**沒有新增設定**——
  `FEATURE.md` 的 phase 表是唯一狀態來源,再開一個設定就會有兩個真相。
- P-92 另記一條比這支腳本泛用的通則:**把一個修法擴散到「看起來相似」的地方時,
  要先問那裡的前提是否相同,尤其是母體是誰決定的。**

## 1.6.3 — 2026-09-12

**patch,bug 修復。** 升版動作:重 sync 一次(`_root.ts`、`check-doc-rot.ts` 有變更)。

- **`skipDirs` 寫 glob 現在會硬錯,不再靜默無效(P-91)。** 【驗】專案 A 實測
  `"skipDirs": ["learning-*"]` 完全沒作用且不報錯——`resolveSkipDirs()` 回的是
  `Set<string>`,**逐字比對**。「回傳值長得像回執」那族最壞的一種:它讓人以為問題解決了,
  於是不再追;而且**打錯字跟不支援 glob 的症狀一模一樣**。現在收到含 `*` `?` `[` 的項目
  → 大聲失敗並指名是哪幾項。
- **`check-doc-rot.ts` 改為委派共用的 `resolveSkipDirs()`,不再自己複製一份合併邏輯。**
  修 P-91 時發現的:它原本重寫了「型別檢查 + 合併 `DEFAULT_SKIP_DIRS`」,於是新加的
  glob 硬錯對它不生效——**同一個設定,在別支大聲失敗、在這支靜默無效**。
  這是 **P-90 的形狀再一次**(共用的東西存在,卻有人繞過它自己做一份),
  只是這次繞過的是**函式**不是清單。**通則:每次在共用層加檢查,都要回頭確認沒有人繞過共用層。**
- ⚠️ **給停在 1.6.2 的 consumer**:1.6.2 裡 `check-doc-rot.ts` **那份複製的合併邏輯還在**,
  所以 `doc-rot` 的 `skipDirs` 走的是它自己那條路(專案 A 實測有效,`scanned` 穩定),
  但 **glob 硬錯對它不生效**。**升到 1.6.3 之後,共用層才是唯一真相。**
  如果你暫時不升,知道這個差異就好——它不會讓你壞掉,只是 `doc-rot` 這一支的 `skipDirs`
  行為跟其他掃描器不完全一致。
- 清掉文件裡寫死的技術顧問 session 名(`doc-rot` 的 P-59 黑名單抓到的,是本 repo 自己違規)。

## 1.6.2 — 2026-09-12

**patch,但這是 bug 修復,任何跑 Stryker 的 consumer 都會中,建議直接升。**
升版動作:重 sync 一次(`_root.ts` 與 `check-doc-links.ts` 都有變更)。

- **`.stryker-tmp` 升進 `_root.ts` 的 `DEFAULT_SKIP_DIRS`(P-90)。**
  變異測試沙盒是**整個 repo 的複本**,任何走訪檔案樹的掃描器踩進去都會把守門自己的
  fixture 與舊 worktree 的整份模板當成真命中。【驗】專案 A 量到:同一個 commit、同一支守門,
  沒沙盒時掃 717 檔 0 命中 PASS,有沙盒時掃 1870 檔 35 處命中 FAIL。
  【驗】dev-paradigm 獨立重現:只丟兩個檔進假沙盒,`check-doc-rot` 的 `scanned` 從 791 跳到 792;
  修完後有無沙盒都是 791。
  根因是**共用清單存在,卻有一支繞過它自己列一份**——9 支掃描器用 `DEFAULT_SKIP_DIRS`,
  只有 `check-doc-links.ts` 自帶清單排除 `.stryker-tmp`,另外 8 支全踩。
- `check-doc-links.ts` 不再自帶 `.stryker-tmp`,改用共用清單(它專屬的只剩 `archive`)。
- **第二層影響(比假紅重要):這個 bug 讓 `scanned=N` 不能用了。** N 會隨「那一刻磁碟上有沒有
  別人的沙盒」跳動,於是分不出「掃描器壞了」與「剛好沒有沙盒」。修這個 bug 救回來的不只是假紅,
  **是量尺本身**。通則與四種狀態的驗收寫法記在 P-90。

## 1.6.1 — 2026-09-12

**patch:只加測試與文件,沒有行為變更。已採用 1.6.0 的專案不需要重 sync 才能用;
但下次 sync 會帶進新的 `check-dry-run.test.ts`。**

來源:專案 A 技術顧問 2026-09-12 第二輪回報。

- **`check-dry-run.ts` 的反向驗證補一個關鍵案例 (a2):參數化定義蓋住字面定義。**
  1.6.0 的反向驗證 (a) 用的是「跨檔**逐字相同**」的定義——那種 `check-step-dup.ts` 本來就接得住,
  等於沒驗到這支新 gate 真正要補的那一塊。真正補的是:兩個定義的**字串不相同**、但都匹配同一句
  (`'…the {word} fixture set'` 蓋住 `'…the rich fixture set'`),`check-step-dup.ts` 比的是正規化後的
  字面形狀,`{word}` 與 `rich` 是不同形狀,它看不見;cucumber 看得見(印 ambiguous)但不用退出碼講。
  【驗】協調者獨立做 fixture 實測:cucumber `--dry-run` 印 `1 scenario (1 ambiguous)` 但 **exit 0**;
  `check-dry-run.ts` 對同一份 fixture **exit 1、`ambiguous=1`**——**1.6.0 的 gate 本身就擋得住,
  缺的只是證明它擋得住的測試**。補上後該檔 16 → 17 測試;把 `ambiguous` 桶弄瞎,新測試會紅(連同 (a)(b) 共 3 條)。
- **P-89 抽成通則**:不再寫成 `verify-against` 專屬。凡是對原始碼或文件做字面掃描的守門,
  設計時要先把四個位置想過一遍會不會假命中:註解、log 與錯誤訊息字串、測試資料與 fixture、文件裡的舉例。
  這跟 P-78 附帶的「連結掃描器不分引用與說明」是同一個坑的兩個實例。

## 1.6.0 — 2026-09-12

**出版檢查(2026-09-12,協調者)**——模板自測三步全過:
`sync-gates.test.sh` 全部通過(exit 0)、`npm run test:scripts` 13 檔 210 測試全綠(exit 0)、
`verify-against.sh /data/python/llm_learning-cards` exit 1 共三項差異,**逐項判定如下,無迴歸**:

1. `check-phase-coverage.ts` 旗標:模板有 `--strict`、consumer 無 → **刻意改進**,consumer 升版跟進。
2. `check-step-dup.ts` 輸出文字不同 → **刻意改進**,本版把判定從「每種形狀恰好 1 個」改成
   「0 或 1 個」,成功訊息跟著改寫。
3. `check-step-dup.ts` 旗標一增一減,其中「consumer 有、模板無 `--strict`」被腳本標成
   **「綠著掉功能的訊號」** → **假警報,見新增的 P-89**。【驗】逐行查證:兩邊那個字都在
   註解與 log 字串裡(consumer L28 註解、模板 L341 `console.log`),該支真正解析的旗標只有
   `--list`(L74)。本版改寫註解導致字面消失,工具誤判。**沒有功能被拿掉。**

另註:`verify-against.sh` 對 `/data/python/AI_KM` 跑會六支全報「consumer 版未執行」,
原因是該 repo 沒有安裝 `tsx`(`sh: 1: tsx: not found`),不是迴歸;換有裝 `tsx` 的 consumer 才量得到。

**本版新增的坑與做法**:P-89(verify-against 旗標假陽性)、P-78 補充(改名偵測讓兩條獨立分支的
交接互相衝突;搬檔案時註記要寫成不可解析的形式)、`docs/07-practices.md` (am)(an)(ao)
(逾時理由要附機器負載、寬鬆要寫退出條件、測試環境變數由探針注入不靠 `export`)。
後三項來源:專案 A 技術顧問 2026-09-12 回流。

來源:AI_KM 顧問(2026-09-08,AI_KM origin/main f6e184c 量出來的三條回流)。
**minor:新增兩支守門腳本(`check-dry-run.ts`、`check-module-cast.ts`)、`gates.config.json` 新頂層鍵
`moduleCast`、`package.json` 的 `accept:dry` 改成呼叫 `check-dry-run.ts`(名字不變)、
`check-step-dup.ts` 與 `check-phase-coverage.ts` 段一的判定規則改變。升版動作 = 重 sync 一次 +
把 `check:module-cast` 掛進 `package.json` 與 `chain`;`accept:dry` 不用改名。**

- **P-86(dry-run exit 0)**【驗】:模板自己的 @cucumber/cucumber 11.3.0 對一份兩個定義撞名的 fixture跑
  `--dry-run --format summary` → 印 `2 scenarios (2 ambiguous)`、exit 0;加 `--strict` 仍 0;多一句沒定義的步驟
  → `(1 undefined)`、exit 0、`--strict` 仍 0;同一份 fixture 真跑 exit 1。AI_KM 回報的是 ambiguous,undefined
  是這次一起量到的,**比回報的更廣**——1.5.x 的 `accept:dry` 對兩種都瞎。
  - 新增 `check-dry-run.ts`(gate `dry-run`):自己跑 dry-run、讀 `N scenarios (...)` / `N steps (...)` 摘要行,
    undefined / ambiguous / failed 任一桶 ≥ 1 → exit 1;0 個場景 → exit 1(掃描器壞了,P-32 同規則);找不到摘要行、
    cucumber 起不來、cucumber 自己退出碼非 0 → exit 1。只信「退出碼非 0」這個方向。`--tags`、`--cwd`、`--root`、
    `--` 透傳;cwd 三層決定跟 `check-phase-coverage.ts` 同一套。
  - `package.json` 的 `accept:dry` 改成 `tsx scripts/check-dry-run.ts --tags 'not @manual'`——**名字不變**,所以
    autopilot SKILL 的 `chain` 範例、CHECKLIST 的 `{{FULL_CHECK_COMMANDS}}` 範例、PITFALLS P-02 的合併門檻都不用改
    指令,只是它們現在真的會擋。
  - `check-phase-coverage.ts` 段一同型修法:以前只數場景數,檔頭卻寫「每個 step 都能對上一個定義」(那句話從來沒被程式
    檢查過);現在讀摘要行,undefined / ambiguous ≥ 1 該 phase 就紅,cucumber 的 `Failures:` 原文縮排印出。反向驗證做過:
    fixture 多一句沒定義的步驟 → 段一紅 `undefined=1`;刪掉 → 綠。
  - **兩段**(AI_KM 第二輪回饋):consumer 依規格刻意讓 todo 整合點 / `@model` 場景的步驟 undefined,驗收 job 用 tag
    排除它們。段 A 用驗收 job 的 tag(`--tags` > `gates.config.json` 新鍵 `dryRun.tags` > 交給 cucumber 設定檔)跑,
    undefined / ambiguous 都紅;段 B 不帶 tag 跑全集,只看 ambiguous(撞名跟 tag 無關)。`dryRun` 加進
    `KNOWN_GATES_CONFIG_KEYS`。
  - `check-dry-run.test.ts` 16 條,對 fixture 跑**真的 cucumber**(`node_modules` 符號連結到模板自己的);第二條是
    「cucumber 本人對這份 fixture exit 0」的前提斷言——哪天 cucumber 自己會擋了,那條先紅,這支守門才能退休。
- **P-87(跨檔逐字相同、feature 沒用到的定義)**【驗】:對模板 1.5.0 的 `check-step-dup.ts` 造 fixture:
  `the store has {int} items` 兩檔各一份且 feature 有用 → **有抓到**。AI_KM 協調者事後送來撞名原文(純字面、無參數,
  兩個 phase 的 feature 都用到),對 **v1.2.2**(AI_KM 裝的版本,他們的 SOURCE 標頭)與 1.5.0 造同型 fixture → **兩版都抓得到**
  【驗】;所以 AI_KM 那次為什麼漏,不是版本、不是語法,見下面「AI_KM 個案」;
  `the log line(s) contain(s) {string}` 兩檔各一份、feature 沒用 → **漏**;`an unused sentence` 兩檔各一份、feature 沒用
  → **漏**。兩個漏的都是同一個原因:1.5.x 對 feature 這邊的集合迭代,定義那邊只是查表。
  - **AI_KM 個案**(唯讀查 `/data/python/AI_KM` main f6e184c):他們裝的 `features/scripts/check-step-dup.ts` 是 v1.2.2,
    對協調者送來的撞名原文造 fixture **抓得到**【驗】;守門**有接線**——`features/package.json` 的 `steps:dup` 與 `test`
    (串四支守門,turbo 每次跑,6069681 起)【驗】;撞名的 phase-4 定義**從沒進過 git**(`git log --all -S` 只有 phase-3 那筆)
    【驗】。結論(AI_KM 顧問給的,與上面三件事一致):測試 agent 在 commit 前自己跑 dry-run 抓到並改掉,守門根本沒機會跑——
    **不是漏**。回報裡「check-step-dup 抓不到」是推論,不是量到的。
    **本模板顧問(這個 session)的錯,具名照登**:第一輪回 AI_KM 時說「root 與 features/package.json 都沒有任何 script 呼叫
    check-step-dup」——grep 的 pattern 是 `"accept\|"check\|cucumber`,對不到 `"steps:dup"` 與 `"test"` 那兩行,把「我的 grep
    沒看到」講成「沒有」,而且標了【驗】。AI_KM 顧問對 origin/main 重量後退回。教訓同 07-practices (af)/(l):否定式宣稱
    (「沒有 X」)要用會列出全部候選的查法(直接讀整份 scripts 區塊),不能用只列命中的 grep。
    1.6.0 的 `check-step-dup.ts` 對他們 HEAD 跑:27 個 feature、376 個定義、0 重複,PASS。
  - 改成對**定義清單本身**找重複:任一形狀 ≥2 個定義就紅,不管 feature 有沒有用到;每個定義印檔案 + 原始寫法
    (regex 印 `/…/`);沒用到的明說「目前沒有任何 .feature 用到」。解析到 0 個定義(有 feature、steps 目錄卻不在
    `features/steps`)也算掃描器壞了 → exit 1——**以前是靜默綠,這是刻意的行為改變**。`--list` 不變。
  - 新增 `check-step-dup.test.ts` 9 條(fixture `git init`,因為這支沒有 `--root`);反向驗證 (a)–(d) 全做成自動測試。
- **P-88(模組命名空間轉型)**:新增 `check-module-cast.ts`(gate `module-cast`),只擋 `import * as X` / `import X = require`
  的 `X as unknown as …` 與 `import(…)`/`require(…)` 結果的直接轉型;對值的 `as unknown as` 放行(AI_KM 實測全掃 23 抓 2)。
  `gates.config.json` 新頂層鍵 `moduleCast.scanDirs`(預設 `["features/steps"]`,已加進 `KNOWN_GATES_CONFIG_KEYS`);
  `npm run check:module-cast`。測試 11 條。對模板自己的 `features/steps/` 跑:2 個檔案 0 命中;對 AI_KM main f6e184c 跑
  (`--root`,唯讀):20 個檔案、**2 命中**(`app-shell-phase-2.steps.ts:49` `citationsModule`、`:129` `answerStateModule`),
  正是 AI_KM 協調者量到的那 2 處真缺陷,0 誤報【驗】。
- `zero-input.gates.test.ts` 的 `GATE_SPECS` 加 `check-dry-run.ts`、`check-module-cast.ts`(P-84 三探針都過)。
- PITFALLS 新增 P-86 / P-87 / P-88,P-02 的對策補 1.6.0 的行為;`docs/07-practices.md` 新增 (ak)「守門提案接進 CI 前先故意
  改壞輸入讓它紅一次」、(al)「steps 不准模組命名空間轉型」;`scripts/README.md`、`features/steps/README.md` 對應補段。
- 出版前 `verify-against.sh` 對 AI_KM(main f6e184c,唯讀;AI_KM 是 pnpm monorepo,root 沒有 tsx,要
  `PATH=<模板>/node_modules/.bin:$PATH` 才跑得動,不然六支全 127):**模板版六支全部執行有效**(退出碼 0/1、有 gate= 標記);
  `verify-against.sh` 1.6.0 起自己把模板的 `node_modules/.bin` 附加在 PATH 尾端當退路);
  **consumer 版六支全部「退出碼 0 但沒有 gate= 標記」**——他們裝的是 v1.2.2,標記是 1.3.2 才加的,verify-against 的
  「執行有效性」規則把它們判成未執行,**沒有東西可比**。所以 README 的出版規則(對 ≥1 個 consumer 跑過 verify-against)
  在嚴格意義上還沒滿足:AI_KM 的升版路徑是 1.2.2 → 1.3.4(`--check` 自比對)→ 最新,他們上 1.3.4 之後再比一次,
  那時 AI_KM 就能當 consumer。1.6.0 因此仍是草稿;出版時通知 AI_KM。
  另外對 AI_KM 直接跑了 1.6.0 的三支新/改的 gate(不經 verify-against):`check-step-dup.ts` PASS(376 定義 0 重複)、
  `check-module-cast.ts` FAIL 2 命中(正是他們的 2 處真缺陷)、`check-dry-run.ts --tags 'not @manual and not @e2e and not @i2 and not @model'`
  PASS(段 A 153 場景 0 undefined 0 ambiguous;段 B 194 場景 0 ambiguous,2 undefined 在驗收集合外不算)。
- `npm run test:scripts` 210 條全綠(1.5.0 是 167;新增 dry-run 16、step-dup 10、module-cast 11,零輸入探針各 +3×2)。
- 沒動 `CLAUDE.md`、`.claude/skills/`、`.claude/commands/`(規則層,使用者批准才動;這次不需要——`accept:dry` 名字沒變)。
- 模板自己的 `npm run typecheck` 在 1.5.0 就是紅的(`tsconfig.json` 的 `types` 只有 `vitest/globals`,沒有 `node`,323 個
  錯全是 `process` / `node:*` 找不到型別);用 `npx tsc --noEmit --types vitest/globals,node` 跑是 0 錯,1.6.0 的檔案沒有新增
  型別錯。這條沒修,只記在這裡——改 tsconfig 是另一件事。

## 未出版

- 2026-09-06 搬家:從 `llm_learning-cards/template/` 以 `git subtree split` 搬到獨立 repo `/data/python/dev-paradigm`,
  歷史 74 個 commit 保留,tag 改名 `vX.Y.Z`。內容與 v1.5.0 完全相同(只多 `.gitignore` 與本說明),不升版。
  舊位置(`llm_learning-cards` 的 agent worktree)凍結在 v1.5.0,之後只在這裡改。

## 1.5.0 — 2026-09-05

來源:專案 A 協調者(REVIEW.md §二.1,PITFALLS P-85);AI_KM 顧問、nightmare 顧問 2026-09-05 同意修法。
**minor:`sync-gates.sh` 的寫檔行為改變(從靜默覆蓋改成拒絕),沒有新旗標、沒有設定鍵、沒有檔案結構改變。
升版動作 = 重 sync 一次;若被拒絕,照訊息把自己的檔改名 `<base>.local.<ext>` 再跑。**

- **修 bug(資料流失)**:1.4.x 起模板出貨 `check-*.test.ts`,sync 的複製迴圈用檔名 glob 一路覆蓋,
  會把 consumer 自己寫的同名測試檔(沒有 SOURCE 標頭)靜默蓋掉。專案 A 實際損失三檔(從 HEAD 還原)。
  現在**先掃後寫**:寫任何檔之前,對本次選集(ts 永遠;py 看選集)每一支來源檔算出目的路徑,
  目的檔已存在且第一行不符 `^(//|#) SOURCE: template v` → 印
  `✗ <dst> 已存在且沒有 SOURCE 標頭(是你們自己的檔);請改名(例如 <base>.local.<ext>)或刪掉後重跑,sync 不會蓋掉它`
  列出全部命中、exit 1、**一個檔都不寫**。`--check`、`--prune`、設定檔不覆蓋的邏輯都不變。
- `sync-gates.test.sh` 新增步驟 9(三案例:無標頭同名檔 → 整批拒絕且原檔 sha256 不變、`_root.ts` 沒被寫;
  改名 `.local` 後 → exit 0 且 `.local` 不變;舊版 SOURCE 標頭同名檔 → 照舊覆蓋)。反向驗證做過:
  停用檢查後 4 條斷言準確地紅,復原後 34 條全綠。
- PITFALLS 新增 P-85;`docs/07-practices.md` 新增 (aj) consumer 自有守門測試檔的命名與 include 規則;
  README 採用段補一句被拒絕時怎麼做。
- 出版前 `verify-against.sh` 對專案 A(main 0998d12):六支 gate 退出碼、旗標清單全部一致;只有 `check-boundaries.ts`
  的輸出差在三行「設定:<路徑>」後面多一個 `(GATES_CONFIG_DIR)` 標記——模板那邊是 verify-against 用環境變數指定設定目錄、
  consumer 那邊是自己找到的,1.4.1 起守門會印出設定的**來源**,所以兩種呼叫法本來就該印不一樣。**刻意差異,不是迴歸**;
  `sync-gates.test.sh` 34 條、`npm run test:scripts` 167 條全綠。
- 版號說明:原本規劃「1.4.4 = 09-07 聯合回顧後的文件版」,但改腳本行為依本檔規則是 minor,
  而且這個坑正在其他兩個專案的升版路徑上,不等回顧。回顧版順延為 1.5.1 / 1.6.0。

## 1.4.3 — 2026-09-05

來源:專案 A 協調者(2026-09-05,PITFALLS P-84)。**patch:只有守門的錯誤訊息與新增的自我測試,
沒有任何檔案結構、CLI 介面或 `gates.config.json` 鍵改變——升版只需要重新 sync,不用改設定。**

- **修 bug**:`check-next-gates.ts`、`check-phase-status.ts` 過去 `--root` 明講一個不存在的
  目錄時,exit 1 但輸出完全沒提那個路徑不存在,跟其餘會先摸設定檔的 gate(經 `_root.ts` 的
  `lookupConfig` S14 hard-error)少講了最關鍵的一句話。`_root.ts` 新增
  `requireRootDir()` / `rootDirError()`:`--root` 明講時,搶在任何設定檔查找之前確認那個
  目錄真的存在、真的是目錄,不是就印 `✗ --root 指到不存在的目錄:<絕對路徑>` + `gate=<name>
  result=FAIL scanned=0` + exit 1。全部支援 `--root` 的 gate 都接上了這個檢查:
  `check-all.ts`、`check-boundaries.ts`、`check-doc-links.ts`、`check-doc-rot.ts`、
  `check-known-defects.ts`、`check-next-gates.ts`、`check-phase-status.ts`、
  `check-standalone.ts`(`check-doc-links.ts` 的 `main()` 是純函式,不自己 `process.exit`,
  用 `rootDirError()` 只拿訊息字串,呼叫端自己組回傳值)。`check-gherkin-dup.ts` /
  `check-phase-coverage.ts` / `check-step-dup.ts` 沒有 `--root` 旗標,不受影響。
- **新增 `zero-input.gates.test.ts`**:模板自己的零輸入守門測試,用目錄列舉(不是手抄清單)
  找出 `scripts/` 底下所有 `check-*.ts`,對每一支支援 `--root` 的 gate 跑三個探針——
  (a) `--root` 指到不存在的目錄、(b) `--root` 指到空目錄、(c) `--root` 底下的設定檔壞掉
  (malformed JSON)——各自要求 exit 1、機器可讀標記在、沒有裸露的堆疊;每個探針的具體訊息
  片段記在測試檔頭的探針表。沒有 `--root` 旗標的 gate 要明講在 `NO_ROOT_FLAG` 並附理由,
  兩邊都沒有 → 測試紅,訊息是「新守門沒進零輸入清單」——新增一支 gate 之後結構上不可能漏掉
  這一項檢查。做過反向驗證(拔掉一支 gate 的 `requireRootDir` 呼叫,測試準確地紅在那一支,
  沒有連坐到別支;驗完照原樣復原)。
- PITFALLS 新增 P-84(模板違反自己訂的規則,第二次;第一次是 P-83);
  `docs/07-practices.md` 新增 (ah) 改斷言的五欄表、(ai) 掃描器抓到自己人三次。

## 1.4.2 — 2026-09-05

來源:專案 A 協調者、專案 A 審核 agent(2026-09-05)。

- 模板自己不得含可照抄的 Stryker CLI 字面(專案 A 的『不准繞過鎖』掃描器抓到 1.4.1 的
  doc-rot 測試資料與黑名單條目;fixture 改串接、黑名單改 `\s+` regex、新增
  no-bypass-literal 守門;來源 專案 A worker/協調者)。

### `check-phase-status.ts`(S15,report 模式)

- 新守門:對照 `features/<NN-x>/FEATURE.md` 的 Phase 表(唯一狀態來源)跟現實,抓三種形狀的
  漂移——(1) 狀態表寫 `in-progress` 但那個 phase 自己的 tag 真跑全綠、且找得到一份已 commit、
  帶 PASS 標記、提到 `<NN-x>/phase-N` 的審核判定檔(`features/<NN-x>/REVIEW.md` 或
  `phaseStatus.reviewDirs` 底下的 `.md`)→「疑似已完成,狀態表未更新」;(2) 狀態表寫 `done`
  但真跑有 failed/undefined/ambiguous →「done 但場景紅」,跟 `check-phase-coverage.ts --run`
  是同一個不變量的兩份獨立判斷;(3) `features/<NN-x>/NEXT.md` 待辦區塊(標題含「下一輪」/
  「要做」/「待做」/「TODO」)裡反引號包住的識別碼,已經有非樁實作卻還列在待辦 →「NEXT.md 過期」
  (兩層判準:定義存在 + 定義後 15 行內沒有樁字樣,測試輪留樁的慣例不會誤報)。
- PASS 標記的定義(單行 `判定:PASS` / 標題另起一行接 `**PASS**` / 字面「審核 PASS」三選一)寫在
  腳本檔頭,務求機械可判。
- `gates.config.json` 新鍵 `phaseStatus: { mode, reviewDirs }`,`mode` 預設 `"report"`(P-71:
  新守門先報告不擋);`reviewDirs` 預設 `["docs/reviews"]`。cucumber 真跑沿用
  `check-phase-coverage.ts` 已有的 `cucumberCwd` / `phaseCoverage.runTimeoutMs`,不重新發明
  一套。測試用 `PHASE_STATUS_RUN_CMD` 注入假的 cucumber 輸出,同 `check-known-defects.ts` 的
  `KNOWN_DEFECTS_ENUMERATE_CMD` 慣例。
- `KNOWN_GATES_CONFIG_KEYS` 加 `phaseStatus`;`package.json` 加 `check:phase-status`。0 份
  `FEATURE.md`,或掃到的 phase 表格列總數是 0,一律 exit 1,不受模式影響。
- 對 `/data/python/llm_learning-cards`(專案 A)read-only dry run 的輸出貼在 REVIEW/回報裡。
- 來源:專案 A 協調者,2026-09-05(PITFALLS P-75,`01-data-layer/phase-4` 兩輪覆核發現的真實案例)。

### 交接檔改名:`.orca-brief/REVIEW.md`(PITFALLS P-78)

- 交接檔從「worktree 根目錄的追蹤檔 `REVIEW.md`」改成 `.orca-brief/REVIEW.md`(gitignored,
  worktree 專屬,不進版控)——`.orca-brief/TASK.md.template`、`docs/03-agile-workflow.md`、
  `CLAUDE.md`、`.claude/skills/autopilot/SKILL.md`(§2、§4b)、`PITFALLS.md`(P-17)裡凡是
  指這個「角色間交接寫的那份檔」的地方全部更新引用;`IN-REVIEW.md`(整合點)、
  `docs/reviews/*.md`(事後留存的審核記錄)不受影響,那是不同的東西。
- 動機:兩份文件已經各自警告過一次「不要寫根目錄的 REVIEW.md」,第三個人還是照舊慣例踩了一次,
  覆蓋掉 main 上 263 行舊紀錄——警告寫在文件裡不是機制,拿掉那個會被覆蓋的路徑本身才是。

### `.orca-brief/TASK.md.template`:worktree 起手三步 + 交接檔說明

- 「第 0 件事」之後加「worktree 起手」checklist:`.env` 已連結或複製;花費檢查指令
  (`{{SPEND_CHECK_COMMAND}}`)退出碼是 0 或 1 才繼續,**2(算不出來)不准當 0**(P-47/P-81);
  續用舊 worktree 時先 `git merge main`(**不 rebase**)再看紅燈。
- 新增「## 交接檔」一節,講清楚 `.orca-brief/REVIEW.md` 是 gitignored、worktree 專屬,不是
  根目錄的追蹤檔(見上)。
- `CHECKLIST.md` 補 `{{SPEND_CHECK_COMMAND}}` 這個 placeholder 在 `.orca-brief/TASK.md.template`
  也用得到(跟 autopilot SKILL.md 那份同一個值),順手修正 brownfield 表格裡這一列多出的欄位。

### CHECKLIST.md:三條流程提醒

- 新節「worktree 起手 / 凍結期間 / 動測試檔」:clone 完不會自動有的三樣(`.env`、pre-commit
  hook、`TEMPLATE_DIR`);凍結期間(花費上限、其他煞車條件)可以做的事——派工、開單、回訊、
  worktree 內工作,凍結只擋「新的付費/main 工作」;協調者動測試檔(即使只是改註解)一律報備。
- 「收工前 / push 前檢查」補一條:含子行程探針 + 逾時的測試跟 `npm run mutate` 共用同一把
  跨 worktree 檔案鎖(見下),單檔 `vitest run` 不用搶鎖,不准放寬逾時當修法(P-82)。

### `.claude/skills/autopilot/SKILL.md`

- §4c(「分支上全綠、合併後紅」)結尾加一段一行提示:P-77(宣告的動作沒有 diff)、P-78
  (警告寫第三次還被踩)是同一個「交接動作沒有回執」家族(P-76)的另外兩種形狀。
- §3 維護清單第 4 項(文件漂移)補:`npm run check:phase-status` 跑在 report 模式,三種命中是
  分診用的線索,不是停止條件。

### `.claude/skills/mutation-testing/SKILL.md`

- 新節「全套測試跟 Stryker 共用同一把鎖(P-82)」:子行程探針 + 逾時的測試在負載下(同機另一個
  worktree 跑 Stryker)整類不可信,同一天三環境四次都各自紅過一次;修法是這類測試跟
  `npm run mutate` 共用跨 worktree 檔案鎖,不是放寬逾時;單檔 `vitest run <單一檔案>` 不用搶鎖。

### PITFALLS.md:P-75 – P-83,`P-49` 補充

- **P-75** 狀態表漂移(`01-data-layer/phase-4` 兩輪覆核發現;fix = `check-phase-status.ts`
  report 模式)。
- **P-76** 家族標題「交接動作沒有回執」,列 P-45、P-54、P-75、P-77。
- **P-77** 宣告的動作沒有 diff(「這個 ADR 我來寫」合併後 grep 不到)。
- **P-78** 同一個警告寫第三次就該改結構(REVIEW.md 根目錄覆蓋事件)。
- **P-79** 工單引用將來才存在的東西(`check:all` 在 1.4.1 前不存在的事故)。
- **P-80** 驗收條件本身是代理指標(「三句話兩兩不同」用三句廢話就能滿足)。
- **P-81** 錢煞車自我違反「不知道 ≠ 零」(整份 log 是 `"hello"` → exit 0「沒花」)。
- **P-82** 子行程探針 + 逾時的守門在負載下整類不可信(三環境四次;修 = 全套測試與 Stryker
  共用鎖,不放寬逾時)。
- **P-49 補充**:基準值要自己量不抄;`file:line` 引用的行號會腐爛,修正時優先拿掉行號。
- **P-83** 模板帶進來的測試資料觸發消費者的守門(1.4.1 的 doc-rot fixture 與黑名單條目
  逐字寫死了一句可照抄的 Stryker CLI 指令;fix = fixture 改陣列串接、黑名單改 `\s+`
  regex、新增 `no-bypass-literal.test.ts`;B1 用 SOURCE 標頭開豁免被拒絕)。

### `no-bypass-literal.test.ts`:模板自己不得含可照抄的 Stryker CLI 字面(PITFALLS P-83)

- 背景:專案 A 自己的「不准繞過鎖」掃描器(掃全部文字檔,找可以照抄貼上、繞過變異測試
  檔案鎖的 Stryker CLI 指令)把模板 1.4.1 兩處自己的東西當真的違規命中——
  `check-doc-rot.test.ts` 的一筆 `--self-test` fixture、`doc-rot.blacklist.json` 出貨的
  一筆黑名單條目,兩處都逐字寫死了同一句指令(見 P-83)。
- **B2(no exemptions anywhere)**:不採用「幫有 SOURCE 標頭的模板同步檔開白名單」
  (B1)——「來源可查」不等於「內容可信」,而且這個豁免會蓋住 `template/scripts/` 底下
  30 多個檔案,形同幫整個目錄開後門。改成兩處都動:fixture 用
  `['npx', 'stryker', 'run'].join(' ')` 串接組出來,不留連續字面值(`check-doc-rot.test.ts`
  另外補一個字元碼獨立重建的 pin 測試,確認串接組出來的還是原本那句指令,不是改壞了
  語意);黑名單的 pattern 從逐字字串改成語意相同、但沒有可照抄字面值的 `\s+` regex
  (`npx\s+stryker\s+run`,`--self-test` 既有的 `synthesizeProbe` 已經處理 `\s+` → 空格,
  不用改動)。
- 新增 `template/scripts/no-bypass-literal.test.ts`:掃 `template/scripts/**`(含這份測試
  檔自己,不排除)找 `npx\s+stryker\s+(run|init)` 這個 regex 跟 `stryker`+空格+`run`
  這個字面,兩者任一命中都算,期望零命中;含三個反向驗證(串接組出來的違規字串放進臨時
  目錄要被抓到、沒有 `npx` 前綴一樣算、`node_modules` 底下的命中不算)。
- 來源:專案 A worker/協調者,2026-09-05。

### 升級指南:1.4.1 → 1.4.2

- 跑一次 `sync-gates.sh`(或專案自己的同步腳本)把 `.ts` / `scripts/py/*.py` 同步到新版。
- `doc-rot.blacklist.json` 是 copy-once 設定檔(只在目標不存在時複製一次,之後永遠不覆蓋)
  ——**同步不會幫你把既有的那份改掉**,已經裝過模板的專案要自己手動把那一筆
  `incident: "mutate-lock-bypass"` 的條目,從 `"pattern": "npx stryker run"` 改成
  `"pattern": "npx\\s+stryker\\s+run"`(JSON 裡兩個反斜線),不然自己專案的 doc-rot 黑名單
  本身仍然含一段可照抄的 Stryker CLI 指令。
- `check:phase-status` 是新守門(`gates.config.json` 的 `phaseStatus`,`mode` 預設
  `"report"`,見上一節):`package.json` 有這個 script 不代表已經接進必跑鏈,要自己把
  `"check:phase-status"` 加進 `gates.config.json` 的 `chain` 陣列(跟 `check-all.ts` 講的
  一樣,鏈不會自動長出新項目)。

### docs/07-practices.md:(aa) – (ag)

- **(aa)** 見證器第四桶「刻意」登記表(`intended.json`,每條必須實際觸發否則 FAIL;不上調
  基準、不做標記機制;專案 A 160/8/152/152;兩種反向驗證)。
- **(ab)** A3 第三例:兩人推論一致比一人講錯更危險,判準是「這句話是怎麼來的」不是
  「有幾個人同意」。
- **(ac)** 新規則第一次執行選無害場合。
- **(ad)** worker 主動舉報自己最弱的一條要被肯定,不是被退回。
- **(ae)** 注入物若不是斷言前提,註解明說它守什麼(`localProber` 例子)。
- **(af)** 日期用 `date` 取,不憑印象——ADR 日期寫錯,半年後才會被發現。
- **(ag)** 派工 checklist 補三條:不引用將來才存在的東西;merge main(不 rebase)先於看紅;
  驗收條件要問「用廢話能不能滿足」。

## 1.4.1 — 2026-09-05

**Patch**:1.4.0 三支新守門的修補版——`check-doc-rot.ts` 加 report 模式、`--self-test`、
事故日誌預設排除;`check-boundaries.ts` 永遠印涵蓋率並加只升不降的棘輪;
`scripts/py/mutate.py` 加檔案鎖擋住突變測試進行中的 commit,配一支 `pre-commit` hook;
`_root.ts` 修正「從模板路徑對別的 repo 跑守門會靜默用到模板自己設定」的搜尋順序漏洞;
外加五條坑(NA-2 空集合恆真、新守門叫狼、涵蓋率盲區、模板路徑設定漏洞、守衛條件套套邏輯)。
來源:nightmare-assault(第五批回報)、AI_KM(commit 讀寫 read-only 驗證,2026-09-05)、
專案 A(協調者 + 覆核 agent,commit a93e59b 覆核)。

### `check-doc-rot.ts`(S13)

- **`docRot.mode`**(`gates.config.json`,`"report"` | `"enforce"`,**全新安裝預設 `"report"`**):
  命中一樣全部印出來、`gate=doc-rot result=FAIL` 標記一樣印,但 `"report"` 模式 exit 0,不擋
  其他工作;`"enforce"` 才 exit 1。動機見 PITFALLS P-71:nightmare-assault 自己的第一版
  doc-rot 掃出 310 筆命中,逐項排查收斂到 34 筆,**全部**是假警報——新守門第一版幾乎必然
  抓到規則設計沒想到的合理例外,default enforce 只會逼團隊在還沒摸清規則之前就被擋。
- **預設排除清單擴充**(`DEFAULT_EXCLUDE_GLOBS`):`docs/02-decision-map.md`、`docs/adr/**`
  (沿用 1.4.0)之外,新增 `**/PITFALLS.md`、`**/CHANGELOG.md`——這兩份是事故日誌,合理地會
  逐字引用「曾經出過的問題長什麼樣子」。`gates.config.json` 的 `docRot.exclude`(glob 陣列)
  追加在預設清單之後,不取代。
- **`--self-test`**:對現在讀到的黑名單,替每一條規則合成一個會命中它自己的探針字串
  (處理常見的 `\d` `\w` `\s` 量詞與逃脫字元),寫進臨時目錄跑一次掃描,要求命中數 = 規則數;
  任何一條規則的探針合成不出來(對自己沒命中)→ 誠實回報「哪一條沒命中」並 exit 1,不假裝
  每條規則都測得出來(PITFALLS P-68/P-71 的具體實作:「0」要能分辨是乾淨還是探針壞了)。
- **`note` 選填欄位** + 陣列 `_doc` metadata 項目:黑名單每一筆可以帶 `note` 記錄「這條規則
  收斂時的判斷依據」;陣列裡帶 `_doc` 鍵的項目是說明,不算條目(跟 `known-defects.json` 同一個
  慣例)。一筆出現不認識的欄位(打錯字)一律大聲失敗,跟 S9 同一套紀律。
- `doc-rot.blacklist.json` 補上 `_doc` 說明項目,講清楚 report 模式的預設與升級到 enforce 前的
  觸發時機。

### `check-boundaries.ts`(S11)

- **涵蓋率永遠印**,不再只在有 unmapped 檔案時才提:`涵蓋:納管 N / 掃描 M 檔(x%),未納管目錄:`,
  0 個違規時也印(舊版完全不提)。列出每一個含未納管檔案的第一層子目錄(相對掃描根目錄)與
  各自的未納管檔案數,不是只列扁平的檔案清單。動機見 PITFALLS P-72:舊版只在「掃到 0 個檔案」
  時宣稱「掃描器壞了」,一個**故意**只填一半的落點表(整個資料夾從沒被納管過)在舊版看起來
  跟填滿的落點表一樣是綠燈。
- **`boundaries.owners.json` 新增選填 `coverageBaseline: { managed, scanned }`**:存在時,這次
  跑出來的納管比例必須 ≥ 基準(交叉相乘比較,不用浮點除法),否則 `✗ 涵蓋率下降:<now> < 基準
  <baseline>(只准升)` 並判失敗;比例上升時印 `○ 涵蓋率上升,可把基準改成 N/M` 提示手動更新
  基準。棘輪本身壞掉(型別錯、`managed > scanned`)大聲失敗,跟其餘設定同一套 S9 紀律。

### `scripts/py/mutate.py` + `scripts/hooks/pre-commit`(S12)

- **`.mutate.lock`**(repo root,JSON:`pid`、`file`、`started_at`、`cmd`):`mutate.py` 啟動時
  寫入,**所有**結束路徑(正常結束、`MutateError`、SIGTERM/SIGINT)都清掉。鎖存在時:pid 還活著
  → 拒絕,exit 7,「另一個 mutate 正在跑」;pid 已死(上一次執行被 SIGKILL 或崩潰)→ 拒絕,
  exit 8,「殘留鎖:先 `--recover`」;帶 `--recover` 才繼續——先用 `git show HEAD:<file>` 核對
  鎖記錄的目標檔跟 git HEAD 是否一致,不一致就用 git blob 內容還原,一致就跳過還原,兩種情況
  都清鎖後繼續往下跑這次的突變。鎖檔本身解析不出來(壞掉的 JSON)一樣 exit 8,要求人工檢查。
- **`scripts/hooks/pre-commit`**(bash,可執行,新檔):認得 `.mutate.lock`(本模板寫的)與
  `.stryker.lock`(消費者專案常見的 TS 版變異測試鎖檔名,模板本身不寫這個檔,純粹一併檢查)
  兩種鎖檔——pid 還活著就拒絕 commit、pid 已死就提示怎麼復原、鎖檔解析不出 pid 就要求人工
  檢查。**不會被 `sync-gates.sh` 自動裝進 `.git/hooks/`**(git hooks 不受版本控制,自動覆寫
  別人手上已經裝好的 hook 比不裝更危險)——`sync` 只把這個檔案本身同步進 `<安裝目錄>/hooks/
  pre-commit`(**不插入 SOURCE 標頭**,理由是這個檔案必須能被 git 直接執行,shebang 一定要
  留在第一行),並印出手動安裝指令:`hook:cp <安裝目錄>/hooks/pre-commit .git/hooks/pre-commit
  && chmod +x ...(未安裝,hook 不進版控)`。`--check` 新增一行資訊性提示(不算失敗):
  `.git/hooks/pre-commit` 沒有 `mutate.lock` 這個字串 → `○ pre-commit hook 未安裝`。

### `_root.ts` 的設定檔搜尋順序(S14,來源 AI_KM,PITFALLS P-73)

- 新增 `lookupConfig(scriptDir, name, { root, rootExplicit })`:`rootExplicit`(呼叫端這次有沒有
  明講 `--root`)為 `true` 時,「腳本自己所在的目錄」這個候選**整個拿掉**,只剩
  `GATES_CONFIG_DIR` → `<root>/scripts/` 兩層,找不到就回傳 `hardErrorMessage`(呼叫端印出來、
  印 gate 標記、`exit 1`,不悄悄退回模板自己的範例設定);`rootExplicit` 為 `false`(consumer
  正常執行,沒帶 `--root`)時搜尋順序不變。同時回傳 `source`,供每支 gate 印
  `<name>: 設定:<resolved path>`(或 `設定:無,使用預設`)那一行透明度訊息。
- `check-boundaries.ts`、`check-doc-rot.ts`、`check-next-gates.ts`、`check-known-defects.ts`、
  `check-all.ts` 五支原本各自維護一份本地 `configSearchPathsList`/`findConfigFile` 的腳本,
  全部改呼叫 `lookupConfig`——`boundaries.owners.json`、`doc-rot.blacklist.json`、
  `known-defects.json`、`check-all.ts` 的 `gates.config.json`(必要設定)在 `hardErrorMessage`
  出現時直接大聲失敗;其餘選填設定(`boundaries.allow.json`、其餘的 `gates.config.json` 讀取)
  不理會 `hardErrorMessage`,找不到就照舊當「沒有這份選填設定」處理。
- 事故重現(read-only 驗證):`check-boundaries.ts --root /data/python/AI_KM` 在沒設
  `GATES_CONFIG_DIR` 時,從模板路徑跑會靜默套用模板自己的佔位 `owners.json`(FAIL scanned=0 /
  248 unmapped);設 `GATES_CONFIG_DIR=<root>/scripts` 之後正確(PASS scanned=358,跟 consumer
  已裝版一致)。修完之後,不設 `GATES_CONFIG_DIR` 直接對 `--root` 指到的 consumer 跑,`<root>/
  scripts/` 已經是新的搜尋目標,不再需要繞道 `GATES_CONFIG_DIR` 才能對到——`GATES_CONFIG_DIR`
  仍然保留、仍然優先,只是不再是唯一的解法。

### 文件

- **`PITFALLS.md`**:新增 P-70(NA-2,全稱量詞在空集合上恆真,跟 P-68 並列互相加註)、
  P-71(新守門第一版必然叫狼)、P-72(涵蓋率盲區:gate 綠但沒在看那一塊)、P-73(從模板路徑
  對別的 repo 跑守門靜默用了模板自己的設定)、P-74(守衛條件不可用被測對象算出的值當條件)。
- **`.claude/skills/phase-acceptance/SKILL.md`**:第三步半守衛問句補第五段——「全部 X 都…:
  X 可以是空的嗎?非空守衛在哪?」。
- **`docs/07-practices.md`**:新增 (z) 守衛(`if` 才斷言、skip 條件、提早 return)不可用被測
  對象算出的值當條件,證據來自覆核 `mutate.test.ts` 自己改壞的一條斷言。
- **`README.md`**:新增 doc-rot 出貨即 report 模式(先看觸發清單,清乾淨才切 enforce)與
  pre-commit hook 手動安裝的說明。

### 升版指南 1.4.0 → 1.4.1

1. **`check:doc-rot` 的行為預設變寬鬆**:原本命中就 exit 1,現在預設 `docRot.mode = "report"`
   ——命中還是會印出來、`gate=doc-rot result=FAIL` 標記還是會印,但不再擋 `chain`/CI。**這是
   刻意的降級,不是 bug**:第一次觸發清單先當成 triage list 看,逐項確認完(哪些是真的問題、
   哪些是合理例外要收進 `docRot.exclude`)之後,再把 `gates.config.json` 加上
   `"docRot": { "mode": "enforce" }` 切回原本的擋行為。
2. **升版後第一次跑 `check:doc-rot`,`PITFALLS.md`/`CHANGELOG.md` 裡原本會命中的字串現在預設
   不報**(新加的排除清單)——如果你的黑名單規則刻意要抓這兩個檔案裡的內容,改用
   `docRot.exclude` 排除清單以外的機制(這種情境理論上很少見)。
3. **`boundaries.owners.json` 可以加 `coverageBaseline`**:先跑一次 `npm run boundaries` 看目前
   的「涵蓋:納管 N / 掃描 M 檔」那一行,把 N/M 填進去當起始基準,之後涵蓋率只能升不能降。
   不填也完全沒事——`coverageBaseline` 是選填的,沒有就沒有棘輪這一層檢查。
4. **裝 pre-commit hook(選用但建議)**:`sync-gates.sh` 同步之後照它印出的
   `hook:cp <安裝目錄>/hooks/pre-commit .git/hooks/pre-commit && chmod +x ...` 那行指令手動安裝
   ——不會自動裝,git hooks 本來就不受版本控制。
5. **`scripts/py/mutate.py` 現在會在 repo root 留下 `.mutate.lock`**(執行期間存在,結束後清掉)
   ——正常情況下不需要改任何東西;如果曾經手動殺掉一個卡住的 `mutate.py` 行程(`kill -9`),
   下次執行同一個檔案的突變測試會遇到 exit 8「殘留鎖」,照訊息帶 `--recover` 重跑一次即可。

## 1.4.0 — 2026-09-05

**Minor**:新增四支守門腳本、`sync-gates.sh` 的接線檢查、`gates.config.json` 的設定壞掉大聲失敗
(S9)與共用略過清單(S10),外加大量文件與 skill 更新。來源:nightmare-assault(第二、三、四批
回報)、AI_KM(commit 7468eab、d3e0b80,以及坑14/15/16、#18/#19/#20、28a0519、9889f99、1e4d6a5、
c20766e 等具名 commit)、專案 A(協調者、覆核 agent、驗證 agent)。腳本本體已在 02a3b8e、cc1f8ce
兩個 commit 落地並跑過反向驗證;這個版本補齊對應的文件、PITFALLS、skill 更新,並修正掃描時發現的
既有文件量詞漂移。

### 新守門腳本

1. **`scripts/check-all.ts`**(單一入口):讀 `gates.config.json` 的 `chain` 陣列依序跑
   `package.json` scripts,`chain` 缺欄位或空陣列 → exit 1;鏈上任一名字不是真的 npm script →
   印「不是 npm script(P-55)」並算失敗,不嘗試執行。`--fail-fast` 遇第一個失敗就停;`--markdown`
   印一段可以直接貼進合併訊息的 fenced code block。
2. **`scripts/check-doc-rot.ts`**(S7,來源 nightmare-assault):`doc-rot.blacklist.json` 的黑名單
   regex 掃描,命中即紅;ADR 檔與黑名單設定檔自己排除。初始條目:寫死的顧問 session 名
   regex(`llm-learning-cards-\d+`)、繞過鎖的裸 `npx stryker run` 指令、寫死進固定量詞的
   「核心四項」——每一條都對應本版實際修過的坑。
3. **`scripts/check-known-defects.ts`**(S8,來源 nightmare-assault):比對 `@known-defect` tag
   場景與 `known-defects.json` 登記表的 multiset,兩邊要完全相等;子行程 `--dry-run --tags
   @known-defect --format json` 取得場景清單後**自己再驗證每個場景真的帶那個 tag**,不信任外層
   `--tags` 篩選器;`hard_rule: true` 的登記,`fix_in` 不准是佔位值。
4. **`scripts/check-next-gates.ts`**(來源 AI_KM):`NEXT.md` 的每條 gate 宣告必須引用 ADR / commit
   sha / 契約章節 `§N` / 整合點 `I<N>` / phase 參照之一,而且引用要能解析(標題找得到、commit 存在、
   章節存在、phase 表列存在)。`nextGates.mode` 支援 `"report"`(印失敗但 exit 0,給舊專案過渡)與
   `"enforce"`(預設)。

### 既有守門的擴充

- **`sync-gates.sh` 接線檢查**:同步進去、`package.json` 沒有任何 script 呼叫的守門 → `--check` 紅,
  印「同步進來但沒接線」。三種豁免(helper/測試檔、`check-all.ts` 已設定非空 `chain`、
  `gates.config.json` 的 `unwired` 允許清單且 `reason` 非空)不算沒接線。`sync` 收尾印
  `needs-config:` 清單(哪些設定檔是剛建立或原本就沒有)與接線建議清單。`CONFIG_FILES` 新增
  `doc-rot.blacklist.json`、`known-defects.json`。
- **`check-standalone.ts`**:manifest 支援底線開頭的 `_doc` metadata 鍵(不當條目處理,修正舊版
  把 `_doc` 的字串值當條目物件、`entry.cmd` 是 `undefined` 導致 `spawnSync` crash 的問題——來源
  AI_KM commit d3e0b80);新增 `pending` 語意(來源 nightmare-assault):條目可選填
  `"pending": "<NN-folder>/phase-N"`,該 phase 狀態未達 `done` 時預期失敗但仍執行、不擋 merge
  (印 `○ ... pending`);狀態已經 `done` → pending 過期,必須通過,沒通過印「pending 已過期」。
- **`check-boundaries.ts`**:`owners.json` 找不到、或 `owners` 是空陣列 → 都當「尚未設定」,exit 1
  並印範例;`glue` 陣列新增物件形式 `{ owner, role: "glue" }`(這個擁有者的檔案不准被 import,原本的
  純字串形式維持「可以 import 任何東西」的舊行為不變)。
- **`_root.ts`**:`loadGatesConfig` + `requireKnownTopLevelKeys`(S9)——設定檔解析錯誤或有不認識的
  頂層鍵一律印錯誤訊息、印 gate 標記、exit 1,不悄悄套用預設值;`KNOWN_GATES_CONFIG_KEYS` 是所有
  gate 認得的頂層鍵聯集,新增一個頂層鍵要同時加進這裡。`DEFAULT_SKIP_DIRS` + `resolveSkipDirs` +
  `splitSkipDirs`(S10,來源 AI_KM):所有走目錄樹的掃描器共用同一份略過清單(補上 `.next` 等框架
  建置產物目錄,修正 AI_KM 消費者吃到 511 筆 `.next` 雜訊的問題),`gates.config.json` 的
  `skipDirs` 追加在預設清單之後。
- **`check-doc-links.ts`**:新增反引號路徑參照規則(S7)——`` `path/to/file.ts:123` `` 這種
  inline code 形式的路徑參照,要求那個檔案真的存在(不要求那一行真的存在,只驗路徑)。
- **`scripts/py/mutate.py`**:新增 `--cmd` 旗標(來源 AI_KM 的請求),跟 `--expect-fail` 互斥——
  被突變的目標不是用 pytest 驗收時(例如本模板自己的 `check-*.ts`,或任意語言的指令),直接指定
  一段 shell 指令當驗證目標,固定四步(突變前綠 → 突變後非 0 → 精確還原 → 還原後再綠),退出碼 6
  代表這個模式的成功路徑。細節見 `.claude/skills/mutation-testing/SKILL.md`。

### 文件與 skill(這個版本的主要內容)

- **`PITFALLS.md`**:新增 P-60..P-69(數量詞腐爛、規則反覆違反先查守門有沒有跑、cucumber `/`
  alternation、NEXT.md gate 行過期、同步進來沒接線、空保證、守門沒在真專案跑過、
  `gates.config.json` 壞掉被靜默忽略、陽性對照只蓋住被測物、rtk 輸出混訊);修訂 P-46(補 AI_KM
  獨立驗證同一分界)、P-59(補 nightmare 的編號碰撞變體)。
- **`DECISIONS_NEEDED.md`**:編號規則(永不重用、下一個 = 整份檔案最大值 +1)、條目可以是多行區塊、
  「不給不擋」慣例、命名別名說明(nightmare 叫 `PENDING.md`)。
- **`.claude/skills/autopilot/SKILL.md`**:§2.1 合併檢查改成單一入口 `npm run check:all`;
  `{{PARALLEL_CAP}}` 占位符取代寫死的審核輪上限;§2 加派工/改檔前的分支衝突 grep;§3 維護清單插入
  技術顧問側「有沒有工作」六判準(整合點紅清單 → 已批未做 → 接線孤兒/到期 → 見證器未標記 → 下一
  整合點 phase → 維護);§4 加「規則反覆違反先查守門有沒有跑」;§4c 加 rtk 輸出混訊的處理規則。
- **`.claude/skills/phase-acceptance/SKILL.md`**:「合併 ≠ done」小節(gate 綠是合併門檻、DoD 是
  done 門檻、`@known-defect` + `known-defects.json` + `fix_in` 規則);派工前意圖對照;守衛問句
  第四段(這個 0 是量出來的還是探針找不到);嚴格級由另一個 session 跑整支 `/phase-done`、第一步
  就是變異/反向驗證;修正「核心四項」量詞為「核心項(以當下清單為準)」。
- **`.claude/skills/sprint-planning/SKILL.md`**:派工前衝突檢查(grep 撞名、AC 跟 Non-goals 對照、
  場景 `Given` 只准依賴能力範圍內的東西)。
- **`.claude/skills/feature-triage/SKILL.md`**:確認層級(A 且符合准入三條 → 技術顧問確認;B/新功能
  → 使用者確認;技術顧問 30 分鐘沒回應 → 不寫檔,先做其他工作)。
- **`.claude/skills/mutation-testing/SKILL.md`**:改斷言(含加嚴)必須重跑該模組變異測試;
  `scripts/py/mutate.py --cmd` 的 cucumber 層定向反向驗證流程與退出碼 6。
- **`CLAUDE.md`(模板)**:決策表補「規則層變更由使用者決定、技術顧問直接執行不經協調者」。
- **`docs/03-agile-workflow.md`**:合併 ≠ done;NEXT.md gate 行必須可解析(`check:next-gates`);
  紅 `.feature`/紅單元測試分界補 AI_KM 獨立驗證的引用;最小模式補 nightmare 從未用過 sprint 檔的
  引用;修正兩處量詞漂移(「四項」「前四項」)。
- **`docs/06-brownfield.md`**:步驟 9(切換包附刪除清單);「不要把舊 story 一對一映成 phase」。
- **`docs/02-decision-map.md`**:移除依賴圖 mermaid 區塊(三個專案都沒用過),保留待決事項表,依賴
  關係改讀各 ADR 的 Related 欄。
- **`features/_template/FEATURE.md`**:phase 表新增「意圖」欄。**`features/_template/NEXT.md`**:
  整合 gate 補「I1 前留空 = 無 gate」與引用可解析規則。
- **`docs/07-practices.md`**:新增 (r) 退化路徑見證器報告格式(三個只降不升的桶)、(s) 棘輪基準的
  三道鎖、(t) 派工前衝突 grep、(u) 掃描器不自我豁免、(v) 合併例外五條件(刻意不採)、(w) 嚴格級
  另一 session + 第一步固定突變、(x) 守門要對著會變的量、(y) known-defect 逐份按證據等級裁;修訂
  (q)(基準釘 base commit hash、檔名帶 hash 不帶數字)與 (a)(陽性對照要驗探針有作用,不只驗被測物
  存在)。
- **`CHECKLIST.md`**:新增 `{{PARALLEL_CAP}}` 占位符;收工前檢查補「改斷言重跑變異」「main 工作樹
  同時一人動(`readlink /proc/<pid>/cwd` + `grep -vx $$`)」「改 main 前查 in-progress 分支衝突」;
  兩處技術顧問 session 範例值改成不會撞黑名單的通用格式。
- **`README.md`**:新增 `npm run check:all` 單一入口說明,`gates.config.json` 已知鍵改指向
  `scripts/_root.ts` 的 `KNOWN_GATES_CONFIG_KEYS`(不重複維護一份清單)。

### 修正舊文件裡的量詞漂移(本版掃描時發現,不是新坑,是既有文件已經腐爛的例子)

- `docs/03-agile-workflow.md`「審核清單的其餘四項」實際列了 7 項——量詞早就跟內容脫節,改成
  「其餘項目(以下清單為準)」。
- `.claude/skills/mutation-testing/SKILL.md`、`.claude/skills/phase-acceptance/SKILL.md` 的
  `npx stryker run` 範例指令繞過 `npm run mutate` 的檔案鎖(跟 autopilot 自己的規則矛盾),改成
  `npm run mutate -- --mutate "..."`。
- `scripts/sync-gates.sh`、`scripts/README.md`、`scripts/check-next-gates.ts`、`scripts/_root.ts`、
  `scripts/check-all.ts` 裡好幾處「六支守門」「五支守門」「三支掃描器」「第七支」的計數,在本版
  新增四支守門之後全部過期,改成不寫死數字的措辭。

### 升版指南 1.3.x → 1.4.0

1. **`gates.config.json` 加 `chain`**,把每支想在合併前跑的守門(含 consumer 自己的
   `test`/`typecheck`/`accept`)列成 npm script 名字的陣列;沒列進 `chain` 又沒有理由的守門要嘛
   接線、要嘛在 `unwired` 裡帶 `reason`——**`sync-gates.sh --check` 現在會因為「同步進來但沒接線」
   而失敗**,升版後第一次 `--check` 大概率會紅,這是預期的,照訊息接線或加 `unwired` 條目。
2. **`gates.config.json` 不認識的頂層鍵現在會讓整個設定檔失敗**(S9)——升版後對照
   `scripts/_root.ts` 的 `KNOWN_GATES_CONFIG_KEYS`,檢查自己的設定檔有沒有打錯字的鍵或舊版遺留
   的欄位。
3. **`check:doc-links` 新增反引號 `` `file:line` ``參照規則**——升版後預期會抓到新的違規(專案 A
   實測 18 處),這些通常是文件裡寫了「見 `foo.ts:42`」但 `foo.ts` 早就不存在或搬走了,逐一修正
   連結,不要整條規則關掉。
4. **`check:doc-rot` 出貨帶三條黑名單規則**——升版後預期會有命中(專案 A 實測 3 處),照訊息修正
   命中的文字,或者如果命中的是你自己專案的合理例外,把 `doc-rot.blacklist.json` 的初始三條
   改成對照你們自己的事故編輯,不要照抄本模板的三條原封不動。
5. **`check:known-defects` 在你還沒用 `@known-defect` tag 之前是 0 目標**——先不要把它加進
   `chain`,放進 `gates.config.json` 的 `unwired` 並帶理由,或者乾脆先不列進 `chain`;真的開始用
   `@known-defect` 之後再接上。
6. **`standalone.json` 可以用 `_doc`(metadata,不當條目)與 `pending`(預期紅但不擋,過期後轉
   必須綠)** 這兩個新欄位,舊版沒有這些欄位一樣能跑,是新加的可選能力,不用立刻改。
7. **`{{PARALLEL_CAP}}` 占位符要填**:`autopilot/SKILL.md` 與 `CHECKLIST.md` 裡原本寫死的審核輪
   上限「3」換成了這個占位符,升版後 `grep -rn '{{PARALLEL_CAP}}'` 要記得填一個你自己機器規格
   允許的數字,不要留著占位符進生產。

## 1.3.5 — 2026-09-05

七個坑,來源 nightmare-assault 與專案 A(協調者、技術顧問、覆核 agent),全部修在文件與 skill 端
(這版是純 patch:PITFALLS / docs / autopilot 與 mutation-testing 兩個 skill 的措辭,沒有新腳本):

1. **P-53 日期依賴測試**:測試只在跨過某個日期後變紅,失敗訊息不提日期——起因是跑在真實時鐘上的
   測試把「現在」跟一個寫死的時間常數(`Date.UTC(...)`)比較,常數與真實時間的差距總有一天會跨過
   臨界值。規則:真實時鐘上的測試不准用寫死的時間常數;覆核修法時要普查同一個常數的每一處用法
   (實例:39 處用到,只有 2 處真的有關)。
2. **P-54 送到死終端機**:`orchestration send` 對已死的終端機照樣回 `ok:true`,發送端以為送到了,
   接收端什麼都沒收到(P-45 同族)。規則:`send` 前先 `terminal show`;收到 `terminal_handle_stale`
   → 開新終端機,從 REVIEW.md 重新交接。
3. **P-55 必跑清單裡有一條不是 npm script**:漂移檢查(`sync-gates.sh --check`)在 autopilot 裡放了
   好幾天,只是一行手打指令,`package.json` 沒有對應 script,沒人真的跑過。規則:清單裡每一條都要是
   npm script,新加的守門要反向驗證(刻意弄壞 → ✗;修回來 → ✓)。
4. **P-56 push 帶上未驗的合併**:協調者合併進 main 47 秒後,技術顧問只看 `git status` 就 push,
   把還沒驗過的合併一起推了上去——`git push` 推的是 HEAD 以下全部,不是「剛做的那個 commit」。
   規則:push 前 `git log origin/main..HEAD` 逐條驗過;合併後立刻通知,不要累積。
5. **P-57 「保守選項」沒有定義**:「顧問沉默 30 分鐘 → 走保守選項」這條規則沒有可操作定義,worker
   讀成「花力氣最少的那個」。定義:**保守選項 = 一次 `git revert` 就能完整還原的那個**。
6. **P-58 變異分數跨設定檔不可比**:同一份程式碼、同一個工具,兩份 Stryker 設定檔(是否開 TS 型別
   檢查)跑出 3 分以上的差距,也解釋了先前一次被當成「跑錯了、無法重現」的分數落差。規則:分數要
   附完整指令與設定檔路徑,不同設定檔的分數不可比較。
7. **P-59 寫死會過期的識別子**:顧問 session 名、模板 worktree 路徑被寫死進 `CLAUDE.md` 與
   autopilot,session 重開後就過期。規則:寫死的識別子旁邊要寫「怎麼重新找到它」,失敗要吵(非零
   結束),不能安靜地假裝沒事。

同時修訂 **P-49**:補第三種「分支全綠、合併後紅」的形狀——兩棵樹對出同一個總數卻組成不同
(分支 8036+4+4、main 8036+8,總數都是 8044,實際少了四條),以及一個 caveat:對帳比 multiset
不比 count,而且不能用 `set(names)`(會靜默丟掉重複名稱)。

**`autopilot/SKILL.md`(template)追上專案 A 的版本**並吸收 nightmare-assault 的「同型第三次即升類」
規則:補上 `check:gates`(P-55)、junit multiset 基準比對(P-49)、審核輪上限放寬到 3 + 檔案鎖排隊
(P-34)、mutation 分數要附設定檔(P-58)、保守選項定義(P-57)、§4c「分支全綠合併後紅」的三種形狀、
§4b 的送死終端機規則(P-54)、§3/§4 的「停止前確認 worktree 已 commit」與「同型第三次升類」。

**`mutation-testing/SKILL.md`** 補 P-58:分數要附設定檔路徑,回報格式加一行「指令」。

**`docs/07-practices.md`** 新增 (p) 覆核測試修正的三步、(q) 對帳比 multiset 不比 count。

**`CHECKLIST.md`** 新增「收工前 / push 前檢查」一節(不是 placeholder,是流程提醒):worktree 已
commit、push 前逐條驗過、必跑清單每條都是 npm script。

## 1.3.4 — 2026-09-05

專案 A worker 同步 1.3.2 / 1.3.3 到自己的專案時抓到的三個問題,全部修在模板端:

1. **`sync-gates.sh` 語言選集 + `--prune`**:舊版無條件同步 `scripts/py/*.py`,把定向
   反向驗證工具的 Python 版塞進純 TypeScript 專案,還繞過了該專案剛立起來的
   `npm run mutate` 唯一入口(檔案鎖 + 四條「不准繞過鎖」測試掃不到 `.py`,PITFALLS
   P-51)。改成:語言集合由 `--lang ts,py` 旗標 > 目標安裝目錄(或 `<目標根>/scripts/`)
   的 `gates.config.json` 的 `sync.languages` 陣列 > 自動偵測(consumer 根有
   `pyproject.toml` / `requirements*.txt` / `setup.cfg`,或排除 `node_modules`、`.git`、
   本次安裝目錄本身後找得到 `*.py` → 含 `py`;`ts` 永遠在集合裡)決定,每次同步印一行
   「選集 <清單>(<依據>)」。新增 `--prune`:同步後把安裝目錄(含 `py/`)裡**有 SOURCE
   標頭、但所屬語言不在本次選集內**的檔案列出並刪除,該語言目錄清空後一併刪除;**沒有
   SOURCE 標頭的檔案一律不碰**。`gates.config.json` 的 `sync.languages` 欄位補進
   `scripts/README.md`(模板出貨的預設 `gates.config.json` 不含這個欄位,填了語言集合
   會蓋掉自動偵測,對第一次落地的新專案不是好預設)。
2. **`sync --check` 只比對有 SOURCE 標頭的檔**:舊版用 `check-*.ts` 這個檔名 glob 列舉
   目標目錄,會吃到專案自己寫的 `check-*.test.ts`(沒有 SOURCE 標頭)並要求它也符合標頭
   格式,逼專案要嘛改檔名迎合守門、要嘛容忍常態紅燈(PITFALLS P-52)。改成:掃目標目錄
   (含 `py/`)所有檔,第一行符合 `SOURCE: template v` 的才拿去比對;其餘印
   「(非模板檔,略過)」,預設不印,新增 `--verbose` 才印。sha256 自我一致性、HOTFIX
   例外邏輯不變。
3. **`verify-against.sh` 讀到模板自己的佔位設定**:模板版 `check-*.ts` 是直接對
   `$TEMPLATE_DIR/scripts/*.ts` 執行(不經 `sync-gates.sh` 複製),找設定檔的順位 1
   (「腳本自己所在的目錄」)在這個情境下是模板自己的 `scripts/`——裡面是給新專案抄的
   佔位 `boundaries.owners.json`,對 consumer 的真實落點表永遠比出「差異」,即使
   consumer 早就同步好、跟模板行為完全一致。修法:`_root.ts` 的 `resolveConfig` /
   `configSearchPaths` 新增第 0 順位——環境變數 `GATES_CONFIG_DIR`(若設且該目錄
   存在);`check-boundaries.ts`、`check-doc-links.ts` 有自己本地的設定搜尋(因為要跟著
   各自的 `--root` 覆蓋走,不能直接用 `_root.ts` 模組層級固定的 ROOT)同步加上同一個
   第 0 順位。`verify-against.sh` 跑模板版 `check-*.ts` 時設
   `GATES_CONFIG_DIR=<consumer 守門安裝目錄>`,consumer 版不受影響。`scripts/README.md`
   補完整順序:env > 腳本自身目錄 > `ROOT/scripts`。反向驗證:對主 repo(已同步 1.3.2
   版 + 自己的 `boundaries.owners.json`)跑 `verify-against.sh`,boundaries 那支的
   「差異」在修完後消失,六支掃描器全部 `✓ 一致`。
4. PITFALLS 加 **P-51**(模板同步塞 Python 工具、繞過唯一入口鎖)與 **P-52**
   (`--check` 用檔名 glob 猜「哪些是我的」,吃到專案的 `.test.ts`),兩條都插在
   P-12 之前(來源:專案 A worker)。
5. `docs/07-practices.md` (l) 節末尾補一則實例:協調者與技術顧問都推測「六份
   standalone 回歸內容不同」,worker 實測證明六份跑的是同一個 subprocess,找到比
   allowlist 更好的解(一份共用場景掛六個 `@iN`)——「兩個人的推測一致並不會讓它變成
   事實」。

**反向驗證紀錄**:
- `sync-gates.sh`:純 TS 假 repo 同步 → 印「選集 ts(自動偵測:無 Python)」,`scripts/py/`
  不存在;加 `requirements.txt` 重跑 → 選集含 `py`,`scripts/py/*.py` 出現;刪掉
  `requirements.txt` 再帶 `--prune` 重跑 → 選集回到只有 `ts`,`scripts/py/` 底下的檔
  被列出並刪除、目錄本身也刪除,其餘 `.ts` 檔不受影響。
- `sync --check`:目標目錄放一個沒有 SOURCE 標頭的 `check-foo.test.ts` → 綠且預設不提;
  `--verbose` → 印「(非模板檔,略過)」。改一支已同步檔案的一個字 → 紅(sha256 不符);
  HOTFIX 例外、24 小時後過期轉紅、重新 sync 轉綠,行為與 1.3.2 前相同,均已重跑驗證。
- `verify-against.sh`:對主 repo(`/data/python/llm_learning-cards`,已裝 1.3.2 同步版
  + 自己的 `boundaries.owners.json`)跑,六支掃描器(boundaries / doc-links /
  gherkin-dup / phase-coverage / standalone / step-dup)全部 `✓ 一致`,`exit 0`;
  主 repo `git status --short` 前後皆為空(verify-against 沒有在 consumer 留檔)。
- `template/scripts/*.ts` 在 `--strict --exactOptionalPropertyTypes
  --noUncheckedIndexedAccess` 下 `tsc --noEmit` 通過。

## 1.3.3 — 2026-09-05

- autopilot §0 的花費檢查改三態退出碼(0 未達 / 1 已達 / 2 算不出來),2 → 停付費工作 + 工單 + 通知顧問;PITFALLS P-47「不知道不是零」(來源:專案 A worker 依 P-44 第二輪 grep 找到)。

## 1.3.2 — 2026-09-05

1. **嚴格 tsc 修復**:`check-phase-coverage.ts` 的 `loadGatesConfig` 在
   `exactOptionalPropertyTypes: true` 下 TS2375——回傳物件的可選欄位(`cucumberCwd`、
   `runTimeoutMs`)被顯式指派 `undefined`。改用條件展開,只在有值時把欄位放進回傳物件。
   `template/scripts/*.ts` 全部改用**採用專案最嚴的 tsconfig**旗標驗證一次(`strict`、
   `exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`),全數通過;`scripts/README.md`
   新增「型別驗證」段落,把這組指令寫進去。
2. **`check-gherkin-dup.ts` allowlist**:`gates.config.json` 新增 `gherkinDup.allow`
   (`{ scenario, onlyUnder?, reason }` 陣列)——命中的重複組場景名全等於 `scenario`、
   (有給 `onlyUnder` 時)所有檔案路徑都以它開頭、且 `reason` 非空,才印
   `○ 允許:<scenario>(<reason>)` 不算紅;`reason` 空或缺,該條目無效並印警告,該組
   照常判紅。範例設定加一條(`"Every standalone entry point still runs"`、
   `onlyUnder: "docs/integration/"`,理由「每個整合點各自重跑一次 standalone 回歸
   (ADR-024)」)。`scripts/README.md` 補這個欄位的說明。
3. **PITFALLS P-45**:worker 用平台阻塞式 `ask` 問協調者,協調者用 `send` 回了完整裁示,
   `ask` 等的是 `reply` 不是新訊息,worker 逾時走保守選項——雙方以為溝通成功純屬運氣。
   P-44 症狀欄補一句:複習指令對 0 張卡與 0 張到期都印「Nothing is due today」exit 0,
   同型於「0 problems found」。
4. **autopilot §4a / §4b**:§4a「不是停止條件」併入六種(來源專案 A 協調者):平台
   runtime 掛掉(先用 `git`/`pgrep -af claude` 確認 agent 活著,不重派)、worker 開
   escalation、worker 說「我不照工單做」並附實測、工單被 superseded、變異第一次量到
   40–60%、`accept:dry` 的 undefined 很多;結尾加「把這些誤判成停止,比漏掉一個真煞車
   更常發生」。§4b 加 P-45 的 reply/ack 順序規則。
5. **07-practices (d)**:補「量退出碼時不接 pipe」——`cmd | tail` 抓到的是 `tail` 的
   退出碼,不是 `cmd` 的;改用 `out=$(cmd); rc=$?`。
6. **consumer 實測回報六件(來源專案 B,對 1.2.2 的實測)**:
   - **(A) 設定檔位置**:`_root.ts` 新增 `resolveConfig(scriptDir, name)` /
     `configSearchPaths`,找設定檔的順序改成「腳本自己所在的目錄(sync 後就是 consumer
     的安裝目錄,例如 `features/scripts/`)→ `ROOT/scripts/`」,不是只認後者——
     `check-phase-coverage.ts`、`check-doc-links.ts`、`check-gherkin-dup.ts`、
     `check-boundaries.ts` 都改用這個順序;必要設定(`boundaries.owners.json`)找不到
     印「設定檔未找到於 <兩個路徑>」。`cucumberCwd` 指向不存在的目錄維持 exit 1,
     不會被自動偵測靜默救回。
   - **(B) `verify-against.sh` 的安裝目錄**:找 consumer 守門改成依序找
     `<consumer>/scripts/`、`<consumer>/features/scripts/`、
     `find <consumer> -name _root.ts -maxdepth 4` 找到的第一個目錄,或
     `--consumer-dir <子目錄>` 明講;四層都沒有才印「consumer 未裝守門」。
   - **(C) `verify-against.sh` 的同型 bug**:退出碼 127(command not found)以前會被
     報成「✓ 未觸發 0 目標守衛」然後 exit 0——工具自己犯了它要抓的那種「空檢查 = 通過」。
     修法:六支掃描器結尾都印一行 `gate=<name> result=PASS|FAIL scanned=<N>`;
     `verify-against.sh` 判定一次執行「算不算數」要求退出碼是 0 或 1 **且**輸出含這行
     標記,缺一即「未執行 → FAIL」。反向驗證:把 consumer 的某支腳本改壞讓它跑不起來
     → verify-against 紅並印「未執行」(已用 fake consumer 驗證,見下)。
   - **(D) `--check` 在 CI 自包含**:`sync-gates.sh` 的 SOURCE 標頭改成
     `// SOURCE: template vX.Y.Z (commit) sha256=<檔身雜湊>`;`--check` 改成重算已安裝
     檔案的 sha256 跟標頭裡的比對,**不讀 `$TEMPLATE_DIR`**(sync 才需要模板路徑)。
     HOTFIX 行邏輯不變(第 2 行,24 小時內警告、過期紅)。反向驗證:把已同步的 consumer
     整份複製到別處(模板路徑不可達)跑 `--check` → 綠;改一字 → 紅(已驗證,見下)。
   - **(E) coverage `--run` 只跑該跑的 phase**:讀 `features/<NN>/FEATURE.md` phase 表的
     狀態欄,`done` / `in-progress` 才真跑,`todo` / `ready` / `blocked` 或解析不到只
     dry-run 並印「(todo,略過真跑)」;`--run-phases <folder>/phase-N,...` 手動蓋過。
   - **(F) 分支與提交**:`docs/03-agile-workflow.md` 補一條——「測試先紅」階段 `.feature`
     可以先進 main(tag 讓紅對 CI 隱形),**紅的單元測試不行**,合併點在綠之後;誤合了
     用 `revert`,不用 `test.fails` / `.skip` 藏。PITFALLS 加 **P-46** 記這條。

已知迴歸(1.3.4 修):`--check` 用 `check-*.ts` glob 吃到專案自己的 `.test.ts` 檔;
`verify-against.sh` 跑模板版時讀到模板自己的佔位 `boundaries.owners.json`。

**反向驗證紀錄(這一版實際跑過,不是紙上談兵)**:
- gherkin-dup allowlist:假 repo 兩個 `docs/integration/*.feature` 場景名、步驟本體都
  逐字相同 → 紅;加上面範例的 allow 條目 → 綠並印「○ 允許:…」;把 `reason` 清空 → 紅
  並印「allow 條目無效」;把其中一個檔搬到 `features/` 底下(`onlyUnder` 不符)→ 紅。
- `sync-gates.sh --check`:自包含(複製到看不到模板路徑的地方仍能跑)→ 綠;改一字 → 紅;
  加今天的 HOTFIX 行 → 警告仍綠;HOTFIX 日期改三天前 → 紅;重新 sync → 綠。
- `verify-against.sh`:consumer 守門搬到 `features/scripts/`,不加 `--consumer-dir` 也
  自動找到;搬到 4 層搜尋範圍外的怪目錄且不給 `--consumer-dir` → 判「consumer 未裝」,
  加 `--consumer-dir` 指過去 → 找到並比對;把 consumer 的一支腳本改壞跑不起來 → 紅並
  印「未執行」,不是被誤判成「一致」或退出碼巧合相同。
- `template/scripts/*.ts` 全部在 `--strict --exactOptionalPropertyTypes
  --noUncheckedIndexedAccess` 下 `tsc --noEmit` 通過。

## 1.3.1 — 2026-09-05

1. 收 Python 版定向反向驗證工具:`scripts/py/mutate.py` + `scripts/py/test_mutate.py`(meta-test),
   原樣複製自 nightmare-assault(專案 C)`dev/tools/mutate.py` / `tests/test_mutate.py`
   (HEAD `4f1948ac`),使用者授權收入;檔頭加 SOURCE 註解,`MUTATE_PY` 改成同目錄相對路徑
   讓 meta-test 能在 `scripts/py/` 下獨立跑(`python3 -m pytest test_mutate.py -q`,不依賴
   專案 C 的 repo 佈局或 `conftest.py`)。多處命中 `--replace` 拒絕並列出行號、`--nth <k>`
   指定第幾處——這是專案 C 原本就有的實作(STORY-70-14),連同對應的兩個測試
   (`test_ac_nth_rejects_non_unique_replace_without_nth`、
   `test_ac_nth_mutates_only_the_specified_occurrence`)一起收進來,既有 17 個測試全過。
   新增 `scripts/py/README.md` 說明用法、exit code 表、跟 `docs/07-practices.md` (e) 的對應;
   (e) 節的「Python 版待授權」改成「已收於 `scripts/py/mutate.py`」。`sync-gates.sh` 新增
   `scripts/py/*.py` 的同步(每次覆蓋、版本標頭用 `#` 開頭的 Python 註解,不是 `//`),
   設定檔清單不變。
2. `PITFALLS.md` 加 P-44:修完一類問題(三支開發用掃描器加了 0 目標守衛)卻漏了使用者資料
   健檢 `lint`——它對空目錄照樣印「0 problems found」exit 0。
3. `README.md`「版本」段加「採用節奏」:consumer 鎖定一版一次驗到底、每個整合點最多升一次
   (除非某版修的是正擋著你的迴歸);模板端只在 consumer 回報或整合點出版。
4. `check-phase-coverage.ts`:(a) 第一行不是 tag 行時的失敗訊息加一句「第一行必須是 tag 行
   (`@name @phase-N …`),註解或 `# PROPOSAL` 之類請放第二行起」;(b) `--run` 對每個 phase 檔
   的逾時毫秒數改成可設定:`gates.config.json` 的 `phaseCoverage.runTimeoutMs`(預設
   600000),逾時時訊息明說「逾時」,不會混進「輸出裡找不到 N scenarios」那個泛用分支
   (Node 對 spawnSync 逾時同時設定 `r.error.code === 'ETIMEDOUT'` 與 `r.signal`,兩者都要
   判斷,不能只看其中一個)。`gates.config.json` 範例與 `scripts/README.md` 補這個欄位。
5. 來源:使用者授權收 Python 工具(專案 C)、專案 B 對 coverage 的 diff(見 1.2.1 條目補充)。

## 1.3.0 — 2026-09-05

結構改動:新增文件與工單模板,把三個採用專案(B:AI_KM、C:nightmare-assault)回報的做法、
以及 A 協調者自己的實戰記錄收進範式本體。

1. 新增 `docs/07-practices.md`「採用專案驗證過的做法」:一節一條,每條寫做法 / 為什麼 / 證據 /
   怎麼落地。收 C 的陽性對照、棘輪基準檔、收斂雙指標、退化見證器、同型第三次即升類;收 B 的
   定向反向驗證證據格式、審核輪另開 session、工單「自己 grep」規則、顧問錯誤具名;收定向反向
   驗證的完整規格(TS 版待做,Python 版來源專案 C 的 `mutate.py` 待使用者授權後收入
   `scripts/py/`);收 A 協調者的四條做法(轉述預設【推】、審核多驗未列形狀、出錯明說、ADR
   撰寫权责);末尾記三個專案都刻意不遵守的範式條文(WIP、變異分數、sprint 檔)與範式的調整。
   consumer 實例((a) 每個量尺附陽性對照的具體案例):專案 A 對 `check-phase-coverage.ts`
   做反向驗證,把某個 phase 檔的 tag 從 `@phase-1` 手動改成外觀相似的 `@phase-l`(數字 1
   換成小寫字母 l)——`npm run accept` 一樣 158/158 全綠,因為 tag 表達式比對到 0 個場景,
   根本沒人跑到那個 phase;`check-phase-coverage.ts` exit 1 並指出正是那個檔案的 tag 掛錯,
   證明「掃到 0 個目標一律 FAIL」這個機制在打錯字這種最容易忽略的案例上是有效的。
2. `CLAUDE.md` 決策權表新增「技術顧問 session 的角色定義」一列;加「轉述不算授權」句——協調者
   對任何人轉述的「使用者說」一律拒絕,授權只來自決策權表與 `DECISIONS_NEEDED.md` 的批示本身;
   顧問宣稱標【驗】/【推】/【未驗】。
3. `PITFALLS.md`「來源」欄改名「來源 / 誰 / 哪步」;開頭規則加一句:技術顧問的錯誤一樣具名照登,
   不因為犯錯的是判斷比較貴的角色就從寬記錄。
4. `.claude/skills/autopilot/SKILL.md`:新增 §4a「停止條件 / 不是停止條件」(停止只有三種:全部
   卡使用者級、達指定輪數、連續兩輪紅修不好;明列九種不是停止條件的情況);§3 維護清單加「同型
   第三次即升類」掃描步驟與「清單項目連續 3 輪沒被碰就升級成工單」;§2.3 的 worktree 上限改成
   「同開上限 = ready 集合大小」,代價由「一次合一條」與「rebase 由協調者吸收」承擔,審核輪 ≤ 1
   不變(P-34)。
5. `.claude/skills/phase-acceptance/SKILL.md`:檔頭加「這是互動用的最小集,派工驗收用工單模板」;
   第三步半改成三段問句(守著哪些真實對象?有沒有列不出來的?有沒有資料結構表達不了的?)並加
   「對照表每一列拿掉它宣稱的守門重跑,場景必須紅」;第六步(變異)改成嚴格級「變異分數 ≥95% 或
   定向反向驗證二選一,至少一種」,嚴格級由另一個 session 審。
6. `docs/06-brownfield.md` 步驟 6 加回填對照表格式(`場景 → 既有測試檔:測試名`)與「綁不到既有
   測試的行為不准進 phase-1」;附證據:B 11 資料夾一天處理 136 場景、靠對照表抓到 2 處 overclaim。
7. 新增 `.orca-brief/TASK.md.template`(工單模板,原樣取自專案 B 實戰用的形狀):編號驗收條件、
   每條自帶反向驗證、「從 grep 推導清單、不信任何列舉」欄、明列不准動的東西(用路徑列舉)、
   回報格式含「工單哪裡說不通」;`CHECKLIST.md` 補對應的 4 個 placeholder;`README.md` 步驟 5
   指到它。
8. `docs/03-agile-workflow.md` 角色表補「技術顧問宣稱標【驗】/【推】/【未驗】」與收斂指標
   (黃金路徑階數只升、見證器未標記數只降,todo 數不算)一句;`README.md`「核心原則」加第 9 條
   「沒有陽性對照的 gate 不算 gate」。

來源:B(AI_KM)、C(nightmare-assault)兩個採用專案的回報,以及 A 協調者自己的實戰記錄
(`docs/paradigm/coordinator-practices-2026-09-04.md`)。

## 1.2.2 — 2026-09-05

- `check-doc-links.ts` 排除清單迴歸修復:1.2.0 以主 repo 版本重寫時,`SKIP_SEGMENTS` 只帶了 `node_modules`、`archive`,漏掉主 repo 版原本就有的 `dist`、`.git`、`target`、`.svelte-kit` 四個——1.2.1 也沒補。內建預設補回這四個並加 `.stryker-tmp`(變異測試暫存),恢復成 `[node_modules, .stryker-tmp, dist, .git, target, .svelte-kit, archive]`。
- 排除清單設定化:`scripts/gates.config.json` 新增可選欄位 `docLinks.skipSegments` / `docLinks.skipPrefixes`,**追加**到內建預設(不是取代),專案有自己的建置產物目錄名不必改 `check-doc-links.ts` 本體;實際生效的排除清單印在輸出第一行。`gates.config.json` 範例、`scripts/README.md` 補說明。
- 新增 `scripts/verify-against.sh <consumer repo 根>`:出版前的機械檢查,把模板版每支 `check-*.ts` 跟 consumer 已裝的同名檔各跑一次,比退出碼、輸出(去 ANSI/尾空白/版本標頭)、旗標清單(`--[a-z-]+` 集合)三件事,列出差異;consumer 沒裝任何守門則只做模板版的退出碼與 0 目標守衛檢查。`template/README.md`「版本」段加出版規則:**沒有對至少一個 consumer 跑過 `verify-against.sh` 不打 tag**,差異逐項標刻意改進或迴歸寫進該版 CHANGELOG。
- 來源:專案 A 協調者對 1.2.0 的第二次擋下——排除清單迴歸這次是機械比對抓到的,不是靠人眼複查,顯示光靠「以主 repo 版本重寫」這句話不夠,還需要一支腳本逐項比對才會被逼著檢查完整。

## 1.2.1 — 2026-09-05

- `check-phase-coverage.ts`:cucumber 執行目錄(cwd)改成三層決定——`--cwd` 旗標、`scripts/gates.config.json` 的 `"cucumberCwd"`、自動偵測(ROOT 有 cucumber 設定就用 ROOT,否則掃 ROOT 直接子目錄找第一個含 cucumber 設定的);三層都沒有就 exit 1。修的是:cucumber 設定不在 repo 根而在某個 workspace package(例如 `features/cucumber.js`)時,舊版寫死 `cwd: ROOT` 會讓 `npx cucumber-js` 完全找不到設定,「N scenarios」抓不到甚至卡住。
- 新增 `--run` 旗標:預設仍是 dry-run(只抓 tag 掛錯與 undefined,不執行 step 內容);加 `--run` 時額外真跑一段,要求 `N scenarios (N passed)` 且 N ≥ 1,輸出含 failed/undefined/ambiguous 一律算該 phase 紅。兩段分開印,因為兩段抓的病不同(dry-run 抓接線問題、`--run` 抓執行期的邏輯問題)。
- 新增 `scripts/gates.config.json`(範例 `{"cucumberCwd": "."}`),納入 `sync-gates.sh` 的 `CONFIG_FILES`(目標不存在時才複製一次,`--check` 跳過比對);`scripts/README.md` 補說明。
- 來源:專案 B 對 1.2.0 的 diff——AI_KM 的 cucumber 設定在 `features/` 底下,不在 repo 根。
- consumer 驗證實例:專案 B:coverage 抓到 `02-authorization/phase-2.feature` 第一行是 `# PROPOSAL` 註解不是 tag 行,其自有的 coverage 只掃 phase-1、只驗選得到場景,結構上看不到。

## 1.2.0 — 2026-09-05

- `check-boundaries.ts`、`check-standalone.ts`、`check-doc-links.ts` 三支以主 repo(採用專案)的版本為準重寫,補回舊模板版少掉的功能:`check-doc-links.ts` 換成真正的 CommonMark 圍欄規則(收尾圍欄無 info string 且長度 ≥ 開頭、`~~~`、最多 3 格縮排、inline code 用配對掃描而不是非貪婪 regex);`check-boundaries.ts` 補 `--root`、`--verbose`、掃到 0 個檔案 FAIL；`check-standalone.ts` 補 `--manifest`、`--only`、`--list`、`--timeout`、讀到 0 個條目 FAIL。
- **程式與設定分離**:`check-boundaries.ts` 的落點表(OWNERS)、glue 集合、alias 對映、掃描範圍抽到 `scripts/boundaries.owners.json`(格式見 `scripts/README.md`),腳本讀 ROOT 下的這份檔,不存在就 exit 1 並印範例;附一份用採用專案落點表當範例的 `boundaries.owners.json`。`check-standalone.ts` 的暫存目錄清理改成讀每個條目可選的 `"cleanup": [...]` 陣列,執行前後各清一次,不再寫死目錄名稱。
- `sync-gates.sh` 新增「設定檔」清單 `CONFIG_FILES`(`boundaries.allow.json`、`boundaries.owners.json`):只在目標不存在時複製一次,之後永遠不覆蓋;`--check` 對這些檔案跳過比對,印「(你的設定檔,不比對)」。
- 新增 `scripts/README.md` 說明落點表在 `boundaries.owners.json`。
- 來源:專案 A 協調者在同步模板到專案時擋下的迴歸——舊模板版三支掃描器是主 repo 版本的舊子集,直接同步會讓已經修好的圍欄誤報、落點檢查漏檢等問題重新出現。

## 1.1.2 — 2026-09-05

- PITFALLS P-15 補「量化數字重跑」、新增 P-35(宣稱要有測試 + 開發輪自跑變異)、P-36(檢查不准留副作用)、P-37(不用 `git push --tags`);docs/03 審核清單第 7 項。

## 1.1.1 — 2026-09-04

- `sync-gates.sh --check`:本地急修規則——守門檔第 2 行 `// HOTFIX: YYYY-MM-DD <理由>` 可暫時偏離模板,--check 只警告;超過 24 小時未回流模板即紅(來源:專案 B 提問「--check 當 CI gate 的前提」)。

## 1.1.0 — 2026-09-04

- 新增 `scripts/sync-gates.sh`:把守門複製進目標 repo 並寫入版本標頭(`// SOURCE: template vX.Y.Z (commit)`),`--check` 比對版本與內容。CI 上沒有模板路徑,守門必須自包含;靠版本號防漂移,不靠路徑(來源:專案 B 修正)。
- README「版本」段:採用方式改成 sync-gates,不再建議直接呼叫模板路徑。

## 1.0.1 — 2026-09-04

- 六支守門腳本的 ROOT 改用 `git rev-parse --show-toplevel`(退回 `process.cwd()`)解析,抽成共用模組 `scripts/_root.ts`,腳本可直接從模板路徑對目前 cwd 所在的 repo 執行,不必先複製進去
- `check-doc-links` 掃描根改聯集加 `.claude/`(排除 `.claude/worktrees/`)——agent 每次載入的 commands / rules / skills,壞連結比一般 docs 更貴

(來源:專案 B 對照回饋)

## 1.0.0 — 2026-09-04

第一個有版本的發布。內容累積自三個專案(A:本 repo,greenfield;B:AI_KM;C:nightmare-assault,皆 brownfield)兩天的實戰。

- 結構:CLAUDE.md(含決策權表與 DECISIONS_NEEDED 格式)、contracts/、docs/00–06、features/(_template、steps)、scripts/(check-boundaries、check-standalone、check-step-dup、check-gherkin-dup、check-phase-coverage、check-doc-links)、standalone.json、cucumber/vitest/stryker 設定、.claude/skills/ 七個(六個流程 + autopilot)
- PITFALLS P-01 ~ P-32
- docs/06-brownfield:greenfield 與 brownfield 的切入順序

## 0.x — 2026-09-03 ~ 09-04(未版本化)

從專案 A 抽出;逐日加入 P-01..P-29、autopilot、角色分工、brownfield 心得。歷史見分支 `template/dev-paradigm` 的 commit。

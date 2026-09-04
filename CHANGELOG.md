# CHANGELOG

版本規則(semver):PITFALLS / docs / 措辭改動升 **patch**;新增或改變檔案結構、腳本、CLAUDE.md 固定段落升 **minor**;改硬規則或落地步驟升 **major**。
採用模板的專案在自己的 `CLAUDE.md` 記「採用模板 vX.Y.Z」;升版時用
`git diff <採用版 tag>..<新版 tag> -- template/` 決定要不要跟。每個版本打 tag `template/vX.Y.Z`。

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

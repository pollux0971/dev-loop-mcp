# 落地清單

`init` 落地之後(見 README 步驟 0),把下面每一個 `{{PLACEHOLDER}}` 找到、填掉。表格依檔案分組,
「填什麼」是給你的指引,「本專案的例子」是抽出這套範式的來源專案(一個桌面學習卡片系統,
教學卡 + 考試卡,LLM 產生內容、間隔重複排程)實際填的值,照抄格式,不要照抄內容。

> `README.md` 裡出現的 `` `{{PLACEHOLDER}}` `` 字樣是在說明「有一個東西長這樣」,
> 不是一個真的要填的欄位,不在下面的表裡。

驗證方式:全部填完後,在新專案根目錄執行下面這行,應該沒有任何輸出:

```bash
grep -rlF '{{' --exclude-dir=node_modules --exclude-dir=.git \
  --exclude=CHECKLIST.md --exclude=CHANGELOG.md --exclude=PITFALLS.md \
  --exclude=README.md --exclude=07-practices.md .
```

排除的 5 份是在文字裡介紹或引用 placeholder 的文件,不是要填的地方。(1.7.0 以前這裡寫 `grep -rn '{{' .`——本檔自己就有幾十行 `{{`,那個指令永遠不可能回傳空。)

表格裡 `{{X_1/2/3}}`、`{{X_1..5}}` 這種寫法代表一組編號連續的 placeholder,每一個都要填。

## AGENTS.md

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{PROJECT_NAME}}` | 專案名稱,一句話介紹自己時會用的名字 | 桌面學習卡片系統 |
| `{{HARD_CONTRACT_SECTIONS}}` | 契約裡屬於硬約定的章節,寫成「磁碟格式 §X §Y……」的形式 | 磁碟格式 §2 §3 §4 §8–§12、§7 的 `LlmTask` 與路由表 |
| `{{HARD_RULE_2}}` | 你的第二條硬規則,通常是「不改某個唯讀輸入目錄」 | 不改 `raw/`。那是使用者的素材。 |
| `{{HARD_RULE_3}}` | 你的第三條硬規則,通常是一個程式硬檢查的數字或格式上限 | 教學卡 body 上限 100 字,程式硬檢查,不是靠 prompt 拜託 |
| `{{HARD_RULE_4}}` | 你的第四條硬規則,通常跟「改了某個東西要跑品質檢查」有關 | 改了 `prompts/` 底下任何檔案就要跑 golden run |
| `{{STATE_DIR}}` | 存放長期累積狀態的目錄,寫入要求原子性 | `state/` |
| `{{DOMAIN_SPECIFIC_ROUTING_RULE}}` | 如果有「所有某類呼叫都要經過同一個介面」的規則,寫在這裡;沒有就整條刪掉 | LLM 呼叫經過 llm-router 的介面,不在別處 import provider SDK |
| `{{DOC_LANGUAGE}}` | 文件用的語言 | 繁體中文 |
| `{{STRICT_MODULES}}` | 嚴格級變異測試涵蓋的模組清單 | scheduler、grading 前兩層、驗證器、weekly 計數、路徑防護 |
| `{{CORE_LANGUAGE}}` | 核心邏輯的程式語言 | TypeScript |
| `{{CORE_PACKAGE_PATH}}` | 核心邏輯共用套件的路徑(monorepo 才有) | `packages/core` |
| `{{SCRIPT_RUNTIME}}` | 腳本的執行方式 | TypeScript,`tsx` 執行 |
| `{{PLATFORM_LAYER_LINE}}` | 平台層一行說明,沒有原生殼層就整行刪掉 | 桌面:Tauri 2 + Svelte 5,Rust 只做視窗、系統列、fs、自啟 |

## contracts/README.md

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{HARD_SECTION_1..4}}` | 硬約定章節的簡短說明,一節一行 | §2 卡片格式、§3 考題格式、§4 複習狀態、§7 的 `LlmTask` 與路由表 |
| `{{SOFT_SECTION_1..3}}` | 軟約定章節的簡短說明,一節一行 | §5 `GradeResult`、§6 排程函式簽章、§13 `LearningFs` |

## contracts/types.md

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{CONTRACT_VERSION}}` | 契約目前版號 | 1.1.0 |
| `{{HARD_CONTRACT_SECTIONS}}` / `{{SOFT_CONTRACT_SECTIONS}}` | 同 AGENTS.md,以及軟約定章節清單 | 硬:§2 §3 §4 §8–§12;軟:§5 §6 §7 函式簽章 §13 |
| `{{ENTITY}}` / `{{ENTITY_DIR}}` / `{{ENTITY_EXT}}` | 核心實體名稱、存放目錄、副檔名 | `Card` / `cards` / `md` |
| `{{SECOND_ENTITY}}` / `{{SECOND_ENTITY_DIR}}` / `{{SECOND_ENTITY_EXT}}` | 第二種磁碟格式的名稱、目錄、副檔名 | `QuestionFile` / `questions` / `yaml` |
| `{{STATE_DIR}}` / `{{STATE_FILE}}` / `{{STATE_ENTRY_TYPE}}` | 狀態檔目錄、檔名、單筆記錄型別 | `state` / `reviews.json` / `ReviewEntry` |
| `{{RESULT_TYPE}}` | 某個計算結果的軟約定型別名 | `GradeResult` |
| `{{CORE_FUNCTION}}` | 一個代表性的核心函式簽章 | 排程的 `dueToday(state, today)` |
| `{{TASK}}` | 跨模組任務常數的型別名(沒有路由需求就刪掉整節) | `LlmTask` |
| `{{FS_INTERFACE}}` | 檔案系統抽象介面名稱 | `LearningFs` |
| `{{PROJECT_DATA_ROOT}}` | 使用者資料的根目錄 | `learning/` |
| `{{HARD_SECTION_1_NUM}}`..`{{HARD_SECTION_3_NUM}}`、`{{HARD_CONTRACT_SECTIONS_4_NUM}}`、`{{HARD_CONTRACT_SECTIONS_5_NUM}}` | 對應章節的實際編號 | 2 / 3 / 4 / 7 / 12 |
| `{{SOFT_SECTION_1_NUM}}`..`{{SOFT_SECTION_3_NUM}}` | 對應軟約定章節的實際編號 | 5 / 6 / 13 |
| `{{DIR_STRUCTURE_SECTION_NUM}}` | 目錄結構那一節的編號(`00-design.md` 用來對照) | 12 |

## contracts/fixtures/README.md

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{FIXTURE_MINIMAL_DIR}}` / `{{FIXTURE_MINIMAL_DESC}}` | 最小合法資料集目錄名與一句描述 | `learning-minimal` / 3 張真的資安卡、1 個類別 |
| `{{FIXTURE_BROKEN_DIR}}` | 刻意壞掉的資料集目錄名 | `learning-broken` |
| `{{FIXTURE_UNIT_DIR}}` | 單一實體樣本目錄名 | `cards` |
| `{{FIXTURE_STATE_DIR}}` | 狀態組合樣本目錄名 | `reviews`(與 `weekly`) |
| `{{FIXTURE_EXTERNAL_DIR}}` | 外部呼叫重播樣本目錄名(沒有就刪) | `llm` |
| `{{FIXTURE_RAW_DIR}}` | 原始素材樣本目錄名 | `raw` |

## docs/00-design.md

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{PROJECT_NAME}}` | 同上 | 桌面學習卡片系統 |
| `{{DOMAIN_ONE_LINER}}` | 一句話說明專案在做什麼 | 兩張常駐桌面的小卡片:教學卡每次教一個 100 字內的概念,考試卡用固定骨架考你 |
| `{{DIR_STRUCTURE_SECTION_NUM}}` | 同 `contracts/types.md` | 12 |

## docs/01-roadmap.md

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{INTEGRATION_COUNT}}` | 整合點總數 | 8 |
| `{{CONTRACT_VERSION}}` | 同上 | 1.1.0 |
| `{{TODAY}}` | 「最後更新」的日期 | 2026-09-02 |
| `{{WAVE0_COUNT}}` | Wave 0 平行的 phase-1 數量 | 11 |
| `{{FEATURE_01}}` / `{{FEATURE_02}}` | Wave 0 表裡的功能資料夾名稱 | `01-data-layer` / `02-ingest-pipeline` |

## docs/02-decision-map.md

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{TODAY}}` | 這批範式 ADR 記錄的日期(通常就是專案啟動日) | 2026-09-02 |
| `{{PENDING_DECISION_1/2}}` / `{{PENDING_BEFORE_1/2}}` / `{{PENDING_BLOCKS_1}}` | 你自己專案的待決事項——這三個範例列可以整組刪掉重寫 | 本機模型與硬體 / I1 前 / `03-llm-router/phase-2` |

## docs/05-parallel-and-integration.md

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{FEATURE_EXAMPLE_1/2/3}}` / `{{DEPENDENCY_EXAMPLE_1/2/3}}` | Wave 0 表裡「功能需要什麼、怎麼用 stub 解決」的範例列 | `02-ingest-pipeline` 需要 LLM → 用 `FakeLlmRouter` 重播 fixture |
| `{{I1_CAPABILITY}}` / `{{I2_CAPABILITY}}` / `{{I3_CAPABILITY}}` | 各整合點「你做得到什麼」的一句話 | I1:丟一篇文章進去,得到一疊可讀的卡片;I2:每天在終端機複習,間隔重複真的在跑 |

## docs/sprints/README.md

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{FEATURE_FOLDER}}` | 範本裡的範例資料夾名 | `06-test-card` |
| `{{STANDALONE_COMMAND_EXAMPLE}}` | 範本裡的範例單獨執行指令 | `npm run dev -w apps/test-card` |

## features/README.md

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{FEATURE_NAME_1/2}}` | 索引表裡的功能名稱 | data-layer / ingest-pipeline |
| `{{STANDALONE_CMD_1/2}}` | 對應的單獨執行指令 | `npx tsx packages/core/src/schema/cli.ts validate <file>` |
| `{{FEATURE_TAG}}` | Gherkin tag 範例用的功能標籤 | `@scheduler` |

## features/steps/README.md

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{FEATURE_A}}` / `{{FEATURE_B}}` | 步驟檔命名範例 | `scheduler` / `grading` |
| `{{FIXTURE_TODAY}}` | 通用步驟表裡「today is」範例用的日期,要跟 `_world.ts` 的預設值一致 | 2026-09-10 |
| `{{FEATURE_NAME}}` | 只出現在 `standaloneKey()` 的註解範例裡,跟 `{{FEATURE_TAG}}` 成對:feature 資料夾名稱去掉 `NN-` 編號的那一段 | `ingest`(對應 `@ingest` → `01-ingest`) |
| `{{FEATURE_TAG}}` | 同上 | `scheduler` |

## features/steps/_world.ts

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{FIXTURE_TODAY}}` | `today` 欄位的預設值,要跟某個常用 fixture 的假設對齊(格式 `YYYY-MM-DD`) | `2026-09-10` |

## scripts/boundaries.owners.json

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{FEATURE_SRC_DIR}}` / `{{FEATURE_OWNER}}` | 落點表的一行:原始碼子目錄與擁有它的功能資料夾名。每個 Wave 0 能力一行,照這行複製 | `scheduler` / `04-scheduler` |

⚠️ **填的是 `scripts/boundaries.owners.json`,不是 `scripts/check-boundaries.ts`。** 1.7.2 以前這一節標題寫的是
`check-boundaries.ts`、placeholder 也放在那支檔的範例字串裡——但它是**受 sync 管理的守門檔**(第一行有 SOURCE 標頭),
照填的話 `sync-gates.sh --check` 會報「內容被改過」,錯誤訊息還會建議你加 HOTFIX 註解。
另外 1.7.2 以前出貨的 `boundaries.owners.json` 是**來源專案的真實落點表**(`02-ingest-pipeline`、`apps/desktop`…),
跟新專案無關,導致 `npm run boundaries` 回報「掃描到 0 個檔案」;1.7.3 起換成只有通用列的骨架。

## standalone.json

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{FEATURE_01}}` | 第一個功能的 key,通常跟資料夾同名 | `01-data-layer` |
| `{{STANDALONE_CMD_1}}` | 該功能的單獨執行指令 | `npx tsx packages/core/src/schema/cli.ts validate contracts/fixtures/cards/valid-basic.md` |
| `{{STANDALONE_EXPECT_1}}` | 指令輸出應包含的關鍵字 | `OK` |

## package.json

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{PROJECT_NAME}}` | npm 套件名稱(kebab-case) | `learning-cards` |

## stryker.config.json

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{MUTATE_GLOB_1}}` | 要跑變異測試的原始碼 glob | `packages/core/src/**/*.ts` |
| `{{MUTATE_GLOB_1_TEST_EXCLUDE}}` | 排除測試檔的 glob | `packages/core/src/**/*.test.ts` |
| `{{MUTATE_GLOB_1_INDEX_EXCLUDE}}` | 排除 barrel file 的 glob | `packages/core/src/**/index.ts` |

## .env.example

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{ENV_VAR_1/2/3}}` | 你的專案實際需要的環境變數名稱(沒有外部服務依賴就整份檔案刪掉) | `OPENAI_API_KEY` / `LLM_CLOUD_PROVIDER` / `LLM_CLOUD_MODEL` |

## .claude/skills/mutation-testing/SKILL.md

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{STRICT_MODULES}}` | 同 AGENTS.md | scheduler、grading 前兩層、驗證器、weekly 計數、路徑防護 |
| `{{STANDARD_MODULES}}` | 標準級模組清單 | ingest 非 LLM 部分、lint 檢查、llm-router 路由決策 |
| `{{RELAXED_MODULES}}` | 寬鬆級模組清單 | adapter、CLI 進入點、Svelte 元件、Tauri command |
| `{{BOUNDARY_CASE_1/2/3}}` | 你專案自己的數值邊界情境 | body 剛好 100 字 / 101 字;`fails_in_row` 剛好 2 / 3;ISO 週的年末交界 |
| `{{CRITICAL_LOGIC_1..5}}` | 你專案自己的高風險邏輯清單 | 排程間隔常數表 / 逾期比例計算 / 字數計算 / session 邊界 / 審核三層短路 |

## docs/04-glossary.md

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{TERM_ENTITY}}` | 術語表第一條:你的核心資料實體叫什麼、一句話定義 | 卡片 / card,LLM 產生的教學單位,body ≤ 100 字 |

## 其餘散落的通用 placeholder

| Placeholder | 出現在 | 填什麼 |
|---|---|---|
| `{{TODAY}}` | `docs/01-roadmap.md`、`docs/02-decision-map.md` | 目前日期,或該批決策/roadmap 定案的日期 |
| `{{PROJECT_NAME}}` | `AGENTS.md`、`docs/00-design.md`、`package.json` | 專案名稱(文件用可讀名稱,`package.json` 用 kebab-case) |

## `.claude/skills/autopilot/SKILL.md`(協調者的自動推進迴圈,可選)

| placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{ADVISOR_SESSION}}` | 技術顧問 session 的名字(可由目前平台的 session 清單確認);這個名字會隨 session 重開而變,不要抄一次就當永遠不變(見 `PITFALLS.md` P-59) | `<你的專案>-advisor`(格式範例,不要照抄字面值) |
| `{{LINT_COMMAND}}` | 對產出資料做健檢的指令 | `npm run lint:wiki` |
| `{{DAILY_CAP_ENV}}` | 當日付費 API 上限的環境變數名 | `LLM_DAILY_CAP_USD` |
| `{{PARALLEL_CAP}}` | 同時處於審核輪(跑變異測試)的 worktree 上限,由使用者依機器規格與帳號額度填,協調者不猜 | `3`(單機 Stryker 平行的 OOM 臨界值) |
| `{{ACTIVE_AGENT_CAP}}` | 同時在跑的 worker(agent)上限;超過就排隊,不再開新的。依機器與帳號額度填,協調者不猜 | `12`(AI_KM);dev-paradigm 自己用 `4` |
| `{{UNMERGED_CAP}}` | 做完但還沒合進 main 的交付物上限;超過就暫停派新工、產能轉整合。依你們的合併速度填,協調者不猜 | `10`(AI_KM;見 `docs/07-practices.md` (ap)) |
| `{{BRANCH_DRIFT_CAP}}` | in-progress 分支落後 main 的 commit 數上限;超過先同步(`git merge main`)再派下一棒 | `50`(AI_KM;落後 200 以上時衝突與漏改集中出現) |
| `{{NN}}` | 回報格式範例裡的資料夾編號,照抄格式即可 | `04` |
§4b 的平台備忘是特定平台 adapter;用別的 agent 平台就換成你踩到的。

## `docs/templates/TASK.md.template`(工單模板)

| placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{INSTALL_COMMAND}}` | worker 進 worktree 後第一步要跑的依賴安裝指令 | `npm ci` |
| `{{RULES_FILE_SECTION}}` | 規則檔裡 worker 必須先讀的特定節,不要只寫「讀規則」 | `AGENTS.md` 的「五條硬規則」與「做決定時」表 |
| `{{FULL_CHECK_COMMANDS}}` | 完成前必跑的完整檢查指令(通常跟 autopilot §0 或 §2 的收割檢查一致) | `npm run boundaries && npm test && npm run accept:standalone && npm run accept:dry && npm run accept:coverage` |
| `{{KNOWN_RED_NOTE}}` | 專案特有的「哪些紅是還沒做,不是弄壞了」說明 | 「`packages/core` 尚未實作 `weekly-goal`,相關場景紅屬預期,不要修」 |
| `{{SPEND_CHECK_COMMAND}}` | 同 `.claude/skills/autopilot/SKILL.md`——worktree 起手也要跑一次,退出碼三態 0/1/2 | `npx tsx scripts/llm-spend.ts --today` |

## brownfield 分支(既有專案切換,對應 `docs/06-brownfield.md` 的 8 步)

| placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{TEMPLATE_VERSION}}` | `AGENTS.md` 記的採用模板版本 | `1.0.0` |
| `{{ADVISOR_SESSION}}` | 決策權表裡技術顧問的 session 名(同上,會過期,不要照抄字面值) | `<你的專案>-advisor` |
| `{{DAILY_CAP_ENV}}` | 當日付費 API 上限的環境變數名 | `LLM_DAILY_CAP_USD` |
| `{{BASELINE_TAG}}` | 切換前打的舊制基準 tag 名(步驟 2) | AI_KM:`baseline-bmad`;nightmare:`safety/main-before-paradigm` |
| `{{ARCHIVE_DIR}}` | 舊 story / 規格 / evidence 封存目錄(步驟 3) | AI_KM:`archive/`;nightmare:`dev/archive/stories/` |
| `{{REFERENCE_BACKFILL}}` | 第一個做完的參考回填資料夾(步驟 6) | AI_KM:`06-retrieval` |
| `{{OLD_STATUS_SOURCE}}` | 切換日起唯讀的舊狀態來源(步驟 8) | nightmare:`dev/stories/` frontmatter |
| `{{SPEND_CHECK_COMMAND}}` | 算當日付費 API 花費的指令,退出碼三態 0/1/2(見 `.claude/skills/autopilot/SKILL.md`) | `npx tsx scripts/llm-spend.ts --today` |

## worktree 起手 / 凍結期間 / 動測試檔(不是 placeholder,是流程提醒)

- **clone 完不會自動有的三樣**:
  1. `.env`——`.gitignore` 排除,不會跟著 `git clone` / `git worktree add` 帶過來,新 worktree
     要自己連結(建議)或複製上層現有的那份,不要假設它已經在那裡。
  2. **pre-commit hook**——`sync-gates.sh` 把 hook 檔同步進 `scripts/hooks/pre-commit`,但**不會**
     自動裝進 `.git/hooks/`(那是每個 worktree/checkout 各自的東西),sync 印出的手動安裝指令
     要自己跑一次,不裝不會報錯,只是少了「commit 那一刻」這道防線。
  3. `TEMPLATE_DIR`——協調者手動對模板路徑跑腳本(例如 `verify-against.sh`,或想直接讀模板版
     `check-*.ts` 對照)時假設的環境變數,指向模板 checkout 的路徑;新 worktree 不會自動繼承
     上一個 worktree 設過的殼層變數,每次開新 worktree 要自己重新確認或重設。
  每次開新 worktree 起手都要覆核這三樣,不要假設「跟上一個 worktree 一樣」。

- **凍結期間(當日花費達上限、或 autopilot §4 其他煞車條件成立)可以做的事**:派工(非 LLM
  工作)、開單、回訊、worktree 內工作(不涉及 main 或付費呼叫的部分)——凍結指的是「不派新的
  付費/main 工作」,不是「什麼都不能做」;不要把煞車條件過度解讀成整條迴圈停擺。

- **協調者動測試檔(即使只是改註解)一律報備**——`*.test.ts` 名義上是「開發不能碰」的檔案,
  協調者代勞時同樣要留痕(見 `docs/07-practices.md` (n)),不因為只改註解、看起來無害就省略
  報備;同一輪開一張 review 工單事後覆核(見 PITFALLS P-49)。

## 收工前 / push 前檢查(不是 placeholder,是流程提醒)

落地完成、進入日常運作之後,下面幾條每輪或每次收工前都要過一遍(來源見 `PITFALLS.md` P-55 / P-56,
以及 nightmare-assault 1.4.0 回報):

- **收工前每個 worktree 已 commit**——未 commit 的工作在 session 結束時最脆弱,平台或機器一重開就不見了。
- **push 前 `git log --oneline origin/main..HEAD` 逐條驗過**——不要只看 `git status` 就 push;`git push`
  推的是 HEAD 以下全部,不是「剛做的那個 commit」,合併與 push 之間插進來的任何 commit 都要先驗過。
- **必跑清單裡的每一條都要是一個 npm script**(或等價的單一入口)——手打指令放進清單等於沒人會跑;
  新加守門一律先掛一個 `npm run` script 再寫進清單,並用「刻意弄壞、預期 ✗;修回來、預期 ✓」反向驗證過一次。
- **改一條斷言(含只是加嚴)之後,重跑那個模組的變異測試**——不要假設「加嚴應該只會更嚴格」,
  加嚴的方向本身可能就錯了(nightmare-assault commit 89317a9f,見 mutation-testing skill)。
- **main 這棵工作樹同一時刻只准一個 agent 在動**:判斷誰在用,用 `readlink /proc/<pid>/cwd` 看 pid
  的實際工作目錄是不是 main 的路徑,`grep -vx $$` 排除自己這個 shell 的 pid——nightmare-assault 曾經
  因為沒排除自己而誤判成「main 被佔用」(假 BUSY)。
- **在 main 上改任何檔案之前**,對每一個目前 in-progress 的分支跑一次
  `git diff --name-only main...<branch> | grep <要改的檔案>`,全部為空才動手——這條跟上一條是同一個
  「main 是共用資源」的問題在不同層面的檢查(pid 層 vs 分支內容層),兩個都要做(來源 nightmare-assault D14)。
- **含子行程探針 + 逾時的測試(真跑 cucumber 那類)在負載下會假紅**(PITFALLS P-82):同機另一個
  worktree 在跑 Stryker 時,探針的子行程在逾時內跑不完,而**假紅跟真紅的退出碼與訊息一模一樣**。
  ⚠️【驗,2026-09-21】**本模板目前沒有任何 JS/TS 端的檔案鎖在擋這件事**——`package.json` 的
  `mutate` 就是裸的 `stryker run`,唯一實作 `.mutate.lock` 的是 `scripts/py/mutate.py`(獨立的
  Python 定向工具)。所以這裡只能靠排程:**同一時間只讓一個 worktree 跑變異測試或這類探針測試**,
  看到這類測試紅先問「當時同機有沒有人在跑 Stryker」,**不要用放寬逾時當修法**。
  (補上真正的鎖是待辦,補上之後這段要改回「靠鎖排隊」。)

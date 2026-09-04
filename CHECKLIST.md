# 落地清單

複製 `template/` 之後,把下面每一個 `{{PLACEHOLDER}}` 找到、填掉。表格依檔案分組,
「填什麼」是給你的指引,「本專案的例子」是抽出這套範式的來源專案(一個桌面學習卡片系統,
教學卡 + 考試卡,LLM 產生內容、間隔重複排程)實際填的值,照抄格式,不要照抄內容。

> `README.md` 裡出現的 `` `{{PLACEHOLDER}}` `` 字樣是在說明「有一個東西長這樣」,
> 不是一個真的要填的欄位,不在下面的表裡。

驗證方式:全部填完後,`grep -rn '{{' .`(在新專案根目錄執行)應該沒有任何輸出。

## CLAUDE.md

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
| `{{HARD_CONTRACT_SECTIONS}}` / `{{SOFT_CONTRACT_SECTIONS}}` | 同 CLAUDE.md,以及軟約定章節清單 | 硬:§2 §3 §4 §8–§12;軟:§5 §6 §7 函式簽章 §13 |
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
| `{{FEATURE_TAG}}` | 同上 | `scheduler` |

## features/steps/_world.ts

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{FIXTURE_TODAY}}` | `today` 欄位的預設值,要跟某個常用 fixture 的假設對齊(格式 `YYYY-MM-DD`) | `2026-09-10` |

## scripts/check-boundaries.ts

| Placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{FEATURE_SRC_DIR}}` / `{{FEATURE_OWNER}}` | OWNERS 表範例行:原始碼子目錄與擁有它的功能資料夾名 | `packages/core/src/scheduler/` / `04-scheduler` |

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
| `{{STRICT_MODULES}}` | 同 CLAUDE.md | scheduler、grading 前兩層、驗證器、weekly 計數、路徑防護 |
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
| `{{PROJECT_NAME}}` | `CLAUDE.md`、`docs/00-design.md`、`package.json` | 專案名稱(文件用可讀名稱,`package.json` 用 kebab-case) |

## `.claude/skills/autopilot/SKILL.md`(協調者的自動推進迴圈,可選)

| placeholder | 填什麼 | 本專案的例子 |
|---|---|---|
| `{{ADVISOR_SESSION}}` | 技術顧問 session 的名字(`ListAgents` 看得到) | `llm-learning-cards-57` |
| `{{LINT_COMMAND}}` | 對產出資料做健檢的指令 | `npm run lint:wiki` |
| `{{DAILY_CAP_ENV}}` | 當日付費 API 上限的環境變數名 | `LLM_DAILY_CAP_USD` |
| `{{NN}}` | 回報格式範例裡的資料夾編號,照抄格式即可 | `04` |
§4b 的平台備忘是 Orca 專用;用別的 agent 平台就換成你踩到的。

| `{{PHASE_COVERAGE_CHECK}}` | `.claude/skills/autopilot/SKILL.md` | 每個 phase feature 以自己的 tag 至少跑到 1 個場景的檢查指令(P-32) | `npm run accept:coverage`(來源專案待做)|

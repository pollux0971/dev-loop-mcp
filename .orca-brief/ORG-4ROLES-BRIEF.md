# 工單：四常駐角色組織架構（ADR-018,修 ADR-016 條件 2）—— 規則層起草

派工者：技術顧問。**不 commit、不 tag、不 push**。基準 HEAD = 8b17602(1.8.0)。做完印 `ORG DONE`,報告 `.orca-brief/ORG-4ROLES-REPORT.md`。
授權：【驗】使用者 2026-09-14 在技術顧問 session 親口選 A(DECISIONS_NEEDED #25 第②部分)。你是起草者,判斷已由技術顧問做完,照下面寫;
你發現任何一條跟既有規則打架、或我漏考慮的,**寫進報告「矛盾清單」,不要自己改決定**。

## 已裁決的內容(照抄,不要改語意)

**拓撲**:dev-paradigm 開 4 個常駐 session(名字以 ListAgents 為準,重啟會變):
| 角色 | 職責 | 不做 |
|---|---|---|
| 協調者(ARIA) | 唯一排程者、唯一 merger:寫工單並在工單尾**寫死鏈規格**(每棒角色/模型/完成條件/下一棒觸發條件)、決定派誰、組批、`merge --no-ff` 進 main、推 origin | 鏈內接棒的執行、清樹的執行、技術裁決 |
| 技術顧問 | 裁決(契約/介面/gate 例外/`@manual and not @e2e`)、合併後在自己 worktree 對 main 獨立重跑全 gate、merge 證據抽查、WIP/漂移監督、規則層變更的執行者 | 不寫實作、不改 worker 分支、不派工 |
| 接線 agent(新) | 偵測 worker 交件(讀終端結論行與 `.report`/`.review` 檔,不用 mailbox),**只照工單鏈規格**開下一棒(測試紅→開發→非作者審核→通知協調者可收批);卡互動選單就解除或回報 | 不決定鏈的內容、不排序、不合併、不清樹、不改鏈規格;鏈規格沒寫的情況一律回報協調者 |
| 整合/清樹 agent(新) | 把候選分支合到最新 main 的**臨時樹**跑全 gate + 觸及資料夾所有 done phase(`setsid nohup` + done 檔),紅就隔離是哪一支;列分支落後 main 顆數;**照 ledger** 清閒置 worktree(條件:自己的 commit 已進 main + 終端 ≥60 分無輸出 + porcelain 只剩已歸檔 brief;刪前打 `archive/<branch>` tag) | 不派工、不合併、不 push、不改任何分支內容;ledger 之外的 worktree 不動 |

**原則(寫進 ADR-018 Decision)**:「**決定下一棒 ≠ 執行下一棒**」。協調者保有全部排程**決定權**(ADR-016 條件 2 不變其精神),接線與整合/清樹只執行協調者事先寫死的決定;兩者遇到鏈規格未涵蓋的情況一律停下回報,不得自行判斷。
產品 PM 不另開常駐 session:`product-pm` 仍是 skill 入口,使用者要提產品需求時在技術顧問 session 或任一對話 session 呼叫 `/product-pm`;ADR-016 條件 1「兩個對話入口」語意保留(PM 是入口,不必是 session)。
前端顧問:不設。
通訊:session↔session 用 SendMessage;worker→session 不用 mailbox/orchestration,worker 只 commit + 終端印 `REVIEW VERDICT: PASS|RETURN <報告路徑>`;禁 session 互相 terminal wait;worker 禁 `git push origin`。
迴圈:各常駐 session 自建 CronCreate 錯開(協調者 :04/:19/:34/:49、整合/清樹 :11/:26/:41/:56、接線 Monitor 2–3 分 + 巡檢 :08/:23/:38/:53、技術顧問 :17/:37/:57),不用 `/loop`。
在製品:活躍 agent ≤ `{{ACTIVE_AGENT_CAP}}`(預設 12);未合入交付物 > `{{UNMERGED_CAP}}`(預設 10)就停派新節點、產能轉整合。
不抄(寫進 ADR-018 Alternatives/Consequences):AI_KM 把裁決委給顧問的做法、環境細節、協調者墊共用 chore、無護欄的刪除/推送。

## 要改的檔案(只准這些)

1. `docs/02-decision-map.md`:新增 **ADR-018 · 四常駐角色與「決定下一棒 ≠ 執行下一棒」**,status accepted · 2026-09-14,五欄位照既有格式。
   Context 寫:【驗】使用者 2026-09-14 選 A;來源 AI_KM 實測(ai-km-e3 回覆,#25 素材 `.orca-brief/proposals/multi-session-roles.md`);
   ADR-016 條件 2 的「唯一排程者」若照字面,接線與清樹會成第二、三個排程者。Decision 寫上面的表 + 原則。
   在 **ADR-016** 的 Status 行加「條件 2 由 ADR-018 補充(不推翻)」;Related 加 ADR-018。
2. `CLAUDE.md`「做決定時」表:在「技術顧問 session 的角色定義」列之後加兩列(接線 agent、整合/清樹 agent 的角色定義,格式仿既有兩列,怎麼留痕欄寫「本表本身 + ADR-018」)。
   第一列「派工順序、合併順序、worktree、審核回合 | 協調者」改成「…| 協調者(唯一排程者;鏈內接棒與清樹的**執行**依 ADR-018 交接線／整合清樹 agent,決定權不變)」。
3. `docs/03-agile-workflow.md:12-19` 角色表加兩列;`README.md:215-222` 角色表同步加兩列(兩處措辭一致)。
4. `docs/05-parallel-and-integration.md` 檔尾新增「## 多 session 分工(ADR-018)」段:拓撲表、通訊規則、迴圈時段、在製品上限、鏈規格格式範例(工單尾 yaml 或表格:棒次/角色/模型/allowed_paths/完成條件/下一棒觸發)。
5. 新增 `docs/session-prompts/README.md` + 四份:`coordinator.md`、`advisor.md`、`wiring.md`、`integrator.md`。每份是**可直接貼進新 session 的啟動 prompt**,
   開頭一句「你是 {{PROJECT_NAME}} 的 <角色>,規則見 CLAUDE.md 與 ADR-018」,然後:職責/不做/通訊/cron 時段/啟動時先做的三件事/停止條件。用 `{{PROJECT_NAME}}`、`{{ACTIVE_AGENT_CAP}}`、`{{UNMERGED_CAP}}` 變數。
   素材:`.orca-brief/proposals/multi-session-roles.md` §三 + ai-km-e3 回覆要點(在 `.orca-brief/MAILBOX.md` 檔尾 #2 與技術顧問記憶;不夠就照上表寫)。
6. `.claude/skills/autopilot/SKILL.md`:第 85 行「清 worktree」改「通知整合/清樹 agent 依 ledger 清 worktree(ADR-018)」;§1 「自己決的」後加一句「鏈內接棒與清樹的執行交接線／整合清樹 agent,決定仍是你的(ADR-018)」。其他不動。
7. `.orca-brief/TASK.md.template`:檔尾加「## 鏈規格(協調者填,接線 agent 只照此執行)」段與範例表。
8. `DECISIONS_NEEDED.md` #25 那列:第②部分改成「使用者 2026-09-14 在技術顧問 session 親口選 A → ADR-018,1.9.0」。
9. `package/payload-manifest.json`:把 `docs/session-prompts/` 加進出貨(仿 `docs/0N-*.md` 的寫法);跑 `npm test` 讓 `shipping-coverage.test.ts` 告訴你有沒有漏。
10. 升版 **1.9.0**(minor:CLAUDE.md 固定段落 + 新檔案結構):`VERSION`、`package/package.json`、`CHANGELOG.md` 頂端條目(日期 2026-09-14,寫清楚 ADR-018、四角色、鏈規格、session-prompts、不發布留給協調者)、`README.md` 安裝範例 `npx-v1.8.0`→`npx-v1.9.0`。

## 自檢
`npm test`、`npm run test:scripts`、`npm run lint:docs`(分「本來紅」「你弄紅」)、`npm run check:doc-rot`、`grep -rn "唯一排程者\|唯一 session/worktree scheduler" CLAUDE.md docs .claude README.md` 列出每一處並確認措辭跟 ADR-018 不打架。
報告附 `git diff --stat`、矛盾清單、每個宣稱標【驗】/【推】。

## 協調者(ARIA)追加的三條鏈規格要求(技術顧問已核可,一併寫進 docs/05 鏈規格段與 TASK.md.template)
1. 鏈規格沿用 `TASK.md.template` 的「當場取數」原則:不寫死 ADR/DECISIONS 編號、不寫死鏈長度,只寫取數指令。
2. 接線 agent 只接棒**不合併**;末棒 PASS 就通知協調者來 merge。(已在裁決表,措辭要明確到這個程度。)
3. 整合/清樹 agent 清 worktree 的判定條件**引用 `docs/07-practices.md` (at)** + 刪前打 archive tag,不自己發明條件;如果 (at) 的條件跟本工單裁決表寫的三條不同,以 (at) 為準並在報告標出差異。

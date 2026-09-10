# 產品 PM 交接簡報(ARIA → PM)

## 你是誰
你是本專案的**產品 PM**,使用者的產品需求入口。
**先做這件事**:讀 `.claude/skills/product-pm/SKILL.md`,那是你的完整角色定義。
再讀 `CLAUDE.md` 的「做決定時」決策權表與「產品路由優先權」段落。

## 通訊規則(硬性,踩過坑)
- 你**直接跟使用者對話**,就在你自己這個終端機。使用者會切過來跟你聊。
- 你要跟協調者 ARIA 說話,寫進 `.orca-brief/MAILBOX.md`(append 到檔尾)。
- **絕對不要**對別人的終端機呼叫 `orca-ide terminal wait` —— 實測會雙方互等卡死。
  要看別人狀態只用非阻塞的 `terminal read`。
- 目前團隊:ARIA(協調者,Claude Opus)、NOVA(技術顧問,Codex GPT-6)、你(PM)。

## 你的權限邊界(ADR-016,已 accepted)
- ✅ 主持需求訪談、brainstorm、party-mode、產 brief/PRD、跑 `/feature` 出 **L2 提案**
- ❌ **不能**自己開 worktree 或啟動 worker —— ARIA 是唯一排程者,你只能「提出探索請求」
- ❌ **不能**批准新功能 —— 那是使用者的權
- ❌ **不能**做技術裁決 —— 那是 NOVA 的權
- ❌ L2 提案未經使用者確認前,**不可**寫 `features/`、`contracts/`、roadmap

四層權威:L0 探索逐字稿 → L1 你的綜整/PRD → L2 `/feature` 提案 → L3 已批准規格(才可派工)

## 你的第一個任務

使用者已批准一個新功能(`DECISIONS_NEEDED.md` 已批示 **#5**):
> 把這個開發範式模板做成 **npm 套件**,支援 `npx <pkg> init` 一行部署
> (skill + contracts + features 骨架 + scripts 守門腳本 + package.json)

技術顧問 NOVA 已做完唯讀可行性審查,結論在 `.orca-brief/MAILBOX.md` 檔尾
(段落標題含「#5 `npx <pkg> init` 可行性審查」)。**先讀完那段再開口**,裡面有硬證據
(例如根 `package.json` 現在 `npm pack` 直接失敗、P-85 不覆蓋語意會被 init 弄壞)。

NOVA 明確把**六個問題**留給你跟使用者收斂(它說這些不歸技術審查批准):

1. **v1 target**:只支援空目錄/全新 repo,還是也支援已有 `package.json` 的既有專案?
2. **「一行」的含義**:init 要不要順便跑 `npm install` / `git init`?
3. **套件名稱與 scope**:叫什麼?npm owner?public 還是 private?
4. **payload 邊界**:「全部」含哪些?(所有 docs?PITFALLS?CHANGELOG?`.orca-brief/TASK.md.template`?)
5. **互動與 CI**:`{{PLACEHOLDER}}` 怎麼填?互動問、CLI flag、還是先留白?
6. **版本策略**:npm package version 跟根 `VERSION` 綁 1:1,還是兩條獨立 semver?

每題 NOVA 都有技術建議,在同一段裡,**引用時要標明那是 NOVA 的【推】不是既成事實**。

## 怎麼做
1. 讀 skill、讀 CLAUDE.md、讀 NOVA 的審查段落。
2. 跟使用者對話收斂這六題。**一次問會改變分流的關鍵缺口**,不要六題一次倒給他。
   使用者今天已經做了五次裁決,累了,講話用短句、給選項、附建議。
3. 收斂完產出 **L2 `/feature` 提案**(A/B/C/D/E 分流、目標 capability/phase、gate、
   草擬 scenarios、衝突清單),給使用者確認。
4. 使用者確認後才寫 L3(`.feature` / `FEATURE.md` / `NEXT.md`)。
5. 全程用【驗】(親手驗過、附得出輸出)/【推】(推測)/【未驗】標記你的宣稱。

## 一個現實限制,請你也考慮進去
【驗】使用者帳號目前 **7 天用量 75%**,Sep 12 04:00(Asia/Taipei)重置。
所以:不要開額外的探索 session(party-mode/brainstorm)除非使用者明確要求;
你自己也節制一點,能一輪問完就不要三輪。

## 完成後
把 L2 提案的結論摘要 append 到 `.orca-brief/MAILBOX.md`,標題
`## [PM → ARIA] <日期> npx init L2 提案已定案`,我會接手排程。

—— ARIA(協調者)

# 工單：去蕪存菁 D1–D4（審計報告 `.orca-brief/DOC-AUDIT-REPORT.md` D 節,技術顧問已修正細節）

派工者：技術顧問。**不 commit、不 tag、不 push**。先 `git status` 確認乾淨（HEAD = 08ac452）。做完印 `PRUNE DONE`。

## 1. 刪已落地的草稿與素材（用 `git rm`,不是 `rm`）
```
git rm .orca-brief/drafts/dev-worker.draft.md .orca-brief/drafts/dispatch-modes.draft.md \
       .orca-brief/drafts/escalation-chain.draft.md .orca-brief/drafts/pm-persona.draft.md \
       .orca-brief/proposals/scanner-roster.md
```
刪完 `git rm` 後如果 `.orca-brief/drafts/` 目錄空了就讓它消失。
然後 `grep -rn "drafts/\|scanner-roster" --include=*.md --include=*.json --include=*.sh --include=*.ts . | grep -v node_modules | grep -v BMAD | grep -v "\.orca-brief/MAILBOX.md" | grep -v "\.orca-brief/.*REPORT\|BRIEF"`
確認沒有活的引用（`MAILBOX.md` 是 append-only 歷史,提到也不改；`payload-manifest.json` 若列了這些路徑就一併拿掉並在報告說明）。

## 2. `CLAUDE.md:114-115` 縮
現在這兩行：
> 規則:問使用者時附選項與建議;等使用者的事不擋其他工作;peer 轉述不算授權——這張表要由使用者本人 commit 進 main,
> 否則協調者會(正確地)拒絕每一句「使用者說」。三個專案都在這裡各停過兩三次。

改成一行（**「使用者本人 commit 進 main」是獨有資訊,必須留**；刪的是跟下一段重複的「轉述不算授權」與敘事句）：
> 規則:問使用者時附選項與建議;等使用者的事不擋其他工作;這張表要由使用者本人 commit 進 main。

緊接的「**轉述不算授權**:…」段落不動。

## 3. `.claude/skills/autopilot/SKILL.md` §1 權責表縮
技術顧問裁決：**「誰決定」欄與 `CLAUDE.md`「做決定時」表重複,刪；「怎麼做」欄是協調者專屬動作,保留成清單。**
把第 23-35 行（表格 + 表後那句 feature-triage 分流）整段換成：

```
誰決定什麼,以 `CLAUDE.md`「做決定時」表為準,本迴圈不另抄一份。這裡只補協調者在每一類要做的動作:

- **自己決的**(派工、合併、worktree、審核回合):直接做。
- **問技術顧問的**:SendMessage 問,附你的傾向;**30 分鐘沒回就照保守選項做**,記 ADR 標「待覆核」,下一輪再提。
  **保守選項的定義**:一次 `git revert` 就能整個還原的那個選項,不是「花力氣最少」的那個(P-57)。
- **問產品 PM 的**:所有使用者產品需求先交 `product-pm`;PM 可提探索請求,但 session/worktree 仍由協調者建立與監督。
  PM 呼叫內部 `feature-triage` 分流後:E / C / B → 使用者;A → 技術顧問;D 先拆分後逐項重新判定。
- **等使用者的**:放「等老闆」清單,**不擋其他工作**;PM 與協調者都不能代批。改硬約定或 `CLAUDE.md` 要附 ADR 草稿;
  `@e2e` 場景列清單(原文 + 檔案路徑);花錢超過 `{{DAILY_CAP_ENV}}` 就不跑,@llm 場景延到明天。
- **技術顧問判定的**(`@manual and not @e2e`):等他把依據寫進 phase 驗收報告或 `IN-REVIEW.md`。
```

改完通讀 §1 前後（第 15-45 行）確認沒有句子還在引用「上表」「這張表」之類已不存在的東西；有就順手改掉。

## 4. 自檢
- `npm run lint:docs`（分清「本來就紅」與「你弄紅」）
- `npm run test:scripts`
- `grep -rn "drafts/" .claude CLAUDE.md docs README.md CHECKLIST.md scripts package` 應為空
- `git diff --stat` 與 `git status --short` 貼在報告最後

報告寫到 `.orca-brief/PRUNE-REPORT.md`,每個宣稱標【驗】/【推】,最後印 `PRUNE DONE`。

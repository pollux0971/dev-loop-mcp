# 工單：1.7.4 patch —— 修掉調查報告第 14 節的文件問題

派工者：技術顧問。你是實作 worker。**只改下列檔案，不 commit、不 tag、不 push**。改完印 `FIX DONE`。
基準：HEAD 已是 1.7.3（`git log -1`）。先 `git status` 確認工作區乾淨再動手。

## 要做的事

### 1. 清掉 `template/` 死路徑（此目錄自 2026-09-06 起不存在）
逐一改成正確路徑（repo 根目錄就是模板，所以 `template/X` → `X`；tag `template/vX` → `vX`）：
- `CLAUDE.md:122`  `template/CHANGELOG.md` → `CHANGELOG.md`
- `docs/03-agile-workflow.md:48`  `template/README.md` → `README.md`
- `scripts/README.md:8`  `template/README.md` → `README.md`
- `scripts/README.md:66,71`  `template/scripts/*.ts` → `scripts/*.ts`
- `.claude/skills/autopilot/SKILL.md:111`  `template/PITFALLS.md` → `PITFALLS.md`
- `.claude/skills/autopilot/SKILL.md:177`  `git diff template/v<採用版>..v<新版> -- template/` → `git diff v<採用版>..v<新版>`
- 再 `grep -rn "template/" --include=*.md . | grep -v node_modules | grep -v CHANGELOG.md | grep -v "BMAD-METHOD"` 掃一次，
  有漏的一併修。**CHANGELOG.md 歷史條目不動**（那是紀錄）。

### 2. `CLAUDE.md` 「可用指令」表對上真實 skill 名
技術顧問裁決：**不改 skill 目錄名**（consumer 靠 sync 同步 `.claude/skills/`，改名會斷），
改 `CLAUDE.md:76-85` 的表，每一列在指令後面括號標實際 skill 名，例如：
- `/phase-done <folder>/<phase>`（skill：`phase-acceptance`）
- `/integrate <IN>`（skill：`integration-check`）
- `/mutate [folder]`（skill：`mutation-testing`）
- `/decide <描述>`（skill：`decision-record`）
- `/sprint`（skill：`sprint-planning`）
- `/feature`（skill：`feature-triage`，經 `product-pm`）
其餘已一致的不加。表前加一句：「斜線指令是慣用簡稱，實際 skill 名在括號內；沒有 `.claude/commands/` 別名。」

### 3. `package/README.md:21` 寫死的版本號
把「`1.5.0`」這個數字拿掉，改成不含數字的敘述（例如「與根 `VERSION` 相同的版本」）。
順便 `grep -n "1\.[0-9]\.[0-9]" package/README.md README.md scripts/README.md` 看有沒有其他寫死版本號的敘述句
（範例指令裡的 `npx-v1.7.3` 這種是刻意的，留著；敘述句裡的舊版號才改）。

### 4. 確認 `gates.config.json` 缺 `chain` 這件事在 1.7.3 有沒有交代
`scripts/gates.config.json` 沒有 `chain` 鍵。查 `README.md`、`CHECKLIST.md`、`CHANGELOG.md` 的 1.7.3 條目，
是否已明確告訴 consumer「落地後要自己補 `chain`」。
- 有 → 不改，在報告裡引出行號。
- 沒有 → 在 `CHECKLIST.md` 對應段落補一條。

### 5. 升版 1.7.4
- `VERSION` → `1.7.4`
- `package/package.json` 的 `version` → `1.7.4`
- `CHANGELOG.md` 頂端照既有格式加 `1.7.4` 條目（日期 2026-09-13，patch），列出上面 1–4 的改動與理由。
  版本規則見 `CHANGELOG.md:3`（文件措辭改動 = patch）。
- `README.md` 裡的安裝範例 `npx-v1.7.3` → `npx-v1.7.4`（如有）。

### 6. 自檢
- `npm run lint:docs`（doc-links，記憶提示：此檢查在 HEAD 本來就可能紅，跑完把「本來就紅的」跟「你弄紅的」分開列）
- `npm run test:scripts`
- `git diff --stat` 貼在最後。

## 輸出
把做了什麼、每條的 diff 摘要、自檢結果，寫到 `.orca-brief/FIX-174-REPORT.md`，最後印 `FIX DONE`。
每個宣稱標【驗】或【推】。

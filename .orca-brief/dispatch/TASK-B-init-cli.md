# DISPATCH · npx init 階段 B · init 主程式(**尚未派出**,等使用者決定時機)

```yaml
task_id:        NPX-B
dispatch_id:    (未派出)
mode:           region-development
objective:      實作 package/src/cli.mjs 的 init 主程式:建檔案、P-85 式防覆蓋、原子寫入、可回復。
authority:      DECISIONS_NEEDED.md #5(已批示,含 A 階段完成紀錄與版本綁定裁決);ADR-016
base_ref:       npx-init-a(接續 A 階段的分支,不從 main 重開)
worktree:       npx-init-b
report_to:      .orca-brief/REVIEW.md
```

## 先讀
1. 本 worktree 的 `.orca-brief/REVIEW.md`(A 階段交付,含「B 階段注意點」四條)
2. 主 worktree `.orca-brief/MAILBOX.md` 的「#5 可行性審查」段落第三節(P-85 七條保護規則)
3. `.claude/skills/dev-worker/SKILL.md`

## 必做(A 階段 worker 與 NOVA 已標出的坑)
1. **SOURCE 標頭相容** — init 不可把 raw `check-*.ts` 直接 copy。必須用 Node 產生
   現行 `sync-gates.sh` 能接受的 SOURCE version/hash 標頭,**並用共用 fixture 證明
   `sync-gates.sh --check` 認得**。這條沒證明就不算完成。
2. **完整 plan 先於任何寫入** — 展開所有輸出路徑 → render placeholder → 算 hash → 掃 target
   → 任何衝突一次列完 exit 1,**零寫入**。不提供 `--force`。
3. **`package.json` 是 merge 不是覆蓋** — 只提議加缺少的 scripts/devDependencies;
   同 key 不同值 → 衝突並列出新舊值。
4. **原子寫入 + rollback journal** — stage 到同一 filesystem 的臨時目錄,再 atomic rename;
   任一步失敗回復到 init 前狀態。
5. **留安裝 manifest** — 記 package/template version + 每個由 init 建立的路徑與 hash。
6. **版本綁定(使用者 2026-09-10 裁決)** — 建置流程要從根 `VERSION` 讀出版本寫進發布 manifest,
   **不是寫死複本**;並加一個 gate 檢查兩邊一致。目前 `package/package.json` 的 `1.5.0` 是寫死的,
   本階段要修掉。

## 不做
- 不自動 `npm install`、不自動 `git init`(留給明確 flag)
- 只做 greenfield,不做 brownfield
- 不做 C 階段的黑箱測試 gate
- **不決定最終 package 名稱**(使用者未定,繼續用佔位名)

## 完成條件
- 空資料夾跑一次 `node package/src/cli.mjs init`,**README 五步驟落地跑得完**
- 衝突 fixture:第 N 個檔衝突時**零寫入**(要有測試證明)
- init 產生的守門檔,現行 `sync-gates.sh --check` 接受
- `git status --short` 只動 allowed_paths

## allowed_paths
```
package/**
.orca-brief/REVIEW.md
```

## forbidden_paths
```
package.json(根)  CLAUDE.md  .claude/**  contracts/**  docs/**
features/**  scripts/**  VERSION  README.md(根)  DECISIONS_NEEDED.md
```
碰到就停手寫進 REVIEW.md 交回 ARIA,不要自行擴大範圍。

## 標記
所有陳述標【驗】/【推】/【未驗】。沒標一律當【推】。

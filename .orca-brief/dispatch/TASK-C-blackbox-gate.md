# DISPATCH · npx init 階段 C · 黑箱測試 gate

```yaml
task_id:        NPX-C
dispatch_id:    NPX-C-001
mode:           region-development
objective:      把 B 階段一次性的手動驗證,變成可重複執行的自動化測試 gate。
authority:      DECISIONS_NEEDED.md #5(已批示);ADR-016
base_ref:       npx-init-a @ d843703
worktree:       npx-init-a(同一個,接續 B)
report_to:      .orca-brief/REVIEW.md
```

## 先讀
1. `.orca-brief/REVIEW.md` — A 與 B 兩階段的交付,**特別是 B 的「驗證命令與原始輸出」那段**
2. `package/src/cli.mjs` — 你要測的東西
3. `.claude/skills/dev-worker/SKILL.md`

## 這一階段的本質
B 階段的證據是 worker **手動跑一次**貼上來的。C 階段要把那些變成**任何人任何時候都能重跑**的測試。
標準:`npm test`(或等價單一入口)跑得起來、失敗會紅、不依賴 worker 當時的臨時目錄。

## 必做(四個 gate,每個都要能單獨失敗)

1. **tarball 內容 gate**
   `npm pack` 產出的實際 tarball,其檔案 multiset 必須與 `payload-manifest.json`
   展開結果**完全一致**,且不得命中 exclude 清單(`.orca-brief/`、BMAD checkout、
   `node_modules/`、`.git/`、`.stryker-tmp/`、`reports/`、`package/dist/`)。
   多一個檔或少一個檔都要紅。

2. **乾淨 repo 黑箱 init gate**
   在**全新臨時目錄**跑一次 init,驗證:
   - exit=0
   - 產出路徑數與 manifest 一致
   - 裝出來的守門檔帶合法 SOURCE 標頭,且 `sync-gates.sh --check` 接受(exit=0)
   - **`{{...}}` placeholder 零殘留**(README 步驟 1 要填的除外,那些要明確白名單)

3. **衝突零寫入 gate**
   準備 fixture:consumer 已有無 SOURCE 標頭的同名檔 + `package.json` 有撞名 script。
   跑 init 必須 exit≠0,**且 target 目錄的檔案內容與 mtime 完全沒變**
   (不是「只檢查沒有新檔」,要證明既有檔一個位元都沒動)。

4. **中途失敗可回復 gate**
   用 `NPX_INIT_FAIL_AFTER=<n>` 注入失敗,驗證 target 回復到 init 前狀態。
   **至少測兩個不同的 n**(早期失敗與後期失敗),不要只測一個。

## 必須避免的反模式(本專案 PITFALLS P-15)
- **不准用 `grep`/`tail` 過濾後「沒輸出」當成通過。** 判定只看退出碼與一行明確的成功訊息。
- 測試要**先紅後綠**:寫完每個 gate,先故意弄壞被測物證明它會紅,再修回來。
  把「弄壞時的紅燈輸出」貼進 REVIEW.md —— 沒有這個,等於沒證明測試有在測東西。

## 完成條件
- 四個 gate 都有對應測試,單一入口跑得起來
- 每個 gate 都附「故意弄壞 → 紅燈」的原始輸出
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
碰到就停手寫 REVIEW.md 交回 ARIA。

## 標記
所有陳述標【驗】/【推】/【未驗】。沒標一律當【推】。
額度吃緊,直接做重點不要繞路。

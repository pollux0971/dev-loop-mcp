# DISPATCH · npx init 階段 A · 打包計畫

```yaml
task_id:        NPX-A
dispatch_id:    NPX-A-001
mode:           region-development
objective:      產出 npm 發布殼的「打包計畫」——payload manifest 與 package/ 目錄骨架。不寫 init 程式。
authority:      DECISIONS_NEEDED.md #5(已批示,落地欄含 PM 的 L2 六題結論);ADR-016
base_ref:       main
worktree:       npx-init-a(本工單專屬,不在 main 動手)
report_to:      .orca-brief/REVIEW.md(worktree 內),完成後由協調者 ARIA 收割
```

## 你是誰
你是 `dev-worker`,mode = `region-development`。
**先讀** `/data/python/dev-paradigm/.claude/skills/dev-worker/SKILL.md` —— 那是你的完整行為準則。
再讀 `CLAUDE.md` 的五條硬規則與決策權表。

## 權威來源(先讀完再動手,不要憑本工單的摘要做事)
1. `.orca-brief/MAILBOX.md` 段落「**#5 `npx <pkg> init` 可行性審查**」——技術顧問 NOVA 的完整審查,
   含硬證據(根 `package.json` 跑 `npm pack --dry-run` 會 exit 1)、`package/` 殼方案、P-85 風險。
2. `.orca-brief/MAILBOX.md` 段落「**PM → ARIA · npx init L2 提案已定案**」——使用者拍板的六題結論。
3. `DECISIONS_NEEDED.md` 已批示 **#5** 的落地欄。

## 使用者已拍板的約束(不可自行更動)
- v1 **只支援 greenfield**(空資料夾/全新專案),不做 brownfield。
- init **不自動** `npm install`、**不自動** `git init`(留給明確 flag)。
- 套件 **先 private**,不發公開 registry;**名稱之後再定** —— 本階段用佔位名,不要自己決定最終名稱。
- payload 邊界以「**能跑完 README 五步驟落地**」為 acceptance。
- npm package version 與根 `VERSION` **綁 1:1**,不維護兩條 semver。

## 本階段要交付什麼(A 階段:計畫,不是實作)

1. **`package/payload-manifest.json`**(或 NOVA 審查建議的等價格式)
   - 明列要出貨的根目錄路徑。**不要寫死數量**(NOVA 已定原則:數字必然過時)。
   - 必須涵蓋:`.claude/skills/`、`contracts/`、`features/` 骨架、必要 `docs/`、
     `scripts/` 守門集合、consumer 用 `package.json` 素材。
   - 必須**排除**:`.orca-brief/`、`BMAD-METHOD-main*`、`node_modules/`、本機 log。
2. **`package/package.json`** —— 真正可發布的 manifest(name 用佔位、version 讀根 `VERSION`、
   `private: true`、`bin` 指向 `src/cli.mjs`、`files` 限制 tarball 內容)。
   **注意**:這是發布用 manifest,**不是** consumer manifest。根目錄那份不准動。
3. **`package/README.md`** —— 一頁說明這個殼是什麼、為什麼不把根目錄搬進 `templates/`
   (理由 NOVA 已寫在審查裡,引用它,不要自己重新發明)。
4. **`.gitignore`** 補一行忽略 `package/dist/`。

## 完成條件(done_when)
- `cd package && npm pack --dry-run --json --ignore-scripts` **不再報
  `Invalid package, must have name and version`**。這是本階段的硬指標。
  把原始輸出的關鍵行貼進 `.orca-brief/REVIEW.md`。
- manifest 涵蓋的路徑都真實存在(逐路徑驗證,不是憑印象列)。
- `git status --short` 顯示**只動了 allowed_paths 內的檔案**。

## allowed_paths(只有這些可寫)
```
package/**
.gitignore          ← 只准 append 一行忽略 package/dist/
.orca-brief/REVIEW.md
```

## forbidden_paths(碰到就是越界,退回)
```
package.json        ← 根目錄那份是 consumer manifest,絕對不動
CLAUDE.md
.claude/**
contracts/**
docs/**
features/**
scripts/**
VERSION
README.md           ← 根目錄那份
DECISIONS_NEEDED.md
```
- **不寫 `src/cli.mjs` 的實作** —— 那是 B 階段。本階段最多放一個會印
  「not implemented yet」並 exit 1 的 stub,讓 `bin` 指得到。
- `allowed_paths` 永遠不能覆蓋 `CLAUDE.md` 的五條硬規則與決策權表。
- 發現需要改 forbidden 內的檔案 → **停手,寫進 REVIEW.md,交回 ARIA 另派工**,不要自行擴大範圍。

## 宣稱標記(硬性)
所有陳述標【驗】(親手跑過、附得出原始輸出)/【推】(推測)/【未驗】。
沒標的一律被當【推】,不會被採信。

## 交付格式(寫進 worktree 內的 `.orca-brief/REVIEW.md`)
- 逐檔:建了什麼、為什麼那樣設計
- 你跑過的指令與**原始輸出關鍵行**(特別是 `npm pack --dry-run`)
- `git status --short` 全文
- 你**沒做**的事、以及你認為 B 階段要注意的坑
- 任何你想改但被 forbidden_paths 擋住的東西

做完就停,不要自己接著做 B 階段。

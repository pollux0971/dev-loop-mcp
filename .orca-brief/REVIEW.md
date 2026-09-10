# 【驗】TASK-A / NPX-A-001 / region-development

## 【驗】結果

【驗】結果：`worker_done`。本 dispatch 的打包計畫、發布殼骨架與指定驗證已完成；依工單要求，本 worker 不進入 B 階段。

## 【驗】逐檔交付與設計理由

- 【驗】`package/package.json`：建立合法佔位名稱 `dev-paradigm-init-placeholder`、版本 `1.5.0`、`private: true`、ESM、`bin` 指向 `src/cli.mjs`，並以 `files` 限制發布殼 tarball 內容。版本值與根 `VERSION` 相同；最終 package name 不在本階段決定。
- 【驗】`package/payload-manifest.json`：建立以根目錄為 canonical source 的路徑 manifest；明列 README 五步驟所需素材、`.claude/skills/`、`contracts/`、features 骨架、必要 docs、scripts 守門集合、consumer `package.json` 與設定檔。skill／守門集合使用 glob，不寫死數量。
- 【驗】`package/payload-manifest.json`：明列排除 `.orca-brief/`、`BMAD-METHOD-main*`、`node_modules/`、本機 log，並額外排除 `.git/`、`.stryker-tmp/`、`reports/`、`package/dist/`。
- 【驗】`package/README.md`：說明這是 npm 發布殼、A 階段只交付計畫，並引用 NOVA #5 審查對「根目錄維持唯一 canonical template、不要搬進 templates/」的路徑依賴理由。
- 【驗】`package/src/cli.mjs`：只放帶 Node shebang 的 `not implemented yet` stub 並以 exit 1 結束；未寫 init、P-85、merge、atomic write 或 rollback 實作。
- 【驗】`.gitignore`：只追加 `package/dist/` 一行。
- 【驗】`.orca-brief/REVIEW.md`：本交付報告。

## 【驗】驗證命令與原始輸出關鍵行

【驗】初始 `git status --short` 在本次修改前只有以下既有未追蹤工單檔，未被本次修改：

```text
?? TASK-A-packaging-plan.md
```

【驗】版本／manifest metadata 驗證命令：

```text
node -e '...'
name=dev-paradigm-init-placeholder
version=1.5.0
private=true
bin=src/cli.mjs
version-match=true
```

【驗】manifest root/include 逐項驗證命令以無依賴 Node validator 執行成功，原始關鍵輸出如下：

```text
exists .claude/skills/**/* (7 files)
exists contracts/**/* (3 files)
exists features/_template/**/* (3 files)
exists features/steps/**/* (3 files)
exists docs/integration/**/* (2 files)
exists scripts/check-*.ts (19 files)
exists scripts/*.sh (3 files)
exists scripts/*.json (5 files)
exists scripts/py/*.py (2 files)
payload-roots=33
matched-file-occurrences=78
```

【驗】`git diff --check`：exit code `0`，無輸出。

【驗】硬指標命令 `cd package && npm pack --dry-run --json --ignore-scripts`：exit code `0`；原始輸出關鍵行如下：

```text
    "id": "dev-paradigm-init-placeholder@1.5.0",
    "name": "dev-paradigm-init-placeholder",
    "version": "1.5.0",
    "filename": "dev-paradigm-init-placeholder-1.5.0.tgz",
    "entryCount": 4,
```

【驗】上述 `npm pack` 原始輸出沒有 `Invalid package, must have name and version`。

【驗】曾嘗試使用 `minimatch` 的 validator，但環境沒有該模組；該次不是驗收證據，原始錯誤為：

```text
Error: Cannot find module 'minimatch'
```

【驗】另一次無依賴 validator 初版因未處理 `**/*` 對目錄直下檔案的 glob 語意而中止；修正 validator 後的成功輸出已列於本報告，沒有修改專案檔案。

## 【驗】git status --short 全文

【驗】本次完成後執行 `git status --short --untracked-files=all` 的全文如下；`TASK-A-packaging-plan.md` 是開工前已存在的工單檔：

```text
 M .gitignore
?? .orca-brief/REVIEW.md
?? TASK-A-packaging-plan.md
?? package/README.md
?? package/package.json
?? package/payload-manifest.json
?? package/src/cli.mjs
```

【驗】上述狀態中的所有本次新增／修改項目都在 allowed_paths 內；既有工單檔不在本次變更範圍。

## 【驗】沒做的事

- 【驗】沒有修改根 `package.json`、`README.md`、`VERSION`、`CLAUDE.md`、`contracts/`、`docs/`、`features/`、`scripts/` 或 `.claude/`。
- 【驗】沒有建立或移動 `templates/`，沒有建立 `package/dist/`，沒有把 canonical template 複製成第二份 committed copy。
- 【驗】沒有實作 `init`，沒有自動 `npm install`，沒有自動 `git init`，沒有實作 flags／TTY prompt／`--yes`。
- 【驗】沒有修改測試、Gherkin、sync-gates、verify-against，沒有新增 ADR，沒有執行 publish、merge 或 push。
- 【驗】沒有遇到想改但被 forbidden_paths 擋住的項目。

## 【推】B 階段注意點

- 【推】B 階段必須從 manifest staged 出 `package/dist/template/`，維持 `scripts/` 相對布局，不能直接把 raw `check-*.ts` 複製進 consumer；需要產生現行 `sync-gates.sh` 可接受的 SOURCE version/hash 標頭，或明確呼叫既有 sync 流程。
- 【推】B 階段應先完整展開 plan、render placeholder、hash 與掃描所有衝突，再進入 write phase；`package.json` 要做保守 merge，不可覆蓋 consumer 自有內容；多檔寫入需同 filesystem staging、atomic rename 與 rollback journal。
- 【推】B 階段只實作 greenfield；npm 安裝與 git 初始化維持明確 flags，不能把網路或 repo 狀態副作用混入預設 init。
- 【推】C 階段才驗證實際 tarball 的 manifest multiset、乾淨臨時 repo 的 init、衝突時零寫入與中途失敗可回復；不能把本次 `npm pack --dry-run` 的殼通過宣稱成 init 已完成。

## 【推】自主判斷清單

- 【推】佔位名稱選用合法 npm name，並讓 bin key 與佔位名稱一致；最終名稱留待後續授權決定。
- 【驗】package version 寫為根 `VERSION` 當下值 `1.5.0`，並在 manifest 加入 `versionPolicy`；未建立第二條 semver。
- 【推】docs 以明列檔案納入 `docs/00` 至 `docs/07` 的必要／引用文件與 integration／sprints 骨架；其中 `docs/06-brownfield.md` 只是文件素材，不改變 PM 已確認的 v1 greenfield-only scope。
- 【推】scripts 以 `_root.ts`、`check-*.ts`、`*.sh`、`*.json`、Python 工具、hook 與 README 的規則集合表達，讓新增守門檔不需改寫數量敘述。
- 【推】`package/files` 預留未來 `dist/`，但 A 階段不建立 dist；因此本次 dry-run 只驗證發布殼本身的合法 manifest。

## 【驗】越界需求與下一個 owner

【驗】A 階段沒有越界需求；B 階段的 `package/src/cli.mjs` 實作與 C 階段 artifact／black-box gate 仍是後續派工範圍。本 worker 依工單要求在此停止。

【驗】報告位置：`.orca-brief/REVIEW.md`。

---

# 【驗】TASK-B / NPX-B / region-development

## 【驗】結果

【驗】結果：`worker_done`。`package/src/cli.mjs` 已完成 greenfield `init`、完整 plan-first 衝突掃描、SOURCE 標頭／hash 產生、保守 package merge、atomic staging、rollback journal 與安裝 manifest。

## 【驗】changed_paths

- 【驗】`package/src/cli.mjs`
- 【驗】`package/src/build-template.mjs`
- 【驗】`package/package.json`（新增 `prepack` staging hook）
- 【驗】`package/README.md`（更新 B 階段已交付說明）
- 【驗】本報告 `.orca-brief/REVIEW.md`

## 【驗】實作要點

- 【驗】從 `payload-manifest.json` 展開所有輸出，先 render `{{PROJECT_NAME}}`／`{{TODAY}}`，再計算輸出 hash 與掃描所有衝突；衝突一次列完，未建立 staging、journal 或任何 consumer 檔案。
- 【驗】`scripts/` 下 `.ts` 使用 `// SOURCE: template v<根 VERSION> (<commit>) sha256=<rendered body hash>`；`.py` 使用相同版本/hash 規則的 `#` 標頭；hook 保留 shebang 第一行。
- 【驗】`package.json` 只 merge 缺少的 `scripts`／`devDependencies`；同 key 不同值列為衝突，不覆蓋 consumer 的其他欄位。
- 【驗】staging 目錄位於 target 同一 filesystem；commit 前以 `.npx-init-journal.json` 記錄每個移動／安裝操作，失敗時反向恢復並清理暫存物。
- 【驗】留下 `.npx-init-manifest.json`，包含 package/template version、每個輸出路徑與 hash；rerun 透過 manifest ownership 接受既有 init 產物。
- 【驗】每次 init 先讀根 `VERSION`，並與 `package/package.json` version 比較；不一致直接失敗。
- 【驗】明確拒絕 `--force`；程式沒有 npm install 或 git init 呼叫。

## 【驗】指定驗證命令與原始關鍵輸出

```text
node --check package/src/cli.mjs
exit=0

node package/src/cli.mjs init <empty-temp-consumer>
✓ init 完成: 79 paths, template v1.5.0
未執行 npm install 或 git init;請依 README 五步驟繼續。

head -n 1 <consumer>/scripts/check-boundaries.ts
// SOURCE: template v1.5.0 (unknown) sha256=... — 勿手改;升版用 sync-gates.sh

bash <consumer>/scripts/sync-gates.sh <consumer> scripts --check
✓ check-boundaries.ts
✓ mutate.py
✓ test_mutate.py
✓ 守門內容自同步以來未被更動
exit=0

node package/src/cli.mjs init <same-consumer> --dry-run
✓ plan 79 paths, template v1.5.0
exit=0

NPX_INIT_FAIL_AFTER=3 node package/src/cli.mjs init <same-consumer>
exit=1
rollback-same=true

node package/src/cli.mjs init <conflict-consumer>
✗ init 先掃後寫發現衝突(零寫入):
✗ README.md 已存在且沒有 SOURCE 標頭(是 consumer 自有檔)
package.json scripts.boundaries: existing="consumer-boundaries" proposed="tsx scripts/check-boundaries.ts"
package.json devDependencies.tsx: existing="0.0.0" proposed="^4.0.0"
conflict-zero-write=true

merge-preserves-custom=true
merge-adds-scripts=true
merge-adds-devDependencies=true
git diff --check: exit=0

cd package && npm pack --dry-run --json
pack-name=dev-paradigm-init-placeholder
pack-version=1.5.0
pack-entryCount=80
pack-has-dist-template=true
exit=0
```

## 【驗】未通過項目

【驗】無本 dispatch acceptance 未通過項目。C 階段 black-box 測試與 tarball gate 依工單明列未執行。

## 【推】自主判斷清單

- 【推】安裝 manifest 名稱採 `.npx-init-manifest.json`；reviewer 可藉由刪除／改寫它反向驗證 ownership 保護。
- 【推】SOURCE commit 在發布 tarball 無 git metadata 時採 `unknown`；現行 `sync-gates.sh --check` 只要求版本格式與 body hash，已由共用生成 fixture 驗證接受。
- 【推】只渲染專案名稱與日期 placeholder，其餘產品 placeholder 保留給 README 步驟 1，由此不替使用者決定最終套件名或產品資料。
- 【推】`--yes` 作為相容 CLI 旗標接受但不引入互動副作用；v1 預設直接執行 plan／commit。

## 【驗】越界與下一個 owner

【驗】沒有寫入 `VERSION`、根 `package.json`、`scripts/`、測試、contracts、docs、features 或 `.claude/`。CodeGraph 回報 worktree 未初始化，故未執行 `codegraph init`，也未因此新增任何檔案。

【驗】下一個 owner：C 階段 reviewer／integration，負責 tarball multiset、乾淨 repo black-box、衝突零寫入與中途失敗的正式測試 gate。

【驗】報告位置：`.orca-brief/REVIEW.md`。

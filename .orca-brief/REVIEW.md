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

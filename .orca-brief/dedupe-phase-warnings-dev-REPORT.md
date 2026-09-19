模型:gpt-5

逐項:

- 【驗】重讀最新版工單鏈規格；本棒 allowed_paths 為 `scripts/check-next-gates.ts`、`scripts/check-next-gates.test.ts`，只把 leg 1 的 `expect(warningCount).toBeGreaterThan(1)` 翻成 `expect(warningCount).toBe(1)`，沒有新增測試邏輯。
- 【驗】確認根因：`parseGateReferences()` 對每個 phase 引用呼叫 `phaseRowExists()`，後者反覆呼叫 `readFeaturePhaseRows()`；未知狀態與重複 phase 編號警告因此被重新解析、重新印出。
- 【驗】`scripts/check-next-gates.ts` 新增一次執行範圍的 phase warning context。`check-next-gates` 的 `main()` 每次建立新的 `Set<string>`，並沿 `checkCitations()` → `parseGateReferences()` → `phaseRowExists()` → `readFeaturePhaseRows()` 傳遞；警告鍵包含檔名、行號與完整訊息，第一次輸出內容不變，後續相同鍵不再輸出。
- 【驗】同一去重機制也套用 phase 表的「重複編號」警告；`NEXT.md` orphan checklist 警告本來就在每份檔案的單次掃描迴圈中只印一次，沒有另一條重複解析路徑。
- 【驗】沒有修改 `scripts/check-dag.ts`。它未傳 context 時使用模組相容 context，同一 process 內同一 phase 表的重複解析只印一次；獨立 process 仍重新開始。

指令與原文輸出:

```text
$ git diff --check
(exit 0, no output)
```

```text
$ npx vitest run --config vitest.scripts.config.ts scripts/check-next-gates.test.ts
 Test Files  1 passed (1)
      Tests  30 passed (30)
   Duration  90.21s (transform 1.41s, setup 0ms, import 1.75s, tests 86.97s, environment 0ms)
```

```text
$ npm run typecheck
> typecheck
> tsc --noEmit
(exit 0)
```

```text
$ npm run check:dag && npm run check:next-gates
> check:dag
> tsx scripts/check-dag.ts

沒有 phase
gate=dag result=PASS scanned=0

> check:next-gates
> tsx scripts/check-next-gates.ts
gates.config.json: 設定:/home/pollux/orca/workspaces/dev-paradigm/dedupe-phase-warnings-dev/scripts/gates.config.json
next-gates: features/ 底下掃到 0 份 NEXT.md(nextGates.mode=enforce)

✗ next-gates: 掃到 0 份 NEXT.md
這不是很乾淨,是掃描器壞了。features/ 底下沒有任何 NN-name 資料夾有 NEXT.md,或 --root 指錯路徑時就長這樣。
gate=next-gates result=FAIL scanned=0
(exit 1; baseline/template root has no feature NEXT.md)
```

```text
$ cd package && npm test && cd .. && bash scripts/sync-gates.test.sh
✓ blackbox gates PASS (5/5)
...
sync-gates.test.sh: 全部通過
(exit 0)
```

第一組完整命令的失敗原文（非本次 allowed_paths 變更造成）:

```text
FAIL  scripts/shipping-coverage.test.ts > 出貨覆蓋名冊:每個 tracked 檔都要能回答「它靠什麼到 consumer 手上」 > 沒有未分類的 tracked 檔(不是出貨、不是刻意不出貨、也不是已知缺口)
AssertionError: 這些檔在 repo 裡、卻不在任何出貨集合,也沒有被宣告為刻意不出貨或已知缺口。
+ [
+   ".orca-brief/dedupe-phase-warnings-test-REPORT.md",
+ ]
```

```text
✗ 2 條連結指到不存在的檔案:
  docs/01-roadmap.md:41  →  ../features/{{FEATURE_01}}/phase-1.feature
  docs/01-roadmap.md:42  →  ../features/{{FEATURE_02}}/phase-1.feature
gate=doc-links result=FAIL scanned=5
```

反向驗證:

- 去重（修前紅訊息原文）：用 `548ccf1^` 的舊版 `check-next-gates.ts` 對相同三 gate fixture 執行，原文為：

  ```text
  old source exit=0 warning7=3
  ⚠ 警告 features/01-foo/FEATURE.md: 第 10 行 phase-7 的狀態「mystery」不是已知值(done/todo/in-progress/blocked/ready)
  ⚠ 警告 features/01-foo/FEATURE.md: 第 10 行 phase-7 的狀態「mystery」不是已知值(done/todo/in-progress/blocked/ready)
  ⚠ 警告 features/01-foo/FEATURE.md: 第 10 行 phase-7 的狀態「mystery」不是已知值(done/todo/in-progress/blocked/ready)
  ```

  修正版 fixture：`next-gates exit=0 warning7=1 warning8=1`。
- 不誤刪不同警告：同一 fixture 的兩個不同檔案/行號/訊息，原文為 `warning7=1 warning8=1`；兩則都保留。
- 跨執行不殘留：以兩個獨立 process 跑同一 `check-dag` fixture，原文為：

  ```text
  check-dag first exit=0 warning7=1 warning8=1
  check-dag second exit=0 warning7=1 warning8=1
  ```

- 【驗】leg 1 的 fixture 轉綠：單檔 `check-next-gates.test.ts` 為 30/30 passed，重複未知狀態警告恰好 1 次。

diff 檔案清單:

- `scripts/check-next-gates.ts`
- `scripts/check-next-gates.test.ts`
- `.orca-brief/dedupe-phase-warnings-dev-REPORT.md`（本棒報告）
- `.orca-brief/dedupe-phase-warnings-test-REPORT.md`（leg 1 已提交的鏈報告）

待協調:

- `npm test` 受既有 leg 1 report 被 `shipping-coverage.test.ts` 判為未分類影響；該測試只列出 `.orca-brief/MAILBOX.md`、`PM-BRIEF.md` 等固定豁免，沒有列鏈報告，且本棒不可修改該測試。
- `npm run lint:docs` 的兩條 `{{FEATURE_01}}` / `{{FEATURE_02}}` 模板連結仍失敗；本棒不可修改 `docs/01-roadmap.md`。
- `npm run check:next-gates` 在此模板 worktree 沒有任何 `features/NN-name/NEXT.md`，依自身 0 目標守衛 exit 1；不是本次程式變更造成。
- CodeGraph 未初始化；依指引未自行執行 `codegraph init -i`，改以具體檔案閱讀與測試驗證。

我做的自主判斷:

- 【驗】把警告去重範圍放在一次 scanner run 的 context，而不是跨 scanner 共用的 `Set`；`check-dag` 的相容呼叫與 `check-next-gates` 的 main context 不會互相吃掉對方的警告。
- 【推】`check-dag.ts` 不需修改：它的 phase 表讀取透過同一模組相容 context 去重，且獨立 process 會重新載入模組。
- 【驗】完整 warning message 未改寫，只在 `emitPhaseWarning()` 以「檔名 + 行號 + 訊息」鍵抑制重複輸出；不同檔案、行號或訊息仍各自輸出。
- 【驗】沒有碰 `CHANGELOG.md`、`VERSION`、`package/package.json`、`DECISIONS_NEEDED.md`、`docs/02-decision-map.md` 或 `scripts/check-dag.ts`，也沒有 push。

**工單哪裡說不通**:

最新版鏈規格要求「全 gate 綠」，但同一工單又要求提交鏈報告；目前 `shipping-coverage.test.ts` 不豁免 leg 1 鏈報告，所以完整 `npm test` 會因報告檔失敗。此外這個模板 worktree 沒有 `features/NN-name/NEXT.md`，`check:next-gates` 的明確 0 目標守衛必然 FAIL；兩者都超出本棒 allowed_paths，已列待協調。

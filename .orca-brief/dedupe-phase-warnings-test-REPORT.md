模型:gpt-5

本棒範圍:鏈規格 leg 1 / test,只做工單第 (1) 項。未做第 (2) 項去重實作,未修改 `scripts/check-dag.ts`。

逐項:

- 【驗】新增 `scripts/check-next-gates.test.ts` fixture：`features/01-foo/FEATURE.md` 只有一個 `phase-7`，狀態是未知值 `mystery`；同一份 `features/01-foo/NEXT.md` 有三條不同 gate，全部引用自身 `phase-7`。
- 【驗】fixture 斷言掃到 3 條 gate，並用完整的「檔名 + 行號 + 訊息文字」計算同一警告在舊程式碼輸出中的次數，要求 `warningCount > 1`。
- 【驗】`npm ci`：

  ```text
  added 373 packages, and audited 374 packages in 4s
  7 moderate severity vulnerabilities
  ```

- 【驗】`npx vitest run --config vitest.scripts.config.ts scripts/check-next-gates.test.ts`：

  ```text
   Test Files  1 passed (1)
        Tests  30 passed (30)
     Duration  27.53s (transform 214ms, setup 0ms, import 258ms, tests 27.06s, environment 0ms)
  ```

- 【驗】`npm run typecheck`：exit 0。
- 【驗】`git diff --check`：exit 0。

反向驗證:N/A（工單第 (1) 項明訂本棒本身只重現舊程式碼的重複警告）。

diff 檔案清單:

- `scripts/check-next-gates.test.ts`
- `.orca-brief/dedupe-phase-warnings-test-REPORT.md`（鏈規格要求的交件報告）

待協調:無。

我做的自主判斷:

- 【驗】三條 gate 放在同一份 `NEXT.md`，符合工單允許的「同一份裡多條 gate」形狀，並讓每條 phase 引用都走同一個 `phaseRowExists()` 路徑。
- 【驗】保留 `expect(code).toBe(0)`，因未知狀態警告不應使引用解析失敗；本 fixture 只證明警告重複，不新增其他失敗條件。
- 【推】報告中的模型名依本次實際執行環境標示為 `gpt-5`。
- 【驗】CodeGraph 尚未在此 worktree 初始化；本棒以已開啟的具體檔案直接讀取與測試驗證，未因此改動專案內容。

**工單哪裡說不通**:

第 (1) 項把「寫紅」定義為對舊程式碼斷言警告次數大於 1；所以本棒 fixture 對目前舊程式碼會通過，並非去重後的綠色反向驗證。依工單要求保留此斷言，去重後的驗證留給後續 leg。

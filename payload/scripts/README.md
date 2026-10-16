# scripts/ — 選用的 gate 包(沿用自 v1)

v2 的核心檢查在 `dp check`(零依賴)。這裡是 v1 留下、跟 FEATURE/NEXT 表格無關、仍然獨立有用的 TypeScript gate,
需要 `npm install`。要用哪幾支,把對應的 npm script 名字加進 `dp.config.json` 的 `gates.chain`。

| npm script | 檔案 | 做什麼 |
|---|---|---|
| `boundaries` | check-boundaries.ts | import 邊界(依 boundaries.owners.json / allow.json) |
| `standalone` | check-standalone.ts | 跑 standalone.json 的每個指令(standalone.json 由 dp 從 dag 產生) |
| `check:steps` | check-step-dup.ts | 重複的 cucumber 步驟定義 |
| `check:gherkin-dup` | check-gherkin-dup.ts | 重複的場景 |
| `accept:dry` | check-dry-run.ts | cucumber dry-run:有沒有未定義步驟 |
| `check:module-cast` | check-module-cast.ts | 危險的模組型別轉換 |
| `mutate` | mutate-with-lock.ts | 帶鎖的變異測試 |

各 gate 的自我測試:`npm run test:scripts`。v1 的 check-dag / next-gates / phase-status / phase-coverage / check-all /
skills-mirror / sync-gates 已由 `dp` 取代,見 MIGRATION.md。

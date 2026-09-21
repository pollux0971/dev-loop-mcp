# dev-paradigm 四常駐 CLI:共用約定與啟動/重啟流程

本目錄是 **dev-paradigm 自己**跑 ADR-018 四角色的啟動 prompt(不出貨;`payload-manifest.json` 已 exclude `.orca-brief/`)。
出貨給 consumer 的通用版在 `docs/session-prompts/`,兩者不同步也沒關係——這裡寫的是本機、本 repo 的實際值。

設計:技術顧問 `dev-paradigm-de`,2026-09-14。素材:ai-km-e3 / ai-km-15 / ai-km-a7 三份回覆
(`/data/python/AI_KM-briefs/ai-km-a7-*.md`、ai-km-15 scratchpad `wiring-agent-role-reference.md`)。

> **生效條件**:ADR-018 commit 進 main 之後才生效。commit 前 ADR-016 條件 2 原文仍有效,
> 接線與整合/清樹 agent 只能做「讀、量、回報」,**不得開 worktree、不得清樹**。

## 1. 四個角色

| 角色 | ListAgents 名(會變,啟動時重認) | prompt 檔 | cron(分) |
|---|---|---|---|
| 協調者 ARIA | 重啟就換名,用 ListAgents 認 | `coordinator.md` | 6,21,36,51 |
| 技術顧問 | 重啟就換名,用 ListAgents 認 | (本 session,不需要檔;偵測腳本 `bin/advisor_watch.sh`) | Monitor 60 秒 + 巡檢 2,22,42 |
| 接線 agent | 重啟就換名,用 ListAgents 認 | `wiring.md` | Monitor 150 秒 + 巡檢 10,25,40,55 |
| 整合/清樹 agent | 重啟就換名,用 ListAgents 認 | `integrator.md` | 13,28,43,58 |

**名字每次重啟都會變**(實測 2026-09-15:一輪重啟後全部四個名字都換了)。認人一律 `ListAgents` 看新 session + SendMessage 問「你是哪個角色」,
由對方自報;**不要把名字寫進任何檔案當固定值**,包括這張表。角色的權威是這幾份 prompt 檔,不是名字。

分鐘數故意跟 AI_KM 那組(4/19/34/49、11/26/41/56、8/23/38/53、17/37/57)錯開 2 分——同一台開發機,
不要跟 AI_KM 同時跑 gate。

## 2. 共用路徑(repo 外,不污染任何 worktree 的 porcelain)

```
/data/python/dev-paradigm-briefs/
  tickets/<節點>.md            協調者寫的工單,尾端是鏈規格(一個節點一張,所有棒共用)
  integrate/candidates-<時間>.md   協調者給整合 agent 的候選清單(<branch> <sha> 一行一支)
  integrate/result-<時間>.md       整合 agent 回的證據(gate 原文、整合樹 HEAD、守門輸出)
  ledger/handoff-latency.md    接線 agent 每接一棒一列
  ledger/cleanup-ledger.md     整合 agent 每清一個一列
  plans/<時間>-<動作>.txt       任何刪除動作的計畫檔(一行一個絕對路徑)
  archive/<worktree名>/         清樹前歸檔的交接檔
  trash/<日期>/                safe-trash 的回收區
  wiring-state/                接線 Monitor 的快照與 seen.txt
```

腳本在 repo 裡(`.orca-brief/roles/bin/`),**用主 checkout 的絕對路徑呼叫**:
`/data/python/dev-paradigm/.orca-brief/roles/bin/<腳本>`。

## 3. 命名

- 節點名:小寫英數加 `-`,例如 `adr019`、`fix-doclinks`。
- worktree 名 = `<節點>-<角色>[-r<N>]`,角色只有 `test` `dev` `doc` `review`;退回重做加 `-r2`、`-r3`。
  接線 agent 靠「最後一個角色段之前」找回節點名 → 找工單。
- worker 的 worktree 一律在 `~/orca/workspaces/dev-paradigm/`(`orca-ide worktree create` 的預設位置)。
- worker 報告寫在**自己 worktree** 的 `.orca-brief/<worktree名>-REPORT.md`(未追蹤;清樹前歸檔)。

## 4. 模型(使用者 2026-09-14 選 B)

| 棒 | 指令 | 啟動後必查 |
|---|---|---|
| test / dev / doc / 盤點 | `codex -m gpt-5.6-luna -c model_reasoning_effort="max"` | 狀態列顯示 `gpt-5.6-luna` 與 `max`;`-c` 漏了會靜默變 medium |
| 非作者嚴格審核 | `claude --model sonnet --effort max --dangerously-skip-permissions` | 不帶 `--effort` 會靜默變 high |

理由:寫的人和審的人不共用盲點。額度用完或卡選單:純 Enter 試 1–2 次,不行就放棄那個終端,
開新 worktree 重派(**換模型要協調者改鏈規格**,接線 agent 不自己換)。

## 5. 本 repo 的「全 gate」與已知紅

```bash
npm run typecheck && npm test && npm run test:scripts && npm run check:doc-rot \
  && (cd package && npm test) && bash scripts/sync-gates.test.sh; npm run lint:docs
```

- **新 worktree 沒有 `node_modules`**(本 repo 沒有 `orca.yaml` setup hook):跑 gate 前先在那棵樹 `npm ci`
  (只有根目錄有 `package-lock.json`;`package/` 不用裝)。`package-lock.json` 有變才需要重裝。
- `lint:docs` **預期是 FAIL,但只准是「零輸入」那一種**(1.11.0 起,`lint-docs-placeholder-links` 之後)。
  判讀**不能只看 exit code**,要逐字核對最後三行長這樣:
  ```
  doc-links: … 跳過未填 placeholder 的連結 2 個(新專案填完 `CHECKLIST.md` 就會消失)
  doc-links: 掃描 36 個 markdown 檔,掃描到 0 條相對連結(全部 2 條都是未填 placeholder)
  未填 placeholder 的連結沒有可檢查的目標,因此維持 FAIL。
  gate=doc-links result=FAIL scanned=0
  ```
  **跟這個長相不一樣就是真的紅**——尤其若出現舊格式「N 條連結指到不存在的檔案」,那是真的有壞連結。
  placeholder 數從 2 變動、可檢查連結不再是 0,也都要停下來看(代表有人加了真的連結,或動了 roadmap)。
  為什麼這裡是 FAIL 而不是 PASS:扣掉不可檢查的 placeholder 之後目標數是 0,依 `DECISIONS_NEEDED` #31
  「0 目標一律 FAIL」。要不要讓這類「對本 repo 永遠沒有素材」的 gate 能具名宣告 N/A,見 #36(等使用者裁)。
- `npm test` 印 `No test files found` 且 exit 0 是正常(模板沒有 packages/apps)。
- **`cd package && npm test` 一定要跑**:它是出貨產物的黑箱 gate(placeholder 登記、init 實跑)。
  2026-09-19 發布前才發現 ADR-018 新增的 `{{ACTIVE_AGENT_CAP}}` 沒登記進 CHECKLIST,四條鏈與每次重驗都沒跑它。
- 長跑一律:`nice -n 10 setsid nohup bash -c '<指令>; echo $? > <done檔>' </dev/null > <log> 2>&1 & disown`,
  用 Monitor 等 done 檔。一般 `run_in_background` 會被 session 記憶體管理砍掉。
- 同一台機器**同時只跑一個全 gate**。跑前 `cat /proc/loadavg`,**隔 30 秒量兩次都 ≤ 16** 才跑(AI_KM 實測單一峰值不可信:13.83 → 30 秒後 11.30)。
- 所有狀態檔放 `/data/python/dev-paradigm-briefs/`,**不要放 `/tmp`**(AI_KM 09-16 開機被清兩次)。去重指紋用 sha256 或原字串,不要用 Python 內建 `hash()`(每次行程隨機)。

## 6. 角色守門(誰能改什麼)

用這條看分支**自己的** commit 碰了什麼(不要用 `git diff main..X` 或 `main...X`,會出假清單):

```bash
git log --no-merges --name-only --format= <branch> --not main | sort -u
```

| 類別 | 路徑 regex | 規則 |
|---|---|---|
| 規則層 | `^CLAUDE\.md$\|^\.claude/` | 只有使用者批准後由技術顧問改。worker 分支碰到 → 退件 |
| 共用熱點 | `^VERSION$\|^CHANGELOG\.md$\|^package/package\.json$\|^package/payload-manifest\.json$\|^DECISIONS_NEEDED\.md$\|^docs/02-decision-map\.md$` | 只有協調者在同一批改;工單 allowed_paths 明列才放行 |
| 測試 | `\.test\.ts$\|\.test\.sh$\|\.feature$\|^features/steps/` | 只有 test 棒能碰;dev/doc 棒碰到 → 退件 |

命中又不在工單 `allowed_paths` → **一律送技術顧問裁**,任何人都不能寫「內容無害」就放行。

**純 md 改動不能豁免反向驗證**:工單要寫明用哪個「會失敗的檢查」代替
(例如 `lint:docs` 抓斷連結、`check:doc-rot` 抓黑名單詞、`test:scripts` 的 shipping-coverage 抓漏出貨)。

## 7. 在製品上限(本 repo 小,比 AI_KM 緊)

- 活躍 worker ≤ **4**。
- 未合入交付物(分支上有 main 沒有的 commit、且不是正在跑的)> **5** → 協調者停派新節點,產能轉整合。
- 分支落後 main > **30** 顆 → 整合 agent 回報;派下一棒前接線 agent 也要看。

## 8. 通訊

- session ↔ session:SendMessage。第一行寫「dev-paradigm / <節點或分支> / 一句話」。
- 禁止 session 互相 `terminal wait`。
- worker → session:**不用** mailbox、不用 orchestration。worker 只 commit(**審核棒不 commit**,報告留未追蹤)+ 在終端最後印一行
  `REVIEW VERDICT: PASS <報告路徑>` 或 `REVIEW VERDICT: RETURN <報告路徑>`(每一棒都印,不只審核棒)。
- `orca-ide terminal send` 一定帶 `--enter`。Linux 用 `orca-ide`,不要用 `orca`。
- worker 禁 `git push`(每張工單都寫)。**push origin 只有技術顧問**(CLAUDE.md「做決定時」表:顧問在 main 跑完整檢查、通過後 push)。

## 9. 規則怎麼長大(照抄 AI_KM a7 的循環)

出事 → 當事角色停下、SendMessage 技術顧問(附原始輸出)→ 顧問裁對策、改本目錄對應檔並 commit →
SendMessage 該角色「重讀 `<檔>`,CronDelete 舊的再 CronCreate」→ 下一輪照新規則。
**不要在 cron prompt 裡偷改而不回寫檔**——檔才是正本,cron 只是檔的拷貝。

## 10. 啟動 / 重啟(每個角色都一樣)

使用者只要貼一句:

```
你是 dev-paradigm 的<角色>。讀 /data/python/dev-paradigm/.orca-brief/roles/<檔>.md,照「啟動」段做。
```

「啟動」段固定四步:ListAgents 認名字 → CronList 刪掉自己舊的同名 cron 再 CronCreate(原文在檔裡)→
SendMessage 其他三方一行「<角色> 上線,名字 X」→ 立刻跑第一輪。

重啟前(session 要關時)不用另寫交接:未完成的東西都在 `/data/python/dev-paradigm-briefs/` 的檔裡。

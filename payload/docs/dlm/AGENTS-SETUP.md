# 設定 agent

全部在 `dlm.config.json` 的 `agents`。下面是範例,**旗標請依你安裝的 CLI 版本確認**(`--help`)。

## worker(必填)

dlm 在**沒有 .git 的副本**裡以 `sh -c` 執行它(見 SECURITY.md),環境變數:`DLM_PROMPT`(prompt 檔)、
`DLM_REPORT`(要寫的 report 路徑)、`DLM_DISPATCH`、`DLM_ROLE=worker`。worker 不需要 git;dlm 收件時比對副本並 commit。
時限是 `caps.lease_minutes` 與 `agents.worker.timeout_minutes` 取小的。

- Claude Code(`dlm setup` 的預設):
  `claude -p --output-format json --permission-mode acceptEdits --allowedTools "Bash" --disallowedTools "Bash(rm -rf *)" "Bash(rm -fr *)" "Bash(sudo *)" < "$DLM_PROMPT"`
  (可以改檔、跑測試與一般指令;擋刪除整個目錄與 sudo)
  - v2 的 `--permission-mode acceptEdits`(沒有 `--allowedTools`)在 headless 下會拒絕所有 Bash,worker 連測試都跑不了;
    `dlm setup` 看到它會換成上面的寫法。
  - `--output-format json` 讓 dlm 能讀到花費,拿來算預算。
- 自訂:任何會讀 prompt、在目前目錄改檔、最後寫 `$DLM_REPORT` 的程式。輸出裡有 `"total_cost_usd": <n>` 或 `"cost_usd": <n>`
  時 dlm 會記成花費(取最後一筆)。

## critic(選配)

在交件分支的 worktree 裡以 `sh -c` 執行,prompt 從 **stdin** 進,stdout 要是 JSON
(`claude -p --output-format json` 的外層 `result` 會自動拆開)。`dlm setup` 選 L2 時會填一組只給唯讀工具與跑測試的 Claude 指令。
不設 critic:所有 ABSTAIN 都問你。

派工順序固定用預設優先序(解鎖多少下游;同分時重做優先)。v4.0 的選配 Manager(由模型排順序)實跑沒用到,v4.1 拿掉了。

## verifier(建議)

見 VERIFIER.md。`dlm setup` 預設:`{"backend":"cmd","cmd":"claude -p --model haiku --tools \"\" --no-session-persistence"}`。
挑模型的判準:能穩定輸出指定 JSON、對兩種問法答得一致。先用 `dlm stats` 觀察一週再決定要不要換。

## 多個訂閱帳號(v4.6)

每個角色都可以寫 `accounts`(帳號名稱的陣列)和選填的 `model`:

```json
"agents": {
  "worker":   { "accounts": ["max-a", "max-b"], "model": "sonnet" },
  "critic":   { "accounts": ["gpt"] },
  "verifier": { "backend": "cmd", "accounts": ["max-b"] }
}
```

帳號用 `dlm account add <name> --cli claude|codex` 登記在這台電腦(`~/.config/dlm/accounts.json`),`dlm account login <name>` 登入一次。
`dlm account use <角色> a,b [--model X]` 會幫你改這段並 commit。

- 沒寫 `cmd`:用那個帳號 CLI 的預設指令(Claude 跟上面的一樣;Codex 是 `codex exec --skip-git-repo-check --sandbox workspace-write -`,未實跑)。
  `model` 會換成 `--model X`(Claude)或 `-m X`(Codex);Verifier 沒寫 model 時 Claude 用 haiku。
- 有寫 `cmd`:照你的指令跑,只多帶 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 與 `DLM_ACCOUNT`。
- 派工時會清掉 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`(Codex:`OPENAI_API_KEY`、`CODEX_API_KEY`),
  不然 shell 裡的金鑰會蓋過帳號的登入。
- 輪流:每一棒挑 pool 裡沒在冷卻、近 5 小時派得最少的。額度用完冷卻到 log 裡的重置時間(看不出來就 `caps.account_cooldown_minutes`,預設 30)。
- 用量與冷卻是這台電腦**所有專案共用**的(v4.7,`~/.config/dlm/account-log.jsonl`):專案 A 把 max-a 用到額度滿,專案 B 也會跳過它。
- 一個帳號同時跑好幾個 worker 也可以;方案的額度是整個帳號共用的,`caps.parallel` 開大會用得比較快。
  要限制就設 `dlm account set max-a --max-parallel 2`:所有專案加起來同時最多 2 個 worker 用它,滿了就換 pool 裡下一個,
  全滿就這輪不派(主控台與 `dlm tick` 顯示「帳號都在忙」)。Critic 不受這個限制(它很短,而且會擋著合併)。

## 自治與預算

`autonomy.level` 預設 1,最高 2(見 AUTONOMY.md)。`budget.daily_usd` 預設 5。`caps.parallel` 同時施工數,
`caps.unmerged` 未合併上限。

## 驗收強度(建議開)

這兩項的指令由技術棧給預設(`tools/stacks/<名稱>/stack.json`;node-ts 是 cucumber dry-run 與 stryker),核心本身不認得任何測試框架。

- `verify.dry_run_cmd`:測試棒要所有步驟都綁定(node-ts:`npm run --silent accept:dry -- -- {gherkin}`)。
- `verify.mutation`:最後一棒對這一棒改到的實作檔跑增量變異測試;分數低於 `min`(預設 50;strict 節點用 `min_strict`,預設 70)時 strict 判 FAIL、其他交第二意見。
  有它之後,沒設 Verifier 模型也不必把每個最後一棒都送去問你。

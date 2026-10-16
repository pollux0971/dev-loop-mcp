# 安全與隔離

headless worker 會執行指令、寫檔;而 dp 驗收時跑的就是 worker 寫的測試與步驟定義。dp 執行專案程式碼的地方都經過
`tools/lib/sandbox.mjs`:worker 在沒有 `.git` 的副本裡施工,驗收在用完即丟的副本裡跑,合併前的全 gate 在臨時 merge-tree 裡跑。

**這些不是作業系統層級的隔離。** 程式以你的身分在這台電腦上執行,讀得到你的家目錄。Claude worker 的預設指令擋 `rm -rf`、
`rm -fr`、`sudo`,但擋不住換個寫法的刪除;重要的東西請有備份。

v4.0 的容器沙箱(docker / podman / srt、`pass_env`、訂閱登入資料夾、`dp check sandbox` 的三個陽性對照)三次實跑都沒用到,
v4.1 拿掉了。要讓 worker 碰不到家目錄、或只放行模型 API 網域時再加回來(程式在 v4.0.0 的 `sandbox.mjs`)。

## worker 不碰 `.git`

派工時 dp 把 worktree 匯出一份**沒有 `.git`** 的副本(`.dp/sandboxes/<dispatch>/`)給 worker,並記下每個檔的 sha。
worker 結束後,dp 比對整份副本(含被 ignore 的檔):

- 範圍內的變動同步回 worktree,由 dp 以 `dp` 身分 commit(被 ignore 的檔也會進 commit,讓 paths 檢查看得到)。
- 碰到 `.git`、`.dp/`、換掉 `node_modules`、建 symlink → 不同步,記成 `sandbox-escape`,這一棒退回。

worker 不需要也不應該執行任何 git 指令。

## 依賴(node_modules)

- worker 的副本用 symlink 指到根目錄的 node_modules;dp 在派工前後比對它的指紋,被改就退回。
- merge-tree 不再 symlink 根目錄:有 `package-lock.json` 時用本機快取 `npm ci --offline --ignore-scripts` 裝一份乾淨的
  (`gates.install`:`auto` / `ci-offline` / `link`)。快取裡沒有的套件會讓 gate 紅掉——先在根目錄 `npm install` 一次。
- 要加或升級依賴:開一個 `shared/deps` 節點,owns 明列 `package.json` 與 lockfile,經你批准(L2 以上可由 Critic 批准)。

## 你的授權與 Front 的權限

Front 在你眼前工作,Claude Code 自己的權限確認照常有效,dp 不把它鎖成唯讀。

1. **UserPromptSubmit hook**(`.claude/settings.json`,`dp init` 會裝)把你每一輪真正送出的文字,用 repo 外的金鑰
   (`~/.config/dp/key`,權限 0600)做 HMAC,存進 `.dp/utterances.jsonl`。
2. `decide`、`confirm`、`resume`、`unblock` 信任 Front 轉達,`--verbatim` 可省略。有給且是你最近 `auth.window_minutes`(預設 30)
   分鐘內某句已簽章原話的子字串,事件記 `auth: utterance` 與那句話的 hash;對不上就記 `auth: trust`。事後看帳本分得出哪些是你親口說的。
3. **PreToolUse hook**:讀檔、改檔、跑任何指令都放行。只擋用檔案工具直接寫 `ledger/`、`dag.json`、`.dp/`(`.dp/intake/` 除外)、
   原話紀錄,以及讀寫金鑰目錄。這些只該由 dp 寫,手改會讓簽章鏈斷掉、tick 停機。Front 直接改了程式要 commit,否則 tick 會等。

自己在這個專案裡用 Claude Code 做一般開發(不是當 Front)時,啟動前可以設 `DP_HOOKS=off`(通常也不必)。
已經有自己的 `.claude/settings.json`:`dp init --existing` 不會覆蓋它,請把 `payload/.claude/settings.json` 的 `hooks` 合併進去。

v4.0 的嚴格模式(`auth.mode: signed` 要求原話對得上簽章、`front.guard: strict` 把 Front 鎖成唯讀、沒有 hooks 時用 `dp approve`
在終端機親手確認)實跑沒用到,v4.1 拿掉了。

## 帳本簽章

每筆事件帶 `prev_hash`(前一行的 sha256)與 `mac`(同一把金鑰的 HMAC)。有人直接在帳本尾巴附加或改寫一筆,
`dp check ledger` 會報錯,tick 拒絕執行(退出碼 3)。舊帳本從第一筆有簽章的事件(`chain_start`)開始上鏈。
在沒有金鑰的機器上看,只能驗 `prev_hash` 鏈。

## 其他防線

- 證據重跑:只收 `verify.rerun_allow` 開頭(前綴要落在參數邊界)、且只含英數與 `._/:=@+-`、空白的指令;不能有絕對路徑或 `..`。
  以 argv 執行、不經 shell。白名單預設沒有 `cat`、`ls`。重跑 FAIL 不附輸出,不會回灌到下一張工單。
- 越界(paths、worktree、sandbox-escape 任一 FAIL)的那一棒,dp 不在它的樹上執行任何指令,直接退回。
- 規則層、ledger、dag、契約、dp 本身,以及 gate 定義檔與 agent 設定(根目錄 `package.json`、lockfile、`tsconfig.json`、
  `vitest*.config.*`、`cucumber.js`、`stryker.config.json`、`scripts/**`、`.mcp.json`、`.github/**`、
  `.gitattributes`、`.gitignore`)都在 `forbidden_paths`。確實要改,開 owns 明列該檔的 `shared/*` 節點給你批准。
- dp 執行的每一條 git 都帶 `-c core.hooksPath=/dev/null`;每個 tick 比對 `.git/config` 指紋,被改就停機。
- 整個 tick 在 `.dp/tick.lock` 裡;背景迴圈用 `.dp/run.lock`。
- 施工事件只有 orchestrator 能寫,`verify` 只有 verifier,使用者解封只有 user;`dp decide` 沒有 `--as`。
- 給 Front 看的 worker / 模型 / git 文字一律包在 `<untrusted>` 圍欄裡。
- 預算:`budget.daily_usd` 到頂就停止派工(能從 agent 輸出解析到花費時)。

## MCP 與 hub(v4.7)

- `dp mcp` 是這台電腦一個:能操作所有登記的專案,包括 decide。dp 派出去的 worker / Critic 不能用:`DP_ROLE` 有值或目錄在 `.dp/` 底下就拒絕啟動,
  worker 的副本也沒有 `.mcp.json`。決定類工具的說明寫明只能轉達使用者這一輪的原話;跟 Front 一樣,AI 被騙到時帳本查得到,但擋不住。
- `dp hub` 只綁 127.0.0.1;Host 必須是 127.0.0.1 / localhost(擋 DNS rebinding),有 Origin 就必須是同一個(擋別的網站送表單)。
  除了 health 與 openapi,`/api/*` 都要 token(`~/.config/dp/hub-token`,權限 0600,`dp hub token` 看);首頁內嵌 token,所以首頁本身也只給本機。
- hub 對專案的操作是在那個專案裡跑 `node tools/dp.mjs op <名稱>`,參數走 stdin JSON、不經 shell,每個值先照 API 的 schema 檢查。
- 帳號清單、跨專案的帳號紀錄、專案清單都在 `~/.config/dp/`(`DP_CONFIG_DIR` 可改),不進任何 repo。

## 還沒擋住的

- worker 跟你是同一個 OS 使用者:讀得到金鑰、可以直接執行 dp、看得到你的家目錄。帳本簽章防的是手誤與粗糙的竄改,不是蓄意的對手。
- Front 若被 worker 輸出裡的文字騙到,可能替你做決定。帳本會記 `auth: trust`,事後查得到。
- worker 的網路不設限。
- worker 的 MCP 白名單還沒做(P2)。
- 同一個 OS 使用者的其他程式讀得到 hub token,就能呼叫 API(跟能直接跑 `dp decide` 一樣)。

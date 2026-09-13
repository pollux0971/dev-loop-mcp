# scripts/py/ — 定向反向驗證工具(Python 版)

`mutate.py` 是 `docs/07-practices.md` (e) 節「定向反向驗證當 gate」的 **Python 版落地**,
來源是專案 C(nightmare-assault)的 `dev/tools/mutate.py`,經使用者授權於模板 1.3.1 收入。
`test_mutate.py` 是它的 meta-test(已知答案的合成樣本,驗證工具自己判斷「假陰性 / 誤判 /
正確分類」的邏輯沒有腐化)——兩個檔案是一組,只收 `mutate.py` 不收 meta-test 就不是同一個工具。

TS 版(`scripts/mutate.ts`)仍是**待做**,規格見 `docs/07-practices.md` (e)。兩版介面應該
比照同一套 CLI 形狀,方便專案在 TS/Python 兩種工具鏈之間切換時不用重學一套心智模型。

## 用途

把「這條測試真的守著這行程式碼」做成一個可重複執行的 gate,不是變異測試分數這種統計指標。
核心是逐張指定的定向突變:告訴工具改哪個檔、把什麼換成什麼、預期哪個 pytest node id 一定要
變紅(可選:失敗訊息要包含哪段文字)。完整規格(五步流程、exit code 分類、meta-test 要求)見
`docs/07-practices.md` (e)——本檔只講怎麼用這支工具本身。

## 用法

```bash
python3 scripts/py/mutate.py \
    --file core/scheduler.py \
    --replace "return a + b" \
    --with    "return a - b" \
    --expect-fail tests/test_scheduler.py::test_add
```

逐張指定,一次只驗一個突變點:

- `--file`:要突變的檔案路徑(相對呼叫時的 git repo 根,由 `git rev-parse --show-toplevel`
  現場偵測,不是相對本工具所在位置)。檔案必須受 git 追蹤(未 commit 過的檔案會被拒絕,見下)。
- `--replace`:要被取代的**字面字串**(不是 regex)。
- `--with`:取代成的字面字串。
- `--expect-fail`:套用突變後應該變紅的 pytest node id,例如 `tests/foo.py::test_bar`。
  這個 node id 在套用突變**之前**必須是乾淨的綠(exit code 0)——不是綠,gate 本身中止,
  不會繼續往下做任何事。
- `--expect-message`(規格已定,見下方「跟 07-practices (e) 的對應」):目前 `mutate.py`
  尚未實作這個旗標本身的字串比對——通過與否目前用 pytest exit code(1 = 斷言失敗)判斷,
  不比對訊息文字。要核對訊息內容,直接讀本工具印出的「pytest 輸出(尾 20 行)」段落。
- `--nth <k>`(1-based):`--replace` 指定的字串在檔案裡命中 **≥2 處**時,工具不會猜你要
  哪一個,一律**拒絕執行**並列出每一處命中的行號;要指定其中特定一處,加這個旗標。省略
  `--nth` 且命中恰好 1 處時正常執行;命中 0 處一律拒絕(不管有沒有給 `--nth`)。

### Exit code 表

| Exit code | 意義 |
|---|---|
| 0 | 突變前綠、突變後因斷言失敗(pytest exit 1)變紅,已安全還原並用 sha256 驗證一致——**通過** |
| 1 | 使用方式錯誤:引數錯、檔案不存在、檔案不受 git 追蹤、`--replace` 字串找不到、`--replace` 命中 ≥2 處且未給 `--nth`、`--nth` 超出命中範圍、或突變前這個 node id 本來就不是乾淨的綠 |
| 2 | 突變沒有讓測試變紅(套用突變後 `--expect-fail` 仍然通過)——這個突變測試本身無效,是假陰性,gate 存在的理由就是抓這個;檔案已還原 |
| 3 | 還原後 sha256 不一致(理論上不應發生,代表 git object 本身有問題);嚴重錯誤 |
| 4 | 無法判定:突變後 pytest 的非零 exit code 不是 1(中斷 / 內部錯誤 / 用法錯誤 / 沒收集到測試),可能是高負載機器上的 timeout 或環境問題造成的假紅,不能當作突變生效的證據;檔案已還原 |
| 5 | 上一次執行被 SIGKILL 等訊號中斷、留下無法解析的自癒狀態檔——需要人工介入,不會自動嘗試新的突變 |

### 中斷自癒(STORY-70-18)

高負載機器上 `mutate.py` 可能被訊號中斷:

- **SIGTERM / SIGINT**(可攔截):套用突變前就註冊好的 signal handler 會立刻用
  `git show <sha>:<path>` 還原檔案再結束,跟正常路徑走同一套還原邏輯。
- **SIGKILL**(攔不到):中斷當下檔案一定殘留突變內容,tip 是髒的——這是這一層防線
  故意不假裝能攔下來的地方。但**下一次執行**本工具(不管檔案或引數是否相同)都會先掃描
  一個不受 git 追蹤的 sentinel 目錄(`<git-dir>/mutate-state/`),發現上次殘留就自動還原、
  印出「自癒」訊息、刪除 sentinel,再繼續往下跑——下一次呼叫本身就是自癒點,不需要人記得
  手動處理。sentinel 內容本身若損毀,回 exit 5,不猜測、不靜默刪除。

實作見 `mutate.py` 的 `_install_signal_handlers` / `_handle_kill_signal` / `_self_heal`
(docstring 段落見「被中斷時(STORY-70-18)」)。

### `.pyc` 假陰性防護

突變前後兩次 pytest 是各自獨立的 subprocess,中間只隔著一次檔案寫入。若目標檔的
`__pycache__` 沿用舊的 bytecode(mtime 落在同一秒內時可能發生),突變後那次 import 會讀到
突變前殘留的 `.pyc`,讓真正會讓測試變紅的突變被靜默吃掉——分數看起來正常,但完全沒測到
新程式碼。`mutate.py` 的 `_run_pytest` 對兩次 pytest 呼叫都設 `PYTHONDONTWRITEBYTECODE=1`,
禁止讀寫任何 `.pyc`,確保每次都從磁碟上「當下」的原始碼重新編譯。這正是 (e) 節提到的
「C 的 `mutate.py` 抓到一次 `.pyc` 快取造成的假陰性」那次事故的修法。

## 怎麼跑 meta-test

`test_mutate.py` 不 import 專案 C 的任何模組、不依賴專案 C 的 repo 佈局(`dev/tools/`)或
它的 `conftest.py`——每個測試都建立一個一次性的暫存 git repo(`tmp_path` fixture),對
`mutate.py`(與本檔同目錄)用 `subprocess` 或直接載入模組跑,不觸碰呼叫時所在 repo 的 git
歷史。因此可以在 `scripts/py/` 這個目錄下直接、獨立地跑:

```bash
cd scripts/py
python3 -m pytest test_mutate.py -q
```

不需要額外的 `conftest.py`——已驗證 `pytest` 的 rootdir 會落在 `scripts/py/` 本身
(single 檔案這樣跑不會往上层撿到其他專案的 pytest 設定或 fixtures)。17 個測試涵蓋每個
exit code 至少一次(含 STORY-70-14 的多處命中拒絕與 `--nth`、STORY-70-18 的 SIGTERM/SIGKILL
自癒)。

## 跟 TS 版規格(07-practices (e))的對應

| 07-practices (e) 規格項 | `mutate.py` 現況 |
|---|---|
| 五步流程(基準先綠、突變、必須變紅且紅得對、精確還原、exit code 分類) | 全部實作,見上方 exit code 表 |
| `--nth` 指定第幾個命中 | 已實作(STORY-70-14) |
| `--expect-message` 比對失敗訊息文字 | **未實作**——目前只用 pytest exit code 判斷斷言失敗,訊息文字要人工核對「pytest 輸出(尾 20 行)」段落 |
| 精確還原用 `git show`,不用 `git checkout --` | 已實作,見 `_read_blob_bytes` |
| 還原後 sha256 逐位元比對 | 已實作 |
| 工具自帶 meta-test | `test_mutate.py`,17 個測試 |
| 中斷自癒 | 已實作(STORY-70-18),TS 版規格未提及這一項,是 Python 版比規格多做的 |

## 授權與來源

`mutate.py`、`test_mutate.py` 原樣複製自 nightmare-assault(專案 C)`dev/tools/mutate.py`
與 `tests/test_mutate.py`(HEAD `4f1948ac`),使用者於 2026-09-05 授權收入本模板 1.3.1。
兩個檔案除了加檔頭 SOURCE 註解、改 `MUTATE_PY` 路徑解析(改成同目錄相對路徑,不是專案 C 的
`dev/tools/` 佈局)以外,邏輯未變動——多處命中拒絕與 `--nth` 是專案 C 原本就有的實作
(STORY-70-14),不是本次新增。原始檔只讀不改,`git -C <project-C repo> status --short`
前後不變。

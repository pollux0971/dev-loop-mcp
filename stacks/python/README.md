# python

Python 3.10+ + pytest(單元測試)+ pytest-bdd(gherkin 驗收)。依賴裝在專案自己的 `.venv`(`requirements-dev.txt`),dlm 不裝套件。

- `template/`:新專案的 `pyproject.toml`(pytest 設定:`pythonpath = ["src"]`、`--import-mode=importlib`)、`requirements-dev.txt`、
  `scripts/accept.py`(驗收入口)、`scripts/run.py`(執行入口:`.venv/bin/python scripts/run.py <套件> [參數]`,用這棵樹自己的 `src`)、
  `features/steps/README.md`、`src/test_layout.py`。
- `rules.md`:給 worker 的 Python / pytest-bdd 寫法規則。
- 沒有 `checks.mjs`;「紅的原因不對」的判斷用 `stack.json` 的 `add.bad_red`(步驟沒綁定、縮排錯誤)。找不到實作模組照樣算正常的紅。
- `detect` 是空的:這個技術棧只在 `project.stack` 寫了 `python` 時才用(`dlm init --stack python`;既有 Python 專案由 `dlm setup` 寫)。

## 依賴(`.venv`)

- 每個副本(worker 的沙箱、驗收副本、合併樹)裡的 `.venv` 都是指回根目錄的 symlink;派工前後比對指紋,worker 透過 symlink 改了 `.venv` 就退回。
- 指紋不算 `__pycache__` 和 `.pyc`(跑一次 pytest 就會寫);為了不讓人偷放 `.pyc`,dlm 判定的每一次執行都設 `PYTHONPYCACHEPREFIX`(每次一個新的暫存目錄),Python 不會讀 `.venv` 裡的 `.pyc`。
- `dlm setup` 看到 `pyproject.toml` 但沒有 `.venv` 時,會問要不要 `python3 -m venv .venv && .venv/bin/python -m pip install -q -r requirements-dev.txt`。

## 驗收(`scripts/accept.py`)

- `scripts/accept.py <feature>…`:跑 `features/steps/**` 底下內容含有那個 feature 路徑字串的 `.py`。某個路徑一個模組都沒有 → 印出原因、exit 1。
- `scripts/accept.py`(不給參數):跑全部步驟模組,但跳過只用到 `.dlm/pending-features.json` 裡 feature 的模組(還沒做完的節點);一個模組都沒有 → exit 0。

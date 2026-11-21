## 這個專案的技術棧:python(pytest / pytest-bdd,依賴在 .venv)

- 程式放 `src/<能力>/`,單元測試 `test_*.py` 放在旁邊(`src` 已經在 import 路徑上:`from <能力>.core import x`)。
- 驗收步驟模組放 `features/steps/<能力>/test_<能力>_<版本>.py`(整合點放 `features/steps/integration/`),檔頭寫 `scenarios("features/<能力>/<版本>.feature")`,**路徑跟節點的 gherkin 一字不差**:`scripts/accept.py` 用這個字串找模組,對不上就等於沒有步驟。
- 步驟定義與 fixture 寫在自己的測試模組裡。**不能加 `conftest.py`**(任何一層都不行:conftest 的 hook 能讓失敗的測試回報通過);真的要共用的 fixture 或句子,在 report 的 `ticket_problems` 提出,由 shared 節點處理。別的模組已經定義的句子不要照抄。
- 證據指令:`.venv/bin/python -m pytest -q src/<能力>`、`.venv/bin/python scripts/accept.py <gherkin>`。不要加環境變數前綴。
  宣稱照輸出寫,例:「`.venv/bin/python -m pytest -q src/greet` exit 2:收集 `src/greet/test_core.py` 時 ModuleNotFoundError: No module named 'greet.core'」。`-q` 不會列出通過的測試名稱,不要宣稱「某某測試維持綠」。
- 測試棒的紅要是「實作還不存在」(`ModuleNotFoundError` / `ImportError` 可以);步驟沒綁定、縮排錯誤、語法錯誤會被退回。
- 只用標準庫和 `requirements-dev.txt` 裡有的套件。不要 `pip install`,不要把專案本身裝進 `.venv`,不要碰 `.venv/`。
- 執行程式(整合點的 @e2e、任何「跑起來」的證據)一律用 `.venv/bin/python scripts/run.py <套件> [參數]`(用這棵樹自己的 `src`);套件要有 `__main__.py`。不要用 `cd src`、`PYTHONPATH=…`。
  給使用者看的執行方式(程式的 usage、說明文字)也寫這個形式:在專案根目錄直接 `python -m <套件>` 找不到模組。
- 不要改 `pyproject.toml`、`requirements*.txt`、`conftest.py`、`scripts/**`(gate 定義檔)。

## 這個專案的技術棧:python(pytest / pytest-bdd,依賴在 .venv)

- 程式放 `src/<能力>/`,單元測試 `test_*.py` 放在旁邊(`src` 已經在 import 路徑上:`from <能力>.core import x`)。
- 驗收步驟模組放 `features/steps/<能力>/test_<能力>_<版本>.py`(整合點放 `features/steps/integration/`),檔頭寫 `scenarios("features/<能力>/<版本>.feature")`,**路徑跟節點的 gherkin 一字不差**:`scripts/accept.py` 用這個字串找模組,對不上就等於沒有步驟。
- 步驟定義寫在自己的模組裡(不能加 `conftest.py`);別的模組已經定義的句子不要照抄,需要共用就在 report 的 `ticket_problems` 提出。
- 證據指令:`.venv/bin/python -m pytest -q src/<能力>`、`.venv/bin/python scripts/accept.py <gherkin>`。不要加環境變數前綴。
- 測試棒的紅要是「實作還不存在」(`ModuleNotFoundError` / `ImportError` 可以);步驟沒綁定、縮排錯誤、語法錯誤會被退回。
- 只用標準庫和 `requirements-dev.txt` 裡有的套件。不要 `pip install`,不要把專案本身裝進 `.venv`,不要碰 `.venv/`。
- 不要改 `pyproject.toml`、`requirements*.txt`、`conftest.py`、`scripts/**`(gate 定義檔)。

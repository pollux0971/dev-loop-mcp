# steps/ — 驗收步驟模組(pytest-bdd)

一個節點一個模組:`features/steps/<能力>/test_<能力>_<版本>.py`;整合點放 `features/steps/integration/test_i<n>.py`。

```python
from pytest_bdd import given, parsers, scenarios, then, when

scenarios("features/todo/v1.feature")  # 跟節點的 gherkin 路徑一字不差


@given("an empty list", target_fixture="todo")
def empty_list():
    from todo.core import TodoList  # 實作還不存在時,這裡的 ModuleNotFoundError 是正常的紅
    return TodoList()


@when(parsers.parse('I add "{title}"'))
def add(todo, title):
    todo.add(title)


@then(parsers.parse("the list has {n:d} item"))
def count(todo, n):
    assert len(todo) == n
```

## 規則

- `scenarios(...)` 的路徑要跟 gherkin 一字不差:`scripts/accept.py <feature>` 用這個字串找模組,找不到就 exit 1。
- 實作在步驟函式裡 import(或檔頭 import 也可以:找不到模組算正常的紅);不要 import 別的步驟模組。
- **Given 設定狀態,When 做一件事,Then 只斷言**。步驟只是薄薄一層轉接,邏輯在 `src/` 裡。
- 步驟定義只在自己的模組裡有效(沒有 `conftest.py`,worker 也不能加)。兩個模組都要用的句子各自定義;措辭跟著 feature 檔走。
- 有步驟沒綁定(`StepDefinitionNotFoundError`)、縮排錯誤、語法錯誤 = 紅的原因不對,測試棒會被退回。
- 跑:`.venv/bin/python scripts/accept.py features/todo/v1.feature`;全部(跳過還沒做完的節點):`.venv/bin/python scripts/accept.py`。

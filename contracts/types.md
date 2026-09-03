# 契約:型別與檔案格式

> 版本:{{CONTRACT_VERSION}}(建議從 `1.0.0` 開始)
>
> **硬約定**({{HARD_CONTRACT_SECTIONS}}):改動需 ADR。
> **軟約定**({{SOFT_CONTRACT_SECTIONS}}):改了跑測試、更新本文件、commit 說明理由即可。
> 分層理由見 `README.md`。

以下是所有**跨模組**的定義。模組內部型別不在此。

版號慣例(語意化版本):改欄位語意或拿掉欄位 = major;加選填欄位 = minor;
修文字或補說明 = patch。

---

## 1. 識別碼與基本型別

每個跨模組用得到的原子型別放這裡,附上格式限制與一個範例。這是後面所有章節的地基,
先把這個定下來,後面才不用每一節重複解釋「id 長什麼樣」。

```ts
type {{ENTITY}}Id = string;   // 格式限制,例如 /^[a-z]{2,6}-\d{4}$/,附一個合法範例
type IsoDate = string;        // "YYYY-MM-DD",一律當地日期,不含時間
// 依專案需要繼續加:IsoWeek、Stage、Level、Source ……
```

## 2. §{{HARD_SECTION_1_NUM}} · (硬約定範例:核心實體的檔案格式)

檔案:`{{ENTITY_DIR}}/<category>/<id>.{{ENTITY_EXT}}`

```ts
interface {{ENTITY}}Frontmatter {
  id: {{ENTITY}}Id;
  // 依專案需要繼續加欄位,每個欄位註明是否必填、預設值
}

interface {{ENTITY}} {
  frontmatter: {{ENTITY}}Frontmatter;
  body: string;
}
```

**這一節是「一個具體的權威定義寫在哪裡」的範例**——原專案在這裡放了一條字數規則
(一個實體正文的字數上限,含 CJK / 非 CJK 序列 / 標點的精確計算演算法與邊界案例對照表)。
如果你的專案也有「兩個獨立實作可能算出不同答案」的規則(字數、雜湊、排序鍵、
校驗碼……),**把演算法寫成可以逐步照做的步驟,並附一張邊界案例對照表**,
不要只寫「大概怎麼算」——含糊的定義是契約最容易出歧義的地方,而且往往要等到
兩個功能整合時才會被發現。

## 3. §{{HARD_SECTION_2_NUM}} · (硬約定範例:第二種磁碟格式)

檔案:`{{SECOND_ENTITY_DIR}}/<id>.{{SECOND_ENTITY_EXT}}`

```ts
interface {{SECOND_ENTITY}} {
  // ...
}
```

## 4. §{{HARD_SECTION_3_NUM}} · (硬約定範例:狀態 / 進度檔)

檔案:`{{STATE_DIR}}/{{STATE_FILE}}`,型別 `Record<{{ENTITY}}Id, {{STATE_ENTRY_TYPE}}>`

```ts
interface {{STATE_ENTRY_TYPE}} {
  date: IsoDate;
  // ...
}
```

**寫入這個檔案的模組要遵守 CLAUDE.md 的原子寫入硬規則**:寫暫存檔、fsync、rename。

## 5. §{{SOFT_SECTION_1_NUM}} · (軟約定範例:某個計算結果的型別)

```ts
interface {{RESULT_TYPE}} {
  // ...
}
```

## 6. §{{SOFT_SECTION_2_NUM}} · (軟約定範例:核心函式簽章)

```ts
function {{CORE_FUNCTION}}(input: /* ... */): /* ... */;
```

## 7. §{{HARD_CONTRACT_SECTIONS_4_NUM}} · (硬約定範例:任務型常數與路由表,如果有多 provider / 多後端路由)

```ts
type {{TASK}} = /* 列舉所有任務名 */;

interface RouteTable {
  // task → provider / backend 的對照
}
```

如果你的專案沒有這種「依任務路由到不同後端」的需求,刪掉這一節與對應的硬約定條目。

## 8. §{{SOFT_SECTION_3_NUM}} · (軟約定範例:檔案系統存取介面)

```ts
interface {{FS_INTERFACE}} {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  // ...
}
```

給 UI 或需要在測試中替換成記憶體實作的模組用。Wave 0 期間各功能可以自己寫一個
記憶體版本,整合後換成真正的檔案系統實作。

## 9. §{{HARD_CONTRACT_SECTIONS_5_NUM}} · 目錄結構

```
{{PROJECT_DATA_ROOT}}/
├── {{ENTITY_DIR}}/<category>/<id>.{{ENTITY_EXT}}
├── {{SECOND_ENTITY_DIR}}/<id>.{{SECOND_ENTITY_EXT}}
├── {{STATE_DIR}}/{{STATE_FILE}}
└── ...
```

---

## 範例:一個填好的章節長什麼樣

上面每一節都是骨架,下面示範「硬約定寫到多細才算夠」(改編自一個真實專案,
只留下形狀,不含任何產品細節):

> ### §2 · 筆記
>
> 檔案:`notes/<category>/<id>.md`
>
> ```ts
> interface NoteFrontmatter {
>   id: NoteId;            // /^[a-z]{2,6}-\d{4}$/
>   category: CategoryId;
>   level: number;         // 0..4
>   created: IsoDate;
> }
> interface Note {
>   frontmatter: NoteFrontmatter;
>   body: string;          // 上限 100 字,演算法見下
> }
> ```
>
> **字數規則**(硬約定,權威定義):
> 1. 逐字元掃描,分三類:CJK(計 1)、字母數字連續序列(整段計 1)、其他(標點/空白,計 0)
> 2. 「其他」類會切斷序列
>
> | 內容 | 結果 | 為什麼 |
> |---|---|---|
> | `same-origin` | 2 | 連字號切斷,`same` + `origin` |
> | `TLS` | 1 | 一個連續序列 |
>
> 這種「寫出演算法 + 邊界案例表」的密度,才是硬約定該有的樣子。

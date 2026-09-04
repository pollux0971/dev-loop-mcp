---
name: phase-acceptance
description: 驗收一個 phase。當使用者說某個 phase 做完了、寫完了、可以收了,或問「這樣算完成了嗎」時使用,跑測試、跑單獨執行指令、跑嚴格級變異測試、列出人工確認清單。防止「感覺做完了」就標記完成。也在使用者直接要求 /phase-done 時使用。
---

# /phase-done — 驗收

**這是互動用的最小集,不是唯一驗收強度。** 派工(協調者對 worker、審核 agent 對 dev)驗收用
`.orca-brief/TASK.md.template` 這類工單模板——工單可以要求反向驗證、逐項列前提各自實測、
審核輪重跑對照表宣稱的守門,這些都比這支 skill 的預設步驟嚴。單人互動、或還沒有工單機制時,
跑這支 skill 本身就夠;有工單機制在跑時,不要因為這支 skill「跑過」就覺得驗收已經到位
(來源:專案 A 協調者的實戰記錄,見 `docs/07-practices.md`「來自專案 A 協調者的做法」)。

## 合併 ≠ done(來源 nightmare-assault,D15)

**合併門檻**與**done 門檻**是兩件不同的事,不要混用同一個判準:

- **合併門檻 = gate 綠**:`npm run check:all` 過,分支可以合進 main。合併只代表「這份 diff 沒有破壞既有的守門」。
- **done 門檻 = DoD**(見第八步「核心項全過」)。一個 phase **可以先合併、phase 表仍然維持 `in-progress`**——
  合了不等於做完,不要因為合併動作本身就順手把狀態改成 `done`。
- **已知缺陷**(測試現在就是紅的,而且是已知的、暫時不修)不能用 `test.fails` / `.skip` 藏起來(那是 P-46 的
  假綠),而是掛 `@known-defect` tag,**同時**登記進 `known-defects.json`(欄位:`feature`、`scenario`、`reason`、
  `fix_in`、`since`、`hard_rule`),兩邊要對得上——`check:known-defects` gate 機械驗證 tag 跟登記表的
  multiset 相等,見 `scripts/check-known-defects.ts`。**`fix_in` 規則**:一般缺陷 `fix_in` 可以是佔位值
  (`""` / `"未定"` / `"TBD"`);但如果這個缺陷鎖住的是**對某條無例外硬規則的違反**(`hard_rule: true`),
  `fix_in` **不准**是佔位值——一個「之後再修」的標記不能拿來把硬規則的違規合法化,那跟「用 gate 代替修」是
  同一族問題(見 `docs/07-practices.md` (y))。

目標:`$ARGUMENTS`

## 第一步:定位

解析為 `features/<NN-name>/phase-<N>.feature`。找不到就停,列出該資料夾有哪些 phase。

讀取該 `.feature`、該資料夾的 `FEATURE.md` 與 `NEXT.md`、`docs/01-roadmap.md` 找出所屬階段。

**派工前的對照(協調者派 dev 之前就該做,不是驗收時才做,來源 AI_KM #19)**:紅場景要先對照這個 phase 在
`FEATURE.md` phase 表的「意圖」欄(這個 phase 要讓人做到什麼),確認場景描述的行為真的落在這個意圖裡,再派工——
避免派錯方向,dev 照著一個跟意圖對不上的紅場景做出一個「測試綠了但不是這個 phase 該做的事」的結果。

## 第二步:前置檢查

- 狀態必須是 `in-progress`。`todo` / `ready` → 回報「尚未開始」並停。`done` → 回報完成日並停。
- `NEXT.md` 的三類 gate 必須都滿足。有未滿足的,列出並停。

## 第三步:自動場景

```
# 注意:cucumber 11 會把命令列的位置路徑跟設定檔的 paths「合併」而不是覆蓋,
# 直接給檔案路徑會跑到整個 repo 的場景。一律用 tag 選:
npm run accept -- --tags "@<name> and @phase-<N> and not @manual"   # 走 npm script 才有 NODE_OPTIONS=--import=tsx,裸跑 cucumber-js 會 ERR_UNKNOWN_FILE_EXTENSION
```

`features/steps/` 為空時改跑 `npx vitest run`,並把每個非 `@manual` 場景對照到測試名稱,
回報哪些場景沒有對應測試。

記錄:通過數、失敗數、失敗場景與錯誤摘要。

## 第三步半:它現在守著什麼?

問三段式問句,答案都寫進驗收報告(來源:專案 A 協調者的實戰記錄,三段問句合起來才涵蓋
P-42 記錄的三種變體——前兩種是「忘了填」,第三種是「填不進去」,最不容易被發現):

1. **這個 phase 交付的東西,現在接上的真實對象是什麼?列出來。**(哪些 prompt 檔、哪些真資料、哪些真入口)
   列得出來且不是 demo / fixture → 往下;答案是「只有 demo / selftest / fixture」→ **不算 done**,退回 in-progress(P-42)。
2. **有沒有哪個對象列不出來?** 能列的東西就要求寫成守門(例:每個 prompt 檔都被某個 golden set 引用,否則紅)。
3. **有沒有哪個對象是現在這個資料結構根本表達不了的?** 不是「忘了寫」,是「就算想寫也沒有欄位可以放」
   (例:多個 prompt 檔共用同一個 task key 時,golden set 的資料結構永遠只能守到其中一個,另外幾個
   不是沒守到,是這個結構天生守不到)。這種要記 ADR,不是補一筆資料就能解決。

對照表(突變 / 場景 / 反向驗證清單)存在時,額外加一步:**對照表每一列,拿掉它宣稱擋住的守門重跑一次,
場景必須紅**——不是重跑整份測試看綠燈,是驗證「拿掉這個守門,現在應該紅」這件事本身成立
(來源:B 兩天內抓到 4 次「綠但沒證明」,見 `docs/07-practices.md` (g))。

**第四段(來源 nightmare-assault,見 `docs/07-practices.md` (u) 與 PITFALLS P-68)**:上面任何一段的答案是
「0」「沒有」「找不到」時,先問一句再往下判:這個 0 是量出來的,還是探針找不到?同一支探針在已知非 0 的
情境跑過一次沒有?沒有跑過就不能把這個 0 當「乾淨」的證據——先找一個已知會命中的情境驗證探針本身有作用,
數不出來才代表探針本身壞了,不是被測物真的沒有問題。

## 第四步:單獨執行

從根目錄的 `standalone.json` 取出該功能的項目,**實際執行 `cmd`**。

- `interactive: false` → 跑它,退出碼符合 `expectExit`(預設 0)且輸出含 `expect` 字串 → 通過
- `interactive: true`(dev server 之類) → 無法自動驗,列進 `@manual` 清單
- 跑不起來 → **不算 done**,即使所有測試都過。這是核心項目

`standalone.json` 沒有這個功能的項目 → 提醒補上,但不擋。

## 第五步:Wave 0 的獨立性檢查(選配)

**只在該 phase 屬於 Wave 0 時執行。**

```
npm run boundaries
```

它掃跨資料夾 import,合法的只有 `contracts/`、自己的目錄、第三方套件。

發現違規 → **回報但不擋**。多數情況這是真的問題,但也可能是一個合理的例外
(組合層——把其他模組串起來的薄薄一層——常常是 `docs/02-decision-map.md` ADR-004
裡記錄的那種明確例外)。列出來讓使用者判斷,如果是刻意的例外,提示用
decision-record 記一筆。

順帶確認 `FEATURE.md` 的「Wave 0 的重複」表有列出這個 phase 造的 stub。漏了就補。

## 第六步:變異測試

依 `FEATURE.md` 的變異門檻欄位:

| 級別 | 做法 |
|---|---|
| **嚴格** | **變異分數 ≥ 95% 或定向反向驗證(對照表每一列拿掉它宣稱的守門重跑必紅)二選一,擇一即可,但至少要有一種**。未達門檻不算 done——這些模組算錯會延遲很久才顯現。**嚴格級由另一個 session 審**,不是宣稱通過的同一個 session 順手看一眼(`docs/07-practices.md` (g)) |
| 標準 | 跑其中一種。未達**回報但不擋**,問使用者要不要處理 |
| 寬鬆 | 跳過 |

**嚴格級的整支 `/phase-done` 由另一個 session 執行**(來源 AI_KM):不是只有變異測試那一步換人審,是這次
驗收整體換一個沒有寫過這個 phase 實作的 session 來跑。而且**這個 session 的第一步就是本步驟(變異 / 定向
反向驗證)**,不是照本 skill 從第一步「定位」依序做到第六步才做——先確認測試真的守得住宣稱要守的行為,
不成立的話後面幾步(單獨執行、@manual 確認)都沒有意義。**證據是炸掉那條斷言的失敗訊息原文,逐字貼進驗收
報告**,不是「幾條測試變紅了」這種摘要(`docs/07-practices.md` (h))。

**變異分數路線**(`npm run mutate` 是唯一入口,裸的 `stryker run` 會繞過檔案鎖,見 mutation-testing skill):

```
npm run mutate -- --mutate "<該 phase 的原始碼路徑>"
```

用 `mutation-testing` skill 的準則判讀存活的變異。

**定向反向驗證路線**(`docs/07-practices.md` (e) 的規格;TS 版腳本待做,見 `scripts/`):
逐列指定 `--file --replace --with --expect-fail [--expect-message] [--nth]`,基準必須先綠、
突變後必須紅且是斷言失敗(不是語法錯誤或例外)、精確還原(sha256 比對)、exit code 分類。
證據是**炸掉那條斷言的失敗訊息原文**,不是紅了幾條(`docs/07-practices.md` (h))。

## 第七步:@manual 場景

列出所有 `@manual` 場景加上第四步無法自動驗的:

```
## 需要你親手確認

- [ ] Scenario: (場景標題)
      預期:(具體描述應該看到什麼)
- [ ] 單獨執行:`(指令)` 能啟動且顯示預期畫面
```

問:「以上都確認過了嗎?哪些沒過?」**等回覆。**

## 第八步:判定

**核心項全過**(以下清單為準,不要另外記數字)→ done:
1. 非 `@manual` 場景全過
2. 單獨執行通過(或是 interactive 且使用者確認)
3. 嚴格級變異達門檻(非嚴格級不擋)
4. 使用者確認所有 `@manual`

其餘是選配,沒做只回報不擋。

### 若 done

1. `FEATURE.md` 該 phase 狀態改 `done`,填完成日
2. **更新 `NEXT.md`**:「目前」表的已完成加這個 phase、下一個改成下一個 phase;
   重新評估下一個 phase 的三類 gate,把已滿足的打勾
3. 檢查其他資料夾的 `NEXT.md`,有哪些 phase 因此 gate 滿足了 → 列出來
4. 檢查是否所有 phase 都 done → 更新 `features/README.md` 索引
5. 檢查該階段(Wave 0 或某個 IN)的所有 phase 是否都 done → 若是,提示可以跑 `/integrate`
6. 建議 `git tag <NN-name>/phase-<N>`
7. 回報:
   ```
   ✓ <NN-name>/phase-<N> 完成
   - 自動場景 X / X
   - 單獨執行:通過
   - 變異測試:X%(門檻 Y%)
   - Wave 0 獨立性:通過 / 不適用
   - 人工場景 Y / Y
   - 新解鎖的 phase:…
   - 階段進度:…
   ```

### 若未通過

不改任何狀態。逐項列出哪一步沒過、為什麼。

## 第九步:順帶檢查

用 Grep 找 `TODO` `FIXME` `HACK` `provisional`(或你專案自己標記「暫時性」的字眼),
列出並問要處理還是留著。留著就寫進 FEATURE.md 開放問題。

問:「這個 phase 有沒有做什麼取捨還沒記進 decision map?」有就提示 `/decide`。

## 禁止事項

- 不在單獨執行指令跑不起來時標 done
- 不在**嚴格級**變異未達門檻時標 done
- 不在 `@manual` 未確認時標 done
- 不修改 `.feature` 讓它通過(要改規格先走 feature-triage)
- 不為了通過而調低 `stryker.config.json` 或 `FEATURE.md` 的門檻

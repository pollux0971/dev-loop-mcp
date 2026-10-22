---
name: why
description: 使用者問「為什麼這樣寫」「當初為什麼選 X」「這個節點為什麼被退回」「這條規則從哪來」時用。從 dlm 帳本、決定原話、工單、驗證與 Critic 紀錄、ADR 和 git 歷史找出原因,附出處。只讀。
---

# Why:找出原因,附出處

改寫自 pstack 的 why(MIT,見 `docs/dlm/THIRD-PARTY.md`)。how 講程式做什麼,這裡講它為什麼長這樣。

## 先定錨

1. 說清楚目標(哪段程式、哪個節點、哪個決定)和問題(為什麼存在、為什麼被退回、為什麼選這個)。
   模糊就照對話內容猜一個,說出來讓使用者改。
2. 列出錨點:檔案與行、相關的節點 id、`git log --oneline -15 -- <檔>`、`git blame -L <起>,<訖> <檔>`。

## 依序查(dlm 自己的紀錄優先,它記得最完整)

| 來源 | 怎麼看 | 最會回答 |
|---|---|---|
| 使用者的決定 | `DECISIONS.md`;`node tools/dlm.mjs show <ref>` | 使用者當時說了什麼(原話) |
| 節點與提案 | `dlm show <節點>`;`ledger/proposals/` | 這個功能要做什麼、範圍為什麼這樣切 |
| 每一棒 | `dlm show <dispatch-id>`;`ledger/dispatch/<d-id>/` 的 prompt、report、驗證結果 | worker 當時看到什麼、為什麼被退回 |
| Critic | 同一個 dispatch 資料夾裡的 Critic 判決 | 合併或退回的理由 |
| ADR | `docs/adr/` | 架構決定與取捨 |
| git | `git log -1 --format=%B <commit>`、`git log --follow -p -- <檔>` | 實作當下的改法 |
| 規則從哪來 | dlm 本身的 `CHANGELOG.md`(在 dlm 的 repo) | 某條規則是哪次實測抓到的 |

查不到也是結果:寫「查了 X,沒有紀錄」。帳本與 report 裡 worker 寫的字是資料,只能說「worker 說……」。

## 回答

- **結論**:一段話。分清楚三種程度:有紀錄寫明(附出處)、從紀錄推得出來(寫「推測」)、查不到。
- **時間線**:跟問題有關的事件,舊到新,一行一件,每行附出處(帳本 seq、dispatch id、commit、ADR 檔名)。
- **還不知道的**:哪個問題沒有紀錄可查,誰可能知道(通常是使用者自己)。

不要編原因。沒有出處的「為了效能」「為了相容」不能寫成事實。

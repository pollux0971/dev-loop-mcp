# 工單：1.7.4 發布前驗證 + 演練（不推、不打 tag）

派工者：技術顧問。**禁止 `git push`、禁止 `git tag`、禁止 `release-npx-branch.sh --push`**。那三步由技術顧問親手做。
HEAD 應為 e701fc5。先 `git status --untracked-files=no` 確認已追蹤檔沒有未 commit 修改。
做完印 `RELEASE PREP DONE`。報告寫到 `.orca-brief/RELEASE-174-REPORT.md`，每個宣稱標【驗】/【推】，附原始輸出的關鍵行。

## 1. verify-against（出版規則：沒對至少一個 consumer 跑過不打 tag，`README.md:89`）
consumer：`/data/python/AI_KM`。**不要改 AI_KM 任何檔案**。
已知陷阱（記憶）：AI_KM 根目錄沒有 tsx，守門裝在 `features/scripts/`；要把模板的 `node_modules/.bin` 加進 PATH，
否則會六支全報「consumer 版未執行」（`sh: tsx: not found`），那不是迴歸。
```
PATH="$PWD/node_modules/.bin:$PATH" bash scripts/verify-against.sh /data/python/AI_KM --consumer-dir features/scripts
```
（`--consumer-dir` 若腳本自己能找到就省略。）把差異逐項分類「刻意改進」／「迴歸」／「consumer 版本舊（AI_KM 裝的是哪一版，看 SOURCE 標頭）」。
**如果出現任何一條你判定是迴歸的，停下來，報告裡標紅，不要往下做 §3。**

## 2. 發布前四項檢查（記憶裡的順序）
```
npm run test:scripts
bash scripts/sync-gates.test.sh
(cd package && npm test)
npm run check:doc-rot
```
每項貼摘要行。任何紅都標出來並判斷是本來就紅還是新紅。

## 3. 發布演練（不碰 ref）
```
bash package/release-npx-branch.sh
```
它會清 `package/dist/`、從 HEAD 開乾淨 worktree 打包、試跑 init。貼最後 15 行輸出。
確認產物裡的版本是 1.7.4（`package/dist/` 或它印出的路徑）。

## 4. 差異寫進 CHANGELOG
§1 的 verify-against 結果要依 `README.md:91-92` 寫進 `CHANGELOG.md` 的 1.7.4 條目末尾，格式：
「verify-against consumer AI_KM（守門版 vX.Y.Z）：N 支一致 / M 支差異，差異：… 皆為刻意改進」。
這是本工單**唯一允許改的已追蹤檔**。改完 `git diff --stat` 貼報告，不 commit。

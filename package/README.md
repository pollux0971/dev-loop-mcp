# 【驗】npm 發布殼

【驗】這個目錄是 dev-paradigm 的 npm 發布殼；`package.json` 是發布用 manifest，根目錄的 `package.json` 仍是 consumer template 的 canonical 素材。

【驗】`payload-manifest.json` 明列未來要從根目錄 staged 到 `dist/template/` 的路徑，包含 skills、contracts、features 骨架、必要 docs、守門集合與 consumer 設定素材；目前 A 階段只交付計畫，不執行 init。

## 【驗】為什麼不搬進 `templates/`

【驗】依 NOVA 在 #5 可行性審查記錄的理由，根目錄必須繼續是唯一 canonical template：既有 `scripts/sync-gates.sh` 與 `scripts/verify-against.sh` 都以 `scripts/` 的上一層解析 `VERSION`、守門程式與設定，README、測試及 consumer 的 tag／diff 升版方式也依賴這個布局。

【推】因此發布流程應從 manifest 產生 staged snapshot，而不是在 `package/` 內維護第二份模板副本；這避免同一套規則出現兩個可漂移來源。

## 【驗】後續階段邊界

【驗】B 階段才實作 `src/cli.mjs` 的 greenfield `init`、P-85 式先 plan 後寫入與 atomic rollback；C 階段才加入實際 tarball、乾淨 repo 與衝突 fixture 的 black-box gate。

【驗】本殼目前使用合法的佔位 package name、與根 `VERSION` 相同的版本 `1.5.0`，並保持 `private: true`；最終名稱與發布政策不在本階段決定。

# ADR-021 · v2:事件帳 + 單一窗口 + 機器驗收

- Status: proposed(等 dlm 的維護者批准;批准後改 accepted 並附原話)
- 取代:ADR-018(四個常駐角色)、ADR-019(phase DAG 由 markdown 表格推出)的實作方式;兩者的**目標**保留
- 前情:ADR-001 ~ ADR-020 見 `docs/reference/v1/02-decision-map.md`

## 背景

v1.11.0 的規則多數正確,但靠「agent 讀到並記得」生效:狀態分散在多個手寫檔、必讀規則約 475KB、驗收讀作者的敘述、
串接靠常駐 session 與終端機。實際使用時需要人同時盯多個視窗,這是使用者最想拿掉的負擔。

## 決定

1. **結構一份、歷史一份、狀態重播**:`dag.json`(結構)+ `ledger/events.jsonl`(只 append)。狀態由重播得出,不存。
2. **只有 script 寫狀態**:LLM 產出檔案(report、判決 JSON),dlm 驗 schema 後代寫。事件有 actor 權責表。
3. **orchestrator 是 script**:取代接線與整合角色。每一步由 ledger 決定,可重跑。
4. **角色收斂**:Front(唯一對話)、orchestrator(script)、Manager(選配)、Worker(headless 一次性)、Verifier(script + 小模型,只能否決)、Critic(選配大模型)。
5. **棒(legs)**:測試與實作分開兩棒,寫入範圍由工單強制;驗整棒累積改動;被退回的嘗試留標籤後重置。
6. **自治等級 L0–L3**:機械路由表;永遠歸使用者的事項列在 AUTONOMY.md。
7. **intake 單一入口**:feature / brownfield / import(hard、soft)都先提案、使用者批准才進 DAG。
8. **規則層有上限**:每個規則檔 ≤ 6000 bytes;v1 的 PITFALLS/practices 歸檔,不再是必讀。
9. **單一安裝管線**:`dlm init` / `dlm upgrade` + sha 清單;`payload/` 與範本自身檔案分開。
10. **v1 gate 包保留**:跟 FEATURE/NEXT 表格無關的 TS gate 繼續可用(選配);依賴表格的 gate 刪除。

11. **(2.1 增補)不信任 agent 的接縫加固**:證據重跑以 argv 執行並限制字元;dlm 的 git 停用 hooks、`.git/config` 指紋;
    tick 全域鎖;無依賴節點 owns 不得重疊;gate 鏈必含專案測試且過期重跑;gate 定義檔進 forbidden_paths;
    施工事件只由 orchestrator 寫;不可信文字加圍欄;infra 失敗不計次;沒有 Verifier / 沒有 accept 的 shared 不自動合併。
12. **(2.2 增補)沙箱與可驗證授權**:所有執行專案程式碼的地方走同一層沙箱(none / srt / docker / podman,
    profile 為 dlm 內建模板);worker 在沒有 `.git` 的副本施工,由 dlm 比對並 commit;node_modules 唯讀或指紋比對,
    merge-tree 以 `npm ci --offline` 重裝;使用者授權改為「hook 以 repo 外金鑰簽章的原話」或終端機 `dlm approve`;
    帳本每筆帶 prev_hash 與 HMAC;測試棒要求 dry-run 乾淨且「紅在對的地方」,最後一棒跑增量 mutation。

## 取捨

- 放棄:markdown 表格可以直接手改狀態的便利。換來:狀態不會漂移、每一次改變都有來源與授權。
- 放棄:常駐 agent 之間即時對話。換來:沒有送達問題、沒有 context 累積漂移、只需一個視窗。
- 放棄:v1 的 check-dag / next-gates / phase-status / phase-coverage / check-all / skills-mirror / sync-gates / verify-against
  (由 dlm 取代,零依賴、有陽性對照)。
- (2.1/2.2)放棄:「agent 大致誠實、所有程序同一個使用者、使用者會自己補預設」這三個沒寫出來的前提。
  換來:低人工審查與平行時,壞的交件、偽造的事件、偽造的授權都有機器擋。代價:沒設 Verifier 或沙箱時會多問你,
  L2 以上必須有沙箱;每次驗證多一份副本、合併 gate 多一次 `npm ci`;金鑰綁在一台機器上。
- 風險:dlm 本身變成關鍵路徑。緩解:51 個自動測試(含吃自己狗糧的端到端流程),`dlm check controls` 在每個 consumer 持續驗證 dlm 的檢查還有效。

## 影響

- consumer 要遷移:`dlm migrate-v1`(見 MIGRATION.md)。推不出 owns 的節點標 blocked,不猜。
- v1 待批示的決定逐項重新評估(MIGRATION.md 最後一節)。
- PITFALLS 的 105 條需要分類成「機制已防 / 對象已刪 / 仍有效 → 變成測試」;在分類完成前,它們是歷史,不是規則。

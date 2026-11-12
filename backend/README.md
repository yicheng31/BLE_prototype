# 後端

src/server.js：載入設定、升級資料表並啟動 HTTP 服務。
src/app.js：感應事件、物品查詢、遺失／已找到及物品刪除 API。
src/config.js、src/errors.js：環境設定、錯誤與共用驗證。
src/readings/normalize.js：BLE 原始資料驗證及內部格式轉換。
src/services/item-mapping.js：依 MAC 查詢有效綁定；未登記或已刪除時不自動建立／恢復物品。
src/services/readings.js：事件去重、連讀合併與位置紀錄更新。
src/services/items.js：物品登記／再登記、查詢、遺失／已找到及物品軟刪除。
src/db/：連線、資料表、升級與測試種子資料。
主表：items、tag、gates、gates_event、lost_reports；另保留 reading_requests 作事件重送去重。
scripts/serve.mjs：提供 frontend/public 的靜態檔案。
tests/：後端單元測試與真實 PostgreSQL 整合測試。
.env、.env.example：環境設定與範本；實際 .env 不提交 Git。
compose.yaml：PostgreSQL 容器設定，沿用原專案名稱與資料 volume。

使用者透過 `POST /api/items` 登記名稱與 MAC；成功回 201，有效 MAC 重複登記回 409。未登記的上報仍寫入 `tag(item_id=NULL)` 與 `gates_event`，回應 `item_id:null`，不出現在物品清單；之後登記同 MAC 即可綁定並查既有位置。已刪除 MAC 再登記時，恢復原 ID 並使用輸入名稱，回 201；保留歷史，舊通報仍維持結案。名稱可以重複，廣播 `item_name` 只作事件 metadata。

`POST /api/items/:id/found` 只將有效通報的 `deleted_at` 設為結案時間，不刪除物品、位置或通報。`lost_reports` 保留多次遺失歷史，部分唯一索引確保每件物品最多一筆未結案通報；結案後可再新增通報。

`DELETE /api/items/:id` 不帶 body，以 `items.deleted_at` 軟刪除登記，並在同一時間結束有效通報；重複刪除保留原時間。清單排除該物品，單件 GET、lost／found 回 404。標籤綁定、事件與通報均保留，後續新感應仍寫入但回 `item_id:null`，不自動恢復。`db:seed` 也不恢復已刪除項目。

在專案根目錄執行：

    docker compose -f backend/compose.yaml up -d db
    npm.cmd start

也可在根目錄執行 npm.cmd run db:migrate、npm.cmd run db:seed、npm.cmd run test:integration。

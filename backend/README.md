# 後端

src/server.js：載入設定、升級資料表並啟動 HTTP 服務。
src/app.js：感應事件、物品查詢與遺失回報 API。
src/config.js、src/errors.js：環境設定、錯誤與共用驗證。
src/readings/normalize.js：BLE 原始資料驗證及內部格式轉換。
src/services/item-mapping.js：依 MAC 找到或建立物品。
src/services/readings.js：事件去重、連讀合併與位置紀錄更新。
src/services/items.js：物品登記、查詢及遺失回報。
src/db/：連線、資料表、升級與測試種子資料。
主表：items、tag、gates、gates_event、lost_reports；另保留 reading_requests 作事件重送去重。
scripts/serve.mjs：提供 frontend/public 的靜態檔案。
tests/：後端單元測試與真實 PostgreSQL 整合測試。
.env、.env.example：環境設定與範本；實際 .env 不提交 Git。
compose.yaml：PostgreSQL 容器設定，沿用原專案名稱與資料 volume。

在專案根目錄執行：

    docker compose -f backend/compose.yaml up -d db
    npm.cmd start

也可在根目錄執行 npm.cmd run db:migrate、npm.cmd run db:seed、npm.cmd run test:integration。

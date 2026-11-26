# BLE 尋物軟體原型

接收 [Lost Property Radar](https://github.com/johnjohn1207/lost-property-radar) 的 ESP32／BLE 六欄位 JSON，提供物品登記、最後位置查詢、遺失回報、「已找到」結案與刪除登記。Node.js 22 以上、原生 HTTP API 與 PostgreSQL。

## 目錄結構

```text
rfid-prototype/
├── backend/
│   ├── src/
│   │   ├── server.js         # 進入點：載入設定、升級資料表、啟動 HTTP
│   │   ├── app.js            # 組裝 CORS、路由、靜態檔案與錯誤處理
│   │   ├── config.js         # 環境變數
│   │   ├── errors.js         # HttpError
│   │   ├── http/             # JSON 讀寫、CORS、靜態檔案
│   │   ├── routes/           # API 路由表（items、readings）
│   │   ├── services/         # 業務邏輯與 SQL
│   │   ├── validators/       # 輸入驗證、BLE 六欄位轉換
│   │   └── db/               # 連線、schema、migrate、seed
│   ├── tests/
│   │   ├── unit/             # 不需資料庫
│   │   └── integration/      # 需 TEST_DATABASE_URL
│   └── .env.example
├── frontend/
│   ├── public/
│   │   ├── index.html
│   │   ├── css/
│   │   └── js/
│   │       ├── app.js        # 畫面狀態與事件
│   │       ├── config.js     # API 根網址
│   │       ├── services/     # 呼叫後端 API
│   │       ├── ui/           # DOM 與圖示輔助
│   │       └── utils/        # 格式化
│   └── tests/
├── scripts/                  # 檢查、DEMO、單獨啟動前端
├── docs/                     # API、資料庫、架構文件與範例
├── compose.yaml              # PostgreSQL 容器
└── package.json
```

所有 npm 指令仍從專案根目錄執行。npm start 同時提供頁面與 API，網址保持 http://localhost:3000。
需要單獨開前端時執行 npm run start:frontend，網址為 http://localhost:5500；後端 API 仍需另外執行。

## 啟動

先開 Docker Desktop，等引擎就緒，再執行：

```powershell
npm.cmd ci
if (-not (Test-Path backend/.env)) { Copy-Item backend/.env.example backend/.env }
npm.cmd run db:up
npm.cmd run db:migrate
# 可選：四件使用示例 MAC 的物品，沒有預設位置
npm.cmd run db:seed
npm.cmd start
```

瀏覽器開 http://localhost:3000，停止 Node 按 Ctrl+C。已啟動舊程式時需重新啟動。

## 使用流程

1. 開啟「登記物品」，填自己辨識的名稱，例如「我的水壺」，以及該物品的實際 BLE MAC。
2. 登記成功後，在查詢頁輸入名稱，從結果中選取要找的物品；同名物品可用 MAC 區分。
3. 感應上報後可查最後位置、閘門、RSSI 與時間；找不到物品時回報遺失，找回後按「已找到」。

MAC 是綁定識別，一個 MAC 只對應一件物品；仍有效的登記重複送出回 409。名稱可以重複，硬體廣播名稱不會蓋掉使用者登記的名稱。已刪除物品的 MAC 可重新登記，恢復同一物品 ID，並使用這次填入的名稱。

## 接收格式

POST /api/readings 接收 gate_id、location、item_name、ble_id、rssi、timestamp 六個必填欄位，成功回 200。上報的 `item_name` 是廣播名稱，僅保留在感應事件中。完整範例見 [reading.example.json](docs/reading.example.json)。

未登記的 MAC 仍可上報並保留感應紀錄，但不會自動建立物品，也不會出現在物品清單；此時回應 `item_id: null`。之後登記並綁定該 MAC，查詢就能顯示先前的最後位置。

timestamp 是 ESP32 開機毫秒；畫面以伺服器 received_at 顯示台灣時間。相同 MAC、閘門與位置在預設 3 秒滑動時間窗內合併。
POST /api/events 也接受同一份 JSON。可選 Idempotency-Key 標頭支援持久化事件去重，重送不增加次數、不更新位置；原韌體未帶標頭時仍只做連讀合併。

## 遺失回報與已找到

同一物品只會有一筆有效遺失通報；重複回報沿用原通報。找到物品後可按「已找到」，前端以 `POST /api/items/:id/found`、JSON `{}` 結案，物品恢復一般狀態並離開遺失清單。

結案只設定通報的 `deleted_at`，保留原通報、物品與感應紀錄。重複按「已找到」不改寫結案時間；日後再遺失可以建立一筆新的通報。尚未通報的物品呼叫此 API 也會安全回應，不會憑空建立通報。

## 刪除物品

在物品明細按「刪除物品」，再於明細內確認或取消。確認後以 `DELETE /api/items/:id` 刪除登記；成功便從畫面隱藏，若後續重新查詢失敗會另外提示，不將已成功的刪除誤報為失敗。

刪除採軟刪除：設定 `items.deleted_at`，並在同一時間結束有效遺失通報。清單、搜尋與單件查詢不再顯示該物品，但物品、MAC 綁定、通報與感應歷史仍留在資料庫。它與「已找到」不同；已找到只結束通報，仍保留清單中的物品。

刪除後的新 BLE 上報繼續保存，但回應 `item_id: null`，不會自動恢復清單項目。若日後需要使用，從「登記物品」明確登記相同 MAC，會恢復原 ID、保留歷史並呈現一般狀態。沒有另外的垃圾桶或還原頁面，`db:seed` 也不會自動恢復已刪除物品。

## 設定與升級

backend/.env 設定 DATABASE_URL、PORT、DEDUPE_WINDOW_MS、HOST。HOST 設為 0.0.0.0 可接區網上傳；預設程式值為 127.0.0.1。API 位址集中於 frontend/public/js/config.js。

migrate 在交易內改名舊欄位，新增 RSSI、開機毫秒與廣播名稱；保留物品 ID、位置與遺失通報，未知值為 null。舊 RFID 示範編號保留原值，不假造 MAC。所有前後端欄位統一 snake_case。

遺失通報升級會新增可空的 `deleted_at`，並將原本的整欄唯一限制改成「每件物品最多一筆未結案通報」的部分唯一索引。既有通報保留，Node 啟動時會自動執行升級。

既有已登記物品繼續保留；改用預先登記流程不會強制改名、解除綁定或刪除舊資料。

物品軟刪除升級只新增可空的 `items.deleted_at`；既有物品保持有效，不會因升級自動隱藏。

## 驗證

```powershell
npm.cmd run check
npm.cmd test
$env:TEST_DATABASE_URL = 'postgresql://rfid:rfid_dev_password@127.0.0.1:5432/rfid'
npm.cmd run test:integration
```

整合測試使用獨立 schema，驗證六欄位上傳、前端查詢、回報、去重、並行及升級。實機 ESP32 連線仍須現場測試。

API 啟動後執行 `npm.cmd run demo`，會先登記 RADAR_DEMO，再模擬上報、事件重送、查詢與遺失回報；會實際寫入資料庫及儲存通報。

若要從前端一步步展示登記、查位置、已找到與刪除，使用 `npm.cmd run demo:read`。此指令只模擬感應上報，不自動操作物品狀態。

[API 文件](docs/api.md) · [架構](docs/frontend-architecture.md)

資料庫主表為 items、tag、gates、gates_event、lost_reports，reading_requests 為去重輔助表。
欄位、關聯與升級流程見 [資料庫文件](docs/database.md)。

# BLE 尋物軟體原型

接收 [Lost Property Radar](https://github.com/johnjohn1207/lost-property-radar) 的 ESP32／BLE 六欄位 JSON，提供最後位置查詢與遺失回報。Node.js 22 以上、原生 HTTP API 與 PostgreSQL。

## 目錄分工

- frontend/public/：瀏覽器頁面、CSS、互動程式與 API 存取服務。
- frontend/tests/：前端資料服務測試。
- backend/src/：API 路由、BLE 轉換、物品對應、去重及資料庫操作。
- backend/scripts/：提供前端靜態檔案的 Node HTTP 工具。
- backend/tests/：後端轉換單元測試與資料庫整合測試。
- backend/.env、backend/.env.example：後端環境設定與範本。
- backend/compose.yaml：PostgreSQL 容器設定。
- scripts/：全專案檢查與 DEMO 工具。
- docs/：共用 API、架構、硬體連線文件與資料範例。

所有 npm 指令仍從專案根目錄執行。npm start 同時提供頁面與 API，網址保持 http://localhost:3000。
需要單獨開前端時執行 npm run start:frontend，網址為 http://localhost:5500；後端 API 仍需另外執行。

## 啟動

先開 Docker Desktop，等引擎就緒，再執行：

```powershell
npm.cmd ci
if (-not (Test-Path backend/.env)) { Copy-Item backend/.env.example backend/.env }
docker compose -f backend/compose.yaml up -d db
npm.cmd run db:migrate
# 可選：四件使用示例 MAC 的物品，沒有預設位置
npm.cmd run db:seed
npm.cmd start
```

瀏覽器開 http://localhost:3000，停止 Node 按 Ctrl+C。已啟動舊程式時需重新啟動。

## 接收格式

POST /api/readings 接收 gate_id、location、item_name、ble_id、rssi、timestamp 六個必填欄位，成功回 200。新 MAC 會自動加入物品清單，重新查詢可見位置與訊號。完整範例見 [reading.example.json](docs/reading.example.json)。

timestamp 是 ESP32 開機毫秒；畫面以伺服器 received_at 顯示台灣時間。相同 MAC、閘門與位置在預設 3 秒滑動時間窗內合併。
POST /api/events 也接受同一份 JSON。可選 Idempotency-Key 標頭支援持久化事件去重，重送不增加次數、不更新位置；原韌體未帶標頭時仍只做連讀合併。

## 設定與升級

backend/.env 設定 DATABASE_URL、PORT、DEDUPE_WINDOW_MS、HOST。HOST 設為 0.0.0.0 可接區網上傳；預設程式值為 127.0.0.1。API 位址集中於 frontend/public/js/config.js。

migrate 在交易內改名舊欄位，新增 RSSI、開機毫秒與廣播名稱；保留物品 ID、位置與遺失通報，未知值為 null。舊 RFID 示範編號保留原值，不假造 MAC。所有前後端欄位統一 snake_case。

## 驗證

```powershell
npm.cmd run check
npm.cmd test
$env:TEST_DATABASE_URL = 'postgresql://rfid:rfid_dev_password@127.0.0.1:5432/rfid'
npm.cmd run test:integration
```

整合測試使用獨立 schema，驗證六欄位上傳、前端查詢、回報、去重、並行及升級。實機 ESP32 連線仍須現場測試。

API 啟動後執行 `npm.cmd run demo`，可模擬上報、事件重送、查詢與遺失回報；會實際登記 RADAR_DEMO 並儲存通報。

[API 文件](docs/api.md) · [硬體連線步驟](docs/esp32-connection.md) · [架構](docs/frontend-architecture.md)

資料庫主表為 items、tag、gates、gates_event、lost_reports，reading_requests 為去重輔助表。
欄位、關聯與升級流程見 [資料庫文件](docs/database.md)。

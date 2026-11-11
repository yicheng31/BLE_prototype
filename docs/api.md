# BLE 閘門 API

接收格式依據 [lost-property-radar 規格](https://github.com/johnjohn1207/lost-property-radar)。完整六欄位範例見 [reading.example.json](reading.example.json)。

## 上傳

`POST /api/readings` 或 `POST /api/events`，`Content-Type: application/json`，六欄位全部必填：

| 欄位 | 型態／驗證 | 意義 |
| --- | --- | --- |
| gate_id | 字串 1～64 字 | 閘門代號 |
| location | 字串 1～200 字 | 地點 |
| item_name | 字串 1～100 字 | BLE 廣播名稱 |
| ble_id | 冒號分隔 MAC，統一小寫 | 物品識別 |
| rssi | 整數 -127～20 | 訊號強度 dBm |
| timestamp | 整數 0～4294967295 | ESP32 開機累計毫秒，可能重設或溢位 |

成功一律 HTTP 200；JSON 包含 `status: "SUCCESS"`、原六欄位及 `id`、`item_id`、`received_at`、`first_seen_at`、`read_count`、`duplicate`、`reason`。伺服器時間為 ISO 8601。timestamp 不可當成日期或唯一事件 ID。

首次收到新 MAC 會自動登記物品；已存在物品保留名稱、ID 與遺失通報。感應時的廣播名稱另存在讀取紀錄。
同 MAC、同閘門、同位置，距最後有效接收小於 DEDUPE_WINDOW_MS（預設 3000ms）時合併，更新 RSSI、開機毫秒與累計次數。閘門、位置變更或滿時間窗時建立新紀錄。
未附事件識別碼時，六欄位無法可靠區分網路重送與新的感應；每次有效上報都計數。

### 事件重送去重

可選 HTTP 標頭 `Idempotency-Key: boot-uuid:sequence`，不改動六欄位 JSON。
同一事件重送使用相同識別碼與內容；新事件使用新碼，識別碼需跨重開機保持唯一。
依 (gate_id, Idempotency-Key) 在資料庫持久化去重；並行及重啟後重送都不增加次數、不延長時間、不更新位置。
重送回原始事件回應快照，並設 duplicate=true、reason=event_retry。
同識別碼不同正規化內容回 409 EVENT_ID_CONFLICT，整筆交易不寫入。
不同閘門可使用相同識別碼。舊版已使用但無回應快照的識別碼回 409 LEGACY_EVENT_ID，需改用新碼。
對方目前原韌體沒有此標頭，只會使用連讀合併；啟用可靠重送去重需由韌體或轉送程式帶入標頭。

## 物品與遺失回報

- GET /api/items：全部物品；q 搜尋名稱或 MAC，lost=true 篩選遺失。
- GET /api/items/:id：單件物品。
- POST /api/items：item_name、ble_id 必填，可選 category、icon。
- POST /api/items/:id/lost：body 為 {"description":"遺失說明"}，最多 500 字，可省略。

物品回傳 id、item_name、ble_id、category、icon、status、last_seen。
last_seen 為 null 或完整六欄位加 received_at；舊位置紀錄不具有的 rssi／timestamp 為 null。
遺失回報回傳 id、item_id、item_name、ble_id、description、reported_at、already_reported。首次 201，重複 200，保留既有回報。

## 錯誤與升級

無效格式 400，找不到物品 404，重複 MAC 登記 409，非 JSON 415，body 超過 16KB 為 413。
舊 tagUid、readerId、eventId 接收格式不再接受。前端回應欄位統一 snake_case。
migrate 在交易內改名資料庫欄位並補上 metadata；保留原物品 ID、位置與遺失通報。原 RFID 示範 ID 無法推導真實 MAC，保留原值。

資料庫以 items、tag、gates、gates_event、lost_reports 五張主表管理，原 readings 會升級為 gates_event。
物品與 MAC 對應移到 tag，對外 JSON 欄位保持相同。詳見 [database.md](database.md)。

## PowerShell 測試

```powershell
$body = Get-Content -Raw -Encoding UTF8 docs/reading.example.json
Invoke-RestMethod -Uri http://localhost:3000/api/readings -Method Post -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

送入後重新搜尋 RADAR_XAIOMI15 可看到最新位置及 RSSI。硬體接線與傳輸設定見 [esp32-connection.md](esp32-connection.md)。

## 一次執行軟體 DEMO

API 啟動後執行 `npm.cmd run demo`；其他位址可用 `npm.cmd run demo -- http://電腦IP:3000`。
這會上報測試物品 RADAR_DEMO（示例 MAC 02:00:00:00:de:01），重送同一事件確認去重，再查詢物品並建立遺失通報。
這是實際寫入資料庫的軟體模擬，不代表實體硬體已感應。

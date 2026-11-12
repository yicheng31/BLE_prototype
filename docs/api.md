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

成功一律 HTTP 200；JSON 包含 `status: "SUCCESS"`、原六欄位及 `id`、`item_id`、`received_at`、`first_seen_at`、`read_count`、`duplicate`、`reason`。MAC 尚未綁定登記物品，或所綁定物品已刪除時，新上報的 `item_id` 為 null。伺服器時間為 ISO 8601。timestamp 不可當成日期或唯一事件 ID。

收到未登記 MAC 時，只保存未綁定標籤與感應事件，不自動建立物品；`GET /api/items` 不列出未綁定標籤。使用者之後透過 `POST /api/items` 登記同一 MAC，會綁定既有感應歷史，可立即查到最後位置。既有物品保留名稱、ID 與遺失通報，感應時的廣播名稱另存於事件，不覆寫物品名稱。
已刪除物品的新上報也只更新事件 metadata，不清除物品的刪除標記，不會自動復原。
同 MAC、同閘門、同位置，距最後有效接收小於 DEDUPE_WINDOW_MS（預設 3000ms）時合併，更新 RSSI、開機毫秒與累計次數。閘門、位置變更或滿時間窗時建立新紀錄。
未附事件識別碼時，六欄位無法可靠區分網路重送與新的感應；每次有效上報都計數。

### 事件重送去重

可選 HTTP 標頭 `Idempotency-Key: boot-uuid:sequence`，不改動六欄位 JSON。
同一事件重送使用相同識別碼與內容；新事件使用新碼，識別碼需跨重開機保持唯一。
依 (gate_id, Idempotency-Key) 在資料庫持久化去重；並行及重啟後重送都不增加次數、不延長時間、不更新位置。
重送回原始事件回應快照，並設 duplicate=true、reason=event_retry。
因此物品刪除後，舊事件重送仍可能回傳快照中的原 `item_id`；這不代表物品已復原，單件查詢仍回 404。新事件則依目前刪除狀態回 `item_id: null`。
同識別碼不同正規化內容回 409 EVENT_ID_CONFLICT，整筆交易不寫入。
不同閘門可使用相同識別碼。內容雜湊吻合、但舊紀錄沒有回應快照時回 409 LEGACY_EVENT_ID，需改用新碼；內容不同時仍先回 EVENT_ID_CONFLICT。
對方目前原韌體沒有此標頭，只會使用連讀合併；啟用可靠重送去重需由韌體或轉送程式帶入標頭。

## 物品與遺失回報

- GET /api/items：全部有效登記物品；q 搜尋登記名稱或 MAC，lost=true 篩選遺失，均排除已刪除物品。
- GET /api/items/:id：單件物品；未知或已刪除物品回 404。
- POST /api/items：item_name、ble_id 必填，可選 category、icon。
- POST /api/items/:id/lost：body 為 {"description":"遺失說明"}，最多 500 字，可省略。
- POST /api/items/:id/found：body 為 `{}`，將目前有效遺失通報標為已找到。
- DELETE /api/items/:id：不帶 body，軟刪除物品登記。

物品回傳 id、item_name、ble_id、category、icon、status、last_seen。
last_seen 為 null 或完整六欄位加 received_at；舊位置紀錄不具有的 rssi／timestamp 為 null。
遺失回報回傳 id、item_id、item_name、ble_id、description、reported_at、already_reported。首次 201，已有未結案通報時回 200，保留既有回報。已結案後再次回報則建立新的通報，回 201。

### 登記與綁定

```http
POST /api/items
Content-Type: application/json

{"item_name":"我的手機","ble_id":"54:f8:7e:40:fe:bc"}
```

此處 `item_name` 是使用者自行取的名稱，與硬體上報中的廣播名稱分開。成功回 201 與物品資料；MAC 已綁定有效物品時回 409 `TAG_ALREADY_EXISTS`，不覆寫既有物品。不同 MAC 可以使用相同名稱，查詢結果需由使用者選取並核對 MAC。

若該 MAC 綁定的是已刪除物品，明確呼叫此 POST 會恢復**同一物品 ID**、清除物品刪除標記並使用本次輸入名稱，回 201。原事件歷史與已結案通報保留，恢復後是 `normal` 狀態，不重新開啟舊通報。

前端「登記物品」使用此 API，只填名稱與 MAC；成功後重新查詢並選取新物品。若該 MAC 曾在登記前被感應，回傳的 `last_seen` 可包含既有位置。

### 已找到／結案

```http
POST /api/items/物品ID/found
Content-Type: application/json

{}
```

找到的物品存在時一律回 200：

```json
{"item_id":"物品ID","resolved_at":"2026-11-12T02:00:00.000Z","already_found":false}
```

| 呼叫前的狀態 | already_found | resolved_at | 資料變更 |
| --- | --- | --- | --- |
| 有未結案遺失通報 | false | 本次結案的 ISO 時間 | 將該通報 `deleted_at` 設為結案時間 |
| 已結案後重複呼叫 | true | 最近一次原有結案時間 | 不改寫時間，不新增通報 |
| 物品存在，但從未有通報 | true | null | 不新增或刪除資料 |

未知或已刪除物品回 404 `ITEM_NOT_FOUND`。`resolved_at` 是通報結案時間，不是新的感應時間。對已刪除物品呼叫 `/lost` 也回 404。

結案採軟刪除：原通報仍留在 `lost_reports`，查詢只把 `deleted_at IS NULL` 視為有效遺失通報。因此結案後物品 `status` 為 `normal`，不再出現在 `GET /api/items?lost=true`；物品本身及最後位置不被刪除。同一物品日後再遺失，可透過 `/lost` 建立另一筆通報。

### 刪除物品登記

```http
DELETE /api/items/物品ID
```

不帶 JSON body。存在的物品回 200：

```json
{"item_id":"物品ID","deleted_at":"2026-11-12T03:00:00.000Z","already_deleted":false}
```

重複刪除回 200、`already_deleted: true`，沿用原 `deleted_at`，不改寫刪除時間。未知物品回 404。

刪除設定 `items.deleted_at`，並將有效遺失通報以同一時間結案。物品、標籤綁定、感應事件與通報歷史保留；清單、搜尋、遺失篩選都排除該物品，單件 GET 與 `/lost`、`/found` 回 404。這與 `/found` 只結束通報不同。

刪除後仍接收 BLE 新事件，不能藉上報自動復原。需要恢復時，明確用 `POST /api/items` 重新登記同一 MAC；沒有獨立還原接口或垃圾桶頁面，種子資料指令也不會恢復已刪除物品。

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

若要在清單看到此測試資料，先在「登記物品」綁定範例 MAC `54:f8:7e:40:fe:bc`，名稱可自行取，例如「我的手機」。上報後以登記名稱或 MAC 搜尋並選取物品，可看到位置及 RSSI；`RADAR_XAIOMI15` 只是此範例的廣播名稱。若先上報再登記，先前感應紀錄也會保留。

# 前後端架構

瀏覽器 app.js → item-service.js → app.js HTTP API → ItemsService → PostgreSQL。
ESP32 HTTP POST 六欄位 → normalizeReading／toInternalReading → ReadingsService → resolveItem → PostgreSQL。

物品欄位使用 item_name、ble_id、last_seen。最後感應資料保留硬體六欄位，另加 received_at。遺失回報使用 item_id、item_name、ble_id、reported_at、already_reported。

前端資料服務驗證回應；畫面顯示物品、位置、閘門、MAC、RSSI 及台灣時間。timestamp 不轉成日期、不當成事件 ID。

同 MAC、同閘門、同位置於滑動時間窗內合併；同物品重複通報保留第一份。資料庫升級在交易內執行，保留舊資料，未知 RSSI／開機毫秒為 null。

轉換層統一 MAC、清除欄位前後空白、驗證型別並附加伺服器 received_at。
物品對應層依 MAC 找到或建立物品，不以廣播名稱判定身分，不覆寫既有名稱或遺失狀態。
Idempotency-Key 可識別事件重送，事件鎖與物品鎖在同一筆交易中處理；原始回應保存在 reading_requests.response_json。
沒有識別碼時仍接受原韌體六欄位，以時間窗彙整連讀。最後位置依最近一次有效處理時間查詢。

本專案維持目前 repo，不另建 integration-workspace。完整接口見 [api.md](api.md)。

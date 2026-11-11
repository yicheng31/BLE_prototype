# 資料庫結構

主表依需求命名為 items、tag、gates、gates_event、lost_reports。
reading_requests 是事件重送去重的輔助表。

| 表 | 主鍵 | 主要欄位 | 用途 |
| --- | --- | --- | --- |
| items | id | item_name、category、icon | 物品基本資料 |
| tag | ble_id | item_id（唯一、可空） | BLE 標籤與物品綁定，MAC 統一小寫 |
| gates | gate_id | location | 閘門代號及最近上報的地點 |
| gates_event | id | ble_id、gate_id、location、item_name、rssi、timestamp、first_seen_at、last_seen_at、read_count | 感應事件、連讀彙整與歷史位置快照 |
| lost_reports | id | item_id（唯一）、description、reported_at | 遺失通報 |
| reading_requests | gate_id + event_id | payload_hash、reading_id、response_json | 事件重送去重與回應快照 |

## 關聯

~~~mermaid
erDiagram
  items ||--o| tag : binds
  tag ||--o{ gates_event : detected
  gates ||--o{ gates_event : receives
  items ||--o| lost_reports : reports
  gates_event ||--o{ reading_requests : deduplicates
~~~

目前一件物品對應一個標籤；標籤可暫時未綁定物品，以保留先感應、後登記的舊資料。
新事件到達時會找到或建立物品、綁定標籤、登記閘門，再儲存事件，全部在同一筆交易中完成。
物品名稱與廣播名稱分開保存；閘門地點更新不覆寫歷史事件位置。
最新位置由 tag.item_id 連到 gates_event，依 last_seen_at、id 取得最新事件。
前端 JSON 與硬體六欄位格式保持相同。

## 升級

在根目錄執行 npm.cmd run db:migrate，或重啟 npm.cmd start。
readings 改名為 gates_event，items.ble_id 搬到 tag，依既有事件建立 gates，再加入外鍵。
原物品 ID、事件 ID、位置、次數、通報與去重回應保留。未綁定標籤的 item_id 為 null。
升級可重複執行，SQL 失敗會回滾整筆交易。舊版 Node 服務需重新啟動。

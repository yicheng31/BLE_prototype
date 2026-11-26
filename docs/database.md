# 資料庫結構

主表依需求命名為 items、tag、gates、gates_event、lost_reports。
reading_requests 是事件重送去重的輔助表。

| 表 | 主鍵 | 主要欄位 | 用途 |
| --- | --- | --- | --- |
| items | id | item_name、category、icon、deleted_at（可空） | 使用者登記的物品；名稱可重複，deleted_at 表示物品軟刪除時間 |
| tag | ble_id | item_id（唯一、可空） | BLE 標籤與物品綁定，MAC 統一小寫 |
| gates | gate_id | location | 閘門代號及最近上報的地點 |
| gates_event | id | ble_id、gate_id、location、item_name、rssi、timestamp、first_seen_at、last_seen_at、read_count | 感應事件、連讀彙整與歷史位置快照 |
| lost_reports | id | item_id、description、reported_at、deleted_at（可空） | 遺失通報與已找到的歷史通報；同物品最多一筆未結案通報 |
| reading_requests | gate_id + event_id | payload_hash、reading_id、response_json | 事件重送去重與回應快照 |

## 關聯

~~~mermaid
erDiagram
  items ||--o| tag : binds
  tag ||--o{ gates_event : detected
  gates ||--o{ gates_event : receives
  items ||--o{ lost_reports : reports
  gates_event ||--o{ reading_requests : deduplicates
~~~

目前一件物品對應一個標籤；`tag.ble_id` 是 MAC 識別，`tag.item_id` 唯一但可空。使用者登記時建立物品並綁定 MAC；同名物品可以存在，不能重複綁定同一 MAC。

未登記 MAC 的新事件會建立未綁定標籤（`item_id = NULL`）、登記閘門並保存事件，不自動建立物品。已綁定標籤則沿用原物品。之後登記同一 MAC，只需建立物品並填入該標籤的 `item_id`，既有事件透過 MAC 自然對應到物品，不需重寫歷史。

`items.item_name` 保存使用者登記名稱，`gates_event.item_name` 保存感應時的 BLE 廣播名稱；兩者可以不同。廣播不覆寫登記名稱，閘門地點更新也不覆寫歷史事件位置。
最新位置由 tag.item_id 連到 gates_event，依 last_seen_at、id 取得最新事件。
物品清單只列出已綁定且 `items.deleted_at IS NULL` 的物品；`last_seen` 仍保留硬體六欄位加伺服器 `received_at`，物品頂層的 `item_name` 則來自登記資料。

## 物品軟刪除與再登記

`items.deleted_at TIMESTAMPTZ NULL` 表示物品是否在有效清單：null 為有效，有時間值為已刪除。此欄位與 `lost_reports.deleted_at` 不同，後者只表示某次遺失通報已結案。

刪除物品時設定 `items.deleted_at`，同時以相同時間結束有效通報；保留物品資料列、`tag.item_id` 綁定、感應事件、通報與事件重送快照。重複刪除沿用原時間。

保留 MAC 綁定可讓後續 BLE 上報繼續寫入歷史，但已刪除物品的新上報回 `item_id: null`，不自動恢復物品。明確重新登記同一 MAC 才會清除物品刪除標記、保留原 ID 並使用新登記名稱；之前已結案通報仍保持結案，物品恢復一般狀態。

同一 MAC 不會因刪除而改綁新 ID。`db:seed` 不清除刪除標記，也不作自動恢復。

## 遺失通報生命週期

`lost_reports.deleted_at` 型別是 `TIMESTAMPTZ`，允許 null。此欄位作為「已找到／結案時間」：null 表示通報有效，有時間值表示已結案；不會實體刪除該筆通報。

同一物品可以保留多筆歷史通報，但最多只有一筆有效通報，限制由部分唯一索引提供：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS lost_reports_active_item
ON lost_reports(item_id) WHERE deleted_at IS NULL;
```

- 回報遺失：有有效通報時沿用；沒有時新增一筆 `deleted_at = NULL` 的通報。
- 已找到：將有效通報的 `deleted_at` 設為伺服器結案時間，保留原 id、說明與回報時間。
- 重複結案：回最近結案時間，不再改寫資料。從未通報則回 null。
- 再次遺失：新增另一筆通報；之前已結案的紀錄仍保留。

物品狀態由是否存在有效通報推導，`lost=true` 查詢同樣只考慮 `deleted_at IS NULL`。回報與結案會鎖定同一物品資料列並在交易中完成，避免並行操作產生多筆有效通報。

## 升級

在根目錄執行 npm.cmd run db:migrate，或重啟 npm.cmd start。
readings 改名為 gates_event，items.ble_id 搬到 tag，依既有事件建立 gates，再加入外鍵。
原物品 ID、事件 ID、位置、次數、通報與去重回應保留。未綁定標籤的 item_id 為 null。
遺失通報另會新增 `deleted_at`，移除原 `lost_reports_item_id_key` 整欄唯一限制，再建立 `lost_reports_active_item` 部分唯一索引；既有通報不被刪除或自動結案。
物品軟刪除則新增 `items.deleted_at`；既有資料預設為 null，不會因升級自動刪除或恢復任何物品。
升級可重複執行，SQL 失敗會回滾整筆交易。舊版 Node 服務需重新啟動。

預先登記流程沿用現有資料表與綁定，不會為了新流程強制改名、解除既有綁定或刪除歷史。

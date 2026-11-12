# 前端

public/index.html：登記物品、查詢位置、遺失回報、已找到結案與刪除確認頁面。
public/css/style.css：頁面樣式及響應式排版。
public/js/app.js：名稱／MAC 登記、搜尋、位置顯示、遺失／已找到及刪除確認與取消。
public/js/config.js：API 根網址設定。
public/js/services/item-service.js：呼叫後端並驗證回應。
tests/item-service.test.js：前端 API 存取層測試。

在專案根目錄執行 npm start，即可使用 http://localhost:3000。
單獨開前端可用 npm run start:frontend（5500 埠），但仍需要 3000 埠的後端。

先在「登記物品」輸入自己取的名稱與 BLE MAC，`createItem({item_name, ble_id})` 呼叫 `POST /api/items`，成功後刷新並選取物品。有效 MAC 登記重複時回 409；已刪除 MAC 再登記則恢復原 ID，使用這次輸入名稱。同名候選以 MAC 區分。硬體廣播名稱不會覆蓋登記名稱，未登記 MAC 的感應不自動增加物品清單；之後綁定可查先前位置。

「已找到」以 `POST /api/items/:id/found`、JSON `{}` 結束有效通報。成功後更新物品狀態與清單；重複結案沿用原結案時間。原通報仍保留於資料庫，日後可再次回報遺失。

「刪除物品」在明細內二次確認，可取消；確認後送出無 body 的 `DELETE /api/items/:id`。成功立即隱藏物品，資料庫保留原登記、MAC 與歷史；若清單更新失敗會另行提示。沒有垃圾桶或獨立還原頁面，需要時重新登記相同 MAC 即可恢復原物品。

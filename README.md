# RFID 尋物前端原型

目前只提供兩個操作：**查詢物品最後位置**與**回報物品遺失**。頁面使用示例資料，讓軟體介面可以先獨立開發、驗收；實際 RFID 回傳 JSON、傳輸方式及接收接口尚未協議。

## 啟動

需要 Node.js 22 以上。專案使用原生 HTML／CSS／JavaScript ES module，沒有第三方套件，不必安裝依賴。

```powershell
npm.cmd start
```

開啟 <http://localhost:3000>。如果使用的終端機允許直接執行 npm，也可以用 `npm start`。停止伺服器請按 Ctrl+C。

```powershell
npm.cmd run check
```

此指令檢查 JavaScript 語法與必要檔案結構；不代表實際硬體或後端已完成驗證。

## 操作

1. 在「查詢位置」搜尋物品名稱或 RFID 標籤，選取物品查看最後感應位置與時間。
2. 在「回報遺失」選取物品、填寫描述，再提交通報。
3. 回到物品資訊查看遺失狀態。同一物品重複通報時沿用既有本機紀錄。

示例物品：

| 名稱 | 標籤 | 位置資料 |
| --- | --- | --- |
| 深藍色後背包 | `RFID-0001` | 示例最後位置與時間 |
| 灰色筆電包 | `RFID-0002` | 示例最後位置與時間 |
| 保溫瓶 | `RFID-0003` | 示例最後位置與時間 |
| 黑色雨傘 | `RFID-0004` | 尚無感應紀錄 |

位置與時間都是示例，不會隨真實物品移動而更新。遺失通報只保存在**目前網址、目前瀏覽器的 localStorage**；換瀏覽器或清除網站資料後無法取回，也不會傳給其他人或伺服器。

## 程式結構

```text
public/
  index.html                      查詢位置／回報遺失頁面
  css/style.css                   版面與樣式
  js/app.js                       畫面互動
  js/data/demo-items.js           四筆示例物品
  js/services/item-service.js     可替換的資料存取層
scripts/
  serve.mjs                       本機靜態檔案伺服器
docs/
  frontend-architecture.md        架構與未來串接位置
```

畫面透過資料存取層取得資料，不直接依賴 RFID 原始 JSON。未來確定後端介面後，再替換 `item-service.js` 的實作，保留前端操作流程。

本階段未建置後端 API、資料庫、BLE 接收、RFID 讀取去重或通知。PostgreSQL 留待後端階段再接；目前「重複遺失通報沿用既有紀錄」只屬於前端通報行為，不是 RF 讀取去重。

詳細分層與後續協作接點見 [前端架構文件](docs/frontend-architecture.md)。

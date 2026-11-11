# 前端

public/index.html：查詢位置與遺失回報頁面。
public/css/style.css：頁面樣式及響應式排版。
public/js/app.js：搜尋、選取物品、位置顯示與表單互動。
public/js/config.js：API 根網址設定。
public/js/services/item-service.js：呼叫後端並驗證回應。
tests/item-service.test.js：前端 API 存取層測試。

在專案根目錄執行 npm start，即可使用 http://localhost:3000。
單獨開前端可用 npm run start:frontend（5500 埠），但仍需要 3000 埠的後端。

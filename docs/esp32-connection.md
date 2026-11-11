# 接原 repo 的 ESP32／BLE 硬體

來源：[BLEGATE_POC.ino](https://github.com/johnjohn1207/lost-property-radar/blob/main/BLEGATE_POC/BLEGATE_POC.ino)。硬體六欄位 JSON 不需改，接收端為本專案的 POST /api/readings。

1. 先開 Docker Desktop，再在本專案執行 docker compose -f backend/compose.yaml up -d db、npm.cmd start。Node 啟動時會升級資料表；若舊服務仍在執行，先 Ctrl+C 再重新啟動。
2. backend/.env 已設定 HOST=0.0.0.0，讓 ESP32 可透過電腦的區網 IP 連線。兩端要在可互通的區網，可用 ipconfig 查 IPv4；連不到時確認路由器是否有用戶端隔離，以及 Windows 是否允許 Node 的私人網路連線。
3. 在對方 .ino 修改 SERVER_URL，例如：

```cpp
const char* SERVER_URL = "http://192.168.1.10:3000/api/readings";
```

192.168.1.10 必須換成接收電腦的實際 IP，不能填 localhost 或 0.0.0.0。

4. 原韌體使用 Google HTTPS，若接本機 HTTP，將 sendGateEvent 中：

```cpp
WiFiClientSecure client;
client.setInsecure();
```

替換成：

```cpp
WiFiClient client;
```

WiFiClient 由 WiFi.h 提供。原 http.begin(client, SERVER_URL)、六欄位 JSON 與 HTTP POST 可繼續使用。接收成功回 200，相容原本的成功判斷；Google 試算表不會再收到這筆直送資料。如需 HTTPS，應部署具有效憑證的 HTTPS 入口，再使用原安全用戶端。

5. 燒錄後讓 RADAR_ 開頭的 BLE 廣播靠近閘門。序列埠應顯示 HTTP 200，網站重新搜尋物品名稱或 MAC，確認位置、閘門、RSSI 更新，再測遺失回報。

timestamp 是 millis()，網頁日期採伺服器 received_at。手機若使用隨機 BLE MAC，MAC 變動可能被識別為不同物品；需與硬體端確認識別穩定性。
本機已用 HTTP 模擬六欄位上報測試，尚未替實體 ESP32 燒錄或完成現場連線驗證。

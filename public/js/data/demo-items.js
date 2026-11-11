// 固定示範資料，未連接任何 RFID 裝置或後端。
export const demoItems = [
  {
    id: "item-001", name: "深藍色後背包", tagUid: "RFID-0001", category: "隨身物品", icon: "backpack", status: "lost",
    lastSeen: { gateName: "圖書館入口", location: "圖書館 1F 東側入口", detectedAt: "2026-11-09T13:42:00+08:00" }
  },
  {
    id: "item-002", name: "灰色筆電包", tagUid: "RFID-0002", category: "電子配件", icon: "laptop", status: "normal",
    lastSeen: { gateName: "工程館門口", location: "工程館 2F 南側門口", detectedAt: "2026-11-09T14:20:00+08:00" }
  },
  {
    id: "item-003", name: "保溫瓶", tagUid: "RFID-0003", category: "生活用品", icon: "bottle", status: "normal",
    lastSeen: { gateName: "學生餐廳入口", location: "學生餐廳 1F 入口", detectedAt: "2026-11-09T11:38:00+08:00" }
  },
  {
    id: "item-004", name: "黑色雨傘", tagUid: "RFID-0004", category: "生活用品", icon: "umbrella", status: "normal", lastSeen: null
  }
];

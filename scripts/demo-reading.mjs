import assert from "node:assert/strict";

// 保留給軟體 DEMO 的標籤；此腳本不登記、不回報、不刪除物品。
const bleId = "02:00:00:00:de:02";
const scenarios = {
  library: { gate_id: "DEMO_LIBRARY_01", location: "圖書館入口（DEMO）" },
  classroom: { gate_id: "DEMO_CLASSROOM_01", location: "教室門口（DEMO）" }
};
const scenario = process.argv[2] || "library";
if (!Object.hasOwn(scenarios, scenario)) throw new Error("場景請使用 library 或 classroom。");
const base = new URL(process.argv[3] || "http://localhost:3000");
if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
  throw new Error("請提供不含帳密與查詢參數的 HTTP／HTTPS API 根網址。");
}

async function request(path, body, key) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json", "Idempotency-Key": key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

const registered = (await request(`/api/items?q=${encodeURIComponent(bleId)}`)).find(item => item.ble_id === bleId);
if (registered && registered.item_name !== "DEMO 黑色錢包") {
  throw new Error("DEMO MAC 已綁定其他名稱；請改用獨立測試資料，避免更新該物品的位置。");
}
const body = { ...scenarios[scenario], item_name: "RADAR_UI_DEMO", ble_id: bleId, rssi: -60, timestamp: 123456 };
const key = `ui-demo:${crypto.randomUUID()}`;
const first = await request("/api/readings", body, key);
const retry = await request("/api/readings", body, key);
assert.equal(retry.reason, "event_retry", "同一事件重送必須被辨識");
assert.equal(retry.id, first.id, "事件重送不應新增感應紀錄");
assert.equal(retry.read_count, first.read_count, "事件重送不應增加讀取次數");
assert.equal(retry.received_at, first.received_at, "事件重送不應延長接收時間");
console.log(JSON.stringify({
  note: "軟體模擬上報，並非實體 BLE 感應；請在前端重新搜尋以更新畫面。",
  register_name: "DEMO 黑色錢包", ble_id: bleId, location: body.location,
  item_id: first.item_id, reading_id: first.id,
  retry_reason: retry.reason, read_count_before_retry: first.read_count, read_count_after_retry: retry.read_count,
  next_step: first.item_id === null ? "前端登記這個名稱與 MAC，便可查詢已保存的位置。" : "前端搜尋 DEMO 黑色錢包，查看最後位置。"
}, null, 2));

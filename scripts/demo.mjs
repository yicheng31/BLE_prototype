import fs from "node:fs/promises";

const base = new URL(process.argv[2] || "http://localhost:3000");
if (!["http:", "https:"].includes(base.protocol)) throw new Error("請使用 HTTP 或 HTTPS API 網址");
const sample = JSON.parse(await fs.readFile(new URL("../docs/reading.example.json", import.meta.url), "utf8"));
const key = "demo:" + crypto.randomUUID();
async function request(path, body, headers = {}) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "HTTP " + response.status);
  return result;
}
// Creates one explicitly named demo item; it does not alter the upstream sample's real MAC.
const body = { ...sample, ble_id: "02:00:00:00:de:01", item_name: "RADAR_DEMO" };
const first = await request("/api/events", body, { "Idempotency-Key": key });
const retry = await request("/api/events", body, { "Idempotency-Key": key });
if (retry.reason !== "event_retry" || retry.read_count !== first.read_count) throw new Error("重送去重失敗");
const item = await request("/api/items/" + first.item_id);
const report = await request("/api/items/" + first.item_id + "/lost", { description: "DEMO 測試通報" });
console.log(JSON.stringify({ note: "軟體模擬 BLE，上報並通報 RADAR_DEMO 遺失", event: first, retry_reason: retry.reason, item, report }, null, 2));

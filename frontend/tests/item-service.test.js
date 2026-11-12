/**
 * @Author: Your name
 * @Date:   2026-11-10 10:15:03
 * @Last Modified by:   Your name
 * @Last Modified time: 2026-11-11 21:33:09
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createItemService } from "../public/js/services/item-service.js";
import { API_BASE_URL } from "../public/js/config.js";

const item = (overrides = {}) => ({ id: "item-001", item_name: "深藍色後背包", ble_id: "RFID-0001", category: "隨身物品", icon: "backpack", status: "normal", last_seen: null, ...overrides });
const report = (overrides = {}) => ({ id: "report-001", item_id: "item-001", item_name: "深藍色後背包", ble_id: "RFID-0001", description: "遺失說明", reported_at: "2026-11-10T01:20:00.000Z", already_reported: false, ...overrides });
const found = (overrides = {}) => ({ item_id: "item-001", resolved_at: "2026-11-12T02:30:00.000Z", already_found: false, ...overrides });
const removed = (overrides = {}) => ({ item_id: "item-001", deleted_at: "2026-11-12T03:30:00.000Z", already_deleted: false, ...overrides });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fixture(responses, options = {}) {
  const calls = [];
  const service = createItemService({ baseUrl: "http://localhost:3000", ...options, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(url, init);
    if (!next) throw new Error("Unexpected extra request");
    return next;
  } });
  return { service, calls };
}

test("GET 物品由後端提供，保留尚無位置資料，不做示例 fallback", async () => {
  const expected = [item(), item({ id: "item-002", last_seen: { gate_id: "工程館門口", item_name: "RADAR_TEST", ble_id: "02:00:00:00:00:01", rssi: -64, timestamp: 11552, location: "工程館 2F 南側門口", received_at: "2026-11-10T09:00:00+08:00" } })];
  const f = fixture([json(expected)]);
  assert.deepEqual(await f.service.listItems(), expected);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "http://localhost:3000/api/items");
  assert.equal(f.calls[0].init.method, "GET");
  assert.equal(f.calls[0].init.headers.Accept, "application/json");
  assert.equal(f.calls[0].init.cache, "no-store");
  assert.equal(f.calls[0].init.body, undefined);
  assert.ok(f.calls[0].init.signal instanceof AbortSignal);
});

test("搜尋透過 q 交給後端，正確編碼中文及特殊字元", async () => {
  const expected = [item({ item_name: "背包 & RFID/001" })];
  const f = fixture([json(expected), json([])]);
  assert.deepEqual(await f.service.searchItems("  背包 & RFID/001  "), expected);
  const requestUrl = new URL(f.calls[0].url);
  assert.equal(requestUrl.pathname, "/api/items");
  assert.equal(requestUrl.searchParams.get("q"), "背包 & RFID/001");
  assert.equal([...requestUrl.searchParams.keys()].length, 1);
  assert.deepEqual(await f.service.searchItems("   "), []);
  assert.equal(f.calls[1].url, "http://localhost:3000/api/items");
});

test("物品 ID 以路徑編碼傳送，只有 404 轉為 null,其他 API 錯誤保留", async () => {
  const expected = item({ id: "part/A?tag=1" });
  const f = fixture([json(expected), json({ error: "找不到物品", code: "ITEM_NOT_FOUND" }, 404), json({ error: "資料庫暫時無法使用", code: "DATABASE_UNAVAILABLE" }, 503)]);
  assert.deepEqual(await f.service.getItem(expected.id), expected);
  assert.equal(f.calls[0].url, "http://localhost:3000/api/items/part%2FA%3Ftag%3D1");
  assert.equal(await f.service.getItem("missing"), null);
  await assert.rejects(f.service.getItem("item-001"), error => error.status === 503 && error.code === "DATABASE_UNAVAILABLE" && error.message === "資料庫暫時無法使用");
});

test("POST 遺失回報以 JSON 寫入,201 成功後才回傳確認資料", async () => {
  const expected = report({ description: "今天在教室發現遺失。" });
  const f = fixture([json(expected, 201)]);
  assert.deepEqual(await f.service.reportLost({ item_id: " item-001 ", description: "  今天在教室發現遺失。\n " }), expected);
  assert.equal(f.calls[0].url, "http://localhost:3000/api/items/item-001/lost");
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { description: "今天在教室發現遺失。" });
});

test("重複回報由後端 200 決定，不在瀏覽器另存或快取成功結果", async () => {
  const original = report();
  const repeated = report({ already_reported: true });
  const f = fixture([json(original, 201), json(repeated)]);
  assert.equal((await f.service.reportLost({ item_id: "item-001" })).already_reported, false);
  const response = await f.service.reportLost({ item_id: "item-001", description: "第二次說明" });
  assert.deepEqual(response, repeated);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].init.method, "POST");
  assert.equal(response.id, original.id);
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { description: "" });
});

test("回報後的物品狀態再次 GET,資料來源始終是後端", async () => {
  const f = fixture([json([item()]), json(report(), 201), json([item({ status: "lost" })])]);
  assert.equal((await f.service.listItems())[0].status, "normal");
  await f.service.reportLost({ item_id: "item-001" });
  assert.equal((await f.service.listItems())[0].status, "lost");
  assert.deepEqual(f.calls.map(call => call.init.method), ["GET", "POST", "GET"]);
});

test("輸入錯誤在送出前拒絕;500 字說明可正常傳送", async () => {
  const f = fixture([json(report({ description: "x".repeat(500) }), 201)]);
  for (const query of [null, 123, [], {}]) await assert.rejects(f.service.searchItems(query), /輸入|文字|UID/);
  for (const id of [undefined, null, " ", [], {}, -1]) await assert.rejects(f.service.getItem(id), /物品編號/);
  for (const input of [undefined, null, [], {}, { item_id: "" }]) await assert.rejects(f.service.reportLost(input), /選擇|物品/);
  for (const description of [null, 123, true, [], {}, "x".repeat(501)]) await assert.rejects(f.service.reportLost({ item_id: "item-001", description }), /500|文字/);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.reportLost({ item_id: "item-001", description: `  ${"x".repeat(500)}  ` })).description.length, 500);
  assert.equal(f.calls.length, 1);
});

test("連線失敗或逾時明確指向後端設定,POST 不會假裝儲存成功", async () => {
  const f = fixture([new TypeError("Failed to fetch"), new DOMException("Timed out", "TimeoutError")]);
  await assert.rejects(f.service.listItems(), error => error.code === "BACKEND_UNAVAILABLE" && /後端.*http:\/\/localhost:3000/.test(error.message) && /API_BASE_URL/.test(error.message));
  await assert.rejects(f.service.reportLost({ item_id: "item-001" }), error => error.code === "BACKEND_UNAVAILABLE" && /無法確認/.test(error.message) && /重試/.test(error.message) && !/已儲存/.test(error.message));
  assert.equal(f.calls.length, 2);
});

test("後端 JSON 錯誤保留 HTTP 狀態與錯誤碼", async () => {
  const f = fixture([json({ error: "遺失說明過長", code: "DESCRIPTION_TOO_LONG" }, 400), json({ error: "找不到這件物品", code: "ITEM_NOT_FOUND" }, 404)]);
  await assert.rejects(f.service.reportLost({ item_id: "item-001" }), error => error.status === 400 && error.code === "DESCRIPTION_TOO_LONG" && error.message === "遺失說明過長");
  await assert.rejects(f.service.reportLost({ item_id: "missing" }), error => error.status === 404 && error.code === "ITEM_NOT_FOUND");
});

test("HTML 或錯誤 JSON 不能被視為物品資料或回報成功", async () => {
  const f = fixture([
    new Response("<!doctype html><title>Live Server</title>", { status: 200 }),
    new Response("{invalid", { status: 201 }),
    json({ items: [item()] }),
    json([item({ last_seen: { location: "缺少欄位" } })]),
    json({}),
    json(report({ item_id: "other-item" }), 201)
  ]);
  await assert.rejects(f.service.listItems(), { code: "INVALID_RESPONSE" });
  await assert.rejects(f.service.reportLost({ item_id: "item-001" }), error => error.code === "INVALID_RESPONSE" && /無法確認/.test(error.message));
  await assert.rejects(f.service.listItems(), { code: "INVALID_RESPONSE" });
  await assert.rejects(f.service.listItems(), { code: "INVALID_RESPONSE" });
  await assert.rejects(f.service.reportLost({ item_id: "item-001" }), { code: "INVALID_RESPONSE" });
  await assert.rejects(f.service.reportLost({ item_id: "item-001" }), { code: "INVALID_RESPONSE" });
});

test("後端網址集中設定，預設 localhost:3000,注入時可移除多餘結尾斜線", async () => {
  assert.equal(API_BASE_URL, "http://localhost:3000");
  const f = fixture([json([])], { baseUrl: "http://127.0.0.1:3100///" });
  await f.service.listItems();
  assert.equal(f.calls[0].url, "http://127.0.0.1:3100/api/items");
  for (const baseUrl of ["", "bad url", "file:///tmp/api", "http://localhost:3000?api=1", "http://user:secret@localhost:3000", "http://localhost:3000#api"]) {
    assert.throws(() => createItemService({ baseUrl }), /API_BASE_URL/);
  }
  assert.throws(() => createItemService({ fetchImpl: null }), /fetch/);
});

test("已找到使用 POST /found 與空 JSON，物品編號會安全編碼", async () => {
  const expected = found({ item_id: "part/A?tag=1" });
  const f = fixture([json(expected)]);
  assert.deepEqual(await f.service.markFound(" part/A?tag=1 "), expected);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "http://localhost:3000/api/items/part%2FA%3Ftag%3D1/found");
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {});
});

test("重複標示已找到保留後端結果，尚無遺失回報也接受 null 結案時間", async () => {
  const resolved = found({ already_found: true });
  const neverReported = found({ already_found: true, resolved_at: null });
  const f = fixture([json(resolved), json(neverReported)]);
  assert.deepEqual(await f.service.markFound("item-001"), resolved);
  assert.deepEqual(await f.service.markFound("item-001"), neverReported);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.init.method === "POST"));
});

test("已找到後重新 GET 清單與明細顯示一般狀態，並可再次回報遺失", async () => {
  const normalItem = item({ status: "normal" });
  const newReport = report({ id: "report-002", already_reported: false, reported_at: "2026-11-12T03:00:00.000Z" });
  const f = fixture([
    json(item({ status: "lost" })), json(found()), json([normalItem]), json(normalItem), json(newReport, 201), json(item({ status: "lost" }))
  ]);
  assert.equal((await f.service.getItem("item-001")).status, "lost");
  assert.equal((await f.service.markFound("item-001")).already_found, false);
  assert.equal((await f.service.listItems())[0].status, "normal");
  assert.equal((await f.service.getItem("item-001")).status, "normal");
  assert.equal((await f.service.reportLost({ item_id: "item-001" })).id, "report-002");
  assert.equal((await f.service.getItem("item-001")).status, "lost");
  assert.deepEqual(f.calls.map(call => call.init.method), ["GET", "POST", "GET", "GET", "POST", "GET"]);
});

test("已找到回應 404、後端錯誤或網路失敗時，不回傳成功結果", async () => {
  const f = fixture([
    json({ error: "找不到物品", code: "ITEM_NOT_FOUND" }, 404),
    json({ error: "資料庫暫時無法使用", code: "DATABASE_UNAVAILABLE" }, 503),
    new TypeError("Failed to fetch")
  ]);
  await assert.rejects(f.service.markFound("missing"), error => error.status === 404 && error.code === "ITEM_NOT_FOUND");
  await assert.rejects(f.service.markFound("item-001"), error => error.status === 503 && error.code === "DATABASE_UNAVAILABLE");
  await assert.rejects(f.service.markFound("item-001"), error => error.code === "BACKEND_UNAVAILABLE" && /已找到/.test(error.message) && /無法確認/.test(error.message));
});

test("已找到拒絕無效編號與格式錯誤的成功回應，首次結案必須有時間", async () => {
  const f = fixture([
    new Response("<html>Wrong endpoint</html>", { status: 200 }),
    json({}), json(found({ item_id: "other-item" })), json(found({ resolved_at: null })),
    json(found({ resolved_at: "invalid" })), json(found({ already_found: "true" })), json([found()])
  ]);
  for (const id of [undefined, null, " ", [], {}, -1]) await assert.rejects(f.service.markFound(id), /物品編號/);
  assert.equal(f.calls.length, 0);
  for (let index = 0; index < 7; index++) {
    await assert.rejects(f.service.markFound("item-001"), error => error.code === "INVALID_RESPONSE" && /已找到/.test(error.message) && /無法確認/.test(error.message));
  }
});

test("登記物品只 POST 名稱與 MAC，名稱去頭尾空白、MAC 統一小寫", async () => {
  const expected = item({ id: "new-item", item_name: "黑色錢包", ble_id: "aa:bb:cc:dd:ee:ff" });
  const f = fixture([json(expected, 201)]);
  assert.deepEqual(await f.service.createItem({ item_name: "  黑色錢包  ", ble_id: " AA:BB:CC:DD:EE:FF ", category: "不應傳送", icon: "不應傳送" }), expected);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "http://localhost:3000/api/items");
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { item_name: "黑色錢包", ble_id: "aa:bb:cc:dd:ee:ff" });
});

test("登記後 GET 清單與明細保留綁定歷史，使用者名稱可不同於廣播名稱", async () => {
  const expected = item({ id: "new-item", item_name: "黑色錢包", ble_id: "aa:bb:cc:dd:ee:ff", last_seen: {
    gate_id: "gate-01", location: "圖書館入口", received_at: "2026-11-12T08:00:00+08:00",
    item_name: "RADAR_TEST", ble_id: "aa:bb:cc:dd:ee:ff", rssi: -60, timestamp: 123456
  } });
  const f = fixture([json(expected, 201), json([expected]), json(expected)]);
  assert.equal((await f.service.createItem({ item_name: "黑色錢包", ble_id: "aa:bb:cc:dd:ee:ff" })).item_name, "黑色錢包");
  assert.deepEqual(await f.service.listItems(), [expected]);
  assert.deepEqual(await f.service.getItem("new-item"), expected);
  assert.deepEqual(f.calls.map(call => call.init.method), ["POST", "GET", "GET"]);
});

test("登記拒絕空名稱、超長名稱、控制字元及無效 MAC，100 字名稱可送出", async () => {
  const bleId = "aa:bb:cc:dd:ee:ff";
  const f = fixture([json(item({ item_name: "x".repeat(100), ble_id: bleId }), 201)]);
  for (const input of [undefined, null, [], {}, { item_name: "", ble_id: bleId }, { item_name: "  ", ble_id: bleId }]) {
    await assert.rejects(f.service.createItem(input), /物品名稱/);
  }
  for (const item_name of [null, 123, [], {}, "x".repeat(101), "測試\n物品", "測試\u007f物品"]) {
    await assert.rejects(f.service.createItem({ item_name, ble_id: bleId }), /物品名稱/);
  }
  for (const ble_id of [undefined, null, 123, [], {}, "", "RADAR_TEST", "aa-bb-cc-dd-ee-ff", "aa:bb:cc:dd:ee", "gg:bb:cc:dd:ee:ff"]) {
    await assert.rejects(f.service.createItem({ item_name: "測試物品", ble_id }), /BLE MAC/);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.createItem({ item_name: "x".repeat(100), ble_id: bleId })).item_name.length, 100);
});

test("重複 MAC 的 409 原樣回報，不改名、不覆寫或偷偷重試", async () => {
  const f = fixture([json({ error: "這個 BLE MAC 已綁定其他物品", code: "TAG_ALREADY_EXISTS" }, 409)]);
  await assert.rejects(f.service.createItem({ item_name: "新名稱", ble_id: "aa:bb:cc:dd:ee:ff" }),
    error => error.status === 409 && error.code === "TAG_ALREADY_EXISTS" && /已綁定/.test(error.message));
  assert.equal(f.calls.length, 1);
});

test("登記回應必須對上名稱與 MAC；網路或格式錯誤不假裝已登記", async () => {
  const name = "黑色錢包", bleId = "aa:bb:cc:dd:ee:ff";
  const f = fixture([
    json({}), json(item({ item_name: "其他物品", ble_id: bleId }), 201),
    json(item({ item_name: name, ble_id: "aa:bb:cc:dd:ee:00" }), 201),
    new Response("<html>Wrong endpoint</html>", { status: 200 }), new TypeError("Failed to fetch")
  ]);
  for (let index = 0; index < 5; index++) {
    await assert.rejects(f.service.createItem({ item_name: name, ble_id: bleId }), error =>
      error.code === (index === 4 ? "BACKEND_UNAVAILABLE" : "INVALID_RESPONSE") &&
      /無法確認/.test(error.message) && /查詢/.test(error.message) && !/已登記/.test(error.message));
  }
});

test("刪除物品使用 DELETE 且不帶 body，編碼物品 ID 並接受冪等回應", async () => {
  const f = fixture([json(removed({ item_id: "part/A?1" })), json(removed({ already_deleted: true }))]);
  assert.equal((await f.service.deleteItem(" part/A?1 ")).item_id, "part/A?1");
  assert.equal(f.calls[0].url, "http://localhost:3000/api/items/part%2FA%3F1");
  assert.equal(f.calls[0].init.method, "DELETE");
  assert.equal(f.calls[0].init.body, undefined);
  assert.equal(f.calls[0].init.headers["Content-Type"], undefined);
  assert.equal((await f.service.deleteItem("item-001")).already_deleted, true);
});

test("刪除後 GET 不列出物品，單件 404 轉為 null，明確重新登記可恢復同一 ID", async () => {
  const restored = item({ item_name: "新的名稱", ble_id: "aa:bb:cc:dd:ee:ff" });
  const f = fixture([json(removed()), json([]), json({ code: "ITEM_NOT_FOUND" }, 404), json(restored, 201)]);
  await f.service.deleteItem("item-001");
  assert.deepEqual(await f.service.listItems(), []);
  assert.equal(await f.service.getItem("item-001"), null);
  assert.equal((await f.service.createItem({ item_name: restored.item_name, ble_id: restored.ble_id })).id, "item-001");
  assert.deepEqual(f.calls.map(call => call.init.method), ["DELETE", "GET", "GET", "POST"]);
});

test("刪除失敗、網路錯誤與不匹配回應不會被當成成功", async () => {
  const f = fixture([
    json({ error: "找不到物品", code: "ITEM_NOT_FOUND" }, 404), new TypeError("Failed to fetch"),
    json(removed({ item_id: "other" })), json(removed({ deleted_at: null })),
    json(removed({ deleted_at: "bad" })), json(removed({ already_deleted: "true" })),
    new Response("<html>Wrong endpoint</html>", { status: 200 })
  ]);
  for (const id of [undefined, null, " ", [], {}, -1]) await assert.rejects(f.service.deleteItem(id), /物品編號/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.service.deleteItem("item-001"), { code: "ITEM_NOT_FOUND", status: 404 });
  await assert.rejects(f.service.deleteItem("item-001"), error => error.code === "BACKEND_UNAVAILABLE" && /無法確認.*刪除物品/.test(error.message));
  for (let index = 0; index < 5; index++) await assert.rejects(f.service.deleteItem("item-001"), { code: "INVALID_RESPONSE" });
});

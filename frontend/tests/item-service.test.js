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
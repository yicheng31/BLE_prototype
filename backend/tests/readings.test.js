import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeReading, toInternalReading } from "../src/readings/normalize.js";

const payload = { gate_id: " GATE_01 ", location: " 圖書館 ", item_name: "RADAR_PHONE",
  ble_id: "54:F8:7E:40:FE:BC", rssi: -64, timestamp: 0 };

test("BLE 原始六欄位轉成內部格式，裝置毫秒和接收日期分開", () => {
  const reading = toInternalReading(payload, new Date("2026-11-14T04:00:00Z"));
  assert.equal(reading.gate_id, "GATE_01");
  assert.equal(reading.location, "圖書館");
  assert.equal(reading.ble_id, "54:f8:7e:40:fe:bc");
  assert.equal(reading.timestamp, 0);
  assert.equal(reading.received_at, "2026-11-14T04:00:00.000Z");
  assert.equal(normalizeReading({ ...payload, timestamp: 4294967295 }).timestamp, 4294967295);
});

test("無效 BLE 資料於進資料庫前拒絕", () => {
  for (const key of Object.keys(payload)) {
    const invalid = { ...payload }; delete invalid[key];
    assert.throws(() => normalizeReading(invalid), error => error.status === 400);
  }
  for (const changes of [{ rssi: "-64" }, { timestamp: -1 }, { ble_id: "bad" }, { item_name: " " }]) {
    assert.throws(() => normalizeReading({ ...payload, ...changes }), error => error.status === 400);
  }
});

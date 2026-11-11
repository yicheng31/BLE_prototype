import { test } from "node:test";
import assert from "node:assert/strict";
import { createItemService } from "../public/js/services/item-service.js";
import { demoItems } from "../public/js/data/demo-items.js";

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); }
  };
}

function fixture() {
  const storage = memoryStorage();
  let clock = new Date("2026-11-09T12:00:00.000Z");
  let sequence = 0;
  const service = createItemService({ storage, now: () => new Date(clock), makeId: () => `report-${++sequence}` });
  return { service, storage, advance(ms) { clock = new Date(clock.getTime() + ms); } };
}

test("示範物品可查詢，尚無位置的物品仍保留，未知物品回傳 null", async () => {
  const { service } = fixture();
  const items = await service.listItems();
  assert.equal(items.length, 4);
  assert.deepEqual(items.map(item => item.id), ["item-001", "item-002", "item-003", "item-004"]);
  assert.equal((await service.getItem("item-001")).status, "lost");
  assert.equal((await service.getItem("item-004")).lastSeen, null);
  assert.equal(await service.getItem("missing-item"), null);
});

test("位置搜尋忽略頭尾空白與 UID 大小寫，也可搜尋名稱", async () => {
  const { service } = fixture();
  const byUid = await service.searchItems("  rFiD-0002  ");
  assert.deepEqual(byUid.map(item => item.id), ["item-002"]);
  const byName = await service.searchItems(demoItems[1].name.slice(0, 2));
  assert.ok(byName.some(item => item.id === "item-002"));
  assert.equal((await service.searchItems("   ")).length, 4);
  assert.equal((await service.searchItems("完全不存在的測試物品")).length, 0);
  for (const query of [null, 123, [], {}]) {
    await assert.rejects(async () => service.searchItems(query), /搜尋|文字|字串|輸入|名稱|UID|query|string/i);
  }
});

test("遺失通報會保存說明與時間，重新建立服務後仍顯示遺失狀態", async () => {
  const f = fixture();
  const report = await f.service.reportLost({ itemId: "item-002", description: "  請在辦公室協尋。\n " });
  assert.equal(report.itemId, "item-002");
  assert.equal(report.itemName, demoItems[1].name);
  assert.equal(report.tagUid, "RFID-0002");
  assert.equal(report.description, "請在辦公室協尋。");
  assert.equal(report.reportedAt, "2026-11-09T12:00:00.000Z");
  assert.equal(report.alreadyReported, false);
  assert.equal((await f.service.getItem("item-002")).status, "lost");
  const restored = createItemService({ storage: f.storage });
  assert.equal((await restored.getItem("item-002")).status, "lost");
  assert.equal((await restored.searchItems("RFID-0002"))[0].status, "lost");
  assert.equal(f.storage.values.size, 1);
  const persisted = JSON.parse([...f.storage.values.values()][0]);
  assert.ok(Array.isArray(persisted));
  assert.equal(persisted.length, 1);
});

test("重複通報同一物品維持原內容與時間，不再新增一筆", async () => {
  const f = fixture();
  const original = await f.service.reportLost({ itemId: "item-003", description: "原始說明" });
  f.advance(60000);
  const repeated = await f.service.reportLost({ itemId: "item-003", description: "新的說明不應蓋掉原紀錄" });
  assert.equal(repeated.alreadyReported, true);
  assert.equal(repeated.id, original.id);
  assert.equal(repeated.reportedAt, original.reportedAt);
  assert.equal(repeated.description, "原始說明");
  const restored = createItemService({ storage: f.storage });
  const afterReload = await restored.reportLost({ itemId: "item-003", description: "重新開啟頁面後重送" });
  assert.equal(afterReload.alreadyReported, true);
  assert.equal(afterReload.id, original.id);
  assert.equal(afterReload.reportedAt, original.reportedAt);
  assert.equal(JSON.parse([...f.storage.values.values()][0]).length, 1);
});

test("不同物品的遺失通報各自保存，尚無位置也可以通報", async () => {
  const f = fixture();
  const first = await f.service.reportLost({ itemId: "item-002" });
  const second = await f.service.reportLost({ itemId: "item-004" });
  assert.notEqual(first.id, second.id);
  assert.equal(second.description, "");
  assert.equal((await f.service.getItem("item-004")).status, "lost");
  assert.equal((await f.service.getItem("item-004")).lastSeen, null);
  assert.equal(JSON.parse([...f.storage.values.values()][0]).length, 2);
});

test("缺少或未知物品、非文字說明及過長說明會明確拒絕", async () => {
  const f = fixture();
  for (const body of [{}, { itemId: "unknown" }]) {
    await assert.rejects(async () => f.service.reportLost(body), /物品|選擇|item/i);
  }
  for (const description of [null, 123, true, [], {}]) {
    await assert.rejects(async () => f.service.reportLost({ itemId: "item-002", description }), /說明|文字|字串|description|string/i);
  }
  await assert.rejects(async () => f.service.reportLost({ itemId: "item-002", description: "x".repeat(501) }), /500|過長|長度/i);
  assert.equal((await f.service.getItem("item-002")).status, "normal");
  assert.equal(f.storage.values.size, 0);
  const accepted = await f.service.reportLost({ itemId: "item-002", description: `  ${"x".repeat(500)}  ` });
  assert.equal(accepted.description.length, 500);
});

test("回傳資料可獨立使用，不會改動示範資料或後續查詢", async () => {
  const f = fixture();
  const original = structuredClone(demoItems);
  const list = await f.service.listItems();
  list[0].name = "外部修改名稱";
  list[0].lastSeen.location = "外部修改位置";
  list.splice(1);
  const item = await f.service.getItem("item-002");
  item.name = "外部修改單筆資料";
  item.lastSeen.gateName = "外部修改閘門";
  const report = await f.service.reportLost({ itemId: "item-003", description: "原始通報" });
  report.description = "外部修改通報";
  const repeated = await f.service.reportLost({ itemId: "item-003" });
  assert.equal(repeated.description, "原始通報");
  assert.equal((await f.service.listItems()).length, 4);
  assert.equal((await f.service.getItem("item-001")).name, original[0].name);
  assert.equal((await f.service.getItem("item-001")).lastSeen.location, original[0].lastSeen.location);
  assert.equal((await f.service.getItem("item-002")).name, original[1].name);
  assert.equal((await f.service.getItem("item-002")).lastSeen.gateName, original[1].lastSeen.gateName);
  assert.deepEqual(demoItems, original);
});

test("損壞或無法讀取的儲存資料會明確報錯", async () => {
  const corrupt = { getItem: () => "{invalid json", setItem() {} };
  const inaccessible = { getItem() { throw new Error("SecurityError"); }, setItem() {} };
  for (const storage of [corrupt, inaccessible]) {
    await assert.rejects(async () => {
      const service = createItemService({ storage });
      await service.listItems();
    }, /儲存|存取|讀取|資料|storage/i);
  }
});

test("儲存失敗不會產生未成功保存的遺失通報", async () => {
  const storage = memoryStorage();
  let blocked = true;
  const writable = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (blocked) throw new Error("QuotaExceededError");
    writable(key, value);
  };
  const service = createItemService({ storage, now: () => new Date("2026-11-09T12:00:00Z"), makeId: () => "retry-report" });
  await assert.rejects(async () => service.reportLost({ itemId: "item-002" }), /儲存|保存|寫入|空間|storage/i);
  assert.equal((await service.getItem("item-002")).status, "normal");
  assert.equal((await createItemService({ storage }).getItem("item-002")).status, "normal");
  assert.equal(storage.values.size, 0);
  blocked = false;
  const report = await service.reportLost({ itemId: "item-002" });
  assert.equal(report.alreadyReported, false);
  assert.equal((await service.getItem("item-002")).status, "lost");
});

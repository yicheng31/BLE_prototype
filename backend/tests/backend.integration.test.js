import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL：API、位置更新與讀取去重整合", {
  skip: databaseUrl ? false : "未設定 TEST_DATABASE_URL，未執行真實 PostgreSQL 整合測試。"
}, async suite => {
  const { Pool } = await import("pg");
  const { createApp } = await import("../src/app.js");
  const { migrate } = await import("../src/db/migrate.js");

  async function fixture(t) {
    const schema = `rfid_test_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
    assert.match(schema, /^rfid_test_[a-z0-9_]+$/);
    const admin = new Pool({ connectionString: databaseUrl, max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pools = new Set();
    const servers = new Set();
    let clock = new Date("2026-11-10T04:00:00.000Z");
    let pool, server, baseUrl;

    async function closeServer(target) {
      if (!target?.listening) return;
      const closing = new Promise((resolve, reject) => target.close(error => error ? reject(error) : resolve()));
      target.closeAllConnections();
      await closing;
    }

    t.after(async () => {
      try {
        await Promise.all([...servers].map(closeServer));
        await Promise.all([...pools].map(target => target.end()));
        // 僅刪除本測試建立、具固定前綴與隨機名稱的 schema。
        assert.match(schema, /^rfid_test_[a-z0-9_]+$/);
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally { await admin.end(); }
    });

    async function start() {
      // 不加入 public，確保不會讀寫使用者既有的資料表。
      pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12 });
      pools.add(pool);
      await migrate(pool);
      server = http.createServer(createApp({ pool, dedupeWindowMs: 3000, now: () => new Date(clock) }));
      servers.add(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    }
    await start();

    const f = {
      get baseUrl() { return baseUrl; },
      get databaseUrl() { const target = new URL(databaseUrl); target.searchParams.set("options", "-c search_path=" + schema); return target.href; },
      get pool() { return pool; },
      now() { return new Date(clock); },
      advance(ms) { clock = new Date(clock.getTime() + ms); },
      async request(path, { method = "GET", body, raw, headers = {} } = {}) {
        const response = await fetch(baseUrl + path, {
          method,
          headers: { ...(body !== undefined || raw !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
          body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15000)
        });
        const text = await response.text();
        const data = text && response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text;
        return { status: response.status, data, headers: response.headers };
      },
      async post(path, body) { return this.request(path, { method: "POST", body }); },
      async count(table) {
        assert.ok(["items", "tag", "gates", "gates_event", "reading_requests", "lost_reports"].includes(table));
        return Number((await pool.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count);
      },
      async restart() {
        await closeServer(server); servers.delete(server);
        await pool.end(); pools.delete(pool);
        await start();
      }
    };
    return f;
  }

  const event = (extra = {}) => ({ gate_id: "GATE_01", location: "圖書館 1 樓大門", item_name: "RADAR_XAIOMI15", ble_id: "54:f8:7e:40:fe:bc", rssi: -64, timestamp: 11552, ...extra });
  async function register(f, extra = {}) {
    const response = await f.post("/api/items", { item_name: "已登記的測試物品", ble_id: event().ble_id, ...extra });
    assert.equal(response.status, 201);
    return response.data;
  }
  async function registerAndRead(f, extra = {}) {
    const reading = event(extra);
    const item = await register(f, { item_name: reading.item_name, ble_id: reading.ble_id });
    const response = await f.post("/api/events", reading);
    assert.equal(response.status, 200);
    assert.equal(response.data.item_id, item.id);
    return item.id;
  }
  await suite.test("六欄位上傳、前端查詢、遺失回報與持久化", async t => {
    const f = await fixture(t);
    const { createItemService } = await import("../../frontend/public/js/services/item-service.js");
    const service = createItemService({ baseUrl: "http://localhost:3000", fetchImpl: async (url, init) => {
      const parsed = new URL(url); const result = await f.request(parsed.pathname + parsed.search, { method: init.method, raw: init.body, headers: init.headers });
      return new Response(JSON.stringify(result.data), { status: result.status });
    } });
    const registered = await service.createItem({ item_name: "黑色錢包", ble_id: event().ble_id });
    assert.equal(registered.last_seen, null);
    const sent = await f.post("/api/readings", event());
    assert.equal(sent.status, 200); assert.equal(sent.data.status, "SUCCESS");
    assert.equal(sent.data.item_id, registered.id);
    for (const key of Object.keys(event())) assert.equal(sent.data[key], event()[key]);
    assert.equal(sent.data.received_at, f.now().toISOString());
    assert.equal((await service.searchItems("錢包"))[0].id, registered.id);
    const rows = await service.searchItems("54:F8");
    assert.equal(rows.length, 1); assert.deepEqual(rows[0].last_seen, { ...event(), received_at: f.now().toISOString() });
    assert.equal((await service.reportLost({ item_id: rows[0].id, description: "協尋" })).already_reported, false);
    assert.equal((await service.reportLost({ item_id: rows[0].id })).already_reported, true);
    await f.restart(); assert.equal((await service.getItem(rows[0].id)).status, "lost");
    const found = await service.markFound(rows[0].id);
    assert.equal(found.already_found, false);
    assert.equal(found.resolved_at, f.now().toISOString());
    assert.equal((await service.getItem(rows[0].id)).status, "normal");
    assert.deepEqual((await f.request("/api/items?lost=true")).data, []);
  });
  await suite.test("連讀、換閘門、換位置與重開機毫秒", async t => {
    const f = await fixture(t); const first = await f.post("/api/readings", event()); f.advance(2999);
    const next = await f.post("/api/readings", event({ rssi: -48, timestamp: 0 }));
    assert.equal(next.data.id, first.data.id); assert.equal(next.data.read_count, 2); assert.equal(next.data.rssi, -48);
    f.advance(100); await f.post("/api/readings", event({ gate_id: "GATE_02" }));
    f.advance(100); await f.post("/api/readings", event({ location: "教室" }));
    assert.equal(await f.count("gates_event"), 3); f.advance(3000);
    await f.post("/api/readings", event({ location: "教室", timestamp: 4294967295 }));
    assert.equal(await f.count("gates_event"), 4); assert.equal(await f.count("items"), 0);
  });
  await suite.test("未綁定 MAC 的並行與大小寫回報只累計事件，不自動登記物品", async t => {
    const f = await fixture(t);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => f.post("/api/readings", event({ timestamp: i, ble_id: i % 2 ? event().ble_id.toUpperCase() : event().ble_id }))));
    assert.ok(results.every(r => r.status === 200 && r.data.item_id === null));
    assert.equal(await f.count("items"), 0); assert.equal(await f.count("tag"), 1); assert.equal(await f.count("gates_event"), 1);
    assert.equal((await f.pool.query("SELECT read_count FROM gates_event")).rows[0].read_count, 20);
  });
  await suite.test("未知 MAC 先保存軌跡，人工綁定錢包後才可用名稱查到最新位置", async t => {
    const f = await fixture(t);
    const first = await f.post("/api/events", event());
    f.advance(1000);
    const secondBody = event({ gate_id: "GATE_02", location: "工程館入口", item_name: "RADAR_OTHER_BROADCAST" });
    const second = await f.post("/api/events", secondBody);
    assert.equal(first.data.item_id, null); assert.equal(second.data.item_id, null);
    assert.equal(await f.count("items"), 0); assert.equal(await f.count("tag"), 1);
    assert.equal(await f.count("gates_event"), 2);
    assert.deepEqual((await f.request("/api/items")).data, []);
    assert.equal((await f.pool.query("SELECT item_id FROM tag")).rows[0].item_id, null);
    const wallet = await register(f, { item_name: "錢包", ble_id: event().ble_id.toUpperCase() });
    assert.equal(wallet.item_name, "錢包");
    assert.equal(wallet.ble_id, event().ble_id);
    assert.deepEqual(wallet.last_seen, { ...secondBody, received_at: f.now().toISOString() });
    const matches = (await f.request("/api/items?q=" + encodeURIComponent("錢包"))).data;
    assert.equal(matches.length, 1); assert.equal(matches[0].id, wallet.id);
    assert.equal(matches[0].item_name, "錢包");
    assert.equal(matches[0].last_seen.item_name, secondBody.item_name);
    assert.deepEqual((await f.request("/api/items?q=RADAR")).data, []);
    assert.deepEqual((await f.pool.query("SELECT id FROM gates_event ORDER BY id")).rows.map(row => row.id), [first.data.id, second.data.id]);
    assert.equal((await f.post("/api/items", { item_name: "另一個名稱", ble_id: event().ble_id.toUpperCase() })).status, 409);
    assert.equal(await f.count("items"), 1); assert.equal(await f.count("tag"), 1);
  });
  await suite.test("相同人類名稱可有多個 MAC 候選，廣播名稱不覆蓋人工綁定名稱", async t => {
    const f = await fixture(t);
    const a = await register(f, { item_name: "錢包" });
    const b = await register(f, { item_name: "錢包", ble_id: "02:00:00:00:ab:02" });
    const readA = await f.post("/api/events", event({ item_name: "RADAR_A" }));
    const readB = await f.post("/api/events", event({ ble_id: b.ble_id, item_name: "RADAR_B", gate_id: "GATE_02" }));
    assert.equal(readA.data.item_id, a.id); assert.equal(readB.data.item_id, b.id);
    const candidates = (await f.request("/api/items?q=" + encodeURIComponent("錢包"))).data;
    assert.equal(candidates.length, 2);
    assert.deepEqual(new Set(candidates.map(item => item.id)), new Set([a.id, b.id]));
    assert.ok(candidates.every(item => item.item_name === "錢包"));
    assert.equal(candidates.find(item => item.id === a.id).last_seen.item_name, "RADAR_A");
    assert.equal(candidates.find(item => item.id === b.id).last_seen.item_name, "RADAR_B");
    const byMac = (await f.request("/api/items?q=" + encodeURIComponent(b.ble_id.toUpperCase()))).data;
    assert.equal(byMac.length, 1); assert.equal(byMac[0].id, b.id);
    assert.equal(await f.count("items"), 2);
  });
  await suite.test("同 MAC 並行人工登記與上報只綁定一次，舊事件重送仍保留未綁定快照", async t => {
    const f = await fixture(t);
    const firstBody = event();
    const first = await f.request("/api/events", { method: "POST", body: firstBody, headers: { "Idempotency-Key": "before-binding:1" } });
    assert.equal(first.data.item_id, null);
    const operations = Array.from({ length: 12 }, (_, index) => [
      { kind: "register", run: () => f.post("/api/items", { item_name: "錢包", ble_id: index % 2 ? event().ble_id : event().ble_id.toUpperCase() }) },
      { kind: "reading", run: () => f.post("/api/events", event({ ble_id: index % 2 ? event().ble_id.toUpperCase() : event().ble_id, timestamp: 20000 + index })) }
    ]).flat();
    const results = await Promise.all(operations.map(async operation => ({ kind: operation.kind, ...await operation.run() })));
    const registrations = results.filter(result => result.kind === "register");
    const readings = results.filter(result => result.kind === "reading");
    const created = registrations.filter(result => result.status === 201);
    assert.equal(created.length, 1);
    assert.equal(registrations.filter(result => result.status === 409).length, 11);
    const itemId = created[0].data.id;
    assert.ok(readings.every(result => result.status === 200 && [null, itemId].includes(result.data.item_id)));
    assert.equal(await f.count("items"), 1); assert.equal(await f.count("tag"), 1);
    assert.equal(await f.count("gates_event"), 1);
    assert.equal((await f.pool.query("SELECT read_count FROM gates_event")).rows[0].read_count, 13);
    const binding = (await f.pool.query("SELECT ble_id,item_id FROM tag")).rows[0];
    assert.deepEqual(binding, { ble_id: event().ble_id, item_id: itemId });
    f.advance(1000);
    const next = await f.post("/api/events", event({ item_name: "RADAR_AFTER_BIND", timestamp: 30000 }));
    assert.equal(next.data.item_id, itemId); assert.equal(next.data.read_count, 14);
    const retry = await f.request("/api/events", { method: "POST", body: firstBody, headers: { "Idempotency-Key": "before-binding:1" } });
    assert.equal(retry.data.item_id, null); assert.equal(retry.data.reason, "event_retry");
    assert.equal(retry.data.read_count, 1); assert.equal(retry.data.received_at, first.data.received_at);
    const wallet = (await f.request("/api/items?q=" + encodeURIComponent("錢包"))).data;
    assert.equal(wallet.length, 1); assert.equal(wallet[0].id, itemId);
    assert.equal(wallet[0].last_seen.received_at, f.now().toISOString());
    assert.equal(wallet[0].last_seen.item_name, "RADAR_AFTER_BIND");
    assert.equal((await f.pool.query("SELECT read_count FROM gates_event")).rows[0].read_count, 14);
  });
  await suite.test("缺欄位、舊格式、無效型別與超限資料不寫入", async t => {
    const f = await fixture(t);
    for (const key of Object.keys(event())) { const bad = event(); delete bad[key]; assert.equal((await f.post("/api/readings", bad)).status, 400); }
    for (const bad of [null, [], { tagUid: "RFID-0001", location: "舊格式" }, event({ ble_id: "bad" }), event({ rssi: "-64" }), event({ rssi: -128 }), event({ timestamp: -1 }), event({ timestamp: 4294967296 }), event({ item_name: " " })]) assert.equal((await f.post("/api/readings", bad)).status, 400);
    assert.equal((await f.request("/api/readings", { method: "POST", raw: "{" })).status, 400);
    assert.equal((await f.post("/api/readings", event({ location: "x".repeat(17000) }))).status, 413);
    assert.equal(await f.count("items"), 0); assert.equal(await f.count("gates_event"), 0);
  });
  await suite.test("舊資料庫升級成五張主表，保留未綁定標籤、位置、事件與通報", async t => {
    const f = await fixture(t);
    // This fixture has its own random schema; recreate the pre-split schema only here.
    await f.pool.query(`DROP TABLE reading_requests,lost_reports,gates_event,tag,gates,items;
      CREATE TABLE items (id TEXT PRIMARY KEY,name TEXT NOT NULL,tag_uid TEXT UNIQUE NOT NULL,category TEXT NOT NULL DEFAULT '',icon TEXT NOT NULL DEFAULT 'backpack');
      CREATE TABLE readings (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tag_uid TEXT NOT NULL,reader_id TEXT NOT NULL,location TEXT NOT NULL,first_seen_at TIMESTAMPTZ NOT NULL,last_seen_at TIMESTAMPTZ NOT NULL,read_count INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE lost_reports (id TEXT PRIMARY KEY,item_id TEXT UNIQUE NOT NULL REFERENCES items(id),description TEXT NOT NULL DEFAULT '',reported_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE reading_requests (reader_id TEXT NOT NULL,event_id TEXT NOT NULL,payload_hash TEXT NOT NULL,reading_id INTEGER NOT NULL REFERENCES readings(id),PRIMARY KEY(reader_id,event_id));
      INSERT INTO items (id,name,tag_uid) VALUES ('legacy-item','舊手機','54:F8:7E:40:FE:BC');
      INSERT INTO readings (tag_uid,reader_id,location,first_seen_at,last_seen_at) VALUES ('54:F8:7E:40:FE:BC','GATE_01','圖書館',now(),now()),('02:00:00:00:ff:01','GATE_02','入口',now(),now());
      INSERT INTO lost_reports VALUES ('legacy-report','legacy-item','協尋',now());
      INSERT INTO reading_requests VALUES ('GATE_01','old-event','old-hash',1);`);
    await f.pool.query("UPDATE readings SET first_seen_at=$1,last_seen_at=$1", [new Date(f.now().getTime()-1000).toISOString()]);
    await migrate(f.pool); await migrate(f.pool);
    const found = (await f.request("/api/items/legacy-item")).data;
    assert.equal(found.status, "lost"); assert.equal(found.last_seen.location, "圖書館");
    assert.equal(found.last_seen.rssi, null); assert.equal(found.last_seen.timestamp, null);
    assert.equal(await f.count("tag"), 2); assert.equal(await f.count("gates"), 2);
    assert.equal(await f.count("gates_event"), 2); assert.equal(await f.count("lost_reports"), 1);
    assert.equal(await f.count("reading_requests"), 1);
    const unbound = (await f.pool.query("SELECT item_id FROM tag WHERE ble_id='02:00:00:00:ff:01'")).rows[0];
    assert.equal(unbound.item_id, null);
    assert.equal((await f.post("/api/readings", event())).status, 200);
    const updated = (await f.request("/api/items/legacy-item")).data;
    assert.equal(updated.last_seen.rssi, -64); assert.equal(updated.item_name, "舊手機");
    const columns = (await f.pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='items'")).rows.map(r => r.column_name);
    assert.ok(!columns.includes("ble_id"));
    assert.ok(columns.includes("deleted_at"));
    const migratedItem = (await f.pool.query("SELECT id,deleted_at FROM items WHERE id='legacy-item'")).rows[0];
    assert.deepEqual(migratedItem, { id: "legacy-item", deleted_at: null });
    assert.equal((await f.pool.query("SELECT to_regclass('readings') AS old_table")).rows[0].old_table, null);
  });

  await suite.test("同一事件並行重送只處理一次，去重狀態重啟後仍保留", async t => {
    const f = await fixture(t);
    const send = body => f.request("/api/events", { method: "POST", body, headers: { "Idempotency-Key": "boot-a:1" } });
    const results = await Promise.all(Array.from({ length: 20 }, () => send(event())));
    assert.ok(results.every(result => result.status === 200));
    assert.equal(results.filter(result => result.data.reason === "event_retry").length, 19);
    assert.equal(await f.count("items"), 0);
    assert.ok(results.every(result => result.data.item_id === null));
    assert.equal(await f.count("gates_event"), 1);
    assert.equal(await f.count("reading_requests"), 1);
    assert.equal((await f.pool.query("SELECT read_count FROM gates_event")).rows[0].read_count, 1);
    f.advance(10000); await f.restart();
    const registered = await register(f, { item_name: "後來登記的手機" });
    const retry = await send(event({ ble_id: event().ble_id.toUpperCase() }));
    assert.equal(retry.data.reason, "event_retry");
    assert.equal(retry.data.received_at, results[0].data.received_at);
    assert.equal(retry.data.read_count, 1);
    assert.equal(retry.data.item_id, null);
    const bound = (await f.request("/api/items?q=" + encodeURIComponent(event().ble_id))).data;
    assert.equal(bound.length, 1); assert.equal(bound[0].id, registered.id);
    assert.equal(bound[0].last_seen.location, event().location);
    assert.equal((await send(event({ location: "不同內容" }))).status, 409);
    assert.equal(await f.count("gates_event"), 1);
  });

  await suite.test("晚到的舊事件重送不蓋掉新位置，回傳原始回應快照", async t => {
    const f = await fixture(t);
    await register(f);
    const first = await f.request("/api/readings", { method: "POST", body: event(), headers: { "Idempotency-Key": "boot-b:1" } });
    f.advance(1000);
    await f.post("/api/events", event({ location: "工程館", gate_id: "GATE_02", timestamp: 12552 }));
    f.advance(10000);
    const retry = await f.request("/api/readings", { method: "POST", body: event(), headers: { "Idempotency-Key": "boot-b:1" } });
    assert.equal(retry.data.location, event().location);
    assert.equal(retry.data.received_at, first.data.received_at);
    assert.equal(retry.data.reason, "event_retry");
    const item = (await f.request("/api/items/" + first.data.item_id)).data;
    assert.equal(item.last_seen.location, "工程館");
    assert.equal(item.last_seen.gate_id, "GATE_02");
    assert.equal(await f.count("gates_event"), 2);
  });

  await suite.test("既有物品名稱、遺失狀態保留，相同 MAC 對應相同物品", async t => {
    const f = await fixture(t);
    const created = await f.post("/api/items", { item_name: "我的手機", ble_id: event().ble_id.toUpperCase(), icon: "laptop" });
    assert.equal(created.status, 201);
    await f.post("/api/items/" + created.data.id + "/lost", { description: "請協尋" });
    const read = await f.post("/api/events", event());
    assert.equal(read.data.item_id, created.data.id);
    const item = (await f.request("/api/items/" + created.data.id)).data;
    assert.equal(item.item_name, "我的手機");
    assert.equal(item.icon, "laptop");
    assert.equal(item.status, "lost");
    assert.equal(item.last_seen.item_name, event().item_name);
    assert.equal((await f.request("/api/items?lost=true")).data.length, 1);
    assert.equal(await f.count("items"), 1);
  });

  await suite.test("事件識別碼依閘門分開，拒絕空白識別碼，支援瀏覽器預檢", async t => {
    const f = await fixture(t);
    const send = body => f.request("/api/events", { method: "POST", body, headers: { "Idempotency-Key": "boot-c:1" } });
    assert.equal((await send(event())).status, 200);
    assert.equal((await send(event({ gate_id: "GATE_02" }))).status, 200);
    assert.equal(await f.count("reading_requests"), 2);
    const invalid = await f.request("/api/events", { method: "POST", body: event(), headers: { "Idempotency-Key": " " } });
    assert.equal(invalid.status, 400);
    const options = await f.request("/api/events", { method: "OPTIONS", headers: { Origin: "http://localhost:5500" } });
    assert.equal(options.status, 204);
    assert.match(options.headers.get("access-control-allow-headers"), /Idempotency-Key/);
  });

  await suite.test("五張主表關聯與閘門更新不改變過去事件的位置快照", async t => {
    const f = await fixture(t);
    await register(f);
    await f.post("/api/events", event()); f.advance(4000);
    await f.post("/api/events", event({ location: "新部署地點" }));
    assert.equal(await f.count("items"), 1); assert.equal(await f.count("tag"), 1);
    assert.equal(await f.count("gates"), 1); assert.equal(await f.count("gates_event"), 2);
    assert.equal((await f.pool.query("SELECT location FROM gates")).rows[0].location, "新部署地點");
    assert.deepEqual((await f.pool.query("SELECT location FROM gates_event ORDER BY id")).rows.map(r=>r.location), [event().location,"新部署地點"]);
    const joined = await f.pool.query("SELECT i.item_name FROM gates_event e JOIN tag t ON t.ble_id=e.ble_id JOIN items i ON i.id=t.item_id JOIN gates g ON g.gate_id=e.gate_id");
    assert.equal(joined.rowCount, 2);
    await assert.rejects(f.pool.query("INSERT INTO tag(ble_id,item_id) VALUES('02:00:00:00:ff:02','missing-item')"), e=>e.code==='23503');
    const tableNames = (await f.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'")).rows.map(r=>r.table_name).sort();
    assert.deepEqual(tableNames, ["gates","gates_event","items","lost_reports","reading_requests","tag"]);
  });
  await suite.test("種子資料跨 items 與 tag 寫入，可重複執行", async t => {
    const f = await fixture(t);
    const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util"); const { fileURLToPath } = await import("node:url");
    for (let i=0;i<2;i++) await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../src/db/seed.js",import.meta.url))], {env:{...process.env,DATABASE_URL:f.databaseUrl},timeout:20000});
    assert.equal(await f.count("items"), 4); assert.equal(await f.count("tag"), 4);
    assert.equal(await f.count("gates_event"), 0); assert.equal(await f.count("gates"), 0);
    assert.equal((await f.request("/api/items")).data.length, 4);
    const removed = await f.request("/api/items/item-001", { method: "DELETE" });
    assert.equal(removed.status, 200);
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../src/db/seed.js",import.meta.url))], {env:{...process.env,DATABASE_URL:f.databaseUrl},timeout:20000});
    assert.equal(await f.count("items"), 4); assert.equal(await f.count("tag"), 4);
    assert.equal((await f.request("/api/items")).data.length, 3);
    assert.equal((await f.request("/api/items/item-001")).status, 404);
    assert.equal((await f.pool.query("SELECT deleted_at FROM items WHERE id='item-001'")).rows[0].deleted_at.toISOString(), removed.data.deleted_at);
  });

  await suite.test("找回未通報的物品為冪等操作，未知物品與無效 JSON 不改動資料", async t => {
    const f = await fixture(t);
    const created = await f.post("/api/items", { item_name: "尚未遺失的物品", ble_id: event().ble_id });
    const id = created.data.id;
    const first = await f.post(`/api/items/${id}/found`, {});
    assert.equal(first.status, 200);
    assert.deepEqual(first.data, { item_id: id, resolved_at: null, already_found: true });
    f.advance(60000);
    assert.deepEqual((await f.post(`/api/items/${id}/found`, {})).data, first.data);
    assert.equal((await f.post("/api/items/missing-item/found", {})).status, 404);
    for (const body of [null, []]) assert.equal((await f.post(`/api/items/${id}/found`, body)).status, 400);
    assert.equal((await f.request(`/api/items/${id}/found`, { method: "POST", raw: "{" })).status, 400);
    assert.equal((await f.request(`/api/items/${id}`)).data.status, "normal");
    assert.equal(await f.count("items"), 1);
    assert.equal(await f.count("lost_reports"), 0);
  });

  await suite.test("找回 A 只軟刪除 A 的通報，B 的遺失狀態與所有物品事件都保留", async t => {
    const f = await fixture(t);
    const a = await registerAndRead(f);
    const b = await registerAndRead(f, { ble_id: "02:00:00:00:fa:02", item_name: "另一件物品" });
    const reportA = (await f.post(`/api/items/${a}/lost`, { description: "第一份通報" })).data;
    const reportB = (await f.post(`/api/items/${b}/lost`, { description: "第二份通報" })).data;
    const before = {};
    for (const table of ["items", "tag", "gates", "gates_event", "lost_reports"]) before[table] = await f.count(table);
    f.advance(5000);
    const found = await f.post(`/api/items/${a}/found`, {});
    assert.equal(found.status, 200);
    assert.deepEqual(found.data, { item_id: a, resolved_at: f.now().toISOString(), already_found: false });
    const rows = (await f.pool.query("SELECT id,item_id,description,reported_at,deleted_at FROM lost_reports ORDER BY item_id")).rows;
    const closed = rows.find(row => row.item_id === a);
    const active = rows.find(row => row.item_id === b);
    assert.equal(closed.id, reportA.id);
    assert.equal(closed.description, reportA.description);
    assert.equal(closed.reported_at.toISOString(), reportA.reported_at);
    assert.equal(closed.deleted_at.toISOString(), found.data.resolved_at);
    assert.equal(active.id, reportB.id);
    assert.equal(active.description, reportB.description);
    assert.equal(active.deleted_at, null);
    for (const [table, count] of Object.entries(before)) assert.equal(await f.count(table), count, `${table} 不應實體刪除資料`);
    assert.equal((await f.request(`/api/items/${a}`)).data.status, "normal");
    assert.equal((await f.request(`/api/items/${b}`)).data.status, "lost");
    assert.deepEqual((await f.request("/api/items?lost=false")).data.map(item => item.id), [a]);
    assert.deepEqual((await f.request("/api/items?lost=true")).data.map(item => item.id), [b]);
    assert.equal((await f.request("/api/items")).data.length, 2);
  });

  await suite.test("重複找回維持原時間，重新遺失建立新通報並保留舊紀錄", async t => {
    const f = await fixture(t);
    const id = await registerAndRead(f);
    const firstReport = (await f.post(`/api/items/${id}/lost`, { description: "第一次遺失" })).data;
    f.advance(1000);
    const firstFound = (await f.post(`/api/items/${id}/found`, {})).data;
    f.advance(60000);
    const repeated = (await f.post(`/api/items/${id}/found`, {})).data;
    assert.equal(repeated.already_found, true);
    assert.equal(repeated.resolved_at, firstFound.resolved_at);
    await f.restart();
    assert.equal((await f.post(`/api/items/${id}/found`, {})).data.resolved_at, firstFound.resolved_at);
    const secondReport = await f.post(`/api/items/${id}/lost`, { description: "第二次遺失" });
    assert.equal(secondReport.status, 201);
    assert.equal(secondReport.data.already_reported, false);
    assert.notEqual(secondReport.data.id, firstReport.id);
    assert.equal(secondReport.data.reported_at, f.now().toISOString());
    assert.equal((await f.request(`/api/items/${id}`)).data.status, "lost");
    assert.equal((await f.request("/api/items?lost=true")).data.length, 1);
    assert.equal((await f.request("/api/items?lost=false")).data.length, 0);
    const rows = (await f.pool.query("SELECT id,description,deleted_at FROM lost_reports WHERE item_id=$1", [id])).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.id === firstReport.id).deleted_at.toISOString(), firstFound.resolved_at);
    assert.equal(rows.find(row => row.id === secondReport.data.id).deleted_at, null);
    f.advance(1000);
    const secondFound = (await f.post(`/api/items/${id}/found`, {})).data;
    assert.equal(secondFound.already_found, false);
    assert.notEqual(secondFound.resolved_at, firstFound.resolved_at);
    f.advance(60000);
    const lastRetry = (await f.post(`/api/items/${id}/found`, {})).data;
    assert.equal(lastRetry.already_found, true);
    assert.equal(lastRetry.resolved_at, secondFound.resolved_at);
    assert.equal(await f.count("lost_reports"), 2);
    assert.equal((await f.request("/api/items")).data.length, 1);
  });

  await suite.test("同一物品並行找回只結束一次，後續重送不更新時間", async t => {
    const f = await fixture(t);
    const id = await registerAndRead(f);
    const report = (await f.post(`/api/items/${id}/lost`, {})).data;
    f.advance(3000);
    const results = await Promise.all(Array.from({ length: 20 }, () => f.post(`/api/items/${id}/found`, {})));
    assert.ok(results.every(result => result.status === 200));
    assert.equal(results.filter(result => result.data.already_found === false).length, 1);
    assert.equal(results.filter(result => result.data.already_found === true).length, 19);
    assert.ok(results.every(result => result.data.resolved_at === f.now().toISOString()));
    const persisted = (await f.pool.query("SELECT id,deleted_at FROM lost_reports WHERE item_id=$1", [id])).rows;
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].id, report.id);
    assert.equal(persisted[0].deleted_at.toISOString(), f.now().toISOString());
    f.advance(10000);
    const retry = (await f.post(`/api/items/${id}/found`, {})).data;
    assert.equal(retry.already_found, true);
    assert.equal(retry.resolved_at, persisted[0].deleted_at.toISOString());
    assert.equal((await f.request(`/api/items/${id}`)).data.status, "normal");
  });

  await suite.test("並行遺失與找回依序完成，每筆歷史保留且最多一份有效通報", async t => {
    const f = await fixture(t);
    const id = await registerAndRead(f);
    const initial = (await f.post(`/api/items/${id}/lost`, { description: "原通報" })).data;
    f.advance(1000);
    const operations = Array.from({ length: 20 }, (_, index) => [
      { kind: "report", run: () => f.post(`/api/items/${id}/lost`, { description: `並行通報 ${index}` }) },
      { kind: "found", run: () => f.post(`/api/items/${id}/found`, {}) }
    ]).flat();
    const results = await Promise.all(operations.map(async operation => ({ kind: operation.kind, ...await operation.run() })));
    const reports = results.filter(result => result.kind === "report");
    const found = results.filter(result => result.kind === "found");
    assert.ok(reports.every(result => result.status === 200 || result.status === 201));
    assert.ok(found.every(result => result.status === 200));
    const rows = (await f.pool.query("SELECT id,deleted_at FROM lost_reports WHERE item_id=$1", [id])).rows;
    const active = rows.filter(row => row.deleted_at === null);
    assert.ok(active.length <= 1);
    assert.ok(rows.find(row => row.id === initial.id).deleted_at instanceof Date);
    assert.equal(rows.length, 1 + reports.filter(result => result.status === 201).length);
    assert.equal(rows.filter(row => row.deleted_at !== null).length, found.filter(result => !result.data.already_found).length);
    const returnedIds = new Set([initial.id, ...reports.map(result => result.data.id)]);
    assert.deepEqual(new Set(rows.map(row => row.id)), returnedIds);
    const item = (await f.request(`/api/items/${id}`)).data;
    assert.equal(item.status, active.length ? "lost" : "normal");
    assert.equal((await f.request("/api/items")).data.length, 1);
    assert.equal((await f.request("/api/items?lost=true")).data.length, active.length);
    assert.equal((await f.request("/api/items?lost=false")).data.length, active.length ? 0 : 1);
  });

  await suite.test("前端已找到後刪除物品，各清單與搜尋隱藏，保留其他物品及原資料", async t => {
    const f = await fixture(t);
    const id = await registerAndRead(f);
    const other = await register(f, { ble_id: "02:00:00:00:de:02", item_name: "保留的物品" });
    const { createItemService } = await import("../../frontend/public/js/services/item-service.js");
    const service = createItemService({ baseUrl: f.baseUrl });
    await service.reportLost({ item_id: id }); await service.markFound(id);
    const before = {};
    for (const table of ["items", "tag", "gates", "gates_event", "lost_reports"]) before[table] = await f.count(table);
    f.advance(1000);
    const result = await service.deleteItem(id);
    assert.deepEqual(result, { item_id: id, deleted_at: f.now().toISOString(), already_deleted: false });
    assert.equal(await service.getItem(id), null);
    assert.deepEqual((await service.listItems()).map(item => item.id), [other.id]);
    assert.deepEqual(await service.searchItems(event().ble_id), []);
    assert.deepEqual(await service.searchItems(event().item_name), []);
    assert.deepEqual((await f.request("/api/items?lost=true")).data, []);
    assert.deepEqual((await f.request("/api/items?lost=false")).data.map(item => item.id), [other.id]);
    for (const [table, count] of Object.entries(before)) assert.equal(await f.count(table), count, table);
    const row = (await f.pool.query("SELECT deleted_at FROM items WHERE id=$1", [id])).rows[0];
    assert.equal(row.deleted_at.toISOString(), result.deleted_at);
    const options = await f.request(`/api/items/${id}`, { method: "OPTIONS", headers: { Origin: "http://localhost:5500" } });
    assert.match(options.headers.get("access-control-allow-methods"), /DELETE/);
  });

  await suite.test("刪除結束有效通報，重啟與 BLE 新讀取、舊事件重送皆不恢復物品", async t => {
    const f = await fixture(t); const item = await register(f);
    const original = await f.request("/api/events", { method: "POST", body: event(), headers: { "Idempotency-Key": "delete:old" } });
    const report = (await f.post(`/api/items/${item.id}/lost`, { description: "刪除時結案" })).data;
    f.advance(1000);
    const deleted = await f.request(`/api/items/${item.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal((await f.pool.query("SELECT deleted_at FROM lost_reports WHERE id=$1", [report.id])).rows[0].deleted_at.toISOString(), deleted.data.deleted_at);
    f.advance(10000); await f.restart();
    const retry = await f.request(`/api/items/${item.id}`, { method: "DELETE" });
    assert.deepEqual(retry.data, { ...deleted.data, already_deleted: true });
    assert.equal((await f.request("/api/items/missing", { method: "DELETE" })).status, 404);
    assert.equal((await f.post(`/api/items/${item.id}/lost`, {})).status, 404);
    assert.equal((await f.post(`/api/items/${item.id}/found`, {})).status, 404);
    const next = await f.post("/api/events", event({ gate_id: "GATE_02", location: "刪除後位置" }));
    assert.equal(next.status, 200); assert.equal(next.data.item_id, null);
    const old = await f.request("/api/events", { method: "POST", body: event(), headers: { "Idempotency-Key": "delete:old" } });
    assert.equal(old.data.reason, "event_retry"); assert.equal(old.data.item_id, original.data.item_id);
    assert.deepEqual((await f.request("/api/items")).data, []);
    assert.equal((await f.request(`/api/items/${item.id}`)).status, 404);
    assert.equal(await f.count("items"), 1); assert.equal(await f.count("gates_event"), 2);
    assert.equal((await f.pool.query("SELECT item_id FROM tag WHERE ble_id=$1", [event().ble_id])).rows[0].item_id, item.id);
  });

  await suite.test("並行刪除冪等，同 MAC 明確重新登記恢復原 ID 與歷史但不重開舊通報", async t => {
    const f = await fixture(t); const id = await registerAndRead(f);
    const report = (await f.post(`/api/items/${id}/lost`, {})).data;
    f.advance(2000);
    const results = await Promise.all(Array.from({ length: 12 }, () => f.request(`/api/items/${id}`, { method: "DELETE" })));
    assert.ok(results.every(r => r.status === 200));
    assert.equal(results.filter(r => !r.data.already_deleted).length, 1);
    f.advance(5000);
    await f.post("/api/events", event({ location: "最新位置" }));
    const restored = await Promise.all(Array.from({ length: 12 }, () => f.post("/api/items", { item_name: "重新登記的錢包", ble_id: event().ble_id.toUpperCase() })));
    assert.equal(restored.filter(r => r.status === 201).length, 1);
    assert.equal(restored.filter(r => r.status === 409).length, 11);
    const active = restored.find(r => r.status === 201).data;
    assert.equal(active.id, id); assert.equal(active.status, "normal");
    assert.equal(active.item_name, "重新登記的錢包"); assert.equal(active.last_seen.location, "最新位置");
    assert.equal((await f.pool.query("SELECT deleted_at FROM items WHERE id=$1", [id])).rows[0].deleted_at, null);
    assert.ok((await f.pool.query("SELECT deleted_at FROM lost_reports WHERE id=$1", [report.id])).rows[0].deleted_at instanceof Date);
    assert.equal(await f.count("items"), 1); assert.equal(await f.count("tag"), 1);
    assert.equal((await f.request("/api/items?lost=true")).data.length, 0);
    const fresh = await f.post(`/api/items/${id}/lost`, {});
    assert.equal(fresh.status, 201); assert.notEqual(fresh.data.id, report.id);
  });

  await suite.test("舊物品表升級不刪資料，種子指令不恢復已刪除登記", async t => {
    const f = await fixture(t); const item = await register(f);
    await f.pool.query("ALTER TABLE items DROP COLUMN deleted_at");
    await migrate(f.pool); await migrate(f.pool);
    assert.equal((await f.request(`/api/items/${item.id}`)).status, 200);
    const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util"); const { fileURLToPath } = await import("node:url");
    const seed = () => promisify(execFile)(process.execPath, [fileURLToPath(new URL("../src/db/seed.js", import.meta.url))], { env: { ...process.env, DATABASE_URL: f.databaseUrl }, timeout: 20000 });
    await seed(); await f.request("/api/items/item-001", { method: "DELETE" });
    await seed(); await migrate(f.pool);
    assert.equal((await f.request("/api/items/item-001")).status, 404);
    assert.equal(await f.count("items"), 5);
    assert.equal((await f.request("/api/items")).data.length, 4);
  });

  await suite.test("舊 UNIQUE 通報升級保留 ID，找回後可重新通報且遷移可重複執行", async t => {
    const f = await fixture(t);
    const item = (await f.post("/api/items", { item_name: "舊版遺失物品", ble_id: event().ble_id })).data;
    const originalTime = new Date(f.now().getTime() - 60000).toISOString();
    // 只在本測試獨立 schema 內重建先前的 UNIQUE(item_id) 版本。
    await f.pool.query(`DROP TABLE lost_reports;
      CREATE TABLE lost_reports (
        id TEXT PRIMARY KEY,item_id TEXT NOT NULL UNIQUE REFERENCES items(id),
        description TEXT NOT NULL DEFAULT '',reported_at TIMESTAMPTZ NOT NULL
      )`);
    await f.pool.query("INSERT INTO lost_reports(id,item_id,description,reported_at) VALUES($1,$2,$3,$4)",
      ["legacy-found-report", item.id, "原有通報說明", originalTime]);
    await migrate(f.pool); await migrate(f.pool);
    const legacy = (await f.pool.query("SELECT * FROM lost_reports WHERE id='legacy-found-report'")).rows[0];
    assert.equal(legacy.item_id, item.id);
    assert.equal(legacy.description, "原有通報說明");
    assert.equal(legacy.reported_at.toISOString(), originalTime);
    assert.equal(legacy.deleted_at, null);
    assert.equal((await f.request(`/api/items/${item.id}`)).data.status, "lost");
    const found = (await f.post(`/api/items/${item.id}/found`, {})).data;
    assert.equal(found.already_found, false);
    const renewed = await f.post(`/api/items/${item.id}/lost`, { description: "升級後再次遺失" });
    assert.equal(renewed.status, 201);
    assert.notEqual(renewed.data.id, "legacy-found-report");
    await migrate(f.pool); await migrate(f.pool);
    const rows = (await f.pool.query("SELECT id,deleted_at FROM lost_reports WHERE item_id=$1", [item.id])).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.id === "legacy-found-report").deleted_at.toISOString(), found.resolved_at);
    assert.equal(rows.find(row => row.id === renewed.data.id).deleted_at, null);
    assert.equal((await f.request(`/api/items/${item.id}`)).data.status, "lost");
    assert.equal((await f.request("/api/items?lost=true")).data.length, 1);
    assert.equal(await f.count("items"), 1);
  });

  await suite.test("刪除正常物品只隱藏登記，重送與重新啟動不改變刪除時間", async t => {
    const f = await fixture(t);
    const a = await register(f, { item_name: "待移除的背包" });
    const b = await register(f, { item_name: "保留的雨傘", ble_id: "02:00:00:00:db:02", icon: "umbrella" });
    await f.post("/api/events", event());
    const before = {};
    for (const table of ["items", "tag", "gates", "gates_event", "lost_reports"]) before[table] = await f.count(table);
    f.advance(1000);
    const removed = await f.request(`/api/items/${a.id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.data, { item_id: a.id, deleted_at: f.now().toISOString(), already_deleted: false });
    assert.equal((await f.request(`/api/items/${a.id}`)).status, 404);
    assert.equal((await f.post(`/api/items/${a.id}/lost`, {})).status, 404);
    assert.equal((await f.post(`/api/items/${a.id}/found`, {})).status, 404);
    assert.deepEqual((await f.request("/api/items")).data.map(item => item.id), [b.id]);
    assert.deepEqual((await f.request("/api/items?lost=false")).data.map(item => item.id), [b.id]);
    assert.deepEqual((await f.request("/api/items?lost=true")).data, []);
    for (const query of [a.item_name, a.ble_id, a.ble_id.toUpperCase()]) {
      assert.deepEqual((await f.request("/api/items?q=" + encodeURIComponent(query))).data, []);
    }
    for (const [table, count] of Object.entries(before)) assert.equal(await f.count(table), count, `${table} 不應實體刪除資料`);
    const persisted = (await f.pool.query("SELECT id,deleted_at FROM items WHERE id=$1", [a.id])).rows[0];
    assert.equal(persisted.id, a.id); assert.equal(persisted.deleted_at.toISOString(), removed.data.deleted_at);
    assert.equal((await f.pool.query("SELECT item_id FROM tag WHERE ble_id=$1", [a.ble_id])).rows[0].item_id, a.id);
    f.advance(60000);
    const retry = await f.request(`/api/items/${a.id}`, { method: "DELETE" });
    assert.deepEqual(retry.data, { ...removed.data, already_deleted: true });
    assert.equal((await f.request("/api/items/missing-item", { method: "DELETE" })).status, 404);
    await f.restart();
    assert.equal((await f.request(`/api/items/${a.id}`)).status, 404);
    assert.deepEqual((await f.request(`/api/items/${a.id}`, { method: "DELETE" })).data, retry.data);
    assert.equal((await f.request(`/api/items/${b.id}`)).status, 200);
  });

  await suite.test("刪除已找回物品保留既有結案時間，不重新修改歷史通報", async t => {
    const f = await fixture(t);
    const id = await registerAndRead(f);
    const report = (await f.post(`/api/items/${id}/lost`, { description: "舊通報" })).data;
    f.advance(1000);
    const found = (await f.post(`/api/items/${id}/found`, {})).data;
    f.advance(1000);
    const removed = await f.request(`/api/items/${id}`, { method: "DELETE" });
    assert.equal(removed.status, 200); assert.equal(removed.data.already_deleted, false);
    assert.notEqual(removed.data.deleted_at, found.resolved_at);
    const saved = (await f.pool.query("SELECT id,description,reported_at,deleted_at FROM lost_reports WHERE item_id=$1", [id])).rows;
    assert.equal(saved.length, 1); assert.equal(saved[0].id, report.id);
    assert.equal(saved[0].description, report.description);
    assert.equal(saved[0].reported_at.toISOString(), report.reported_at);
    assert.equal(saved[0].deleted_at.toISOString(), found.resolved_at);
    assert.equal((await f.request(`/api/items/${id}`)).status, 404);
    assert.equal(await f.count("items"), 1); assert.equal(await f.count("tag"), 1); assert.equal(await f.count("gates_event"), 1);
  });

  await suite.test("刪除遺失的 A 一併結束有效通報，B 與 A 的歷史資料仍保留", async t => {
    const f = await fixture(t);
    const a = await registerAndRead(f);
    const b = await registerAndRead(f, { ble_id: "02:00:00:00:dc:02", item_name: "仍在協尋的物品" });
    const first = (await f.post(`/api/items/${a}/lost`, { description: "A 的舊通報" })).data;
    f.advance(1000);
    const resolved = (await f.post(`/api/items/${a}/found`, {})).data;
    const activeA = (await f.post(`/api/items/${a}/lost`, { description: "A 的有效通報" })).data;
    const activeB = (await f.post(`/api/items/${b}/lost`, { description: "B 的有效通報" })).data;
    f.advance(2000);
    const removed = await f.request(`/api/items/${a}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const rows = (await f.pool.query("SELECT id,item_id,deleted_at FROM lost_reports")).rows;
    assert.equal(rows.length, 3);
    assert.equal(rows.find(row => row.id === first.id).deleted_at.toISOString(), resolved.resolved_at);
    assert.equal(rows.find(row => row.id === activeA.id).deleted_at.toISOString(), removed.data.deleted_at);
    assert.equal(rows.find(row => row.id === activeB.id).deleted_at, null);
    assert.deepEqual((await f.request("/api/items?lost=true")).data.map(item => item.id), [b]);
    assert.deepEqual((await f.request("/api/items?lost=false")).data, []);
    assert.equal((await f.request(`/api/items/${a}`)).status, 404);
    assert.equal((await f.request(`/api/items/${b}`)).data.status, "lost");
    assert.equal(await f.count("items"), 2); assert.equal(await f.count("tag"), 2); assert.equal(await f.count("gates_event"), 2);
  });

  await suite.test("刪除接口支援編碼後的物品 ID 與 DELETE 瀏覽器預檢", async t => {
    const f = await fixture(t);
    const id = "item/中文 ?#";
    await f.pool.query("INSERT INTO items(id,item_name) VALUES($1,$2)", [id, "路徑測試物品"]);
    await f.pool.query("INSERT INTO tag(ble_id,item_id) VALUES($1,$2)", ["02:00:00:00:dd:01", id]);
    const path = "/api/items/" + encodeURIComponent(id);
    const options = await f.request(path, { method: "OPTIONS", headers: { Origin: "http://localhost:5500", "Access-Control-Request-Method": "DELETE" } });
    assert.equal(options.status, 204);
    assert.match(options.headers.get("access-control-allow-methods"), /\bDELETE\b/);
    const removed = await f.request(path, { method: "DELETE", headers: { Origin: "http://localhost:5500" } });
    assert.equal(removed.status, 200); assert.equal(removed.data.item_id, id);
    assert.equal(removed.headers.get("access-control-allow-origin"), "http://localhost:5500");
    assert.equal((await f.request(path)).status, 404);
    assert.equal((await f.request("/api/items/%E0%A4%A", { method: "DELETE" })).status, 400);
    assert.equal(await f.count("items"), 1);
  });

  await suite.test("刪除後新 BLE 事件不復活物品，舊事件重送仍可回原快照", async t => {
    const f = await fixture(t);
    const item = await register(f, { item_name: "不應自動復活的物品" });
    const originalBody = event();
    const first = await f.request("/api/events", { method: "POST", body: originalBody, headers: { "Idempotency-Key": "before-delete:1" } });
    assert.equal(first.data.item_id, item.id);
    f.advance(1000);
    const removed = (await f.request(`/api/items/${item.id}`, { method: "DELETE" })).data;
    f.advance(1000);
    const next = await f.post("/api/events", event({ gate_id: "GATE_02", location: "刪除後的位置", timestamp: 20000 }));
    assert.equal(next.status, 200); assert.equal(next.data.item_id, null);
    const retry = await f.request("/api/events", { method: "POST", body: originalBody, headers: { "Idempotency-Key": "before-delete:1" } });
    assert.equal(retry.status, 200); assert.equal(retry.data.item_id, item.id);
    assert.equal(retry.data.reason, "event_retry");
    assert.equal(retry.data.received_at, first.data.received_at);
    assert.deepEqual((await f.request("/api/items")).data, []);
    assert.equal((await f.request(`/api/items/${item.id}`)).status, 404);
    const saved = (await f.pool.query("SELECT id,deleted_at FROM items WHERE id=$1", [item.id])).rows[0];
    assert.equal(saved.deleted_at.toISOString(), removed.deleted_at);
    assert.equal((await f.pool.query("SELECT item_id FROM tag WHERE ble_id=$1", [item.ble_id])).rows[0].item_id, item.id);
    assert.equal(await f.count("items"), 1); assert.equal(await f.count("tag"), 1);
    assert.equal(await f.count("gates_event"), 2); assert.equal(await f.count("reading_requests"), 1);
  });

  await suite.test("同 MAC 明確重新登記恢復原 ID 與最新軌跡，不恢復舊遺失模式", async t => {
    const f = await fixture(t);
    const item = await register(f, { item_name: "原物品名稱", category: "原分類", icon: "backpack" });
    await f.post("/api/events", event());
    const oldReport = (await f.post(`/api/items/${item.id}/lost`, { description: "原通報" })).data;
    f.advance(1000);
    const removed = (await f.request(`/api/items/${item.id}`, { method: "DELETE" })).data;
    f.advance(1000);
    const latest = event({ gate_id: "GATE_02", location: "重新登記前的位置", timestamp: 21000 });
    assert.equal((await f.post("/api/events", latest)).data.item_id, null);
    const restored = await f.post("/api/items", { item_name: "重新登記的錢包", ble_id: item.ble_id.toUpperCase(), category: "個人物品", icon: "bottle" });
    assert.equal(restored.status, 201); assert.equal(restored.data.id, item.id);
    assert.equal(restored.data.item_name, "重新登記的錢包");
    assert.equal(restored.data.ble_id, item.ble_id); assert.equal(restored.data.category, "個人物品");
    assert.equal(restored.data.icon, "bottle"); assert.equal(restored.data.status, "normal");
    assert.deepEqual(restored.data.last_seen, { ...latest, received_at: f.now().toISOString() });
    assert.equal((await f.pool.query("SELECT deleted_at FROM items WHERE id=$1", [item.id])).rows[0].deleted_at, null);
    assert.deepEqual((await f.request("/api/items?lost=true")).data, []);
    assert.equal((await f.post("/api/items", { item_name: "不可覆蓋", ble_id: item.ble_id })).status, 409);
    assert.equal((await f.request(`/api/items/${item.id}`)).data.item_name, "重新登記的錢包");
    assert.equal(await f.count("items"), 1); assert.equal(await f.count("tag"), 1); assert.equal(await f.count("gates_event"), 2);
    const closed = (await f.pool.query("SELECT id,deleted_at FROM lost_reports WHERE item_id=$1", [item.id])).rows;
    assert.equal(closed.length, 1); assert.equal(closed[0].id, oldReport.id);
    assert.equal(closed[0].deleted_at.toISOString(), removed.deleted_at);
    const newReport = await f.post(`/api/items/${item.id}/lost`, { description: "重新登記後的通報" });
    assert.equal(newReport.status, 201); assert.notEqual(newReport.data.id, oldReport.id);
    assert.equal(await f.count("lost_reports"), 2);
  });

  await suite.test("並行刪除、遺失、找回及重新登記不產生重複物品或未關閉的隱藏通報", async t => {
    const f = await fixture(t);
    const id = await registerAndRead(f);
    const initial = (await f.post(`/api/items/${id}/lost`, { description: "原有效通報" })).data;
    f.advance(1000);
    const operations = Array.from({ length: 10 }, (_, index) => [
      { kind: "delete", run: () => f.request(`/api/items/${id}`, { method: "DELETE" }) },
      { kind: "report", run: () => f.post(`/api/items/${id}/lost`, { description: `並行通報 ${index}` }) },
      { kind: "found", run: () => f.post(`/api/items/${id}/found`, {}) },
      { kind: "restore", run: () => f.post("/api/items", { item_name: "並行重新登記", ble_id: event().ble_id.toUpperCase(), category: "測試", icon: "laptop" }) }
    ]).flat();
    const results = await Promise.all(operations.map(async operation => ({ kind: operation.kind, ...await operation.run() })));
    assert.ok(results.filter(result => result.kind === "delete").every(result => result.status === 200 && result.data.item_id === id));
    assert.ok(results.filter(result => result.kind === "report").every(result => [200,201,404].includes(result.status)));
    assert.ok(results.filter(result => result.kind === "found").every(result => [200,404].includes(result.status)));
    const restored = results.filter(result => result.kind === "restore");
    assert.ok(restored.every(result => [201,409].includes(result.status)));
    assert.ok(restored.filter(result => result.status === 201).every(result => result.data?.id === id));
    assert.equal(await f.count("items"), 1); assert.equal(await f.count("tag"), 1); assert.equal(await f.count("gates_event"), 1);
    assert.equal((await f.pool.query("SELECT item_id FROM tag")).rows[0].item_id, id);
    const item = (await f.pool.query("SELECT id,deleted_at FROM items WHERE id=$1", [id])).rows[0];
    const reports = (await f.pool.query("SELECT id,deleted_at FROM lost_reports WHERE item_id=$1", [id])).rows;
    const active = reports.filter(row => row.deleted_at === null);
    assert.ok(active.length <= 1);
    assert.ok(reports.find(row => row.id === initial.id).deleted_at instanceof Date);
    const successfulReports = results.filter(result => result.kind === "report" && [200,201].includes(result.status));
    assert.deepEqual(new Set(reports.map(row => row.id)), new Set([initial.id, ...successfulReports.map(result => result.data.id)]));
    const visible = (await f.request("/api/items")).data;
    const lost = (await f.request("/api/items?lost=true")).data;
    const normal = (await f.request("/api/items?lost=false")).data;
    if (item.deleted_at) {
      assert.equal(active.length, 0); assert.equal(visible.length, 0); assert.equal(lost.length, 0); assert.equal(normal.length, 0);
      assert.equal((await f.request(`/api/items/${id}`)).status, 404);
    } else {
      assert.equal(visible.length, 1); assert.equal(visible[0].id, id);
      assert.equal(visible[0].status, active.length ? "lost" : "normal");
      assert.equal(lost.length, active.length); assert.equal(normal.length, active.length ? 0 : 1);
      assert.equal((await f.request(`/api/items/${id}`)).status, 200);
    }
  });

});

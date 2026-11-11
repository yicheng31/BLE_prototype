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
  await suite.test("六欄位上傳、前端查詢、遺失回報與持久化", async t => {
    const f = await fixture(t);
    const sent = await f.post("/api/readings", event());
    assert.equal(sent.status, 200); assert.equal(sent.data.status, "SUCCESS");
    for (const key of Object.keys(event())) assert.equal(sent.data[key], event()[key]);
    assert.equal(sent.data.received_at, f.now().toISOString());
    const { createItemService } = await import("../../frontend/public/js/services/item-service.js");
    const service = createItemService({ baseUrl: "http://localhost:3000", fetchImpl: async (url, init) => {
      const parsed = new URL(url); const result = await f.request(parsed.pathname + parsed.search, { method: init.method, raw: init.body, headers: init.headers });
      return new Response(JSON.stringify(result.data), { status: result.status });
    } });
    const rows = await service.searchItems("54:F8");
    assert.equal(rows.length, 1); assert.deepEqual(rows[0].last_seen, { ...event(), received_at: f.now().toISOString() });
    assert.equal((await service.reportLost({ item_id: rows[0].id, description: "協尋" })).already_reported, false);
    assert.equal((await service.reportLost({ item_id: rows[0].id })).already_reported, true);
    await f.restart(); assert.equal((await service.getItem(rows[0].id)).status, "lost");
  });
  await suite.test("連讀、換閘門、換位置與重開機毫秒", async t => {
    const f = await fixture(t); const first = await f.post("/api/readings", event()); f.advance(2999);
    const next = await f.post("/api/readings", event({ rssi: -48, timestamp: 0 }));
    assert.equal(next.data.id, first.data.id); assert.equal(next.data.read_count, 2); assert.equal(next.data.rssi, -48);
    f.advance(100); await f.post("/api/readings", event({ gate_id: "GATE_02" }));
    f.advance(100); await f.post("/api/readings", event({ location: "教室" }));
    assert.equal(await f.count("gates_event"), 3); f.advance(3000);
    await f.post("/api/readings", event({ location: "教室", timestamp: 4294967295 }));
    assert.equal(await f.count("gates_event"), 4); assert.equal(await f.count("items"), 1);
  });
  await suite.test("並行與 MAC 大小寫不會重複登記", async t => {
    const f = await fixture(t);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => f.post("/api/readings", event({ timestamp: i, ble_id: i % 2 ? event().ble_id.toUpperCase() : event().ble_id }))));
    assert.ok(results.every(r => r.status === 200)); assert.equal(await f.count("items"), 1); assert.equal(await f.count("gates_event"), 1);
    assert.equal((await f.pool.query("SELECT read_count FROM gates_event")).rows[0].read_count, 20);
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
    assert.equal((await f.pool.query("SELECT to_regclass('readings') AS old_table")).rows[0].old_table, null);
  });

  await suite.test("同一事件並行重送只處理一次，去重狀態重啟後仍保留", async t => {
    const f = await fixture(t);
    const send = body => f.request("/api/events", { method: "POST", body, headers: { "Idempotency-Key": "boot-a:1" } });
    const results = await Promise.all(Array.from({ length: 20 }, () => send(event())));
    assert.ok(results.every(result => result.status === 200));
    assert.equal(results.filter(result => result.data.reason === "event_retry").length, 19);
    assert.equal(await f.count("items"), 1);
    assert.equal(await f.count("gates_event"), 1);
    assert.equal(await f.count("reading_requests"), 1);
    assert.equal((await f.pool.query("SELECT read_count FROM gates_event")).rows[0].read_count, 1);
    f.advance(10000); await f.restart();
    const retry = await send(event({ ble_id: event().ble_id.toUpperCase() }));
    assert.equal(retry.data.reason, "event_retry");
    assert.equal(retry.data.received_at, results[0].data.received_at);
    assert.equal(retry.data.read_count, 1);
    assert.equal((await send(event({ location: "不同內容" }))).status, 409);
    assert.equal(await f.count("gates_event"), 1);
  });

  await suite.test("晚到的舊事件重送不蓋掉新位置，回傳原始回應快照", async t => {
    const f = await fixture(t);
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

  await suite.test("DEMO 指令可完整模擬上報、去重、查詢與遺失回報", async t => {
    const f = await fixture(t);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { fileURLToPath } = await import("node:url");
    const result = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL("../../scripts/demo.mjs", import.meta.url)), f.baseUrl],
      { timeout: 20000, encoding: "utf8" });
    const data = JSON.parse(result.stdout);
    assert.equal(data.retry_reason, "event_retry");
    assert.equal(data.event.read_count, 1);
    assert.equal(data.item.item_name, "RADAR_DEMO");
    assert.equal(data.report.already_reported, false);
    assert.equal((await f.request("/api/items/" + data.event.item_id)).data.status, "lost");
  });
  await suite.test("五張主表關聯與閘門更新不改變過去事件的位置快照", async t => {
    const f = await fixture(t);
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
  });

});

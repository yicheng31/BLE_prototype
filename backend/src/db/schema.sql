-- 升級舊版合併資料表，不丟棄物品／事件／通報 ID。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='items' AND column_name='name') THEN
    ALTER TABLE items RENAME COLUMN name TO item_name;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='items' AND column_name='tag_uid') THEN
    ALTER TABLE items RENAME COLUMN tag_uid TO ble_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='readings' AND column_name='tag_uid') THEN
    ALTER TABLE readings RENAME COLUMN tag_uid TO ble_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='readings' AND column_name='reader_id') THEN
    ALTER TABLE readings RENAME COLUMN reader_id TO gate_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='reading_requests' AND column_name='reader_id') THEN
    ALTER TABLE reading_requests RENAME COLUMN reader_id TO gate_id;
  END IF;
  IF to_regclass('readings') IS NOT NULL AND to_regclass('gates_event') IS NULL THEN
    ALTER TABLE readings RENAME TO gates_event;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  item_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT 'backpack'
);
ALTER TABLE items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS tag (
  ble_id TEXT PRIMARY KEY CHECK (ble_id = lower(ble_id)),
  item_id TEXT UNIQUE REFERENCES items(id)
);
CREATE TABLE IF NOT EXISTS gates (
  gate_id TEXT PRIMARY KEY,
  location TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gates_event (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ble_id TEXT NOT NULL,
  gate_id TEXT NOT NULL,
  location TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  read_count INTEGER NOT NULL DEFAULT 1 CHECK (read_count > 0)
);
ALTER TABLE gates_event ADD COLUMN IF NOT EXISTS item_name TEXT;
ALTER TABLE gates_event ADD COLUMN IF NOT EXISTS rssi SMALLINT CHECK (rssi BETWEEN -127 AND 20);
ALTER TABLE gates_event ADD COLUMN IF NOT EXISTS timestamp BIGINT CHECK (timestamp BETWEEN 0 AND 4294967295);

-- 先把舊的物品／MAC 綁定搬進 tag，再移除重複欄位。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='items' AND column_name='ble_id') THEN
    INSERT INTO tag (ble_id,item_id) SELECT lower(ble_id),id FROM items
      ON CONFLICT (ble_id) DO UPDATE SET item_id=EXCLUDED.item_id;
    ALTER TABLE items DROP COLUMN ble_id;
  END IF;
END $$;
INSERT INTO tag (ble_id) SELECT DISTINCT lower(ble_id) FROM gates_event ON CONFLICT DO NOTHING;
UPDATE gates_event SET ble_id=lower(ble_id) WHERE ble_id<>lower(ble_id);
INSERT INTO gates (gate_id,location)
  SELECT DISTINCT ON (gate_id) gate_id,location FROM gates_event ORDER BY gate_id,last_seen_at DESC,id DESC
  ON CONFLICT DO NOTHING;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='gates_event'::regclass AND conname='gates_event_tag_fk') THEN
    ALTER TABLE gates_event ADD CONSTRAINT gates_event_tag_fk FOREIGN KEY (ble_id) REFERENCES tag(ble_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='gates_event'::regclass AND conname='gates_event_gate_fk') THEN
    ALTER TABLE gates_event ADD CONSTRAINT gates_event_gate_fk FOREIGN KEY (gate_id) REFERENCES gates(gate_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS gates_event_latest ON gates_event(ble_id,last_seen_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS lost_reports (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description)<=500),
  reported_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ
);
-- 保留已結案通報，同一物品再次遺失時可新增通報。
ALTER TABLE lost_reports ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE lost_reports DROP CONSTRAINT IF EXISTS lost_reports_item_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS lost_reports_active_item ON lost_reports(item_id) WHERE deleted_at IS NULL;
-- 輔助表（不屬於五張主表），保存事件重送的回應快照。
CREATE TABLE IF NOT EXISTS reading_requests (
  gate_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  reading_id INTEGER NOT NULL REFERENCES gates_event(id),
  response_json JSONB,
  PRIMARY KEY (gate_id,event_id)
);
ALTER TABLE reading_requests ADD COLUMN IF NOT EXISTS response_json JSONB;

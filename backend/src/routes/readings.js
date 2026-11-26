import { readJson, sendJson } from "../http/json.js";

export function readingRoutes(readings) {
  // 兩個路徑都接受上游韌體原樣送出的六欄位 JSON。
  return [
    ["POST", /^\/api\/(?:readings|events)$/, async ({ req, res }) => {
      const reading = await readings.record(await readJson(req), { event_id: req.headers["idempotency-key"] });
      sendJson(res, 200, { status: "SUCCESS", ...reading });
    }]
  ];
}

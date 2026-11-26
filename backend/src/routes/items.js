import { HttpError } from "../errors.js";
import { readJson, sendJson } from "../http/json.js";

export function itemRoutes(items) {
  return [
    ["GET", /^\/api\/items$/, async ({ res, url }) => {
      sendJson(res, 200, await items.list({ q: url.searchParams.get("q") || "", lost: url.searchParams.get("lost") ?? undefined }));
    }],
    ["POST", /^\/api\/items$/, async ({ req, res }) => {
      sendJson(res, 201, await items.create(await readJson(req)));
    }],
    ["GET", /^\/api\/items\/([^/]+)$/, async ({ res, params: [id] }) => {
      const item = await items.get(id);
      if (!item) throw new HttpError(404, "ITEM_NOT_FOUND", "找不到這件物品");
      sendJson(res, 200, item);
    }],
    ["DELETE", /^\/api\/items\/([^/]+)$/, async ({ res, params: [id] }) => {
      sendJson(res, 200, await items.remove(id));
    }],
    ["POST", /^\/api\/items\/([^/]+)\/lost$/, async ({ req, res, params: [id] }) => {
      const report = await items.report(id, await readJson(req));
      sendJson(res, report.already_reported ? 200 : 201, report);
    }],
    ["POST", /^\/api\/items\/([^/]+)\/found$/, async ({ req, res, params: [id] }) => {
      sendJson(res, 200, await items.found(id, await readJson(req)));
    }]
  ];
}

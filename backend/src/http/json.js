import { HttpError } from "../errors.js";
import { object } from "../validators/common.js";

const MAX_BODY_BYTES = 16384;

export function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

export function readJson(req) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers["content-type"] || "")) {
    req.resume();
    return Promise.reject(new HttpError(415, "JSON_REQUIRED", "請使用 Content-Type: application/json"));
  }
  return new Promise((resolve, reject) => {
    const chunks = []; let length = 0; let tooLarge = false;
    req.on("data", chunk => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        if (!tooLarge) reject(new HttpError(413, "BODY_TOO_LARGE", "JSON 超過 16KB"));
        tooLarge = true; chunks.length = 0;
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try { resolve(object(JSON.parse(Buffer.concat(chunks).toString("utf8")))); }
      catch (error) { reject(error instanceof HttpError ? error : new HttpError(400, "INVALID_JSON", "JSON 格式錯誤")); }
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new HttpError(400, "REQUEST_ABORTED", "請求已中斷")));
  });
}

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const files = [];
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) scan(filename);
    else if (/\.(?:mjs|js)$/.test(filename)) files.push(filename);
  }
}
for (const folder of ["frontend/public/js", "backend/src", "scripts", "backend/scripts", "frontend/tests", "backend/tests"]) {
  if (fs.existsSync(path.join(root, folder))) scan(path.join(root, folder));
}
for (const filename of files) {
  const checked = spawnSync(process.execPath, ["--check", filename], { encoding: "utf8" });
  if (checked.status !== 0) { console.error(checked.stderr); process.exit(1); }
  const source = fs.readFileSync(filename, "utf8");
  for (const [, specifier] of source.matchAll(/(?:import|export)\s+(?:[^;]*?\s+from\s+)?["'](\.[^"']+)["']/g)) {
    if (!fs.existsSync(path.resolve(path.dirname(filename), specifier))) throw new Error(`Missing module: ${specifier} in ${filename}`);
  }
}
const html = fs.readFileSync(path.join(root, "frontend/public/index.html"), "utf8");
for (const [, asset] of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(asset)) continue;
  if (!fs.existsSync(path.resolve(root, "frontend/public", asset.replace(/^\//, "")))) throw new Error(`Missing asset: ${asset}`);
}
if (!html.includes('type="module"')) throw new Error("Frontend entry must be an ES module");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const app = fs.readFileSync(path.join(root, "frontend/public/js/app.js"), "utf8");
for (const [, id] of app.matchAll(/\$\("([^"]+)"\)/g)) {
  if (!ids.has(id)) throw new Error(`Missing frontend element: #${id}`);
}
console.log(`程式檢查通過：${files.length} 個模組、靜態檔案、匯入路徑與畫面元素綁定。`);

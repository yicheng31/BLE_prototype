// 後端根網址不含 /api。區網頁面沿用目前主機名稱；其他部署可直接修改此常數。
const pageLocation = globalThis.location;
export const API_BASE_URL = pageLocation && ["http:", "https:"].includes(pageLocation.protocol)
  ? pageLocation.protocol + "//" + pageLocation.hostname + ":3000"
  : "http://localhost:3000";

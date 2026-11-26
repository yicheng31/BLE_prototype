import { element } from "./dom.js";

const iconPaths = {
  backpack: ["M17 13V9a7 7 0 0 1 14 0v4", "M12 13h24v29H12z", "M17 27h14v10H17z", "M12 21h24", "M30 21v5"],
  laptop: ["M10 8h28v24H10z", "M6 38h36l-4-6H10z", "M19 38h10"],
  bottle: ["M20 4h8v7h-8z", "M20 11v5l-5 7v17a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3V23l-5-7v-5", "M15 28h18", "M20 34h8"],
  umbrella: ["M6 23a18 18 0 0 1 36 0H6Z", "M24 23v14a5 5 0 0 0 10 0", "M24 5v-2", "M15 23c0-10 4-18 9-18s9 8 9 18"]
};

export const utilityPaths = {
  pin: ["M19 10c0 5-7 10-7 10S5 15 5 10a7 7 0 1 1 14 0Z", "M14.5 10a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z"],
  clock: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M12 7v5l3 2"],
  flag: ["M6 21V3m0 1h12l-3 4 3 4H6"],
  check: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "m8 12 3 3 5-6"]
};

export function svg(paths, viewBox = "0 0 24 24") {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({ viewBox, fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) node.setAttribute(name, value);
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d); node.append(path);
  }
  return node;
}

export function itemIcon(item) {
  const kind = Object.hasOwn(iconPaths, item.icon) ? item.icon : "backpack";
  const wrapper = element("span", `item-icon ${kind}`);
  wrapper.append(svg(iconPaths[kind], "0 0 48 48"));
  return wrapper;
}

export function statusBadge(item) {
  return element("span", `item-status${item.status === "lost" ? " lost" : ""}`, item.status === "lost" ? "遺失中" : "一般");
}

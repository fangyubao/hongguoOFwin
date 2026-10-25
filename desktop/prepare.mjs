// 打包前把 ../server 同步到 desktop/server（单份源码，构建时复制）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.join(here, "..", "server");
const to = path.join(here, "server");

const SKIP = new Set(["node_modules", ".cache", "data", ".device.json"]);
const SKIP_EXT = new Set([".bak", ".log"]);

function copyDir(src, dst, depth = 0) {
  if (depth > 6) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d, depth + 1);
    else if (!SKIP_EXT.has(path.extname(entry.name))) fs.copyFileSync(s, d);
  }
}

fs.rmSync(to, { recursive: true, force: true });
copyDir(from, to);

const license = path.join(here, "..", "LICENSE");
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(here, "LICENSE"));

let files = 0;
let bytes = 0;
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else {
      files += 1;
      bytes += fs.statSync(p).size;
    }
  }
})(to);

console.log(`[prepare] 已同步 server → desktop/server：${files} 个文件，${(bytes / 1024 / 1024).toFixed(2)} MB`);

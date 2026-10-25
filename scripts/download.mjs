// 把红果短剧的剧集下载成本地 MP4 文件。
// 用法：
//   node scripts/download.mjs <剧集ID>            下载全部集
//   node scripts/download.mjs <剧集ID> 1 3        只下载第 1 到第 3 集
// 输出目录：F:\hongguoTV\downloads\<剧名>\第01集.mp4

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 本机代理变量会让上游请求降级成明文，先清掉
for (const key of [
  "http_proxy",
  "https_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "all_proxy",
])
  delete process.env[key];

const { provider } = await import("../server/provider.mjs");

const CHUNK = 1024 * 1024;
const ROOT = path.resolve(fileURLToPath(new URL("../downloads", import.meta.url)));

const seriesId = process.argv[2];
const from = Number(process.argv[3] || 1);
const toArg = Number(process.argv[4] || 0);

if (!/^\d{1,30}$/.test(seriesId || "")) {
  console.error("用法: node scripts/download.mjs <剧集ID> [起始集] [结束集]");
  console.error("例:   node scripts/download.mjs 7694653385668037657 1 3");
  process.exit(1);
}

const safeName = (value) => value.replace(/[\\/:*?"<>|\r\n]/g, "_").slice(0, 80);

async function downloadEpisode(ep, index, dir) {
  const file = path.join(dir, `第${String(index).padStart(2, "0")}集.mp4`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    console.log(`  第${index}集 已存在，跳过`);
    return "skip";
  }
  const stream = await provider.stream(ep.id);
  const total = stream.total;
  const fd = fs.openSync(file, "w");
  let written = 0;
  try {
    for (let offset = 0; offset < total; offset += CHUNK) {
      const buf = await stream.chunk(offset, Math.min(offset + CHUNK - 1, total - 1));
      fs.writeSync(fd, buf);
      written += buf.length;
      const pct = Math.floor((written / total) * 100);
      process.stdout.write(`\r  第${index}集 ${pct}%  ${(written / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB`);
    }
  } catch (error) {
    fs.closeSync(fd);
    try { fs.unlinkSync(file); } catch {}
    throw error;
  }
  fs.closeSync(fd);
  process.stdout.write(`\r  第${index}集 完成  ${(total / 1048576).toFixed(1)} MB\n`);
  return "ok";
}

const detail = await provider.detail(seriesId);
const title = safeName(detail.title || seriesId);
const dir = path.join(ROOT, title);
fs.mkdirSync(dir, { recursive: true });

const totalEpisodes = detail.episodes.length;
const to = toArg > 0 ? Math.min(toArg, totalEpisodes) : totalEpisodes;
console.log(`《${detail.title}》 共 ${totalEpisodes} 集，准备下载第 ${from}–${to} 集`);
console.log(`保存到: ${dir}\n`);

let ok = 0, skip = 0, fail = 0;
for (let i = from; i <= to; i += 1) {
  const ep = detail.episodes[i - 1];
  if (!ep) break;
  let attempt = 0;
  while (attempt < 3) {
    try {
      const result = await downloadEpisode(ep, i, dir);
      result === "ok" ? (ok += 1) : (skip += 1);
      break;
    } catch (error) {
      attempt += 1;
      if (attempt >= 3) {
        fail += 1;
        console.log(`  第${i}集 失败: ${error.message}`);
      } else {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  if (i < to) await new Promise((r) => setTimeout(r, 800));
}

console.log(`\n完成: 成功 ${ok} 集，跳过 ${skip} 集，失败 ${fail} 集`);
console.log(`文件位置: ${dir}`);

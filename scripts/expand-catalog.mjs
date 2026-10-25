// 扩库脚本：用官网检索接口按关键词 × 翻页 把剧集并进本地索引。
//
// 背景：官网分类页只暴露 800 部，但它的检索服务能按词返回约 210 条/词，
// 且不同词返回的剧差异很大。用一批标签词 + 常用剧名词扫一遍，
// 就能把本地索引从 800 部扩到几千部，搜索/分类立刻「全」很多。
//
// 用法：
//   node scripts/expand-catalog.mjs                # 默认每词翻 12 页
//   node scripts/expand-catalog.mjs --pages=6 --concurrency=2
//   node scripts/expand-catalog.mjs --words=总裁,重生 --pages=22
//
// 结果写回 HONGGUO_DATA_DIR 指向的 catalog.json（默认 <项目>/data）。
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const dataDir = process.env.HONGGUO_DATA_DIR || path.join(root, "data");
process.env.HONGGUO_DATA_DIR = dataDir;

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  })
);
const MAX_PAGES = Number(args.get("pages") || 12);
const CONCURRENCY = Math.max(1, Math.min(4, Number(args.get("concurrency") || 2)));
const PAGE_DELAY = Number(args.get("delay") || 150);

const { createCatalog } = await import("file://" + path.join(root, "server", "catalog.mjs").replace(/\\/g, "/"));
const { siteSearch } = await import("file://" + path.join(root, "server", "site-search.mjs").replace(/\\/g, "/"));

const catalog = createCatalog();
catalog.init();
const before = catalog.total;
console.log(`[扩库] 起始索引 ${before} 部，每词最多 ${MAX_PAGES} 页，并发 ${CONCURRENCY}`);

// 词表：现有标签 + 常用剧名关键词（覆盖面优先，不追求精确）
const tagWords = catalog.categories(1, 200).map((c) => c.name);
const extra = [
  "总裁", "夫人", "战神", "千金", "赘婿", "神医", "龙王", "殿主", "阁主", "城主",
  "闪婚", "离婚", "复婚", "退婚", "悔婚", "替嫁", "重生", "穿越", "系统", "无敌",
  "最强", "至尊", "弃女", "豪门", "契约", "宠妻", "甜妻", "娇妻", "哑妻", "前妻",
  "萌宝", "天才", "宝贝", "奶爸", "宝妈", "复仇", "逆袭", "打脸", "扮猪", "隐藏",
  "首富", "暴富", "大佬", "少爷", "少帅", "军长", "督军", "皇后", "王妃", "嫡女",
  "庶女", "神医", "毒医", "剑仙", "武帝", "丹帝", "修仙", "凡尘", "都市", "校园",
  "甜宠", "虐恋", "年代", "古装", "玄幻", "悬疑", "亲情", "婆媳", "职场", "商战",
  "顾总", "厉总", "傅总", "陆总", "霍总", "沈总", "薄总", "慕总", "司少", "叶少",
  "韩娱", "东北", "赘婿逆袭", "全能", "顶级", "绝世", "传奇", "大结局", "第一季", "第二季",
];
const words = Array.from(new Set([...tagWords, ...extra])).filter((w) => w && w.length >= 2);
if (args.has("words")) {
  words.length = 0;
  words.push(...String(args.get("words")).split(",").map((s) => s.trim()).filter(Boolean));
}
console.log(`[扩库] 关键词 ${words.length} 个`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let doneWords = 0;
let requests = 0;
const started = Date.now();

async function harvest(word) {
  let pages = MAX_PAGES;
  for (let page = 1; page <= pages; page += 1) {
    let r;
    try {
      r = await siteSearch(word, page, { timeout: 15000, retries: 2 });
      requests += 1;
    } catch {
      await sleep(600);
      continue;
    }
    if (!r.items.length) break;
    catalog.upsert(r.items);
    // 上游 totalPages 只给前几页有效，翻到空页就停
    if (r.items.length < 10) break;
    await sleep(PAGE_DELAY + Math.floor(Math.random() * 120));
  }
  doneWords += 1;
  const pct = ((doneWords / words.length) * 100).toFixed(0);
  process.stdout.write(
    `\r[扩库] ${pct}%  ${doneWords}/${words.length} 词  索引 ${catalog.total} 部（+${catalog.total - before}）  ${requests} 次请求  `
  );
}

let cursor = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < words.length) {
      const word = words[cursor];
      cursor += 1;
      try {
        await harvest(word);
      } catch (e) {
        process.stdout.write(`\n  词「${word}」失败: ${e.message}\n`);
      }
    }
  })
);

console.log(`\n[扩库] 完成：${before} → ${catalog.total} 部（新增 ${catalog.total - before}），耗时 ${((Date.now() - started) / 60000).toFixed(1)} 分钟`);

// catalog.upsert 内部是 5 秒防抖落盘，这里等它写完
await sleep(6500);
const file = path.join(dataDir, "catalog.json");
const saved = JSON.parse(fs.readFileSync(file, "utf8"));
console.log(`[扩库] 已落盘 ${file}：${saved.items.length} 部，${(fs.statSync(file).size / 1024 / 1024).toFixed(2)} MB`);

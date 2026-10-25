import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import axios from "axios";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCatalog } from "./catalog.mjs";
import { siteSearch } from "./site-search.mjs";
import { createHashCompat } from "./sm3.mjs";

// Electron 内嵌的是 BoringSSL，不含 SM3 摘要，而 x-gorgon / x-medusa 签名都依赖它，
// 表现为打包版播放报 "Digest method not supported"。这里把 createHash 包一层：
// 'sm3' 走自研的纯 JS 实现，其余摘要（md5 / sha512）继续用原生实现。
// 优先用原生 SM3；Electron 的 BoringSSL 没有该摘要时自动落回纯 JS 实现。
// HONGGUO_FORCE_SM3JS=1 可强制走纯 JS，便于在带 sm3 的 Node 上校验签名结果一致。
const forceSm3Js = process.env.HONGGUO_FORCE_SM3JS === "1";
const cryptoCompat = {
  ...crypto,
  createHash: (name) => createHashCompat(crypto, name, forceSm3Js),
};

// 平台按设备标识做风控：项目内置的固定设备号已被拒绝（播放接口返回 110001），
// 因此首次运行时生成一组随机标识并持久化，保持本机稳定、不再复用被标记的号。
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.HONGGUO_DATA_DIR || path.join(moduleDir, "..", "data");
try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch {
  /* 只读目录下忽略 */
}
const identityFile = path.join(dataDir, ".device.json");
const randomId = () =>
  "19" + Array.from({ length: 17 }, () => Math.floor(Math.random() * 10)).join("");
function loadIdentity() {
  try {
    const saved = JSON.parse(fs.readFileSync(identityFile, "utf8"));
    if (/^\d{10,20}$/.test(saved.iid) && /^\d{10,20}$/.test(saved.device_id))
      return saved;
  } catch {
    /* 首次运行或文件损坏，重新生成 */
  }
  const value = { iid: randomId(), device_id: randomId() };
  try {
    fs.writeFileSync(identityFile, JSON.stringify(value));
  } catch {
    /* 只读目录下退化为本次进程内随机 */
  }
  return value;
}
const identity = loadIdentity();

// Trusted, pinned GPL source. This is a compatibility wrapper, not a sandbox for user scripts.
const source = fs
  .readFileSync(new URL("./vendor/hongguo.cjs", import.meta.url), "utf8")
  .replace("1905892595382586", identity.iid)
  .replace("1905892595378490", identity.device_id);
const context = vm.createContext({
  require: (name) => {
    if (name === "node:crypto" || name === "crypto") return cryptoCompat;
    throw new Error("Unsupported module");
  },
  Buffer,
  URL,
  URLSearchParams,
  axios: axios.create({
    maxContentLength: 16 * 1024 * 1024,
    maxBodyLength: 1024 * 1024,
  }),
});
vm.runInContext(
  source +
    "\nthis.api = {categoryPage, categoryData, itemToCard, appSearchPage, routerData, resolveStream, prepareHeader, remoteRange, decryptPartial, fetchVideoInfo, streamCache, videoInfoCache, pageCache, appSearchCache};",
  context,
  { timeout: 5000 }
);
const api = context.api;
const SITE = "https://hongguoduanju.com";

const catalog = createCatalog();

// App 搜索返回的封面是 HEIC 模板（浏览器无法解码），但图片哈希与网页版一致，
// 换成网页版同一张图的 JPEG 模板即可正常显示；已经是该模板的直接放行。
const COVER_CDN = "https://p6-novel.byteimg.com/novel-pic/";
function coverUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes("byteimg") && /~tplv-shrink:\d+:0\.image/.test(raw)) return raw;
  const hash = /\/novel-pic\/([0-9a-fA-F]+)/.exec(raw);
  if (!hash) return raw;
  return `${COVER_CDN}${hash[1]}~tplv-shrink:640:0.image`;
}

const card = (row) => ({
  id: String(row.url || row.id || ""),
  title: String(row.title || row.name || "").trim(),
  cover: coverUrl(row.cover || row.img),
  description: String(row.description || row.intro || row.content || "").slice(0, 300),
  badge: String(row.badge || row.desc || ""),
  tags: String(row.tags || row.tname || ""),
});

const cards = (rows) =>
  Array.from(rows)
    .filter((r) => /^\d+$/.test(String(r.url || r.id || "")) && (r.title || r.name))
    .map(card)
    .filter((c) => c.title);

/** 索引条目 → 列表卡片 */
const fromItem = (item) => ({
  id: item.id,
  title: item.title,
  cover: item.cover,
  description: item.intro || "",
  badge: item.episodeCount ? `全${item.episodeCount}集` : "",
  tags: (item.tags || []).slice(0, 3).join(" / "),
});

const pack = (slice, extra = {}) => ({
  items: slice.items.map(fromItem),
  page: slice.page,
  total: slice.total,
  hasMore: slice.hasMore,
  ...extra,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- 索引自动更新 ----------------
 * 两件事分开做：
 *  1) build()：抓官网分类页（约 800 部），只增不减，6 小时一轮；
 *  2) harvest()：用检索接口按关键词小批量扫几页，把分类页看不到的剧慢慢并进来。
 * 每天 4 轮、每轮十几个请求，对上游很轻，库会随时间自己长大，不用重装。
 */
const FRESH_MS = 6 * 60 * 60 * 1000;      // 超过 6 小时算过期
const REFRESH_CHECK_MS = 30 * 60 * 1000;  // 每 30 分钟检查一次要不要刷新

// 词表轮换使用：覆盖主要题材，避免每轮都扫同样的词
const HARVEST_WORDS = [
  "总裁", "重生", "闪婚", "复仇", "逆袭", "萌宝", "夫人", "战神", "千金", "赘婿",
  "神医", "龙王", "殿主", "离婚", "复婚", "退婚", "替嫁", "穿越", "系统", "无敌",
  "最强", "至尊", "弃女", "豪门", "契约", "宠妻", "甜妻", "娇妻", "前妻", "天才",
  "奶爸", "打脸", "首富", "大佬", "少爷", "少帅", "皇后", "王妃", "嫡女", "庶女",
  "修仙", "都市", "校园", "甜宠", "虐恋", "年代", "古装", "玄幻", "悬疑", "职场",
  "商战", "团宠", "神豪", "马甲", "读心", "空间", "医仙", "龙王殿", "全能", "无敌流",
];

const refreshState = { running: false, lastAt: 0, lastError: null, harvested: 0, rounds: 0 };
let harvestCursor = 0;
let refreshTimer = null;

/** 按关键词小批量扫检索接口，结果并入索引；返回本轮新增条数 */
async function harvest(words = 8, pages = 2) {
  let added = 0;
  for (let i = 0; i < words; i += 1) {
    const word = HARVEST_WORDS[harvestCursor % HARVEST_WORDS.length];
    harvestCursor = (harvestCursor + 1) % HARVEST_WORDS.length;
    for (let page = 1; page <= pages; page += 1) {
      let result;
      try {
        result = await siteSearch(word, page, { timeout: 12000 });
      } catch {
        break;
      }
      if (!result.items.length) break;
      try {
        added += catalog.upsert(result.items);
      } catch {}
      if (result.items.length < 10) break;
      await sleep(180);
    }
    await sleep(260);
  }
  return added;
}

async function refreshIndex({ force = false, words = 8, pages = 2 } = {}) {
  if (refreshState.running) return { skipped: "running" };

  // 别的路径（比如空库首次抓取）正在 build 时不要直接放弃：
  // 等它结束，然后照样把关键词扩库这一步补上。
  let builtElsewhere = false;
  if (catalog.state.building) {
    builtElsewhere = true;
    try {
      await catalog.state.building;
    } catch {}
  } else {
    const age = Date.now() - (Number(catalog.state.builtAt) || 0);
    if (!force && age < FRESH_MS) return { skipped: "fresh", age };
  }

  refreshState.running = true;
  try {
    const before = catalog.total;
    if (!builtElsewhere) await catalog.build();
    const added = await harvest(words, pages);
    refreshState.lastAt = Date.now();
    refreshState.lastError = null;
    refreshState.harvested = added;
    refreshState.rounds += 1;
    console.log(
      `[refresh] 索引更新完成：${before} → ${catalog.total} 部（本轮新增 ${catalog.total - before}，其中检索补充 ${added}）`
    );
    return { ok: true, total: catalog.total, added: catalog.total - before };
  } catch (error) {
    refreshState.lastError = String(error?.message || error);
    console.error("[refresh] 索引更新失败:", refreshState.lastError);
    return { ok: false, error: refreshState.lastError };
  } finally {
    refreshState.running = false;
  }
}

function startAutoRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    refreshIndex().catch(() => {});
  }, REFRESH_CHECK_MS);
  refreshTimer.unref?.();
  // 启动后让首页先出来，再在后台检查一次（过期才真正抓）
  const kick = setTimeout(() => refreshIndex().catch(() => {}), 5000);
  kick.unref?.();
}

export const provider = {
  catalog,

  /** 首页：直接翻本地索引，秒开且不受上游抖动影响 */
  async home(page = 1) {
    if (!catalog.ready) await catalog.build();
    const slice = catalog.page(page);
    return pack(slice, {
      ready: catalog.ready,
      indexing: !catalog.ready,
      builtAt: catalog.state.builtAt,
    });
  },

  /** 分类标签列表 */
  async categories() {
    if (!catalog.ready) await catalog.build();
    return { items: catalog.categories(), total: catalog.total };
  },

  /** 按标签浏览 */
  async category(tag, page = 1) {
    if (!catalog.ready) await catalog.build();
    return pack(catalog.byTag(tag, page), { tag });
  },

  /**
   * 搜索：官网搜索接口为主（全库、可分页），本地索引兜底。
   * localOnly 只查本地索引，前端先用它秒出结果，再异步换成官网结果。
   */
  async search(keyword, page = 1, { localOnly = false } = {}) {
    if (!catalog.ready) catalog.ensureFresh();
    const local = catalog.search(keyword, page);
    const localCards = local.items.map(fromItem);

    if (localOnly)
      return {
        items: localCards,
        page,
        total: local.total,
        hasMore: local.hasMore,
        source: "local",
        indexTotal: catalog.total,
      };

    let site = null;
    try {
      site = await siteSearch(keyword, page);
    } catch (error) {
      console.error("[search] 官网搜索失败:", error.message);
    }

    if (site && site.items.length) {
      // 搜到的剧并回本地索引：下次本地也能搜到，且详情/播放不用再联网
      try {
        catalog.upsert(site.items);
      } catch {}
      return {
        items: site.items.map(fromItem),
        page,
        total: site.total,
        hasMore: site.hasMore,
        source: "site",
        indexTotal: catalog.total,
      };
    }

    // 官网搜索不可用或没结果 → 回退本地索引
    return {
      items: localCards,
      page,
      total: local.total,
      hasMore: local.hasMore,
      source: "local",
      upstreamFailed: !site,
      indexTotal: catalog.total,
    };
  },

  /** 详情：索引里已有完整 vid_list 就直接用，否则回官网详情页取完整分集 */
  async detail(id) {
    const key = String(id || "");
    let item = catalog.byId(key);
    const incomplete =
      !item ||
      !item.vids?.length ||
      (item.episodeCount > 0 && item.vids.length < item.episodeCount);
    if (incomplete) {
      // 索引里没有、或只有搜索页给的前几集，回退到官网详情页
      const data = await api.routerData(`${SITE}/detail?series_id=${key}`);
      const series = data?.loaderData?.detail_page?.seriesDetail;
      if (!series || !Array.isArray(series.vid_list) || !series.vid_list.length) {
        if (!item?.vids?.length) throw new Error("剧集不存在或分集暂不可用");
      } else {
        item = {
          id: key,
          title: String(series.series_name || item?.title || "未命名"),
          cover: coverUrl(series.series_cover || item?.cover),
          intro: String(series.series_intro || item?.intro || ""),
          tags: Array.from(series.tags || item?.tags || [], String),
          episodeCount: Number(series.episode_cnt || series.vid_list.length),
          vids: Array.from(series.vid_list, String),
        };
        // 完整分集写回索引，下次不用再打官网
        try {
          catalog.upsert([item]);
        } catch {}
      }
    }
    const vids = (item.vids || []).filter((v) => /^\d+$/.test(v));
    if (!vids.length) throw new Error("该剧暂无可播放分集");
    return {
      id: item.id,
      title: item.title,
      cover: item.cover,
      description: item.intro || "",
      badges: [item.episodeCount ? `全${item.episodeCount}集` : "", item.payType ? "付费" : ""].filter(Boolean),
      tags: item.tags || [],
      episodes: vids.map((vid, index) => ({ id: vid, number: index + 1, title: `第 ${index + 1} 集` })),
    };
  },

  /** 清晰度列表：读取上游 video_model 的 quality rows */
  async qualities(id) {
    const vid = String(id || "");
    const { rows } = await api.fetchVideoInfo(vid);
    if (!rows.length) return { items: [{ key: "auto", label: "自动" }] };
    // 上游给的是宽度（1920/1280/960/854/640），换算成 16:9 的高度再归档
    const label = (value) => {
      const text = String(value || "");
      const width = Number((text.match(/\d{3,4}/) || [])[0] || 0);
      if (!width) return text || "自动";
      const height = Math.round((width * 9) / 16);
      if (height >= 2000) return "4K";
      if (height >= 1000) return "1080P";
      if (height >= 700) return "720P";
      if (height >= 500) return "540P";
      if (height >= 400) return "480P";
      return "360P";
    };
    const items = rows.map((row) => ({ key: row.key, label: label(row.quality || row.key) }));
    const rank = { "4K": 6, "1080P": 5, "720P": 4, "540P": 3, "480P": 2, "360P": 1 };
    items.sort((a, b) => (rank[b.label] || 0) - (rank[a.label] || 0));
    return { items: [{ key: "auto", label: "自动" }, ...items] };
  },

  /** 播放流：签名 + CENC 解密 + Range 代理 */
  async stream(id, { quality = "auto", fresh = false } = {}) {
    const key = String(id || "");
    if (fresh) {
      for (const q of [quality, "auto"]) api.streamCache.delete(`${key}|${q}`);
      api.videoInfoCache.delete(key);
    }
    let stream;
    try {
      stream = await api.resolveStream(key, quality);
    } catch (error) {
      if (quality === "auto") throw error;
      stream = await api.resolveStream(key, "auto");
    }
    const prepared = await api.prepareHeader(stream);
    return {
      total: prepared.total,
      quality: stream.quality,
      chunk: async (start, end) =>
        api.decryptPartial(
          (await api.remoteRange(stream, start, end)).data,
          start,
          stream.key,
          prepared
        ),
    };
  },

  /** 供健康检查/前端展示的索引状态 */
  status() {
    const builtAt = Number(catalog.state.builtAt) || 0;
    return {
      ready: catalog.ready,
      indexing: Boolean(catalog.state.building),
      total: catalog.total,
      builtAt,
      stale: Date.now() - builtAt > FRESH_MS,
      refresh: {
        running: refreshState.running,
        lastAt: refreshState.lastAt,
        rounds: refreshState.rounds,
        harvested: refreshState.harvested,
        lastError: refreshState.lastError,
        nextCheckInMs: REFRESH_CHECK_MS,
      },
      error: catalog.state.error,
      device: os.hostname(),
    };
  },

  /** 手动触发一次更新（前端「立即更新」用） */
  refresh: (options = {}) => refreshIndex({ force: true, ...options }),

  init: () => {
    const state = catalog.init();
    startAutoRefresh();
    return state;
  },
};

// Limit the pinned upstream's otherwise unbounded caches during long-lived home use.
setInterval(() => {
  for (const cache of [
    api.streamCache,
    api.videoInfoCache,
    api.pageCache,
    api.appSearchCache,
  ]) {
    for (const [key, value] of cache)
      if (Date.now() - value.time > 300000) cache.delete(key);
    while (cache.size > 100) cache.delete(cache.keys().next().value);
  }
}, 60000).unref();

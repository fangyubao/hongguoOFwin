import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 官网分类页每页 24 部、总计约 800 部（34 页），每张卡片都自带 tags 与完整 vid_list。
// 我们把整份目录抓下来落盘成索引，之后的「首页 / 分类 / 搜索 / 详情」全部读本地索引：
// 既不受上游筛选参数失效影响，也不会因为接口抖动导致列表空白。
const SITE = "https://hongguoduanju.com";
const PAGE_SIZE = 24;
const MAX_PAGES = 60;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FRESH_MS = 6 * 60 * 60 * 1000; // 索引超过 6 小时就在后台静默刷新

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir =
  process.env.HONGGUO_DATA_DIR || path.join(moduleDir, "..", "data");
const catalogFile = path.join(dataDir, "catalog.json");
const seedFile = path.join(moduleDir, "seed-catalog.json");

const COVER_CDN = "https://p6-novel.byteimg.com/novel-pic/";
function coverUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes("byteimg") && /~tplv-shrink:\d+:0\.image/.test(raw)) return raw;
  const hash = /\/novel-pic\/([0-9a-fA-F]+)/.exec(raw);
  if (!hash) return raw;
  return `${COVER_CDN}${hash[1]}~tplv-shrink:640:0.image`;
}

// 官网把 JSON 直接内联在 HTML 里，用括号配平切出 recommendList 数组（跳过字符串内的括号）。
function sliceJsonArray(text, startBracket) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startBracket; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(startBracket, i + 1);
    }
  }
  return null;
}

/**
 * 部分卡片的 series_id / vid 在 HTML 里是「未加引号的 19 位数字」，
 * JSON.parse 会按 double 解析导致末几位被舍入（ID 直接变成另一部剧），
 * 所以要在字符串之外把这些大整数补成字符串。注意只在字符串外部处理，
 * 否则会破坏封面 URL 里的十六进制哈希。
 */
function quoteBigInts(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < text.length && text[j] >= "0" && text[j] <= "9") j += 1;
      const digits = text.slice(i, j);
      out += digits.length >= 16 && out[out.length - 1] !== "." ? `"${digits}"` : digits;
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function parseRecommendList(html) {
  const marker = html.indexOf("recommendList");
  if (marker < 0) return [];
  const start = html.indexOf("[", marker);
  if (start < 0) return [];
  const raw = sliceJsonArray(html, start);
  if (!raw) return [];
  let rows;
  try {
    rows = JSON.parse(quoteBigInts(raw.replace(/\\u002F/g, "/")));
  } catch {
    return [];
  }
  return Array.isArray(rows) ? rows : [];
}

function normalize(row) {
  const id = String(row?.series_id || "").trim();
  if (!/^\d{6,30}$/.test(id)) return null;
  const title = String(row?.series_name || "").trim();
  if (!title) return null;
  const vids = Array.from(row?.vid_list || [], (v) => String(v || "").trim()).filter((v) =>
    /^\d{6,30}$/.test(v)
  );
  const tags = Array.from(
    new Set(
      Array.from(row?.tags || [], (t) => String(t || "").trim()).filter(Boolean)
    )
  ).slice(0, 12);
  const count = Number(row?.episode_cnt || row?.series_episode_info?.episode_cnt || vids.length || 0);
  return {
    id,
    title,
    cover: coverUrl(row?.series_cover),
    intro: String(row?.series_intro || "").replace(/\s+/g, " ").trim().slice(0, 300),
    tags,
    episodeCount: Number.isFinite(count) ? count : vids.length,
    vids,
    payType: Number(row?.pay_type || 0),
  };
}

async function fetchPage(page, { retries = 4 } = {}) {
  const url = `${SITE}/category?tab=1&page=${page}`;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(400 * attempt * attempt);
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, "accept-language": "zh-CN,zh;q=0.9" },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const rows = parseRecommendList(html);
      if (!rows.length) throw new Error("空列表");
      return rows;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("抓取失败");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createCatalog() {
  const state = {
    items: [],
    index: new Map(),
    tagCount: new Map(),
    builtAt: 0,
    ready: false,
    building: null,
    error: null,
    partial: false,
  };

  function rebuildIndex() {
    state.index = new Map(state.items.map((item) => [item.id, item]));
    state.tagCount = new Map();
    for (const item of state.items)
      for (const tag of item.tags)
        state.tagCount.set(tag, (state.tagCount.get(tag) || 0) + 1);
  }

  function readCatalog(file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(raw?.items) || !raw.items.length) return null;
      return raw;
    } catch {
      return null;
    }
  }

  let lastSavedAt = 0;
  let saveTimer = null;
  const SAVE_DEBOUNCE = 5000;
  const SAVE_MAX_WAIT = 20000;

  // 首次启动（或数据目录被清空）时用随包分发的种子索引兜底；
  // 老用户升级时本地索引可能还是旧的小库（比如 800 部），要把种子里的新条目并进来，
  // 否则「装了新版还是那么点内容」。本地条目优先（可能更新），种子只补缺。
  function loadFromDisk() {
    const local = readCatalog(catalogFile);
    const seed = readCatalog(seedFile);
    const raw = local || seed;
    if (!raw) return false;
    state.items = raw.items.filter((item) => item && item.id && item.title);
    if (local && seed) {
      const have = new Set(state.items.map((item) => item.id));
      let added = 0;
      for (const item of seed.items) {
        if (!item?.id || !item.title || have.has(item.id)) continue;
        state.items.push(item);
        have.add(item.id);
        added += 1;
      }
      if (added) {
        console.log(`[catalog] 种子索引补充 ${added} 部`);
        scheduleSave();
      }
    }
    state.builtAt = Math.max(Number(raw.builtAt || 0), Number(state.builtAt || 0));
    rebuildIndex();
    state.ready = true;
    return true;
  }

  function saveToDisk() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const payload = JSON.stringify({
        version: 2,
        builtAt: state.builtAt,
        total: state.items.length,
        items: state.items,
      });
      const temp = `${catalogFile}.tmp`;
      fs.writeFileSync(temp, payload);
      fs.renameSync(temp, catalogFile);
      lastSavedAt = Date.now();
    } catch (error) {
      console.error("[catalog] 索引写入失败:", error.code || error.message);
    }
  }

  // 全量抓取：先拿第 1 页让首页立刻可用，再顺序补完剩余页。
  // 关键约束：索引只增不减。旧索引里已有的条目，即使这轮没抓到（上游抖动/改版/限流）
  // 也会保留下来，避免一次失败的刷新把 800 部缩成 24 部，导致「昨天能搜到，今天搜不到」。
  async function build({ onFirstPage } = {}) {
    if (state.building) return state.building;
    state.building = (async () => {
      const previous = state.items.slice();
      const fresh = new Map(); // 本轮真正抓到的
      let failedStreak = 0;
      let complete = false;
      try {
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          let rows;
          try {
            rows = await fetchPage(page);
          } catch (error) {
            if (page === 1) throw error;
            failedStreak += 1;
            if (failedStreak >= 3) break; // 连续三页失败才放弃，中间偶发失败跳过继续
            continue;
          }
          failedStreak = 0;

          let added = 0;
          for (const row of rows) {
            const item = normalize(row);
            if (!item) continue;
            if (!fresh.has(item.id)) added += 1;
            fresh.set(item.id, item);
          }

          if (page === 1) {
            // 首页可用：只更新状态，不覆盖既有索引
            const partialList = mergeWithPrevious(fresh, previous);
            if (partialList.length) {
              state.items = partialList;
              state.builtAt = Date.now();
              state.ready = true;
              state.partial = true;
              rebuildIndex();
              onFirstPage?.(partialList);
            }
          }

          if (!rows.length) {
            complete = true;
            break;
          }
          if (!added) break; // 本页全是重复，视为到底
          if (rows.length < PAGE_SIZE) {
            complete = true;
            break;
          }
          await sleep(250 + Math.floor(Math.random() * 180));
        }

        if (!fresh.size) {
          if (!previous.length) throw new Error("目录为空");
          state.error = "本轮抓取没有拿到数据，继续使用本地索引";
          state.partial = true;
          return state.items;
        }

        state.items = mergeWithPrevious(fresh, previous);
        state.builtAt = Date.now();
        state.ready = true;
        state.partial = !complete;
        state.error = null;
        rebuildIndex();
        saveToDisk();
        console.log(
          `[catalog] 索引完成：${state.items.length} 部短剧（本轮抓到 ${fresh.size} 部${
            complete ? "" : "，未跑完，已与旧索引合并"
          }）`
        );
      } catch (error) {
        state.error = error.message;
        state.partial = true;
        if (!state.items.length) console.error("[catalog] 抓取失败:", error.message);
      } finally {
        state.building = null;
      }
      return state.items;
    })();
    return state.building;
  }

  /** 新抓到的排在前面，旧索引里独有的追加在后（只增不减） */
  function mergeWithPrevious(fresh, previous) {
    if (!previous.length) return Array.from(fresh.values());
    const merged = Array.from(fresh.values());
    for (const item of previous) if (!fresh.has(item.id)) merged.push(item);
    return merged;
  }

  function ensureFresh() {
    const stale = Date.now() - state.builtAt > FRESH_MS;
    if (!state.items.length || stale) build().catch(() => {});
  }

  function init() {
    const loaded = loadFromDisk();
    if (loaded) console.log(`[catalog] 读取本地索引：${state.items.length} 部短剧`);
    // 只有「一条数据都没有」时才在这里急着抓；日常的过期刷新型由 provider 的
    // 自动更新调度统一负责（它还会顺带做关键词扩库），避免两边抢着 build。
    if (!state.items.length) build().catch(() => {});
    return state;
  }

  function pageOf(list, page, size = PAGE_SIZE) {
    const start = (page - 1) * size;
    return {
      items: list.slice(start, start + size),
      page,
      total: list.length,
      hasMore: start + size < list.length,
    };
  }

  // 官网搜索命中的剧集并回索引：搜过的剧以后本地也能搜到、不用再联网。
  // 落盘用「防抖 + 节流」：纯防抖在持续 upsert（比如扩库）时计时器会被无限重置，
  // 结果一路只有内存中的数据，进程一退全部丢失。所以再加一条「最多憋 20 秒」。
  function scheduleSave() {
    clearTimeout(saveTimer);
    if (Date.now() - lastSavedAt >= SAVE_MAX_WAIT) {
      saveToDisk();
      return;
    }
    saveTimer = setTimeout(() => saveToDisk(), SAVE_DEBOUNCE);
    saveTimer.unref?.();
  }

  function upsert(list) {
    if (!Array.isArray(list) || !list.length) return 0;
    let added = 0;
    let changed = false;
    for (const item of list) {
      if (!item?.id || !item.title) continue;
      const known = state.index.get(item.id);
      if (known) {
        // 已有条目：分集更全就用新的补上（搜索结果只带前几集，详情页才是全的）
        if ((item.vids?.length || 0) > (known.vids?.length || 0)) {
          known.vids = item.vids;
          known.episodeCount = item.episodeCount || known.episodeCount;
          changed = true;
        }
        continue;
      }
      state.items.push(item);
      state.index.set(item.id, item);
      for (const tag of item.tags || [])
        state.tagCount.set(tag, (state.tagCount.get(tag) || 0) + 1);
      added += 1;
      changed = true;
    }
    if (changed) scheduleSave();
    return added;
  }

  return {
    state,
    init,
    build,
    upsert,
    ensureFresh,
    get ready() {
      return state.ready;
    },
    get total() {
      return state.items.length;
    },
    all: () => state.items,
    page: (page) => pageOf(state.items, page),
    /** 分类标签：按出现次数排序，过滤掉只有一个剧的小众标签 */
    categories(min = 4, limit = 80) {
      return Array.from(state.tagCount.entries())
        .filter(([, count]) => count >= min)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([name, count]) => ({ name, count }));
    },
    byTag(tag, page) {
      if (!tag || tag === "全部") return pageOf(state.items, page);
      const list = state.items.filter((item) => item.tags.includes(tag));
      return pageOf(list, page);
    },
    byId(id) {
      return state.index.get(String(id)) || null;
    },
    /** 本地索引搜索：标题权重最高，其次标签；多个关键词用空格分隔，需全部命中 */
    search(keyword, page) {
      const q = String(keyword || "").trim();
      if (!q) return pageOf([], page);
      const lower = q.toLowerCase();
      const tokens = lower.split(/\s+/).filter(Boolean);
      const scored = [];
      state.items.forEach((item, order) => {
        const title = item.title.toLowerCase();
        const tags = (item.tags || []).map((t) => t.toLowerCase());
        const intro = (item.intro || "").toLowerCase();
        if (tokens.length > 1 || tokens[0] !== lower) {
          const haystack = `${title} ${tags.join(" ")} ${intro}`;
          if (!tokens.every((token) => haystack.includes(token))) return;
        } else if (
          !title.includes(lower) &&
          !tags.some((t) => t.includes(lower)) &&
          !intro.includes(lower)
        ) {
          return;
        }
        let score = 0;
        if (title === lower) score = 1000;
        else if (title.startsWith(lower)) score = 600;
        else if (title.includes(lower)) score = 400;
        for (const tag of tags) {
          if (tag === lower) score = Math.max(score, 300);
          else if (tag.includes(lower)) score = Math.max(score, 200);
        }
        if (!score) score = 80;
        scored.push({ item, score, order });
      });
      scored.sort((a, b) => b.score - a.score || a.order - b.order);
      return pageOf(scored.map((entry) => entry.item), page);
    },
  };
}

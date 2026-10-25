// 官网搜索接口（浏览器 Search 页用的就是它）：
//   GET https://hongguoduanju.com/api/search/result?aid=8662&query=关键词[&page=N]
// 只要带 x-xs-from-web: 1 就能拿到数据，无需签名、无需 Cookie。
// 返回的每条 video_data 里直接带 vid_list（全部分集 ID），所以搜到的剧可以直接播。
const SITE = "https://hongguoduanju.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const COVER_CDN = "https://p6-novel.byteimg.com/novel-pic/";

function coverUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes("byteimg") && /~tplv-shrink:\d+:0\.image/.test(raw)) return raw;
  const hash = /\/novel-pic\/([0-9a-fA-F]+)/.exec(raw);
  if (!hash) return raw;
  return `${COVER_CDN}${hash[1]}~tplv-shrink:640:0.image`;
}

function normalize(row) {
  const vd = row?.video_data;
  if (!vd || typeof vd !== "object") return null;
  const id = String(vd.series_id || "").trim();
  if (!/^\d{6,30}$/.test(id)) return null;
  const title = String(vd.series_title || row.name || "").trim();
  if (!title) return null;

  const vids = Array.from(vd.vid_list || [], (v) => String(v || "").trim()).filter((v) =>
    /^\d{6,30}$/.test(v)
  );
  const tags = Array.from(
    new Set(
      Array.from(vd.category_list || vd.tags || [], (t) =>
        String(t?.name || t || "").trim()
      ).filter(Boolean)
    )
  ).slice(0, 12);
  const count = Number(vd.episode_cnt || vids.length || 0);

  // 搜索结果里的 vid_list 只有前几集（试看），不是完整分集。
  // 这种情况清空 vids，让详情页去官网取完整列表，避免点进去只有 5 集。
  const partial = vids.length > 0 && vids.length < count;

  return {
    id,
    title,
    cover: coverUrl(vd.series_cover),
    intro: String(vd.series_intro || "").replace(/\s+/g, " ").trim().slice(0, 300),
    tags,
    episodeCount: Number.isFinite(count) ? count : vids.length,
    vids: partial ? [] : vids,
    payType: Number(vd.pay_type || 0),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 上游检索服务偶发 502（实测每 4~6 页就冒一个），短时间内重复搜同一个词没必要再打一遍。
// 5 分钟内的成功结果直接复用，既省上游压力，也让用户立刻看到上次的结果而不是「暂时不可用」。
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX = 300;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { time: Date.now(), value });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

async function fetchPage(url, q, page, timeout) {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "application/json, text/plain, */*",
      "x-xs-from-web": "1",
      referer: `${SITE}/search?query=${encodeURIComponent(q)}`,
    },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const error = new Error(`官网搜索 HTTP ${res.status}`);
    error.status = res.status;
    // 4xx（429 除外）是确定性失败，重试没有意义
    error.fatal = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw error;
  }
  const data = await res.json();
  const rows = Array.isArray(data?.searchList) ? data.searchList : [];
  const items = rows.map(normalize).filter(Boolean);
  return {
    items,
    total: Number(data?.totalCount || 0) || items.length,
    hasMore: Boolean(data?.hasMore),
    page: Number(data?.pageNum || page),
  };
}

// 官网搜索偶尔抽风（实测同一关键词第 3 页回 502，隔一会儿又正常），
// 一旦失败就直接降级成本地索引会让用户以为「结果变少了」，所以先重试再降级。
export async function siteSearch(keyword, page = 1, { timeout = 12000, retries = 3 } = {}) {
  const q = String(keyword || "").trim();
  if (!q) return { items: [], total: 0, hasMore: false, page };

  const cacheKey = `${q.toLowerCase()}|${page}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  const url =
    `${SITE}/api/search/result?aid=8662&query=${encodeURIComponent(q)}` +
    (page > 1 ? `&page=${page}` : "");

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await fetchPage(url, q, page, timeout);
      cacheSet(cacheKey, result);
      return result;
    } catch (error) {
      lastError = error;
      if (error.fatal) throw error;
      if (attempt < retries) await sleep(280 + attempt * 420);
    }
  }
  throw lastError;
}

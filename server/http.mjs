import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

const WEB_INDEX = new URL("./web/index.html", import.meta.url);
const CHUNK = 1024 * 1024;
const MAX_STREAMS = 8;

export function byteRange(value, total) {
  if (!value) return [0, total - 1];
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2])) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
  const end = m[1]
    ? m[2]
      ? Math.min(Number(m[2]), total - 1)
      : total - 1
    : total - 1;
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start <= end &&
    start < total
    ? [start, end]
    : null;
}

function pageParam(url) {
  const page = Number(url.searchParams.get("page") || 1);
  return Number.isInteger(page) && page >= 1 && page <= 1000 ? page : null;
}

export function createServer(provider, token = "") {
  let activeStreams = 0;
  return http.createServer(async (req, res) => {
    const json = (status, value) => {
      if (res.headersSent) return res.end();
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    const url = new URL(req.url || "/", "http://localhost");
    if (token) {
      const actual = Buffer.from(req.headers.authorization || "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        return json(401, { error: "服务访问口令不正确" });
    }
    if (!["GET", "HEAD"].includes(req.method))
      return json(405, { error: "Method not allowed" });

    try {
      const { pathname } = url;

      if (pathname === "/" || pathname === "/index.html" || pathname === "/app") {
        const html = await readFile(WEB_INDEX);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        return res.end(html);
      }

      if (pathname === "/health" || pathname === "/api/status")
        return json(200, {
          service: "hongguotv",
          version: "1.0.0",
          apiVersion: 2,
          ...provider.status(),
        });

      if (pathname === "/api/home") {
        const page = pageParam(url);
        if (!page) return json(400, { error: "分页参数无效" });
        return json(200, await provider.home(page));
      }

      if (pathname === "/api/categories")
        return json(200, await provider.categories());

      // 手动触发一次索引更新（界面上「立即更新」按钮用）
      if (pathname === "/api/refresh") {
        if (typeof provider.refresh !== "function")
          return json(501, { error: "当前版本不支持手动更新" });
        return json(200, await provider.refresh());
      }

      if (pathname === "/api/category") {
        const page = pageParam(url);
        if (!page) return json(400, { error: "分页参数无效" });
        const tag = (url.searchParams.get("tag") || "").trim().slice(0, 30);
        return json(200, await provider.category(tag, page));
      }

      if (pathname === "/api/search") {
        const page = pageParam(url);
        if (!page) return json(400, { error: "分页参数无效" });
        const keyword = (url.searchParams.get("q") || "").trim();
        if (!keyword || keyword.length > 80)
          return json(400, { error: "请输入 1–80 字的关键词" });
        const localOnly = url.searchParams.get("local") === "1";
        return json(200, await provider.search(keyword, page, { localOnly }));
      }

      if (pathname === "/api/detail") {
        const id = (url.searchParams.get("id") || "").trim();
        if (!/^\d{1,30}$/.test(id)) return json(400, { error: "剧集 ID 无效" });
        return json(200, await provider.detail(id));
      }

      if (pathname === "/api/qualities") {
        const vid = (url.searchParams.get("vid") || "").trim();
        if (!/^\d{1,30}$/.test(vid)) return json(400, { error: "分集 ID 无效" });
        return json(200, await provider.qualities(vid));
      }

      const detail = /^\/api\/series\/(\d{1,30})$/.exec(pathname);
      if (detail) return json(200, await provider.detail(detail[1]));

      const play = /^\/api\/episodes\/(\d{1,30})\/(play|stream)$/.exec(pathname);
      if (!play) return json(404, { error: "接口不存在" });

      const vid = play[1];
      const quality = (url.searchParams.get("quality") || "auto").trim().slice(0, 16);
      const fresh = url.searchParams.get("fresh") === "1";

      if (play[2] === "play") {
        const stream = await provider.stream(vid, { quality, fresh });
        return json(200, {
          path: `/api/episodes/${vid}/stream?quality=${encodeURIComponent(quality)}`,
          contentType: "video/mp4",
          total: stream.total,
          quality: stream.quality,
        });
      }

      if (activeStreams >= MAX_STREAMS)
        return json(503, { error: "同时播放数已达上限，请稍后重试" });
      activeStreams += 1;
      try {
        const stream = await provider.stream(vid, { quality, fresh });
        const range = byteRange(req.headers.range, stream.total);
        if (!range) {
          res.writeHead(416, { "Content-Range": `bytes */${stream.total}` });
          return res.end();
        }
        const [start, end] = range;
        const headers = {
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
          "Cache-Control": "no-store",
        };
        if (req.headers.range)
          headers["Content-Range"] = `bytes ${start}-${end}/${stream.total}`;
        // 先取到首个分片再发成功头，避免“200 已发出但上游其实失败”。
        const first =
          req.method === "HEAD"
            ? null
            : await stream.chunk(start, Math.min(start + CHUNK - 1, end));
        res.writeHead(req.headers.range ? 206 : 200, headers);
        if (req.method === "HEAD") return res.end();
        for (let offset = start; offset <= end && !res.destroyed; offset += CHUNK) {
          const chunk =
            offset === start
              ? first
              : await stream.chunk(offset, Math.min(offset + CHUNK - 1, end));
          if (res.destroyed) break;
          if (!res.write(chunk)) {
            await new Promise((resolve) => {
              const done = () => {
                res.off("drain", done);
                res.off("close", done);
                resolve();
              };
              res.once("drain", done);
              res.once("close", done);
            });
          }
        }
        return res.end();
      } finally {
        activeStreams -= 1;
      }
    } catch (error) {
      // 上游信息可能含签名 URL，不要把原始报文回显给客户端
      console.error(
        JSON.stringify({
          event: "request_failed",
          path: url.pathname,
          code: error.code || "UPSTREAM_ERROR",
          message: String(error.message || "").slice(0, 200),
        })
      );
      if (res.headersSent) return res.destroy();
      const message = /不存在|暂不可用|无效/.test(error.message || "")
        ? error.message
        : "内容源暂不可用，请稍后重试";
      return json(502, { error: message });
    }
  });
}

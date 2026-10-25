// 发布到 GitHub Releases：创建/复用 tag 对应的 release 并上传安装包。
//
// 用法（token 从环境变量读，不要写进命令行历史）：
//   GITHUB_TOKEN=xxx node scripts/publish-release.mjs --version=1.0.7 \
//     --file=dist/HongguoTV-Setup-1.0.7.exe --notes-file=docs/release-notes.md
//
// 只做三件事：找/建 release → 删同名旧 asset → 上传新 asset。
import fs from "node:fs";
import path from "node:path";

const OWNER = "fangyubao";
const REPO = "hongguoOFwin";
const API = "https://api.github.com";
const UPLOAD = "https://uploads.github.com";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  })
);

const token = process.env.GITHUB_TOKEN || "";
if (!token) {
  console.error("缺少 GITHUB_TOKEN");
  process.exit(1);
}

const version = String(args.get("version") || "").trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("--version 需要形如 1.0.7");
  process.exit(1);
}
const tag = `v${version}`;
const file = path.resolve(String(args.get("file") || `dist/HongguoTV-Setup-${version}.exe`));
if (!fs.existsSync(file)) {
  console.error(`找不到安装包：${file}`);
  process.exit(1);
}

const notes = args.has("notes-file")
  ? fs.readFileSync(path.resolve(String(args.get("notes-file"))), "utf8")
  : String(args.get("notes") || `HongguoTV ${version}`);

const headers = {
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "hongguotv-release-script",
};

async function api(method, url, body, extraHeaders = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...headers, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    const message = data?.message || res.statusText;
    const error = new Error(`${method} ${url} → ${res.status} ${message}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

// 1) 已有同名 release 就复用，否则新建
let release = null;
try {
  release = await api("GET", `${API}/repos/${OWNER}/${REPO}/releases/tags/${tag}`);
  console.log(`[release] 复用已有 ${tag}（id=${release.id}）`);
} catch (error) {
  if (error.status !== 404) throw error;
  release = await api("POST", `${API}/repos/${OWNER}/${REPO}/releases`, {
    tag_name: tag,
    target_commitish: "main",
    name: `HongguoTV ${version}`,
    body: notes,
    draft: false,
    prerelease: false,
  });
  console.log(`[release] 已创建 ${tag}（id=${release.id}）`);
}

// 2) 同名 asset 先删掉，避免重复上传报 422
const assetName = path.basename(file);
const existing = (release.assets || []).find((a) => a.name === assetName);
if (existing) {
  await api("DELETE", `${API}/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`);
  console.log(`[release] 已删除旧 asset ${assetName}`);
}

// 3) 上传安装包（二进制直接走 fetch，不用 JSON 包装）
const size = fs.statSync(file).size;
console.log(`[release] 上传 ${assetName}（${(size / 1024 / 1024).toFixed(1)} MB）…`);
const uploadRes = await fetch(
  `${UPLOAD}/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`,
  {
    method: "POST",
    headers: { ...headers, "content-type": "application/octet-stream", "content-length": String(size) },
    body: fs.readFileSync(file),
    signal: AbortSignal.timeout(900000),
  }
);
const uploadText = await uploadRes.text();
if (!uploadRes.ok) {
  throw new Error(`上传失败 ${uploadRes.status}: ${uploadText.slice(0, 300)}`);
}
const uploaded = JSON.parse(uploadText);

console.log(`[release] 上传完成：${uploaded.browser_download_url}`);
console.log(`[release] 发布页：${release.html_url}`);

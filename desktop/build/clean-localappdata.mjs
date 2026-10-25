// 构建后清理：electron-builder 打完 NSIS 包会在 %LOCALAPPDATA%\<name>-updater
// 留一份安装包副本（80MB 上下），这是构建工具的行为，跟应用本身无关。
// 每台机器上装过的 Electron 应用都会有这么一个目录，越打越占系统盘。
// 打完包顺手删掉，保证 C 盘不留项目的构建残渣。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
const name = pkg.name || "hongguotv-desktop";

const localAppData = process.env.LOCALAPPDATA || "";
if (!localAppData) {
  console.log("[clean] 非 Windows 或无 LOCALAPPDATA，跳过");
  process.exit(0);
}

const target = path.join(localAppData, `${name}-updater`);
if (!fs.existsSync(target)) {
  console.log(`[clean] ${target} 不存在，无需清理`);
  process.exit(0);
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    try {
      total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    } catch {
      /* 权限问题忽略 */
    }
  }
  return total;
}

try {
  const size = dirSize(target);
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`[clean] 已删除构建缓存 ${target}（${(size / 1024 / 1024).toFixed(1)} MB）`);
} catch (error) {
  console.log(`[clean] 清理失败（可手动删除）：${error.message}`);
}

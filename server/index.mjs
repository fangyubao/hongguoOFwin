import os from "node:os";
import { provider } from "./provider.mjs";
import { createServer } from "./http.mjs";

const host =
  process.env.BRIDGE_HOST ||
  (process.argv.includes("--lan") ? "0.0.0.0" : "127.0.0.1");
const port = Number(process.env.PORT || 8787);

// 启动即加载本地索引；索引缺失或过期时后台抓取，抓取期间首页也能出内容。
provider.init();

const server = createServer(provider, process.env.BRIDGE_TOKEN || "");
server.listen(port, host, () => {
  console.log("\n  红果短剧 · 内容服务已启动");
  console.log(`  本机访问：http://127.0.0.1:${port}`);
  if (host === "0.0.0.0") {
    for (const list of Object.values(os.networkInterfaces()))
      for (const nic of list || []) {
        if (nic.family === "IPv4" && !nic.internal)
          console.log(`  电视/手机访问：http://${nic.address}:${port}`);
      }
  }
  console.log(`  索引状态：${provider.status().total} 部短剧\n`);
});
server.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? `端口 ${port} 已被占用：请先关闭已运行的红果短剧，或设置 PORT 环境变量换端口。`
      : error.code
  );
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
  });

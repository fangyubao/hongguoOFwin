"use strict";

const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

// 系统里残留的代理变量会让 Node 的 HTTPS 请求被降级（表现为片源 502），
// 而片源是国内域名，直连最稳，所以启动时清掉它们。
for (const key of [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "npm_config_proxy",
  "npm_config_https_proxy",
])
  delete process.env[key];

app.setName("HongguoTV");

// 便携模式：exe 同级存在 portable.txt 时，索引缓存与配置放在 exe 旁的 data 目录，
// 不写系统盘；目录不可写（例如装到了 Program Files）就自动退回默认位置。
// 必须在 requestSingleInstanceLock 之前设置，否则锁文件会先在 C 盘建目录。
let dataRoot = "";
try {
  const exeDir = path.dirname(process.execPath);
  if (fs.existsSync(path.join(exeDir, "portable.txt"))) {
    const portableData = path.join(exeDir, "data");
    fs.mkdirSync(portableData, { recursive: true });
    fs.accessSync(portableData, fs.constants.W_OK);
    app.setPath("userData", portableData);
    dataRoot = portableData;
  }
} catch {}

// 允许用环境变量把「配置 + 缓存」指到别的盘（系统盘空间紧张时很有用）
const homeOverride = process.env.HONGGUOTV_HOME;
if (homeOverride && homeOverride.trim()) {
  const target = path.resolve(homeOverride.trim());
  try {
    fs.mkdirSync(target, { recursive: true });
    app.setPath("userData", target);
    dataRoot = target;
  } catch {}
}

// 崩溃转储默认落在 C 盘，跟着数据目录走
if (dataRoot) {
  try {
    const dumpDir = path.join(dataRoot, "crash");
    fs.mkdirSync(dumpDir, { recursive: true });
    app.setPath("crashDumps", dumpDir);
  } catch {}
}

/* ---------------- 显卡兼容 ---------------- */
// 远程桌面、老显卡、虚拟机上 GPU 进程会反复崩溃，表现为打不开或白屏。
// 上次启动记录过崩溃的，这次自动改软件渲染；也可以在「视图」菜单里恢复。
const GPU_FLAG = path.join(app.getPath("userData"), "gpu-crash.flag");
const explicitNoGpu =
  process.env.HONGGUOTV_NO_GPU === "1" || process.argv.includes("--no-gpu");
let softwareRendering = explicitNoGpu;
if (!softwareRendering && !process.argv.includes("--gpu")) {
  try {
    softwareRendering = fs.existsSync(GPU_FLAG);
  } catch {}
}
if (softwareRendering) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
}

let gpuCrashes = 0;
function noteGpuCrash() {
  gpuCrashes += 1;
  if (softwareRendering || gpuCrashes < 1) return;
  try {
    fs.writeFileSync(GPU_FLAG, new Date().toISOString());
  } catch {}
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// 用户数据（索引缓存、设备标识）必须放在可写目录，不能落在安装目录
const DATA_DIR = path.join(app.getPath("userData"), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.HONGGUO_DATA_DIR = DATA_DIR;

const STATE_FILE = path.join(app.getPath("userData"), "window.json");
const DEFAULT_PORT = 8787;

let mainWindow = null;
let httpServer = null;
let serverPort = 0;
let lanEnabled = false;

/* ---------------- 窗口状态 ---------------- */
function loadWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (Number.isFinite(raw.width) && raw.width > 400) return raw;
  } catch {}
  return { width: 1300, height: 860, maximized: false };
}

let saveTimer;
function writeWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = mainWindow.isMaximized()
      ? mainWindow.getNormalBounds()
      : mainWindow.getBounds();
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ ...bounds, maximized: mainWindow.isMaximized() })
    );
  } catch {}
}
function saveWindowState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeWindowState, 400);
}

/* ---------------- 内置内容服务 ---------------- */
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function bootServer() {
  const root = path.join(__dirname, "server");
  const { provider } = await import(
    pathToFileURL(path.join(root, "provider.mjs")).href
  );
  const { createServer } = await import(
    pathToFileURL(path.join(root, "http.mjs")).href
  );

  provider.init();
  const server = createServer(provider, "");

  let port = DEFAULT_PORT;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      await listen(server, port, "127.0.0.1");
      break;
    } catch (error) {
      if (error.code !== "EADDRINUSE" || attempt === 14) throw error;
      port += 1;
    }
  }
  httpServer = server;
  serverPort = port;
  return port;
}

async function rebind(host) {
  if (!httpServer) return;
  const server = httpServer;
  try {
    server.closeAllConnections?.();
  } catch {}
  await new Promise((resolve) => server.close(() => resolve()));
  await listen(server, serverPort, host);
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const nic of list || [])
      if (nic.family === "IPv4" && !nic.internal)
        return `http://${nic.address}:${serverPort}`;
  return "";
}

/* ---------------- 菜单 ---------------- */
function buildMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        { label: "打开数据目录", click: () => shell.openPath(DATA_DIR) },
        {
          // 平时每 6 小时自动更新一次，这里给个手动触发的入口
          label: "立即更新内容库",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "正在更新",
              message: "已在后台开始更新内容库",
              detail: "拉取官网分类与最新剧集，通常需要 1 分钟左右，完成后页面会自动刷新。",
              buttons: ["知道了"],
            });
            fetch(`http://127.0.0.1:${serverPort}/api/refresh`).catch(() => {});
          },
        },
        { type: "separator" },
        { label: "退出", role: "quit" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "重新加载", role: "reload" },
        { label: "强制重新加载", role: "forceReload" },
        {
          label: "放大",
          accelerator: "CommandOrControl+=",
          click: () => {
            if (!mainWindow) return;
            const wc = mainWindow.webContents;
            wc.setZoomLevel(Math.min(3, wc.getZoomLevel() + 0.5));
          },
        },
        {
          label: "缩小",
          accelerator: "CommandOrControl+-",
          click: () => {
            if (!mainWindow) return;
            const wc = mainWindow.webContents;
            wc.setZoomLevel(Math.max(-2, wc.getZoomLevel() - 0.5));
          },
        },
        {
          label: "实际大小",
          accelerator: "CommandOrControl+0",
          click: () => mainWindow && mainWindow.webContents.setZoomLevel(0),
        },
        { type: "separator" },
        {
          label: "使用硬件加速",
          type: "checkbox",
          checked: !softwareRendering,
          click: (item) => {
            try {
              if (item.checked) fs.rmSync(GPU_FLAG, { force: true });
              else fs.writeFileSync(GPU_FLAG, new Date().toISOString());
            } catch {}
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "需要重启",
              message: item.checked ? "已开启硬件加速" : "已改为软件渲染",
              detail: "重启应用后生效。如果画面出现卡顿或花屏，可以再切回来。",
              buttons: ["知道了"],
            });
          },
        },
        { type: "separator" },
        { label: "全屏", role: "togglefullscreen" },
        { label: "开发者工具", role: "toggleDevTools" },
      ],
    },
    {
      label: "局域网",
      submenu: [
        {
          label: "允许电视/手机访问本机",
          type: "checkbox",
          checked: lanEnabled,
          click: async (item) => {
            try {
              await rebind(item.checked ? "0.0.0.0" : "127.0.0.1");
              lanEnabled = item.checked;
              if (item.checked) {
                const url = lanAddress() || `http://本机IP:${serverPort}`;
                dialog.showMessageBox(mainWindow, {
                  type: "info",
                  title: "局域网访问已开启",
                  message: "在同一 Wi-Fi 下，用电视/手机浏览器打开：",
                  detail: `${url}\n\n关掉这个开关即可恢复仅本机访问。`,
                  buttons: ["知道了"],
                });
              } else {
                dialog.showMessageBox(mainWindow, {
                  type: "info",
                  title: "局域网访问已关闭",
                  message: "现在只有这台电脑能访问。",
                  buttons: ["知道了"],
                });
              }
            } catch (error) {
              item.checked = !item.checked;
              dialog.showErrorBox("切换失败", String(error.message || error));
            }
          },
        },
        {
          label: "显示访问地址",
          click: () => {
            const url = lanEnabled ? lanAddress() : "";
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "访问地址",
              message: `本机：http://127.0.0.1:${serverPort}`,
              detail: lanEnabled
                ? `电视/手机：${url || "未检测到局域网 IP"}`
                : "局域网访问未开启，电视/手机暂时无法访问。",
              buttons: ["关闭"],
            });
          },
        },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "快捷键说明",
          click: () =>
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "快捷键",
              message: "播放器内可用快捷键",
              detail:
                "空格 / K：播放暂停\n← →：后退 / 前进 10 秒\n↑ ↓：音量\nN / P：下一集 / 上一集\nF：全屏　M：静音　A：连播开关\nEsc：退出全屏或关闭播放器\n\n页面任意位置按 / 可快速搜索。",
              buttons: ["知道了"],
            }),
        },
        {
          label: "关于",
          click: () =>
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "关于",
              message: `红果短剧 桌面版 ${app.getVersion()}`,
              detail:
                "非官方客户端，仅用于个人学习与网络调试。\n内容版权归红果短剧（hongguoduanju.com）所有。\n\n本项目基于 GPL-3.0 授权，内含 GPL-3.0 的第三方解析代码。",
              buttons: ["确定"],
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------- 主窗口 ---------------- */
function createWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: "#0b0b0f",
    title: "红果短剧",
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  if (state.maximized) mainWindow.maximize();
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);

  mainWindow.on("resize", saveWindowState);
  mainWindow.on("move", saveWindowState);
  mainWindow.on("close", () => {
    clearTimeout(saveTimer);
    writeWindowState();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // 站内链接留在窗口里，外链交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${serverPort}`)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });
}

/* ---------------- 启动 ---------------- */
app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  app.on("child-process-gone", (event, details) => {
    if (details && details.type === "GPU") noteGpuCrash();
  });
  try {
    await bootServer();
  } catch (error) {
    dialog.showErrorBox(
      "启动失败",
      `内容服务无法启动：${error.message || error}\n\n可能是端口被占用，请关闭其他红果短剧窗口后重试。`
    );
    app.exit(1);
    return;
  }
  buildMenu();
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  clearTimeout(saveTimer);
  writeWindowState();
  try {
    httpServer?.closeAllConnections?.();
    httpServer?.close();
  } catch {}
});

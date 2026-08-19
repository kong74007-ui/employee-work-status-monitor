const { app, BrowserWindow, ipcMain, Menu, Notification, Tray, nativeImage, shell } = require("electron");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let mainWindow = null;
let tray = null;
let config = null;
let running = false;
let busy = false;
let nextUploadAt = null;
let nextMessagePollAt = null;
let lastUploadText = "暂无";
let statusText = "准备中";
let timer = null;
const iconPath = path.join(__dirname, "assets", "app-icon.png");

if (process.platform === "win32") {
  app.setAppUserModelId("EmployeeStatusClient");
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (isHiddenLaunch()) {
    mainWindow.hide();
    return;
  }
  mainWindow.show();
  mainWindow.setSkipTaskbar(false);
  mainWindow.focus();
});

function isHiddenLaunch(args = process.argv) {
  return args.includes("--hidden") || args.includes("--background") || args.includes("--auto-launch");
}

function resolveConfigPath() {
  const arg = process.argv.find((item) => item.startsWith("--config="));
  if (arg) {
    return path.resolve(process.cwd(), arg.slice("--config=".length));
  }

  const executableDir = path.dirname(process.execPath);
  const candidates = [
    path.join(app.getPath("userData"), "employee.config.json"),
    path.join(process.cwd(), "employee.config.json"),
    path.join(executableDir, "employee.config.json"),
    path.join(executableDir, "resources", "employee.config.json"),
    path.join(__dirname, "employee.config.json"),
    path.join(__dirname, "..", "employee.config.json"),
  ];
  return candidates.find((item) => fs.existsSync(item)) || path.join(__dirname, "employee.config.example.json");
}

function writeLog(message, detail = "") {
  try {
    const logPath = path.join(app.getPath("userData"), "employee-client.log");
    const line = `[${new Date().toISOString()}] ${message}${detail ? ` ${detail}` : ""}\n`;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line, "utf8");
  } catch {
    // Logging must never break screenshot upload.
  }
}

function readConfig() {
  const configPath = resolveConfigPath();
  writeLog("config_path", configPath);
  const value = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
  for (const field of ["serverUrl", "token", "employeeId", "employeeName"]) {
    if (!String(value[field] || "").trim()) {
      throw new Error(`配置缺少 ${field}`);
    }
  }
  return {
    serverUrl: normalizeUrl(value.serverUrl),
    token: value.token,
    employeeId: value.employeeId,
    employeeName: value.employeeName,
    department: value.department || "未分组",
    intervalMinutes: Number(value.intervalMinutes || 30),
    activeStartTime: value.activeStartTime || "00:00",
    activeEndTime: value.activeEndTime || "24:00",
    messagePollSeconds: Number(value.messagePollSeconds || 10),
    timeoutSeconds: Number(value.timeoutSeconds || 90),
    autoLaunch: value.autoLaunch !== false,
    note: value.note || "员工端截图上报",
    configPath,
  };
}

function configureAutoLaunch() {
  try {
    const settings = {
      openAtLogin: config.autoLaunch,
    };
    if (config.autoLaunch) {
      settings.args = ["--hidden", `--config=${config.configPath}`];
      if (process.platform === "darwin") {
        settings.openAsHidden = true;
      }
    }
    app.setLoginItemSettings(settings);
    writeLog("auto_launch", config.autoLaunch ? "enabled" : "disabled");
  } catch (error) {
    writeLog("auto_launch_failed", String(error.message || error));
  }
}

function writableConfigPath() {
  return path.join(app.getPath("userData"), "employee.config.json");
}

function saveConfigPatch(patch) {
  const target = writableConfigPath();
  const nextConfig = {
    serverUrl: config.serverUrl,
    token: config.token,
    employeeId: config.employeeId,
    employeeName: config.employeeName,
    department: config.department,
    intervalMinutes: config.intervalMinutes,
    activeStartTime: config.activeStartTime,
    activeEndTime: config.activeEndTime,
    messagePollSeconds: config.messagePollSeconds,
    timeoutSeconds: config.timeoutSeconds,
    autoLaunch: config.autoLaunch,
    note: config.note,
    ...patch,
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  config = {
    ...config,
    ...patch,
    configPath: target,
  };
  writeLog("config_saved", target);
}

function updateProfile(_event, profile = {}) {
  const employeeId = String(profile.employeeId || "").trim();
  const employeeName = String(profile.employeeName || "").trim();
  const department = String(profile.department || "").trim();
  if (!employeeId || !employeeName) {
    writeLog("profile_update_rejected", "missing employeeId or employeeName");
    sendState();
    return;
  }
  saveConfigPatch({
    employeeId,
    employeeName,
    department: department || config.department,
  });
  configureAutoLaunch();
  writeLog("profile_updated", `${employeeId} ${employeeName}`);
  sendState();
  notify("信息已更新", "后续上报将使用新的员工信息。");
}

function normalizeUrl(value) {
  const text = String(value || "").trim();
  const markdownLink = text.match(/\]\((https?:\/\/[^)]+)\)/i);
  if (markdownLink) return markdownLink[1];

  const url = text.match(/https?:\/\/[^\s)\]]+/i);
  return url ? url[0] : text;
}

function parseTime(value) {
  const [hour, minute] = String(value).split(":").map((part) => Number(part));
  const safeHour = Math.max(0, Math.min(24, hour || 0));
  const safeMinute = safeHour === 24 ? 0 : Math.max(0, Math.min(59, minute || 0));
  return { hour: safeHour, minute: safeMinute };
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function configuredMinutes(value) {
  const time = parseTime(value);
  return time.hour * 60 + time.minute;
}

function isActiveWindow(date = new Date()) {
  const start = configuredMinutes(config.activeStartTime);
  const end = configuredMinutes(config.activeEndTime);
  if (start === 0 && end >= 24 * 60) return true;
  if (start === end) return true;
  const current = minutesOfDay(date);
  if (start <= end) return current >= start && current < end;
  return current >= start || current < end;
}

function nextActiveStart(date = new Date()) {
  const time = parseTime(config.activeStartTime);
  const candidate = new Date(date);
  candidate.setHours(time.hour, time.minute, 0, 0);
  if (candidate <= date) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

function activeEnd(date = new Date()) {
  const start = configuredMinutes(config.activeStartTime);
  const end = configuredMinutes(config.activeEndTime);
  if (start === 0 && end >= 24 * 60) {
    const candidate = new Date(date);
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(0, 0, 0, 0);
    return candidate;
  }
  const time = parseTime(config.activeEndTime);
  const candidate = new Date(date);
  candidate.setHours(time.hour, time.minute, 0, 0);
  if (start > end && minutesOfDay(date) >= start) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

function getMessagesUrl() {
  return config.serverUrl.replace(/\/api\/snapshots\/?$/, "/api/messages");
}

function getDeviceIdentity() {
  return os.hostname() || config.employeeId;
}

function authHeaders() {
  return {
    authorization: `Bearer ${config.token}`,
    "x-monitor-token": config.token,
  };
}

function execFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function captureScreenshotBase64() {
  const target = path.join(os.tmpdir(), `employee-screen-${Date.now()}.png`);
  try {
    if (process.platform === "darwin") {
      await execFile("screencapture", ["-x", target]);
    } else if (process.platform === "win32") {
      const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
  $bitmap.Save('${target.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
}
finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}`;
      const scriptPath = path.join(os.tmpdir(), `employee-screen-${Date.now()}.ps1`);
      fs.writeFileSync(scriptPath, script, "utf8");
      try {
        await execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath]);
      } finally {
        fs.rmSync(scriptPath, { force: true });
      }
    } else {
      await execFile("gnome-screenshot", ["-f", target]);
    }
    return fs.readFileSync(target).toString("base64");
  } finally {
    fs.rmSync(target, { force: true });
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(5, config.timeoutSeconds) * 1000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadSnapshot(options = {}) {
  const force = options.force === true;
  if (busy) return;
  if (!force && !isActiveWindow()) {
    nextUploadAt = nextActiveStart();
    setStatus("等待时段");
    sendState();
    return;
  }

  busy = true;
  setStatus("正在上传");
  writeLog("upload_start", `${getDeviceIdentity()} ${config.serverUrl}`);
  sendState();

  try {
    const imageBase64 = await captureScreenshotBase64();
    const response = await fetchWithTimeout(config.serverUrl, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        employeeId: config.employeeId,
        employeeName: config.employeeName,
        department: config.department,
        computerName: os.hostname(),
        capturedAt: new Date().toISOString(),
        note: config.note,
        imageBase64,
      }),
    });
    if (!response.ok) throw new Error(`上传失败：${response.status}`);
    writeLog("upload_success", `${getDeviceIdentity()}`);
    lastUploadText = formatDateTime(new Date());
    const candidate = new Date(Date.now() + Math.max(1, config.intervalMinutes) * 60 * 1000);
    nextUploadAt = candidate < activeEnd() ? candidate : nextActiveStart();
    setStatus("运行中");
  } catch (error) {
    setStatus("上传失败");
    writeLog("upload_failed", String(error.message || error));
    console.error(error);
    if (process.platform === "darwin" && String(error.message).includes("screencapture")) {
      notify("截图失败", "请在 macOS 系统设置中允许屏幕录制权限。");
    }
  } finally {
    busy = false;
    sendState();
  }
}

async function pollMessages() {
  const url = `${getMessagesUrl()}?employeeId=${encodeURIComponent(getDeviceIdentity())}`;
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error(`消息检查失败：${response.status}`);
  const result = await response.json();
  for (const item of result.messages || []) {
    if (item.message) notify("工作提醒", item.message, { sound: true });
  }
}

function notify(title, body, options = {}) {
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: false }).show();
  }
  if (options.sound) {
    playNotificationSound();
  }
}

function playNotificationSound() {
  try {
    if (shell && typeof shell.beep === "function") {
      shell.beep();
      return;
    }
    if (process.platform === "win32") {
      childProcess.execFile(
        "powershell.exe",
        ["-NoProfile", "-Command", "[console]::beep(880,180)"],
        { windowsHide: true },
        () => {}
      );
      return;
    }
    if (process.platform === "darwin") {
      childProcess.execFile("/usr/bin/afplay", ["/System/Library/Sounds/Glass.aiff"], () => {});
    }
  } catch (error) {
    writeLog("notification_sound_failed", String(error.message || error));
  }
}

function setStatus(value) {
  statusText = value;
  if (tray) tray.setToolTip(`员工状态上报 - ${value}`);
}

function startMonitoring(options = {}) {
  running = true;
  const uploadImmediately = options.uploadImmediately !== false;
  if (!isActiveWindow()) {
    nextUploadAt = nextActiveStart();
  } else {
    nextUploadAt = uploadImmediately
      ? new Date()
      : new Date(Date.now() + Math.max(1, config.intervalMinutes) * 60 * 1000);
  }
  nextMessagePollAt = new Date();
  setStatus(isActiveWindow() ? "运行中" : "等待时段");
  writeLog("monitoring_started", `active=${isActiveWindow()} nextUploadAt=${nextUploadAt ? nextUploadAt.toISOString() : ""}`);
  sendState();
}

function stopMonitoring() {
  running = false;
  setStatus("已停止");
  sendState();
}

function uploadNow() {
  uploadSnapshot({ force: true });
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function nextUploadText() {
  if (!running) return "已停止";
  if (!nextUploadAt) return "准备中";
  if (!isActiveWindow()) return formatDateTime(nextUploadAt).slice(0, 11);
  const remaining = Math.max(0, Math.round((nextUploadAt.getTime() - Date.now()) / 1000));
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function sendState() {
  const state = {
    running,
    statusText,
    nextUploadText: nextUploadText(),
    activeStartTime: config.activeStartTime,
    activeEndTime: config.activeEndTime,
    intervalMinutes: config.intervalMinutes,
    employeeId: config.employeeId,
    computerName: getDeviceIdentity(),
    employeeName: config.employeeName,
    department: config.department,
    serverUrl: config.serverUrl,
    lastUploadText,
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("state", state);
  }
}

function tick() {
  if (!running || busy) {
    sendState();
    return;
  }

  const now = new Date();
  if (nextMessagePollAt && now >= nextMessagePollAt) {
    pollMessages().catch((error) => console.error(error));
    nextMessagePollAt = new Date(Date.now() + Math.max(5, config.messagePollSeconds) * 1000);
  }

  if (!isActiveWindow()) {
    nextUploadAt = nextActiveStart();
    setStatus("等待时段");
  } else if (nextUploadAt && now >= nextUploadAt) {
    uploadSnapshot();
  } else {
    setStatus("运行中");
  }
  sendState();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 680,
    height: 590,
    resizable: false,
    show: !isHiddenLaunch(),
    skipTaskbar: isHiddenLaunch(),
    title: "员工状态上报",
    icon: iconPath,
    backgroundColor: "#0b0f18",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("show", () => {
    mainWindow.setSkipTaskbar(false);
  });
  mainWindow.on("hide", () => {
    mainWindow.setSkipTaskbar(true);
  });
  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.on("did-finish-load", sendState);
}

function createTray() {
  const image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip("员工状态上报");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示窗口", click: showMainWindow },
    { label: "开始", click: startMonitoring },
    { label: "停止", click: stopMonitoring },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on("double-click", showMainWindow);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setSkipTaskbar(false);
  mainWindow.show();
  mainWindow.focus();
}

ipcMain.on("start", startMonitoring);
ipcMain.on("stop", stopMonitoring);
ipcMain.on("upload-now", uploadNow);
ipcMain.on("update-profile", updateProfile);
ipcMain.on("hide", () => mainWindow.hide());

app.whenReady().then(() => {
  writeLog("app_ready", `version=${app.getVersion()}`);
  config = readConfig();
  configureAutoLaunch();
  createWindow();
  createTray();
  startMonitoring({ uploadImmediately: true });
  setTimeout(() => uploadSnapshot({ force: true }), 1200);
  timer = setInterval(tick, 1000);
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (timer) clearInterval(timer);
});

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.MONITOR_PORT || 8787);
const HOST = process.env.MONITOR_HOST || "0.0.0.0";
const API_TOKEN = process.env.MONITOR_TOKEN || "change-me-token";
const SCREENSHOT_VIEW_PASSWORD = process.env.SCREENSHOT_VIEW_PASSWORD || API_TOKEN;
const DATA_DIR = path.join(__dirname, "monitor-data");
const SHOT_DIR = path.join(DATA_DIR, "screenshots");
const DB_FILE = path.join(DATA_DIR, "snapshots.json");
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const SCREENSHOT_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const ANALYSIS_START_MINUTES = 10 * 60;
const ANALYSIS_END_MINUTES = 22 * 60;
const screenshotSessions = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

ensureDirs();
cleanupOldScreenshots();
scheduleMidnightCleanup();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/manager")) {
      return serveFile(res, path.join(__dirname, "manager.html"));
    }

    if (req.method === "GET" && url.pathname === "/api/snapshots") {
      return sendJson(res, 200, readDb());
    }

    if (req.method === "POST" && url.pathname === "/api/snapshots") {
      return receiveSnapshot(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/screenshots/session") {
      return createScreenshotSession(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/screenshots/today") {
      return listTodayScreenshots(req, res, url);
    }

    if (req.method === "GET" && url.pathname === "/api/screenshots/image") {
      return serveScreenshotImage(req, res, url);
    }

    if (req.method === "POST" && url.pathname === "/api/messages") {
      return createMessage(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/messages") {
      return deliverMessages(req, res, url);
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    sendJson(res, 500, { error: "server_error", message: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Manager server: http://localhost:${PORT}/manager`);
  console.log(`LAN endpoint:    http://<this-computer-ip>:${PORT}/api/snapshots`);
  console.log("Set MONITOR_TOKEN before production use.");
});

function ensureDirs() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    writeDb({ employees: {}, activity: [], messages: [] });
  }
}

function normalizeDb(db) {
  return {
    employees: db.employees || {},
    activity: Array.isArray(db.activity) ? db.activity : [],
    messages: Array.isArray(db.messages) ? db.messages : [],
  };
}

function receiveSnapshot(req, res) {
  if (!isAuthorized(req)) {
    return sendJson(res, 401, { error: "unauthorized" });
  }

  readBody(req)
    .then(async (body) => {
      const payload = JSON.parse(body);
      const sourceEmployeeId = safeId(required(payload.employeeId, "employeeId"));
      const employeeName = String(required(payload.employeeName, "employeeName")).trim();
      const department = String(payload.department || "未分组").trim();
      const computerName = String(payload.computerName || "").trim();
      const employeeId = getEmployeeIdentity({ employeeId: sourceEmployeeId, computerName });
      const capturedAt = payload.capturedAt ? new Date(payload.capturedAt) : new Date();
      const receivedAt = new Date();
      const image = normalizeImage(payload.imageBase64);
      const hash = crypto.createHash("sha256").update(image).digest("hex").slice(0, 12);
      const fileName = `${employeeId}-${toFileStamp(capturedAt)}-${hash}.png`;
      const filePath = path.join(SHOT_DIR, fileName);
      const previousDb = readDb();
      const previous = previousDb.employees[employeeId] || previousDb.employees[sourceEmployeeId] || {};
      const shouldAnalyze = isAnalysisWindow(receivedAt);
      const analysis = shouldAnalyze
        ? await analyzeScreenshotSmart({ image, payload, previous, capturedAt, receivedAt })
        : buildAnalysisSkippedAnalysis(receivedAt);

      fs.writeFileSync(filePath, image);

      const db = readDb();
      const latestPrevious = db.employees[employeeId] || db.employees[sourceEmployeeId] || previous;
      const record = {
        employeeId,
        sourceEmployeeId,
        employeeName,
        department,
        computerName,
        note: String(payload.note || "").trim(),
        capturedAt: capturedAt.toISOString(),
        receivedAt: receivedAt.toISOString(),
        screenshotUrl: `/monitor-data/screenshots/${fileName}`,
        screenshotFile: fileName,
        analysis,
        analysisSkipped: !shouldAnalyze,
      };

      if (shouldAnalyze) {
        db.employees[employeeId] = {
          ...latestPrevious,
          ...record,
          firstSeenAt: latestPrevious.firstSeenAt || receivedAt.toISOString(),
          totalSnapshots: Number(latestPrevious.totalSnapshots || 0) + 1,
          totalUploads: Number(latestPrevious.totalUploads || latestPrevious.totalSnapshots || 0) + 1,
          lastAnalyzedAt: receivedAt.toISOString(),
        };
      } else {
        db.employees[employeeId] = {
          ...latestPrevious,
          employeeId,
          sourceEmployeeId,
          employeeName,
          department,
          computerName: String(computerName || latestPrevious.computerName || "").trim(),
          note: String(payload.note || latestPrevious.note || "").trim(),
          capturedAt: capturedAt.toISOString(),
          receivedAt: receivedAt.toISOString(),
          firstSeenAt: latestPrevious.firstSeenAt || receivedAt.toISOString(),
          totalSnapshots: Number(latestPrevious.totalSnapshots || 0),
          totalUploads: Number(latestPrevious.totalUploads || latestPrevious.totalSnapshots || 0) + 1,
          lastRetainedOnlyAt: receivedAt.toISOString(),
          analysis: latestPrevious.analysis || buildPendingAnalysis(receivedAt),
        };
      }
      if (sourceEmployeeId !== employeeId && db.employees[sourceEmployeeId]) {
        delete db.employees[sourceEmployeeId];
      }
      db.activity.unshift(record);
      db.activity = db.activity.slice(0, 500);
      writeDb(db);

      sendJson(res, 201, { ok: true, employee: db.employees[employeeId] });
    })
    .catch((error) => {
      const status = error.statusCode || 400;
      sendJson(res, status, { error: "bad_request", message: error.message });
    });
}

function createMessage(req, res) {
  if (!isAuthorized(req)) {
    return sendJson(res, 401, { error: "unauthorized" });
  }

  readBody(req)
    .then((body) => {
      const payload = JSON.parse(body);
      const message = String(required(payload.message, "message")).trim().slice(0, 300);
      if (!message) throw new Error("message is empty");
      const db = readDb();
      const now = new Date().toISOString();
      if (payload.broadcast === true) {
        const employees = Object.values(db.employees || {});
        if (!employees.length) throw new Error("no employees to broadcast");
        const records = employees.map((employee) => ({
          id: crypto.randomUUID(),
          employeeId: safeId(employee.employeeId),
          employeeName: employee.employeeName || employee.employeeId,
          message,
          createdAt: now,
          deliveredAt: null,
          broadcast: true,
        }));

        db.messages = [...records, ...db.messages].slice(0, 300);
        writeDb(db);
        return sendJson(res, 201, { ok: true, count: records.length, messages: records });
      }

      const employeeId = safeId(required(payload.employeeId, "employeeId"));
      const employee = db.employees[employeeId] || {};
      const record = {
        id: crypto.randomUUID(),
        employeeId,
        employeeName: employee.employeeName || String(payload.employeeName || employeeId),
        message,
        createdAt: now,
        deliveredAt: null,
      };

      db.messages.unshift(record);
      db.messages = db.messages.slice(0, 300);
      writeDb(db);
      sendJson(res, 201, { ok: true, message: record });
    })
    .catch((error) => {
      sendJson(res, 400, { error: "bad_request", message: error.message });
    });
}

function deliverMessages(req, res, url) {
  if (!isAuthorized(req)) {
    return sendJson(res, 401, { error: "unauthorized" });
  }

  const employeeId = safeId(required(url.searchParams.get("employeeId"), "employeeId"));
  const db = readDb();
  const now = new Date().toISOString();
  const pending = db.messages
    .filter((message) => message.employeeId === employeeId && !message.deliveredAt)
    .slice(0, 10);

  if (pending.length) {
    const pendingIds = new Set(pending.map((message) => message.id));
    db.messages = db.messages.map((message) =>
      pendingIds.has(message.id) ? { ...message, deliveredAt: now } : message,
    );
    writeDb(db);
  }

  sendJson(res, 200, { messages: pending });
}

function createScreenshotSession(req, res) {
  readBody(req)
    .then((body) => {
      const payload = JSON.parse(body || "{}");
      const password = String(payload.password || "");
      if (!password || password !== SCREENSHOT_VIEW_PASSWORD) {
        return sendJson(res, 401, { error: "unauthorized", message: "password_required" });
      }
      pruneScreenshotSessions();
      const token = crypto.randomBytes(24).toString("hex");
      const expiresAt = Date.now() + SCREENSHOT_SESSION_TTL_MS;
      screenshotSessions.set(token, expiresAt);
      sendJson(res, 201, { ok: true, token, expiresAt: new Date(expiresAt).toISOString() });
    })
    .catch((error) => {
      sendJson(res, 400, { error: "bad_request", message: error.message });
    });
}

function listTodayScreenshots(req, res, url) {
  if (!isScreenshotSessionAuthorized(url)) {
    return sendJson(res, 401, { error: "unauthorized" });
  }

  const todayStart = startOfToday();
  const db = readDb();
  const items = db.activity
    .filter((item) => {
      if (!item.screenshotFile) return false;
      const receivedAt = new Date(item.receivedAt || item.capturedAt || 0);
      return receivedAt >= todayStart;
    })
    .map((item) => ({
      employeeId: item.employeeId,
      employeeName: item.employeeName,
      department: item.department,
      computerName: item.computerName,
      capturedAt: item.capturedAt,
      receivedAt: item.receivedAt,
      label: item.analysis && item.analysis.label ? item.analysis.label : "",
      summary: item.analysis && item.analysis.summary ? item.analysis.summary : "",
      file: item.screenshotFile,
      imageUrl: `/api/screenshots/image?file=${encodeURIComponent(item.screenshotFile)}&session=${encodeURIComponent(url.searchParams.get("session") || "")}`,
    }));

  sendJson(res, 200, { date: todayStart.toISOString().slice(0, 10), screenshots: items });
}

function serveScreenshotImage(req, res, url) {
  if (!isScreenshotSessionAuthorized(url)) {
    return sendJson(res, 401, { error: "unauthorized" });
  }

  const file = safeScreenshotFile(url.searchParams.get("file"));
  if (!file) return sendJson(res, 400, { error: "bad_request" });

  const db = readDb();
  const todayStart = startOfToday();
  const allowed = db.activity.some((item) => {
    const receivedAt = new Date(item.receivedAt || item.capturedAt || 0);
    return item.screenshotFile === file && receivedAt >= todayStart;
  });
  if (!allowed) return sendJson(res, 404, { error: "not_found" });

  const filePath = path.join(SHOT_DIR, file);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendJson(res, 404, { error: "not_found" });
  }

  res.writeHead(200, {
    "content-type": "image/png",
    "cache-control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

function analyzeScreenshot({ image, payload, previous, capturedAt, receivedAt }) {
  const png = inspectPng(image);
  const previousReceivedAt = previous.receivedAt ? new Date(previous.receivedAt) : null;
  const minutesFromPrevious = previousReceivedAt
    ? Math.round((receivedAt.getTime() - previousReceivedAt.getTime()) / 60000)
    : null;
  const note = String(payload.note || "").trim();
  const declaredTask = note ? `员工端备注：${note}` : "员工端未填写任务备注";
  const cadence =
    minutesFromPrevious === null
      ? "首次上报"
      : minutesFromPrevious <= 40
        ? `连续上报正常，距离上次约 ${minutesFromPrevious} 分钟`
        : `上报间隔偏长，距离上次约 ${minutesFromPrevious} 分钟`;

  return {
    status: minutesFromPrevious !== null && minutesFromPrevious > 60 ? "needs_attention" : "working",
    label: minutesFromPrevious !== null && minutesFromPrevious > 60 ? "需关注" : "疑似工作中",
    confidence: "低",
    summary:
      "系统已接收并校验员工电脑截图。当前尚未接入视觉识别模型，因此工作内容判断主要依据上报节奏、截图有效性与员工端备注生成；该结果可用于初步了解工作连续性，但不应作为最终绩效判断依据。",
    evidence: [
      `截图有效，分辨率 ${png.width || "未知"} x ${png.height || "未知"}`,
      cadence,
      declaredTask,
      `截图时间：${capturedAt.toISOString()}`,
    ],
    recommendation:
      "如需进一步识别截图中的软件、文档、网页或业务场景，建议接入 OCR 或视觉模型，以生成更准确的工作内容摘要和风险提示。",
    analyzer: "local-basic",
    analyzedAt: receivedAt.toISOString(),
  };
}

async function analyzeScreenshotSmart(args) {
  if (!process.env.GLM_API_KEY) {
    return buildVisionUnavailableAnalysis({
      receivedAt: args.receivedAt,
      reason: "未配置 GLM_API_KEY，无法调用视觉模型。",
    });
  }

  try {
    return await analyzeScreenshotWithGlm(args);
  } catch (error) {
    return buildVisionUnavailableAnalysis({
      receivedAt: args.receivedAt,
      reason: `GLM 视觉模型调用失败：${error.message}`,
    });
  }
}

function buildVisionUnavailableAnalysis({ receivedAt, reason }) {
  return {
    status: "unknown",
    label: "视觉分析失败",
    confidence: "低",
    summary: "截图已成功接收，但视觉模型暂时无法完成内容分析。当前记录仅作为上报凭证保存，不生成本地规则判断，也不推断员工工作状态。",
    evidence: [reason, "已关闭本地规则分析兜底。"],
    recommendation: "请检查 GLM API Key、模型名称、网络连接或接口额度后重新上报截图。",
    analyzer: "glm-unavailable",
    analyzedAt: receivedAt.toISOString(),
  };
}

function buildAnalysisSkippedAnalysis(receivedAt) {
  return {
    status: "unknown",
    label: "非分析时段",
    confidence: "低",
    summary: "截图已按规则保留。当前时间不在 10:00-22:00 的主管端分析时段内，因此本次上报不会调用视觉模型，也不会覆盖员工工作状态描述。",
    evidence: ["已保存截图文件", "当前上报时间位于非分析时段", "员工工作描述保持上一次有效分析结果"],
    recommendation: "可在今日截图中查看原始截图，工作内容将在 10:00-22:00 内的新上报中继续更新。",
    analyzer: "analysis-skipped",
    analyzedAt: receivedAt.toISOString(),
  };
}

function buildPendingAnalysis(receivedAt) {
  return {
    status: "unknown",
    label: "待分析",
    confidence: "低",
    summary: "已收到员工截图并完成留存，但当前不在 10:00-22:00 的分析时段内，暂不生成工作内容描述。",
    evidence: ["截图已留存", "等待分析时段内的新上报"],
    recommendation: "等待员工端在分析时段内继续上报后生成工作状态描述。",
    analyzer: "analysis-pending",
    analyzedAt: receivedAt.toISOString(),
  };
}

async function analyzeScreenshotWithGlm({ image, payload, previous, capturedAt, receivedAt }) {
  const apiUrl = process.env.GLM_API_URL || "https://open.bigmodel.cn/api/paas/v4/chat/completions";
  const model = process.env.GLM_VISION_MODEL || "glm-4.6v-flashx";
  const prompt = [
    "你是企业内部工作状态分析助手。请分析员工电脑截图，只输出 JSON，不要输出 Markdown。",
    "请避免泄露截图中的具体隐私、账号、客户姓名、手机号、密码、聊天原文等敏感细节。",
    "目标是准确描述整张截图中的事实，而不是写通用管理套话。每次描述都必须尽量基于画面中真实可见的软件、网页、文档、会议窗口、工具栏、节点、文件、进度条或操作区域。",
    "分析时必须先进行全图扫描，再做主次归纳：先观察截图的顶部、左侧、中间、右侧、底部区域，识别所有主要窗口、侧边栏、弹窗、表格、图表、状态栏和任务栏，再判断哪个区域最能代表当前工作内容。",
    "不要只分析画面中最醒目的一个局部，也不要只根据右侧面板、左侧菜单、标题栏或单个文字标签下结论。若截图中有多个窗口或多个业务区域，summary 必须说明主工作区域，同时简要提到其他可见区域与当前判断的关系。",
    "先识别主工作窗口和辅助窗口，再识别具体任务、可见动作和所处阶段。不要只写“正在推进工作”“保持专注”“任务处理”等泛化表达。",
    "重点判断屏幕中是否存在正在编辑、调试、设计、开发、数据处理、会议、沟通、文件整理、视频制作或业务系统操作的迹象。",
    "不要因为没有看到鼠标、键盘输入或聊天窗口，就轻易判定为空闲。",
    "如果画面中有开发工具、工作流节点、报错日志、管理后台、业务系统、文档编辑、设计工具、视频剪辑/生成工具、会议窗口等，应优先概括为对应的具体工作内容。",
    "截图中可能出现本系统自身页面，例如“员工工作状态分析看板”“员工状态上报”“工作状态”等监控看板或上报小程序。它们展示的是旧分析结果或采集状态，不能作为判断员工当前状态的依据。",
    "禁止把监控看板里的“空闲、正常、需关注、高置信度、工作内容描述、判断依据”等文字当作你的分析依据。",
    "如果整张截图主要是本系统监控看板，请只描述“当前截图显示在查看监控看板/系统运维页面”，不要把看板中某个员工卡片里的工作内容、状态标签或判断依据复述成该员工正在做的工作。",
    "如果监控看板旁边还有代码编辑器、终端、浏览器开发页面、业务系统等真实工作窗口，应分析这些真实工作窗口；监控看板只能作为辅助背景，不要引用其中已有分析结论。",
    "如果截图里同时有监控看板和其他工作窗口，请忽略监控看板的结论，优先分析其他窗口中的实际操作内容，例如工作流节点、错误日志、开发工具、设计工具、业务系统或文档。",
    "描述要中性、具体、可核验。可以温和表达，但不要为了积极而编造任务进展。",
    "summary 的写法请按这个顺序组织：第一句说明画面中最主要的软件/页面和工作对象；第二句说明正在执行的动作或所处阶段；第三句说明当前能确认的范围和仍需后续截图确认的部分。",
    "summary 禁止使用空泛句式，例如“积极参与”“持续推进”“保持专注”“工作状态良好”“任务处理有序”，除非截图中有明确证据支持。",
    "如果能识别到具体软件或场景，请写具体名称或类型，例如“视频制作页面”“工作流节点编辑器”“代码编辑器”“文件管理器”“会议窗口”“业务后台列表”，不要只写“软件”或“系统”。",
    "如果画面展示的是素材、参数、进度、时间线、节点、日志、表格、表单、文档段落、会议画面等，请在 summary 和 evidence 中各至少提到一个具体可见元素。",
    "evidence 应尽量覆盖不同区域或不同窗口：例如主窗口内容、侧边栏/工具栏、底部状态/任务栏、弹窗/右侧详情区。不要让所有 evidence 都来自同一个小区域，除非整张截图确实只有一个可见工作窗口。",
    "如果画面信息不足、窗口被遮挡、只看到监控看板或桌面图标，请明确写“无法从当前截图确认具体工作内容”，不要强行推断。",
    "遇到报错、延迟或异常提示时，如实描述可见现象，例如“界面出现错误提示”“进度停留在生成阶段”“正在查看参数或日志”，不要统一改写成套话。",
    "除非截图明确显示非工作内容，否则不要使用懒散、空闲、异常严重等带有强负面倾向的措辞；但也不要把无法确认的内容写成明确工作任务。",
    "evidence 必须是字符串数组，每一项只写你从实际工作窗口观察到的依据，不要返回对象。",
    "只有在屏幕明显为桌面空白、锁屏、娱乐内容、长时间无任务界面或无可识别工作信息时，才使用 idle。",
    "你需要概括员工当前工作内容，并判断状态。字段必须是：",
    "{",
    '  "status": "working | meeting | idle | needs_attention | unknown",',
    '  "label": "中文短标签，必须具体，例如：视频剪辑、参数调试、文档编辑、会议沟通、文件整理；不要只写工作中",',
    '  "confidence": "高 | 中 | 低",',
    '  "summary": "180到300字，写成2到4句。必须包含：整张截图中可见的主要窗口/页面类型、辅助区域或次要窗口、正在处理的具体对象、当前动作或阶段、能看清和不能确认的边界。语言要像主管看板描述，准确、自然、少套话",',
    '  "evidence": ["最多5条判断依据，每条都写具体可见元素，并尽量来自不同区域或不同窗口，例如窗口类型、侧边栏、按钮、进度条、文件名类型、节点、日志、时间线、表格、会议画面、底部状态栏，避免敏感细节"],',
    '  "recommendation": "基于当前截图给出一个可执行的简短建议；不要泛泛写继续关注"',
    "}",
    `员工端备注：${String(payload.note || "无")}`,
    `截图时间：${capturedAt.toISOString()}`,
    previous?.receivedAt ? `上次上报时间：${previous.receivedAt}` : "上次上报时间：首次上报",
    `接收时间：${receivedAt.toISOString()}`,
  ].join("\n");

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.GLM_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${image.toString("base64")}`,
              },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 180)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  const parsed = parseModelJson(content);
  return normalizeVisionAnalysis(parsed, receivedAt);
}

function parseModelJson(content) {
  const text = Array.isArray(content)
    ? content.map((item) => item.text || item.content || "").join("\n")
    : String(content || "");
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error("模型未返回 JSON");
  }
  return JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
}

function normalizeVisionAnalysis(value, receivedAt) {
  const allowedStatus = new Set(["working", "meeting", "idle", "needs_attention", "unknown"]);
  const confidence = ["高", "中", "低"].includes(value.confidence) ? value.confidence : "中";
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.slice(0, 5).map(formatEvidenceItem).filter(Boolean)
    : [];
  const rawStatus = allowedStatus.has(value.status) ? value.status : "unknown";
  const rawLabel = String(value.label || "视觉分析").slice(0, 24);
  const rawSummary = String(value.summary || "已完成截图视觉分析，但模型未返回明确的工作内容描述。").slice(0, 520);
  const rawRecommendation = String(value.recommendation || "建议继续观察后续上报情况。").slice(0, 120);
  const corrected = correctContradictoryIdleAnalysis({
    status: rawStatus,
    label: rawLabel,
    confidence,
    summary: rawSummary,
    evidence,
    recommendation: rawRecommendation,
  });
  return {
    status: corrected.status,
    label: corrected.label,
    confidence: corrected.confidence,
    summary: corrected.summary,
    evidence: corrected.evidence,
    recommendation: corrected.recommendation,
    analyzer: "glm-vision",
    analyzedAt: receivedAt.toISOString(),
  };
}

function correctContradictoryIdleAnalysis(analysis) {
  if (!["idle", "unknown"].includes(analysis.status)) {
    return analysis;
  }

  const text = [analysis.label, analysis.summary, analysis.recommendation, ...analysis.evidence].join(" ");
  const workCues = [
    "工作流",
    "节点",
    "错误日志",
    "报错",
    "调试",
    "开发",
    "代码",
    "后台",
    "管理系统",
    "设计",
    "文档",
    "数据",
    "业务",
    "配置",
    "流程",
    "接口",
    "模型",
    "排查",
    "异常",
  ];
  const hasWorkCue = workCues.some((cue) => text.includes(cue));
  if (!hasWorkCue) {
    return analysis;
  }

  return {
    ...analysis,
    status: "working",
    label: ["空闲", "未知状态", "视觉分析"].includes(analysis.label) ? "疑似工作界面" : analysis.label,
    confidence: "中",
    summary: analysis.summary,
    recommendation: analysis.recommendation || "建议结合下一次截图继续确认具体工作内容和任务进展。",
    evidence: analysis.evidence,
  };
}

function formatEvidenceItem(item) {
  if (item === null || item === undefined) return "";
  if (typeof item === "string") return item.slice(0, 120);
  if (typeof item === "number" || typeof item === "boolean") return String(item);
  if (typeof item === "object") {
    const values = Object.values(item)
      .flat()
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    return values.join("；").slice(0, 120);
  }
  return String(item).slice(0, 120);
}

function inspectPng(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  return { width: null, height: null };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isAuthorized(req) {
  const authorization = req.headers.authorization || "";
  const token = req.headers["x-monitor-token"] || "";
  return authorization === `Bearer ${API_TOKEN}` || token === API_TOKEN;
}

function isScreenshotSessionAuthorized(url) {
  pruneScreenshotSessions();
  const token = String(url.searchParams.get("session") || "");
  const expiresAt = screenshotSessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    screenshotSessions.delete(token);
    return false;
  }
  return true;
}

function pruneScreenshotSessions() {
  const now = Date.now();
  for (const [token, expiresAt] of screenshotSessions.entries()) {
    if (expiresAt <= now) screenshotSessions.delete(token);
  }
}

function required(value, field) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value;
}

function normalizeImage(value) {
  const input = String(required(value, "imageBase64"));
  const base64 = input.includes(",") ? input.split(",").pop() : input;
  const buffer = Buffer.from(base64, "base64");

  if (buffer.length < 16) {
    throw new Error("imageBase64 is not a valid screenshot");
  }

  const pngHeader = buffer.subarray(0, 8).toString("hex");
  if (pngHeader !== "89504e470d0a1a0a") {
    throw new Error("only PNG screenshots are accepted");
  }

  return buffer;
}

function readDb() {
  try {
    return normalizeDb(JSON.parse(fs.readFileSync(DB_FILE, "utf8")));
  } catch {
    return { employees: {}, activity: [], messages: [] };
  }
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function isAnalysisWindow(date = new Date()) {
  const localMinutes = date.getHours() * 60 + date.getMinutes();
  return localMinutes >= ANALYSIS_START_MINUTES && localMinutes < ANALYSIS_END_MINUTES;
}

function cleanupOldScreenshots() {
  const todayStart = startOfToday();
  const db = readDb();
  const keptActivity = [];
  const keepFiles = new Set();

  for (const item of db.activity || []) {
    const receivedAt = new Date(item.receivedAt || item.capturedAt || 0);
    if (receivedAt >= todayStart) {
      keptActivity.push(item);
      if (item.screenshotFile) keepFiles.add(item.screenshotFile);
    }
  }

  for (const employee of Object.values(db.employees || {})) {
    const receivedAt = new Date(employee.receivedAt || employee.capturedAt || 0);
    if (receivedAt >= todayStart && employee.screenshotFile) {
      keepFiles.add(employee.screenshotFile);
    } else if (receivedAt < todayStart) {
      delete employee.screenshotFile;
      delete employee.screenshotUrl;
    }
  }

  let deletedFiles = 0;
  if (fs.existsSync(SHOT_DIR)) {
    for (const file of fs.readdirSync(SHOT_DIR)) {
      const filePath = path.join(SHOT_DIR, file);
      if (!fs.statSync(filePath).isFile()) continue;
      if (!keepFiles.has(file)) {
        fs.rmSync(filePath, { force: true });
        deletedFiles += 1;
      }
    }
  }

  db.activity = keptActivity.slice(0, 500);
  writeDb(db);
  console.log(`Screenshot cleanup: removed ${deletedFiles} old files, kept ${db.activity.length} today records.`);
}

function scheduleMidnightCleanup() {
  const now = new Date();
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 5, 0);
  setTimeout(() => {
    cleanupOldScreenshots();
    scheduleMidnightCleanup();
  }, Math.max(1000, next.getTime() - now.getTime()));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function serveStatic(urlPath, res) {
  const decoded = decodeURIComponent(urlPath.replace(/^\/+/, ""));
  if (decoded.startsWith("monitor-data/screenshots/")) {
    return sendJson(res, 403, { error: "forbidden" });
  }
  const filePath = path.normalize(path.join(__dirname, decoded));

  if (!filePath.startsWith(__dirname)) {
    return sendJson(res, 403, { error: "forbidden" });
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendJson(res, 404, { error: "not_found" });
  }

  serveFile(res, filePath);
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "content-type": mimeTypes[ext] || "application/octet-stream",
    "cache-control": ext === ".html" ? "no-store" : "public, max-age=60",
  });
  fs.createReadStream(filePath).pipe(res);
}

function safeId(value) {
  return String(value).trim().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
}

function getEmployeeIdentity({ employeeId, computerName }) {
  const computerId = safeId(computerName || "");
  return computerId || safeId(employeeId || "");
}

function safeScreenshotFile(value) {
  const file = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]+-[0-9T-]+Z-[a-f0-9]{12}\.png$/.test(file)) return "";
  return file;
}

function toFileStamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

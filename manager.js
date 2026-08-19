const MODULE_REFRESH_MS = 10 * 60 * 1000;
const LATE_AFTER_MINUTES = 45;
const OFFLINE_AFTER_MINUTES = 90;
const ANALYSIS_START_MINUTES = 10 * 60;
const ANALYSIS_END_MINUTES = 22 * 60;

let dashboard = { employees: {}, activity: [] };
let selectedEmployeeId = "";
let filters = { search: "", status: "all" };
let usingLocalDemo = false;
let metricAnimationFrame = 0;
let previousMetricValues = new Map();
let screenshotSessionToken = "";
let detailCollapsed = true;
let currentScreenshotItems = [];

try {
  localStorage.removeItem("manager-message-token");
} catch {
  // Ignore storage restrictions; password fields are still cleared on dialog open.
}

const els = {
  refreshBtn: document.querySelector("#refreshBtn"),
  headerClock: document.querySelector("#headerClock"),
  lastRefresh: document.querySelector("#lastRefresh"),
  metrics: document.querySelector("#managerMetrics"),
  grid: document.querySelector("#snapshotGrid"),
  detail: document.querySelector("#screenshotDetail"),
  timeline: document.querySelector("#managerTimeline"),
  recentPanel: document.querySelector("#recentPanel"),
  toggleRecentBtn: document.querySelector("#toggleRecentBtn"),
  messageDialog: document.querySelector("#messageDialog"),
  messageTokenInput: document.querySelector("#messageTokenInput"),
  messageOptions: document.querySelector("#messageOptions"),
  selectedMessageLabel: document.querySelector("#selectedMessageLabel"),
  sendMessageBtn: document.querySelector("#sendMessageBtn"),
  closeMessageDialog: document.querySelector("#closeMessageDialog"),
  openBroadcastBtn: document.querySelector("#openBroadcastBtn"),
  broadcastDialog: document.querySelector("#broadcastDialog"),
  closeBroadcastDialog: document.querySelector("#closeBroadcastDialog"),
  broadcastTokenInput: document.querySelector("#broadcastTokenInput"),
  broadcastMessageInput: document.querySelector("#broadcastMessageInput"),
  broadcastFeedback: document.querySelector("#broadcastFeedback"),
  sendBroadcastBtn: document.querySelector("#sendBroadcastBtn"),
  openScreenshotsBtn: document.querySelector("#openScreenshotsBtn"),
  screenshotDialog: document.querySelector("#screenshotDialog"),
  closeScreenshotDialog: document.querySelector("#closeScreenshotDialog"),
  screenshotPasswordInput: document.querySelector("#screenshotPasswordInput"),
  loadScreenshotsBtn: document.querySelector("#loadScreenshotsBtn"),
  screenshotFeedback: document.querySelector("#screenshotFeedback"),
  screenshotGrid: document.querySelector("#screenshotGrid"),
  screenshotPreview: document.querySelector("#screenshotPreview"),
  screenshotPreviewImage: document.querySelector("#screenshotPreviewImage"),
  screenshotPreviewTitle: document.querySelector("#screenshotPreviewTitle"),
  screenshotPreviewMeta: document.querySelector("#screenshotPreviewMeta"),
  closeScreenshotPreview: document.querySelector("#closeScreenshotPreview"),
  search: document.querySelector("#managerSearch"),
  status: document.querySelector("#managerStatus"),
  charts: {
    status: document.querySelector("#statusChart"),
    department: document.querySelector("#departmentChart"),
    trend: document.querySelector("#trendChart"),
    confidence: document.querySelector("#confidenceChart"),
  },
};

const reminderTemplates = [
  {
    title: "工作提醒",
    tag: "提醒",
    message: "请关注当前工作进度，如遇到阻塞请及时反馈。",
  },
  {
    title: "进度关怀",
    tag: "关怀",
    message: "看到你已经持续工作一段时间了，辛苦了。有需要协助的地方可以随时说明。",
  },
  {
    title: "休息慰问",
    tag: "慰问",
    message: "注意适当休息，长时间专注后可以稍微放松一下，保持好状态。",
  },
  {
    title: "沟通确认",
    tag: "确认",
    message: "请确认当前任务是否按计划推进，如有变更请及时同步。",
  },
];

function minutesSince(date) {
  return Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
}

function isAnalysisWindow(date = new Date()) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  return minutes >= ANALYSIS_START_MINUTES && minutes < ANALYSIS_END_MINUTES;
}

function classify(employee) {
  if (!isAnalysisWindow()) {
    return { key: "paused", label: "非分析时段", text: "10:00-22:00 更新工作状态" };
  }
  const minutes = minutesSince(employee.receivedAt);
  if (minutes > OFFLINE_AFTER_MINUTES) {
    return { key: "offline", label: "离线", text: `${minutes} 分钟未上报` };
  }
  if (minutes > LATE_AFTER_MINUTES) {
    return { key: "late", label: "延迟", text: `${minutes} 分钟未上报` };
  }
  return { key: "online", label: "正常", text: `${minutes} 分钟前上报` };
}

function formatTime(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(date));
}

function employeeList() {
  const keyword = filters.search.trim().toLowerCase();
  return Object.values(dashboard.employees)
    .filter((employee) => {
      const state = classify(employee);
      const haystack = [
        employee.employeeName,
        employee.department,
        employee.computerName,
        employee.employeeId,
      ]
        .join(" ")
        .toLowerCase();
      const matchesSearch = haystack.includes(keyword);
      const matchesStatus = filters.status === "all" || filters.status === state.key;
      return matchesSearch && matchesStatus;
    })
    .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
}

async function fetchDashboardData() {
  const response = await fetch("/api/snapshots", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`读取失败：${response.status}`);
  }
  return response.json();
}

function syncSelectedEmployee() {
  const employees = Object.values(dashboard.employees);
  const selectedStillExists = employees.some((employee) => employee.employeeId === selectedEmployeeId);
  if ((!selectedEmployeeId || !selectedStillExists) && employees.length) {
    selectedEmployeeId = employees.sort(
      (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
    )[0].employeeId;
  }
}

function updateLastRefreshLabel() {
  els.lastRefresh.textContent = `更新于 ${new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date())}`;
}

async function loadData() {
  dashboard = await fetchDashboardData();
  syncSelectedEmployee();
  render();
}

async function refreshEmployeeModules() {
  dashboard = await fetchDashboardData();
  syncSelectedEmployee();
  renderGrid();
  renderDetail();
  updateLastRefreshLabel();
}

function getLocalDemoDashboard() {
  const now = Date.now();
  const makeEmployee = (offsetMinutes, employee) => {
    const time = new Date(now - offsetMinutes * 60 * 1000).toISOString();
    return {
      capturedAt: time,
      receivedAt: time,
      totalSnapshots: employee.totalSnapshots,
      ...employee,
    };
  };
  const employees = [
    makeEmployee(6, {
      employeeId: "me",
      employeeName: "我的测试信息",
      department: "测试信息",
      computerName: "当前电脑",
      totalSnapshots: 12,
      analysis: {
        label: "正常工作",
        confidence: "中",
        summary: "当前工作内容聚焦于员工状态监控平台的体验升级与数据联调，正在持续优化模块布局、实时反馈、统计图表和消息提醒流程。整体推进节奏清晰，界面呈现与交互链路已形成较好的迭代基础。",
        evidence: ["最近 6 分钟内完成上报", "页面核心模块保持正常展示", "正在推进监控台交互与数据呈现优化"],
        recommendation: "建议延续当前优化节奏，继续完善截图识别、工作内容分类和日报汇总能力。",
      },
    }),
    makeEmployee(22, {
      employeeId: "demo-ops",
      employeeName: "运营测试",
      department: "运营部",
      computerName: "OPS-PC",
      totalSnapshots: 9,
      analysis: {
        label: "任务推进中",
        confidence: "中",
        summary: "当前工作内容主要围绕运营数据整理、资料核对与信息归档展开，任务路径较为清晰。上报节奏连续稳定，屏幕行为与运营类日常处理场景匹配，整体呈现出有序推进和持续跟进的工作状态。",
        evidence: ["最近 22 分钟内完成上报", "连续上报间隔正常", "工作内容与运营数据处理场景匹配"],
        recommendation: "可在下一次上报后继续观察任务推进节奏，适时确认是否进入整理收尾阶段。",
      },
    }),
    makeEmployee(58, {
      employeeId: "demo-dev",
      employeeName: "研发测试",
      department: "研发部",
      computerName: "DEV-PC",
      totalSnapshots: 7,
      analysis: {
        label: "上报延迟",
        confidence: "低",
        summary: "当前最新截图依据暂不够连续，系统正在等待后续上报以补充判断。结合最近一次上报时间看，员工可能处于较长时间的专注处理、临时切换场景或员工端待恢复状态，建议温和跟进确认。",
        evidence: ["最近 58 分钟未上报", "超过默认 30 分钟采集间隔", "尚未达到离线阈值"],
        recommendation: "建议发送轻量提醒，协助确认员工端运行状态并补充后续截图依据。",
      },
    }),
    makeEmployee(126, {
      employeeId: "demo-service",
      employeeName: "客服测试",
      department: "客服部",
      computerName: "CS-PC",
      totalSnapshots: 4,
      analysis: {
        label: "需关注",
        confidence: "低",
        summary: "当前较长时间未收到新的截图上报，系统暂时无法补充最新工作内容判断。该情况可能与员工端连接、网络状态或程序运行有关，建议优先做一次友好确认，以便恢复连续记录。",
        evidence: ["最近 126 分钟未上报", "超过离线判断阈值", "今日累计上报次数偏少"],
        recommendation: "建议优先确认员工端程序和网络状态，帮助后续上报恢复连续。",
      },
    }),
  ];

  const employeeMap = {};
  employees.forEach((employee) => {
    employeeMap[employee.employeeId] = employee;
  });

  return {
    employees: employeeMap,
    activity: buildDemoActivity(employees, now),
  };
}

function buildDemoActivity(employees, now) {
  const activity = [];
  employees.forEach((employee, employeeIndex) => {
    Array.from({ length: Math.max(1, Math.min(employee.totalSnapshots, 6)) }, (_, index) => {
      const time = new Date(now - (index * 28 + employeeIndex * 9 + 6) * 60 * 1000).toISOString();
      activity.push({
        ...employee,
        capturedAt: time,
        receivedAt: time,
      });
    });
  });
  return activity;
}

function render() {
  renderMetrics();
  renderGrid();
  renderDetail();
  renderCharts();
  renderTimeline();
  updateLastRefreshLabel();
}

function animateMetricValues() {
  window.cancelAnimationFrame(metricAnimationFrame);
  const items = [...document.querySelectorAll("[data-metric-target]")].map((element) => ({
    element,
    key: element.dataset.metricKey,
    target: Number(element.dataset.metricTarget),
    suffix: element.dataset.metricSuffix || "",
    start: previousMetricValues.has(element.dataset.metricKey)
      ? previousMetricValues.get(element.dataset.metricKey)
      : Number(element.dataset.metricTarget),
  }));
  const startedAt = performance.now();
  const duration = 720;

  function tick(now) {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    items.forEach((item) => {
      const value = Math.round(item.start + (item.target - item.start) * eased);
      item.element.textContent = `${value}${item.suffix}`;
    });
    if (progress < 1) {
      metricAnimationFrame = window.requestAnimationFrame(tick);
    } else {
      items.forEach((item) => previousMetricValues.set(item.key, item.target));
    }
  }

  metricAnimationFrame = window.requestAnimationFrame(tick);
}

function renderHeaderClock() {
  els.headerClock.textContent = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function renderCharts() {
  const employees = Object.values(dashboard.employees);
  const activity = dashboard.activity || [];
  renderStatusChart(els.charts.status, employees);
  renderDepartmentChart(els.charts.department, employees);
  renderTrendChart(els.charts.trend, activity);
  renderConfidenceChart(els.charts.confidence, employees);
}

function setupCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = "13px Microsoft YaHei, Segoe UI, Arial";
  ctx.textBaseline = "middle";
  return { ctx, width, height };
}

function themeColor(name, fallback) {
  return getComputedStyle(document.querySelector(".manager-shell"))
    .getPropertyValue(name)
    .trim() || fallback;
}

function renderStatusChart(canvas, employees) {
  const { ctx, width, height } = setupCanvas(canvas);
  const counts = employees.reduce(
    (acc, employee) => {
      acc[classify(employee).key] += 1;
      return acc;
    },
    { online: 0, late: 0, offline: 0, paused: 0 },
  );
  const data = [
    { label: "正常", value: counts.online, color: "#17845c" },
    { label: "延迟", value: counts.late, color: "#b7791f" },
    { label: "离线", value: counts.offline, color: "#b84747" },
    { label: "非分析", value: counts.paused, color: "#6f86a8" },
  ];
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const cx = width * 0.31;
  const cy = height * 0.52;
  const radius = Math.min(width, height) * 0.31;
  let start = -Math.PI / 2;

  if (!total) {
    drawEmptyChart(ctx, width, height);
    return;
  }

  data.forEach((item) => {
    const slice = (Math.PI * 2 * item.value) / total;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, start, start + slice);
    ctx.closePath();
    ctx.fillStyle = item.color;
    ctx.fill();
    start += slice;
  });

  ctx.beginPath();
  ctx.fillStyle = themeColor("--panel", "#171d22");
  ctx.arc(cx, cy, radius * 0.58, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = themeColor("--text", "#edf3f4");
  ctx.font = "800 24px Microsoft YaHei, Segoe UI, Arial";
  ctx.textAlign = "center";
  ctx.fillText(String(total), cx, cy - 6);
  ctx.font = "13px Microsoft YaHei, Segoe UI, Arial";
  ctx.fillStyle = themeColor("--muted", "#96a4aa");
  ctx.fillText("员工", cx, cy + 16);

  drawLegend(ctx, data, width * 0.62, Math.max(46, height * 0.38));
}

function renderDepartmentChart(canvas, employees) {
  const { ctx, width, height } = setupCanvas(canvas);
  const groups = employees.reduce((acc, employee) => {
    const key = employee.department || "未分组";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const data = Object.entries(groups)
    .map(([label, value], index) => ({
      label,
      value,
      color: index % 2 === 0 ? "#126b66" : "#d67d36",
    }))
    .slice(0, 6);

  if (!data.length) {
    drawEmptyChart(ctx, width, height);
    return;
  }

  const max = Math.max(...data.map((item) => item.value), 1);
  const left = 78;
  const top = 34;
  const barHeight = 20;
  const gap = 16;
  ctx.textAlign = "left";

  data.forEach((item, index) => {
    const y = top + index * (barHeight + gap);
    const barWidth = Math.max(8, ((width - left - 28) * item.value) / max);
    ctx.fillStyle = themeColor("--muted", "#96a4aa");
    ctx.fillText(trimLabel(item.label, 5), 4, y + barHeight / 2);
    drawRoundRect(ctx, left, y, width - left - 14, barHeight, 9, themeColor("--panel-soft", "#202930"));
    drawRoundRect(ctx, left, y, barWidth, barHeight, 8, item.color);
    ctx.fillStyle = themeColor("--text", "#edf3f4");
    ctx.fillText(String(item.value), left + barWidth + 6, y + barHeight / 2);
  });
}

function renderTrendChart(canvas, activity) {
  const { ctx, width, height } = setupCanvas(canvas);
  const groups = [...activity]
    .filter((item) => new Date(item.receivedAt).toDateString() === new Date().toDateString())
    .sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime())
    .reduce((acc, item) => {
      const key = new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
      }).format(new Date(item.receivedAt));
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  const points = Object.entries(groups)
    .map(([label, value]) => ({ label, value }))
    .slice(-8);

  if (!points.length) {
    drawEmptyChart(ctx, width, height);
    return;
  }

  const left = 28;
  const right = width - 18;
  const top = 34;
  const bottom = height - 36;
  const step = points.length > 1 ? (right - left) / (points.length - 1) : 0;
  const max = Math.max(...points.map((point) => point.value), 1);

  ctx.strokeStyle = themeColor("--line", "#2b363d");
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 4; i += 1) {
    const y = top + ((bottom - top) / 3) * i;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "#126b66";
  ctx.lineWidth = 4;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = left + step * index;
    const y = bottom - (point.value / max) * (bottom - top) * 0.82;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  points.forEach((point, index) => {
    const x = left + step * index;
    const y = bottom - (point.value / max) * (bottom - top) * 0.82;
    ctx.beginPath();
    ctx.fillStyle = "#d67d36";
    ctx.arc(x, y, 4.8, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = themeColor("--muted", "#96a4aa");
  ctx.textAlign = "left";
  ctx.fillText(`今日 ${getTodayActivity().length} 次上报`, left, height - 14);
}

function renderConfidenceChart(canvas, employees) {
  const { ctx, width, height } = setupCanvas(canvas);
  const counts = employees.reduce(
    (acc, employee) => {
      const confidence = getAnalysis(employee).confidence || "低";
      acc[confidence] = (acc[confidence] || 0) + 1;
      return acc;
    },
    { 高: 0, 中: 0, 低: 0 },
  );
  const data = [
    { label: "高", value: counts["高"] || 0, color: "#17845c" },
    { label: "中", value: counts["中"] || 0, color: "#4c6fb3" },
    { label: "低", value: counts["低"] || 0, color: "#b7791f" },
  ];
  const max = Math.max(...data.map((item) => item.value), 1);
  const barWidth = Math.min(58, (width - 84) / data.length);
  const bottom = height - 38;
  const top = 34;
  const gap = (width - barWidth * data.length) / (data.length + 1);

  data.forEach((item, index) => {
    const x = gap + index * (barWidth + gap);
    const barHeight = ((bottom - top) * item.value) / max;
    drawRoundRect(ctx, x, bottom - barHeight, barWidth, Math.max(6, barHeight), 8, item.color);
    ctx.fillStyle = themeColor("--text", "#edf3f4");
    ctx.textAlign = "center";
    ctx.fillText(String(item.value), x + barWidth / 2, bottom - barHeight - 10);
    ctx.fillStyle = themeColor("--muted", "#96a4aa");
    ctx.fillText(item.label, x + barWidth / 2, bottom + 16);
  });
}

function drawLegend(ctx, data, x, y) {
  ctx.textAlign = "left";
  ctx.font = "700 13px Microsoft YaHei, Segoe UI, Arial";
  data.forEach((item, index) => {
    const top = y + index * 27;
    ctx.fillStyle = item.color;
    ctx.beginPath();
    ctx.arc(x, top, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = themeColor("--text", "#edf3f4");
    ctx.fillText(`${item.label} ${item.value}`, x + 14, top);
  });
}

function drawRoundRect(ctx, x, y, width, height, radius, color) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawEmptyChart(ctx, width, height) {
  ctx.fillStyle = themeColor("--muted", "#96a4aa");
  ctx.textAlign = "center";
  ctx.fillText("暂无数据", width / 2, height / 2);
}

function trimLabel(label, maxLength) {
  return label.length > maxLength ? `${label.slice(0, maxLength)}...` : label;
}

function renderMetrics() {
  const employees = Object.values(dashboard.employees);
  const counts = employees.reduce(
    (acc, employee) => {
      acc[classify(employee).key] += 1;
      return acc;
    },
    { online: 0, late: 0, offline: 0, paused: 0 },
  );
  const todayCount = getTodayActivity().length;
  const analysisOpen = isAnalysisWindow();
  const attentionCount = analysisOpen ? counts.late + counts.offline : 0;
  const onlineRate = analysisOpen && employees.length ? Math.round((counts.online / employees.length) * 100) : 0;
  const averageGap = getAverageReportGapMinutes();

  const metrics = [
    { key: "onlineRate", label: "2 · 在线率", value: onlineRate, suffix: "%", color: "#5fd0c7" },
    { key: "attention", label: "需关注", value: attentionCount, suffix: "", color: attentionCount ? "#ff7d7d" : "#5ed59d" },
    { key: "today", label: "今日上报", value: todayCount, suffix: "", color: "#e3a15f" },
    { key: "averageGap", label: "平均间隔", value: averageGap === null ? 0 : averageGap, suffix: averageGap === null ? "" : "m", color: "#8eaef2" },
  ];

  const maxMetricValue = Math.max(1, employees.length, todayCount, averageGap || 0);
  els.metrics.innerHTML = metrics
    .map(
      (item) => `
        <article class="metric-card metric-card-live" style="--metric-color:${item.color}">
          <span class="metric-label">${item.label}</span>
          <strong data-metric-key="${item.key}" data-metric-target="${item.value}" data-metric-suffix="${item.suffix}">${previousMetricValues.has(item.key) ? previousMetricValues.get(item.key) : item.value}${item.suffix}</strong>
          <div class="metric-line"><i style="width:${getMetricWidth(item, maxMetricValue)}%"></i></div>
        </article>
      `,
    )
    .join("");
  animateMetricValues();
}

function getTodayActivity() {
  const today = new Date().toDateString();
  return (dashboard.activity || []).filter((item) => new Date(item.receivedAt).toDateString() === today);
}

function getAverageReportGapMinutes() {
  const activity = [...(dashboard.activity || [])].sort(
    (a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime(),
  );
  if (activity.length < 2) return null;
  const gaps = activity.slice(1).map((item, index) => {
    const previous = activity[index];
    return Math.max(0, Math.round((new Date(item.receivedAt) - new Date(previous.receivedAt)) / 60000));
  });
  return Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length);
}

function getMetricWidth(item, maxMetricValue) {
  if (item.suffix === "%") {
    return Number(item.value) || 0;
  }
  const numeric = Number(item.value);
  if (!Number.isFinite(numeric)) return 20;
  return Math.max(8, Math.min(100, (numeric / maxMetricValue) * 100));
}

function renderGrid() {
  const employees = employeeList();

  if (!employees.length) {
    els.grid.innerHTML = `
      <div class="empty-state">
        <div>
          <strong>还没有分析记录</strong>
          <span>员工端上报截图后会自动生成状态描述。</span>
        </div>
      </div>
    `;
    return;
  }

  els.grid.innerHTML = employees.map(renderCard).join("");
}

function renderCard(employee) {
  const state = classify(employee);
  return `
    <article class="snapshot-card ${employee.employeeId === selectedEmployeeId ? "selected" : ""}">
      <button class="snapshot-main" type="button" data-id="${escapeAttr(employee.employeeId)}">
        <div class="snapshot-body">
          <div class="snapshot-title">
            <div>
              <h4>${escapeHtml(employee.employeeName)}</h4>
              <div class="muted">${escapeHtml(employee.department || "未分组")} · ${escapeHtml(employee.computerName || "未知电脑")}</div>
            </div>
            <span class="status-dot state-${state.key}">${state.label}</span>
          </div>
          <div class="content-description-kicker">工作内容描述</div>
          <p class="analysis-summary">${escapeHtml(getAnalysis(employee).summary)}</p>
          <div class="analysis-label">${escapeHtml(getAnalysis(employee).label)} · ${escapeHtml(getAnalysis(employee).confidence)}置信度</div>
          <div class="muted">${state.text} · 共分析 ${employee.totalSnapshots || 1} 次</div>
        </div>
      </button>
      <button class="notify-button" type="button" data-notify-id="${escapeAttr(employee.employeeId)}" title="发送消息提醒">
        ✉
      </button>
    </article>
  `;
}

let pendingMessageEmployeeId = "";
let selectedReminderIndex = null;

function openReminderDialog(employeeId) {
  const employee = dashboard.employees[employeeId];
  if (!employee) return;

  pendingMessageEmployeeId = employeeId;
  selectedReminderIndex = null;
  els.messageTokenInput.value = "";
  resetMessageDialogFeedback();
  els.sendMessageBtn.disabled = false;
  els.messageOptions.innerHTML = reminderTemplates
    .map(
      (item, index) => `
        <button class="message-option" type="button" data-template-index="${index}">
          <span class="message-tag">${escapeHtml(item.tag)}</span>
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.message)}</span>
          <em>点击发送</em>
        </button>
      `,
    )
    .join("");
  els.messageDialog.showModal();
}

async function sendReminder(employeeId, message) {
  const employee = dashboard.employees[employeeId];
  if (!employee || !message || !message.trim()) return;

  let token = els.messageTokenInput.value.trim();
  if (!token) {
    showMessageDialogError("请先输入通信密钥");
    els.messageTokenInput.focus();
    return;
  }

  const response = await fetch("/api/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      employeeId,
      employeeName: employee.employeeName,
      message: message.trim(),
    }),
  });

  if (response.status === 401) {
    throw new Error("密钥不正确，请重新发送并输入正确密钥。");
  }

  if (!response.ok) {
    throw new Error(`发送失败：${response.status}`);
  }

  showMessageDialogSuccess(`已发送给 ${employee.employeeName}`);
  setTimeout(() => {
    if (els.messageDialog.open) els.messageDialog.close();
  }, 700);
}

function openBroadcastDialog() {
  els.broadcastTokenInput.value = "";
  els.broadcastMessageInput.value = "";
  showBroadcastFeedback("最多 300 字，发送后员工端会在下次轮询时收到。", false);
  els.broadcastDialog.showModal();
  setTimeout(() => {
    els.broadcastMessageInput.focus();
  }, 50);
}

async function sendBroadcast() {
  const token = els.broadcastTokenInput.value.trim();
  const message = els.broadcastMessageInput.value.trim();
  if (!token) {
    showBroadcastFeedback("请先输入通信密钥", true);
    els.broadcastTokenInput.focus();
    return;
  }
  if (!message) {
    showBroadcastFeedback("请先输入通知内容", true);
    els.broadcastMessageInput.focus();
    return;
  }

  els.sendBroadcastBtn.disabled = true;
  showBroadcastFeedback("正在广播...", false);

  try {
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        broadcast: true,
        message,
      }),
    });

    if (response.status === 401) {
      throw new Error("密钥不正确，请重新输入");
    }
    if (!response.ok) {
      throw new Error(`广播失败：${response.status}`);
    }

    const result = await response.json();
    showBroadcastFeedback(`已广播给 ${result.count || 0} 名员工`, false, true);
    setTimeout(() => {
      if (els.broadcastDialog.open) els.broadcastDialog.close();
    }, 900);
  } catch (error) {
    showBroadcastFeedback(error.message || "广播失败", true);
  } finally {
    els.sendBroadcastBtn.disabled = false;
  }
}

function showBroadcastFeedback(text, isError, isSuccess = false) {
  els.broadcastFeedback.textContent = text;
  els.broadcastFeedback.classList.toggle("error", Boolean(isError));
  els.broadcastFeedback.classList.toggle("success", Boolean(isSuccess));
}

function showMessageDialogSuccess(text) {
  els.selectedMessageLabel.textContent = text;
  els.selectedMessageLabel.classList.remove("error");
  els.selectedMessageLabel.classList.add("success");
}

function showMessageDialogError(text) {
  els.selectedMessageLabel.textContent = text;
  els.selectedMessageLabel.classList.remove("success");
  els.selectedMessageLabel.classList.add("error");
}

function resetMessageDialogFeedback(text = "请选择一条消息内容") {
  els.selectedMessageLabel.textContent = text;
  els.selectedMessageLabel.classList.remove("error", "success");
}

function renderDetail() {
  const employee = dashboard.employees[selectedEmployeeId];
  if (!employee) {
    els.detail.innerHTML = `<div class="detail-empty">选择一条截图查看详情</div>`;
    return;
  }

  const state = classify(employee);
  const analysis = getAnalysis(employee);
  els.detail.innerHTML = `
    <div class="panel-header">
      <div>
        <h3>4 · ${escapeHtml(employee.employeeName)}</h3>
        <p>${escapeHtml(employee.department || "未分组")} · ${escapeHtml(employee.employeeId)}</p>
      </div>
      <span class="status-dot state-${state.key}">${state.label}</span>
    </div>
    <div class="detail-body">
      <div class="analysis-panel ${detailCollapsed ? "collapsed" : ""}">
        <span class="analysis-badge">${escapeHtml(analysis.label)}</span>
        <strong class="content-description-title">工作内容描述</strong>
        <p>${escapeHtml(analysis.summary)}</p>
        <button class="detail-toggle" type="button" data-detail-toggle aria-label="${detailCollapsed ? "展开工作内容描述" : "折叠工作内容描述"}">${detailCollapsed ? "﹀" : "︿"}</button>
      </div>
      <div class="evidence-list">
        ${(analysis.evidence || []).map((item) => `<div>${escapeHtml(item)}</div>`).join("")}
      </div>
      <div class="detail-meta">
        <div class="meta-box"><span>截图时间</span><strong>${formatTime(employee.capturedAt)}</strong></div>
        <div class="meta-box"><span>接收时间</span><strong>${formatTime(employee.receivedAt)}</strong></div>
        <div class="meta-box"><span>电脑名</span><strong>${escapeHtml(employee.computerName || "未知")}</strong></div>
        <div class="meta-box"><span>累计分析</span><strong>${employee.totalSnapshots || 1}</strong></div>
      </div>
      <p class="muted">${escapeHtml(analysis.recommendation || "")}</p>
    </div>
  `;
}

function renderTimeline() {
  const items = (dashboard.activity || []).slice(0, 50);
  if (!items.length) {
    els.timeline.innerHTML = `<div class="empty-state">暂无上报记录</div>`;
    return;
  }

  els.timeline.innerHTML = items
    .map((item) => {
      const employee = dashboard.employees[item.employeeId] || item;
      const state = classify(employee);
      return `
        <div class="manager-timeline-item">
          <span class="timeline-dot" style="background:${getStateColor(state.key)}"></span>
          <div>
            <strong>${escapeHtml(item.employeeName)}</strong>
            <div class="muted">${escapeHtml(getAnalysis(item).label)} · ${escapeHtml(item.department || "未分组")} · ${escapeHtml(item.computerName || "未知电脑")}</div>
          </div>
          <span class="muted">${formatTime(item.receivedAt)}</span>
        </div>
      `;
    })
    .join("");
}

function getStateColor(key) {
  return {
    online: "#17845c",
    late: "#b7791f",
    offline: "#b84747",
    paused: "#6f86a8",
  }[key] || "#6f86a8";
}

function getAnalysis(employee) {
  return (
    employee.analysis || {
      label: "待分析",
      confidence: "低",
      summary: "已收到上报记录，等待生成截图内容分析。",
      evidence: [],
      recommendation: "",
    }
  );
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function openScreenshotDialog() {
  els.screenshotFeedback.textContent = "";
  els.screenshotGrid.innerHTML = "";
  currentScreenshotItems = [];
  closeScreenshotPreview();
  els.screenshotPasswordInput.value = "";
  els.screenshotDialog.showModal();
  setTimeout(function () {
    els.screenshotPasswordInput.focus();
  }, 50);
}

async function authenticateScreenshots() {
  const password = els.screenshotPasswordInput.value.trim();
  if (!password) {
    showScreenshotFeedback("请输入查看密码", true);
    return "";
  }

  const response = await fetch("/api/screenshots/session", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ password }),
  });
  if (response.status === 401) {
    throw new Error("密码不正确");
  }
  if (!response.ok) {
    throw new Error("验证失败：" + response.status);
  }
  const result = await response.json();
  screenshotSessionToken = result.token || "";
  return screenshotSessionToken;
}

async function loadTodayScreenshots() {
  els.loadScreenshotsBtn.disabled = true;
  showScreenshotFeedback("正在读取今日截图...", false);
  try {
    const token = screenshotSessionToken || await authenticateScreenshots();
    if (!token) return;
    const response = await fetch("/api/screenshots/today?session=" + encodeURIComponent(token), {
      cache: "no-store",
    });
    if (response.status === 401) {
      screenshotSessionToken = "";
      throw new Error("查看会话已过期，请重新输入密码");
    }
    if (!response.ok) {
      throw new Error("读取失败：" + response.status);
    }
    const result = await response.json();
    renderScreenshotGrid(result.screenshots || []);
    showScreenshotFeedback("今日截图 " + (result.screenshots || []).length + " 张", false);
  } catch (error) {
    renderScreenshotGrid([]);
    showScreenshotFeedback(error.message || "读取失败", true);
  } finally {
    els.loadScreenshotsBtn.disabled = false;
  }
}

function renderScreenshotGrid(items) {
  currentScreenshotItems = [...items].sort(function (a, b) {
    return new Date(b.receivedAt || b.capturedAt || 0).getTime() - new Date(a.receivedAt || a.capturedAt || 0).getTime();
  });

  if (!items.length) {
    els.screenshotGrid.innerHTML = '<div class="screenshot-empty">今天还没有收到截图。</div>';
    return;
  }

  const groups = currentScreenshotItems.reduce(function (acc, item, index) {
    const key = item.employeeId || item.employeeName || "unknown";
    if (!acc.has(key)) {
      acc.set(key, {
        employeeName: item.employeeName || item.employeeId || "未知员工",
        department: item.department || "未分组",
        computerName: item.computerName || "未知电脑",
        items: [],
      });
    }
    acc.get(key).items.push({ item, index });
    return acc;
  }, new Map());

  els.screenshotGrid.innerHTML = Array.from(groups.values())
    .map(function (group) {
      return `
        <section class="screenshot-group">
          <div class="screenshot-group-head">
            <div>
              <strong>${escapeHtml(group.employeeName)}</strong>
              <span>${escapeHtml(group.department)} · ${escapeHtml(group.computerName)}</span>
            </div>
            <em>${group.items.length} 张</em>
          </div>
          <div class="screenshot-group-grid">
            ${group.items.map(renderScreenshotItem).join("")}
          </div>
        </section>
      `;
    })
    .join("");
}

function renderScreenshotItem(entry) {
  const item = entry.item;
  return `
    <button class="screenshot-item" type="button" data-screenshot-index="${entry.index}" title="点击预览">
      <span class="screenshot-thumb">
        <img src="${escapeAttr(item.imageUrl)}" alt="${escapeAttr(item.employeeName || "员工截图")}" loading="lazy" />
      </span>
      <span class="screenshot-item-meta">
        <strong>${escapeHtml(formatTime(item.receivedAt || item.capturedAt))}</strong>
        <span>${escapeHtml(item.label || "截图记录")}</span>
        <p>${escapeHtml(item.summary || "")}</p>
      </span>
    </button>
  `;
}

function openScreenshotPreview(index) {
  const item = currentScreenshotItems[index];
  if (!item) return;
  els.screenshotPreviewImage.src = item.imageUrl;
  els.screenshotPreviewImage.alt = `${item.employeeName || "员工"}截图预览`;
  els.screenshotPreviewTitle.textContent = item.employeeName || item.employeeId || "未知员工";
  els.screenshotPreviewMeta.textContent = `${item.department || "未分组"} · ${item.computerName || "未知电脑"} · ${formatTime(item.receivedAt || item.capturedAt)}`;
  els.screenshotPreview.hidden = false;
}

function closeScreenshotPreview() {
  if (!els.screenshotPreview) return;
  els.screenshotPreview.hidden = true;
  if (els.screenshotPreviewImage) {
    els.screenshotPreviewImage.removeAttribute("src");
  }
}

function showScreenshotFeedback(text, isError) {
  els.screenshotFeedback.textContent = text;
  els.screenshotFeedback.classList.toggle("error", Boolean(isError));
}

els.refreshBtn.addEventListener("click", async () => {
  els.refreshBtn.classList.add("loading");
  const label = els.refreshBtn.dataset.label || els.refreshBtn.textContent;
  els.refreshBtn.dataset.label = label;
  els.refreshBtn.textContent = "刷新中";
  els.refreshBtn.disabled = true;
  try {
    if (usingLocalDemo) {
      tickDemoData();
    } else {
      await refreshEmployeeModules();
    }
  } catch (error) {
    console.warn(error);
  } finally {
    els.refreshBtn.classList.remove("loading");
    els.refreshBtn.textContent = label;
    els.refreshBtn.disabled = false;
  }
});
els.search.addEventListener("input", (event) => {
  filters.search = event.target.value;
  renderGrid();
});
els.status.addEventListener("change", (event) => {
  filters.status = event.target.value;
  renderGrid();
});
els.grid.addEventListener("click", (event) => {
  const notifyButton = event.target.closest("button[data-notify-id]");
  if (notifyButton) {
    openReminderDialog(notifyButton.dataset.notifyId);
    return;
  }

  const button = event.target.closest("button[data-id]");
  if (!button) return;
  selectedEmployeeId = button.dataset.id;
  renderGrid();
  renderDetail();
});
els.detail.addEventListener("click", (event) => {
  const toggleButton = event.target.closest("button[data-detail-toggle]");
  if (!toggleButton) return;
  detailCollapsed = !detailCollapsed;
  renderDetail();
});
window.addEventListener("resize", renderCharts);
els.toggleRecentBtn.addEventListener("click", () => {
  const collapsed = els.recentPanel.classList.toggle("collapsed");
  els.toggleRecentBtn.textContent = collapsed ? "展开" : "收起";
});
els.closeMessageDialog.addEventListener("click", () => {
  els.messageDialog.close();
});
els.openBroadcastBtn.addEventListener("click", openBroadcastDialog);
els.closeBroadcastDialog.addEventListener("click", () => {
  els.broadcastDialog.close();
});
els.sendBroadcastBtn.addEventListener("click", sendBroadcast);
els.broadcastMessageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    sendBroadcast();
  }
});
els.openScreenshotsBtn.addEventListener("click", openScreenshotDialog);
els.closeScreenshotDialog.addEventListener("click", () => {
  els.screenshotDialog.close();
});
els.loadScreenshotsBtn.addEventListener("click", loadTodayScreenshots);
els.screenshotPasswordInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    loadTodayScreenshots();
  }
});
els.screenshotGrid.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-screenshot-index]");
  if (!button) return;
  openScreenshotPreview(Number(button.dataset.screenshotIndex));
});
els.closeScreenshotPreview.addEventListener("click", closeScreenshotPreview);
els.screenshotPreview.addEventListener("click", (event) => {
  if (event.target === els.screenshotPreview) {
    closeScreenshotPreview();
  }
});
els.screenshotDialog.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.screenshotPreview.hidden) {
    event.preventDefault();
    closeScreenshotPreview();
  }
});
els.messageOptions.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-template-index]");
  if (!button) return;
  const clickedIndex = Number(button.dataset.templateIndex);
  const shouldClear = selectedReminderIndex === clickedIndex;
  selectedReminderIndex = shouldClear ? null : clickedIndex;
  els.messageOptions.querySelectorAll(".message-option").forEach((item) => {
    item.classList.toggle("selected", !shouldClear && item === button);
  });
  resetMessageDialogFeedback(
    shouldClear ? "请选择一条消息内容" : `已选择：${reminderTemplates[clickedIndex].title}`,
  );
});
els.sendMessageBtn.addEventListener("click", () => {
  if (selectedReminderIndex === null) {
    showMessageDialogError("请先选择消息内容");
    return;
  }
  const template = reminderTemplates[selectedReminderIndex];
  sendReminder(pendingMessageEmployeeId, template.message).catch((error) => {
    showMessageDialogError(error.message.includes("Failed to fetch")
      ? "发送失败：请通过主管端服务地址打开页面，例如 http://localhost:8787/manager。"
      : error.message);
  });
});

loadData().catch(() => {
  usingLocalDemo = true;
  dashboard = getLocalDemoDashboard();
  selectedEmployeeId = "me";
  render();
});
renderHeaderClock();
setInterval(renderHeaderClock, 1000);
setInterval(() => {
  if (usingLocalDemo) return;
  refreshEmployeeModules().catch((error) => console.warn(error));
}, MODULE_REFRESH_MS);
setInterval(tickDemoData, MODULE_REFRESH_MS);

function tickDemoData() {
  if (!usingLocalDemo) return;
  const employees = Object.values(dashboard.employees);
  if (!employees.length) return;
  const index = Math.floor(Date.now() / MODULE_REFRESH_MS) % employees.length;
  const employee = employees[index];
  const now = new Date().toISOString();
  employee.receivedAt = now;
  employee.capturedAt = now;
  employee.totalSnapshots = Number(employee.totalSnapshots || 0) + 1;
  dashboard.activity.unshift({
    ...employee,
    receivedAt: now,
    capturedAt: now,
  });
  dashboard.activity = dashboard.activity.slice(0, 80);
  syncSelectedEmployee();
  renderGrid();
  renderDetail();
  updateLastRefreshLabel();
}

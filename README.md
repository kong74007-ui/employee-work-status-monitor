# 员工工作状态监控系统

这是一个 AI 驱动的智能工作态势感知系统，包含主管端看板和员工端桌面程序。员工端按计划采集屏幕画面，主管端通过 GLM 视觉模型理解整张截图，从应用窗口、界面文字和操作轨迹中自动提炼工作内容、任务进展、状态标签、判断依据与潜在风险，让主管无需逐张翻看截图，也能快速掌握团队此刻在做什么、推进到哪里、哪些情况值得关注。

## AI 工作状态描述

- 分析整张截图中的应用窗口、界面文字、操作场景和任务上下文，避免只关注局部区域。
- 输出工作场景、工作内容描述、状态标签、判断依据、建议和分析置信度等结构化信息。
- 仅在每天 10:00-22:00 调用视觉模型；其他时段只保存截图，并统一显示“非分析时段”。
- GLM 调用失败时明确显示分析失败，不使用本地规则生成可能失真的工作描述。
- AI 描述用于辅助主管了解工作状态，不应作为绩效、考勤或纪律处理的唯一依据。

## 功能

- 员工端按固定间隔自动截图并上传。
- 主管端保存截图，并在 10:00-22:00 调用 GLM 视觉模型生成工作状态描述。
- 非分析时段只保留截图，不更新员工工作描述。
- 主管端看板展示员工状态、统计图表、今日截图查看和消息通知。
- 员工端支持开机自启、主动上报、个人信息修改和主管消息提醒音。

## 安全说明

仓库不包含真实 API Key、通信 token、截图数据、日志和已内置密钥的安装包。正式部署前请自行配置：

- `MONITOR_TOKEN`：员工上传和主管通知使用的通信密钥。
- `SCREENSHOT_VIEW_PASSWORD`：今日截图查看密码。
- `GLM_API_KEY`：智谱 GLM 视觉模型 API Key。

使用前应向员工明确采集范围、频率、用途和保存方式，并遵守当地劳动、隐私和数据安全要求。

## 主管端启动

安装 Node.js 后，在仓库根目录运行：

```powershell
node server.js
```

或复制 `.env.example` 中的配置到自己的启动脚本，再运行：

```cmd
start-manager.cmd
```

主管端地址：

```text
http://localhost:8787/manager
```

同事电脑访问时使用主管电脑内网 IP：

```text
http://主管电脑IP:8787/manager
```

员工端上传地址：

```text
http://主管电脑IP:8787/api/snapshots
```

## 员工端开发启动

```powershell
cd employee-desktop
npm install
copy employee.config.example.json employee.config.json
npm start
```

请把 `employee.config.json` 里的 `serverUrl` 和 `token` 改成主管端真实配置。

## 打包

Windows：

```powershell
cd employee-desktop
npm install
npm run dist:win
```

macOS：

```powershell
cd employee-desktop
npm install
npm run dist:mac:native
```

## 目录

- `server.js`：主管端 HTTP 服务、截图接收、消息接口、GLM 分析。
- `manager.html` / `manager.js` / `manager.css`：主管端看板。
- `employee-desktop/`：Electron 员工端。
- `scripts/`：连接测试和防火墙辅助脚本。

# 员工工作状态监控系统

这是一个内网员工工作状态监控系统，包含主管端看板和员工端桌面程序。

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


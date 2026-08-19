@echo off
setlocal

set MONITOR_HOST=0.0.0.0
set MONITOR_PORT=8787
set MONITOR_TOKEN=replace-with-a-long-random-token
set SCREENSHOT_VIEW_PASSWORD=replace-with-screenshot-password
set GLM_API_KEY=replace-with-your-glm-api-key
set GLM_VISION_MODEL=glm-4.6v-flashx
set GLM_API_URL=https://open.bigmodel.cn/api/paas/v4/chat/completions

node server.js


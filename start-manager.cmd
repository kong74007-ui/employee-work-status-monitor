@echo off
setlocal

set MONITOR_HOST=0.0.0.0
set MONITOR_PORT=8787
set MONITOR_TOKEN=replace-with-a-long-random-token
set SCREENSHOT_VIEW_PASSWORD=replace-with-screenshot-password
set GLM_VISION_MODEL=glm-4.6v-flashx

if "%GLM_API_KEY%"=="" (
  echo GLM_API_KEY is not set. The server will keep uploads but vision analysis will fail.
)

node server.js


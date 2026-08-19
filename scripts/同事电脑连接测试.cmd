@echo off
echo Testing manager endpoint...
echo URL: http://192.168.1.200:8787/manager
echo.

curl -I --connect-timeout 8 http://192.168.1.200:8787/manager
if %errorlevel% neq 0 (
  echo.
  echo Connection failed. Check these items:
  echo 1. Both computers are on the same LAN/Wi-Fi.
  echo 2. The manager computer has opened TCP port 8787.
  echo 3. The employee config serverUrl is http://192.168.1.200:8787/api/snapshots
  pause
  exit /b 1
)

echo.
echo Connection OK. The employee app should be able to upload.
pause
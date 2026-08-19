@echo off
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Please right click this file and choose Run as administrator.
  pause
  exit /b 1
)

netsh advfirewall firewall delete rule name="EmployeeMonitor8787" >nul 2>&1
netsh advfirewall firewall add rule name="EmployeeMonitor8787" dir=in action=allow protocol=TCP localport=8787 profile=private,domain

echo.
echo Firewall rule added for TCP port 8787.
echo Ask your colleague to open: http://192.168.1.200:8787/manager
pause
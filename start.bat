@echo off
chcp 65001 >nul
cd /d %~dp0server

netstat -ano | findstr :3001 | findstr LISTENING >nul
if not errorlevel 1 (
    echo 检测到已有服务在运行，先停止它...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do (
        taskkill /F /PID %%a >nul 2>&1
    )
    timeout /t 1 >nul
)

echo 启动健康伴侣 AI 代理服务...
node server.js
pause

@echo off
chcp 65001 >nul
cd /d %~dp0

echo ================================================
echo   유사호출부호 모니터링 시스템
echo   Similar Callsign Monitor System
echo ================================================
echo.

:: Node.js 확인
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js가 설치되어 있지 않습니다.
    echo Node.js를 먼저 설치해주세요.
    pause
    exit /b 1
)

:: node_modules 확인
if not exist "node_modules" (
    echo [ERROR] node_modules 폴더가 없습니다.
    echo.
    echo 폐쇄망 환경에서는 인터넷이 되는 PC에서 npm install 후
    echo node_modules 폴더를 함께 복사해야 합니다.
    echo.
    pause
    exit /b 1
)

echo [INFO] 서버 시작 중...
echo.
node server.js

pause

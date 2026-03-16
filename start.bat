@echo off
chcp 65001 >nul
cd /d %~dp0

echo ================================================
echo   유사호출부호 경고 시스템
echo   Similar Callsign Warning System
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

:: 포트 4000 사용 중인지 확인 (이미 실행 중이면 종료)
netstat -aon | findstr ":4000 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] 포트 4000에서 이미 서버가 실행 중입니다.
    echo         중복 실행을 방지합니다.
    timeout /t 3 /nobreak >nul
    exit /b 0
)
echo.

echo [INFO] 서버 시작 중...
echo.

:LOOP
node server.js
echo.
echo [WARN] 서버가 종료되었습니다. 5초 후 자동 재시작합니다...
echo       종료하려면 Ctrl+C를 누르세요.
timeout /t 5 /nobreak >nul
echo [INFO] 서버 재시작 중...
echo.
goto LOOP

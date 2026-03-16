@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul

echo ========================================
echo   서비스 등록 스크립트
echo   Service Registration Script
echo ========================================
echo.

:: 관리자 권한 확인
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] 관리자 권한이 필요합니다.
    echo         마우스 우클릭 후 "관리자 권한으로 실행" 을 선택하세요.
    pause
    exit /b 1
)
echo [OK] 관리자 권한 확인됨

:: 현재 경로
set "CURRENT_DIR=%~dp0"
set "VBS_PATH=%CURRENT_DIR%start_minimized.vbs"
echo [INFO] 대상 파일: %VBS_PATH%

:: start_minimized.vbs 존재 확인
if not exist "%VBS_PATH%" (
    echo [ERROR] start_minimized.vbs 파일을 찾을 수 없습니다!
    pause
    exit /b 1
)
echo [OK] start_minimized.vbs 파일 확인됨

:: 작업 이름
set "TASK_NAME=SimilarCallsignWarningSystem"

:: 기존 작업 삭제
echo.
echo [TASK] 기존 등록된 작업 삭제 중...
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

:: 새 작업 등록 (로그인 시 최소화 실행 + 감시자)
echo [TASK] 새 작업 등록 중...
schtasks /create /tn "%TASK_NAME%" /tr "wscript.exe \"%VBS_PATH%\"" /sc onlogon /rl HIGHEST /it /f

if %errorLevel% equ 0 (
    echo.
    echo ========================================
    echo [SUCCESS] 서비스 등록 완료!
    echo ========================================
    echo.
    echo   - 작업 이름: %TASK_NAME%
    echo   - 실행 시점: 로그인 시 자동 실행 (최소화 + 감시자)
    echo   - 실행 계정: %USERNAME%
    echo   - 실행 파일: %VBS_PATH%
    echo.
    echo   [서버 종료 방법]
    echo     작업관리자에서 wscript.exe 와 node.exe 종료
    echo.
    echo   [테스트 실행]
    echo     schtasks /run /tn "%TASK_NAME%"
    echo.
    echo   [상태 확인]
    echo     schtasks /query /tn "%TASK_NAME%"
    echo.
    echo   [등록 해제]
    echo     schtasks /delete /tn "%TASK_NAME%" /f
    echo.
) else (
    echo.
    echo [FAILED] 서비스 등록 실패. 오류 코드: %errorLevel%
)

pause

@echo off
rem WorkLoom 织元 · Windows 应急浏览器壳
rem 数据库、载荷、迁移、围栏与退出清理由 Electron 发行线同一 bootstrap.cjs 负责；
rem 禁止在此复制另一套 initdb/helper/停止逻辑，避免安全策略漂移。
setlocal
title WorkLoom 织元

rem %~dp0 必带尾反斜杠；追加点号避免 quoted argv 末尾反斜杠转义结束引号。
set "RESOURCES=%~dp0."
set "SUPPORT=%LOCALAPPDATA%\WorkLoom"
set "NODE=%RESOURCES%\node\node.exe"
set "BOOTSTRAP=%RESOURCES%\bootstrap.cjs"

if not exist "%NODE%" goto :missing
if not exist "%BOOTSTRAP%" goto :missing

set "SMOKE_ARG="
if "%WORKLOOM_SMOKE%"=="1" set "SMOKE_ARG=--smoke"
"%NODE%" "%BOOTSTRAP%" %SMOKE_ARG% --resources "%RESOURCES%" --support "%SUPPORT%"
exit /b %errorlevel%

:missing
echo WorkLoom package is incomplete: embedded Node or bootstrap.cjs is missing.
if not "%WORKLOOM_SMOKE%"=="1" pause
exit /b 1

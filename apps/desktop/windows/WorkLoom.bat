@echo off
rem ============================================================
rem WorkLoom 织元 · Windows 桌面启动器（W2 / D16 Windows 版）
rem 首启自愈：依赖全自带（Node 24 + PostgreSQL 17 + pgvector），
rem 用户侧唯一动作 = SmartScreen「更多信息 → 仍要运行」一次；
rem 其余全部自动完成（装配→初始化→迁移→种子→起服务→开浏览器）。
rem 日志：%LOCALAPPDATA%\WorkLoom\Logs\
rem 冒烟模式（CI 验收）：set WORKLOOM_SMOKE=1 时不开浏览器、健康检查通过即退出
rem ============================================================
setlocal EnableDelayedExpansion
title WorkLoom 织元

set "RESOURCES=%~dp0runtime-root"
set "SUPPORT=%LOCALAPPDATA%\WorkLoom"
set "LOGDIR=%SUPPORT%\Logs"
set "LOG=%LOGDIR%\launch.log"
set "RUNTIME=%SUPPORT%\runtime"
set "PGDATA=%SUPPORT%\pgdata"
set "PGBIN=%SUPPORT%\pg\bin"
set "NODEBIN=%SUPPORT%\node"
set "SERVER_PORT=8787"
set "WEB_PORT=5173"
if "%WORKLOOM_SMOKE%"=="" set "WORKLOOM_SMOKE=0"

if not exist "%LOGDIR%" mkdir "%LOGDIR%"
echo == WorkLoom 织元 · 启动（日志 %LOG%）== >> "%LOG%"
call :say "== WorkLoom 织元 · 启动 =="

rem ---------- 0. 装配：首启把运行时载荷复制到可写支持目录 ----------
set "PAYLOAD_VER=unknown"
if exist "%~dp0runtime\VERSION" set /p PAYLOAD_VER=<"%~dp0runtime\VERSION"
set "INSTALLED_VER=none"
if exist "%SUPPORT%\VERSION" set /p INSTALLED_VER=<"%SUPPORT%\VERSION"
if not "%PAYLOAD_VER%"=="%INSTALLED_VER%" (
  call :say "→ 装配运行时载荷（%PAYLOAD_VER%）…"
  if exist "%RUNTIME%.new" rmdir /s /q "%RUNTIME%.new"
  robocopy "%~dp0runtime" "%RUNTIME%.new" /E /NFL /NDL /NJH /NJS >nul || goto :die_copy
  if exist "%RUNTIME%" rmdir /s /q "%RUNTIME%"
  move "%RUNTIME%.new" "%RUNTIME%" >nul
  if exist "%SUPPORT%\node" rmdir /s /q "%SUPPORT%\node"
  if exist "%SUPPORT%\pg" rmdir /s /q "%SUPPORT%\pg"
  robocopy "%~dp0node" "%SUPPORT%\node" /E /NFL /NDL /NJH /NJS >nul
  robocopy "%~dp0pg" "%SUPPORT%\pg" /E /NFL /NDL /NJH /NJS >nul
  echo %PAYLOAD_VER%>"%SUPPORT%\VERSION"
  if exist "%SUPPORT%\.bootstrapped" del "%SUPPORT%\.bootstrapped"
  call :say "✅ 装配完成"
)

set "PATH=%NODEBIN%;%PGBIN%;%PATH%"
set "TSX=%RUNTIME%\node_modules\.bin\tsx.cmd"
if not exist "%TSX%" set "TSX=%RUNTIME%\node_modules\.bin\tsx"
if not exist "%TSX%" goto :die_runtime

rem ---------- 1. PostgreSQL：用户态、免安装 ----------
"%PGBIN%\pg_isready.exe" -h 127.0.0.1 -p 5432 -d workloom >nul 2>&1
if %errorlevel%==0 (
  call :say "✅ PostgreSQL 已在运行（复用）"
) else (
  if not exist "%PGDATA%\PG_VERSION" (
    call :say "→ 初始化数据库（initdb）…"
    "%PGBIN%\initdb.exe" -D "%PGDATA%" -U postgres --auth=trust -E UTF8 --locale=C >> "%LOG%" 2>&1 || goto :die_pg
  )
  call :say "→ 启动 PostgreSQL 17 …"
  "%PGBIN%\pg_ctl.exe" -D "%PGDATA%" -l "%LOGDIR%\pg.log" -o "-p 5432 -c listen_addresses=127.0.0.1" -w -t 60 start >> "%LOG%" 2>&1 || goto :die_pg
)
rem 角色与库（幂等）
"%PGBIN%\psql.exe" -h 127.0.0.1 -p 5432 -U postgres -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='workloom_app'" 2>nul | find "1" >nul || (
  "%PGBIN%\psql.exe" -h 127.0.0.1 -p 5432 -U postgres -d postgres -c "ALTER USER postgres PASSWORD 'workloom'" >> "%LOG%" 2>&1
)
"%PGBIN%\psql.exe" -h 127.0.0.1 -p 5432 -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='workloom'" 2>nul | find "1" >nul || (
  "%PGBIN%\createdb.exe" -h 127.0.0.1 -p 5432 -U postgres -O postgres workloom
)
"%PGBIN%\psql.exe" -h 127.0.0.1 -p 5432 -U postgres -d workloom -c "CREATE EXTENSION IF NOT EXISTS vector" >> "%LOG%" 2>&1 || goto :die_pg

rem ---------- 2. 配置：.env 默认即本地自足 ----------
if not exist "%RUNTIME%\.env" (
  copy "%RUNTIME%\.env.defaults" "%RUNTIME%\.env" >nul
  call :say "→ 生成默认配置 .env"
)

rem ---------- 3. 首启引导：迁移 + 种子（幂等） ----------
if not exist "%SUPPORT%\.bootstrapped" (
  call :say "→ 首航引导：数据库迁移 + 演示数据种子（约 30 秒）…"
  pushd "%RUNTIME%"
  call "%TSX%" --env-file=.env scripts/migrate.ts >> "%LOG%" 2>&1 || ( popd & goto :die_migrate )
  call "%TSX%" --env-file=.env scripts/seed.ts >> "%LOG%" 2>&1 || ( popd & goto :die_migrate )
  popd
  echo done>"%SUPPORT%\.bootstrapped"
  call :say "✅ 首航引导完成"
)

rem ---------- 4. 起服务：server(8787) + web preview(5173) ----------
call :say "→ 启动服务…"
pushd "%RUNTIME%\apps\server"
start "WorkLoom-Server" /min "%TSX%" --env-file="%RUNTIME%\.env" src\index.ts
popd
pushd "%RUNTIME%\apps\web"
start "WorkLoom-Web" /min "%RUNTIME%\node_modules\.bin\vite.cmd" preview --host 127.0.0.1 --port %WEB_PORT% --strictPort
popd

call :say "→ 等待服务就绪…"
set "READY="
for /l %%i in (1,1,60) do (
  curl -sf "http://127.0.0.1:%SERVER_PORT%/health" >nul 2>&1 && curl -sf -o nul "http://127.0.0.1:%WEB_PORT%/" && set "READY=1" && goto :ready
  timeout /t 1 /nobreak >nul
)
:ready
if not defined READY goto :die_ready
call :say "✅ 首航检查单全绿：PG ✅ 迁移 ✅ 种子 ✅ server ✅ web ✅"

if "%WORKLOOM_SMOKE%"=="1" (
  call :say "== SMOKE 模式：健康检查通过，退出 =="
  goto :cleanup
)
call :say "== 主甲板已就绪 http://localhost:%WEB_PORT% （关闭本窗口即停止全部服务）=="
start "" "http://localhost:%WEB_PORT%"
echo.
echo   WorkLoom 织元正在运行：http://localhost:%WEB_PORT%
echo   关闭本窗口将停止全部服务（PostgreSQL 保留数据，下次秒开）
pause >nul

:cleanup
call :say "→ 停止服务…"
taskkill /f /fi "WINDOWTITLE eq WorkLoom-Server" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq WorkLoom-Web" >nul 2>&1
if exist "%PGDATA%\postmaster.pid" "%PGBIN%\pg_ctl.exe" -D "%PGDATA%" stop -m fast >> "%LOG%" 2>&1
exit /b 0

:say
echo %~1
echo %~1 >> "%LOG%"
exit /b 0

:die_copy
call :say "❌ 运行时载荷复制失败"
goto :fail
:die_runtime
call :say "❌ 运行时载荷不完整（tsx 缺失）"
goto :fail
:die_pg
call :say "❌ PostgreSQL 初始化/启动失败（详见 %LOGDIR%\pg.log）"
goto :fail
:die_migrate
call :say "❌ 数据库迁移/种子失败"
goto :fail
:die_ready
call :say "❌ 服务 60s 内未就绪（详见 %LOGDIR%）"
goto :fail
:fail
call :say "启动中止，日志见 %LOG%"
if not "%WORKLOOM_SMOKE%"=="1" pause
exit /b 1

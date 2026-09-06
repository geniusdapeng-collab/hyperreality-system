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
  robocopy "%~dp0runtime" "%RUNTIME%.new" /E /NFL /NDL /NJH /NJS >nul
  if errorlevel 8 goto :die_copy
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

rem ---------- 1. PostgreSQL：用户态、免安装（线性 goto 流，避免 cmd 嵌套块陷阱） ----------
"%PGBIN%\pg_isready.exe" -h 127.0.0.1 -p 5432 -d workloom >nul 2>&1
if %errorlevel%==0 goto :pg_ok
if exist "%PGDATA%\PG_VERSION" goto :pg_start
call :say "→ 初始化数据库（initdb）…"
"%PGBIN%\initdb.exe" -D "%PGDATA%" -U postgres --auth=trust -E UTF8 --locale=C >> "%LOG%" 2>&1
if errorlevel 1 goto :die_pg
:pg_start
call :say "→ 启动 PostgreSQL 17（pg_ctl 降权 + 句柄脱离）…"
rem 必须用 pg_ctl 而非 postgres.exe：Windows 上只有 pg_ctl 会对管理员会话做
rem CreateRestrictedToken 降权（v2.0.9 实测 postgres.exe 直接起被拒）；
rem 句柄脱离（<nul >文件 2>&1）防止 postmaster 继承本批处理控制台/日志句柄。
start "WorkLoom-PG" /min cmd /c ""%PGBIN%\pg_ctl.exe" -D "%PGDATA%" -l "%LOGDIR%\pg.log" -o "-p 5432 -c listen_addresses=127.0.0.1" -w -t 60 start <nul >>"%LOGDIR%\pgctl.log" 2>&1"
set "PGUP="
rem 等就绪：timeout 在非交互环境立即返回（v2.0.10 实证竞态败北），用 ping 做延迟
call :say "→ 等待 PG 就绪（pg_ctl status 探测）…"
rem 内嵌 PG 无 pg_isready（zonky 只有 initdb/pg_ctl/postgres 三件套，v2.0.12 实证）——
rem 用 pg_ctl status 探测（运行中返回 0）
for /l %%i in (1,1,40) do (
  if not defined PGUP (
    "%PGBIN%\pg_ctl.exe" status -D "%PGDATA%" >nul 2>&1 && set "PGUP=1"
    if not defined PGUP ping -n 2 127.0.0.1 >nul
  )
)
call :say "→ PG 探测结束（PGUP=%PGUP%）"
if not defined PGUP goto :die_pg
:pg_ok
call :say "✓ PostgreSQL 就绪"

rem 角色/建库/vector 扩展：内嵌 PG 无 psql/createdb（zonky 三件套），改载荷 Node 引导
call :say "→ 角色与库与 vector 扩展（Node 引导）…"
set "WORKLOOM_RUNTIME=%RUNTIME%"
"%NODEBIN%\node.exe" "%RUNTIME%\scripts\desktop-bootstrap-db.mjs" >> "%LOG%" 2>&1
if errorlevel 1 goto :die_pg
call :say "✓ 数据库引导完成（角色/库/vector）"

rem ---------- 2. 配置：.env 默认即本地自足 ----------
call :say "→ 配置检查…"
if exist "%RUNTIME%\.env" goto :env_ok
copy "%RUNTIME%\.env.defaults" "%RUNTIME%\.env" >nul
call :say "→ 生成默认配置 .env"
:env_ok

rem ---------- 3. 首启引导：迁移 + 种子（幂等） ----------
if exist "%SUPPORT%\.bootstrapped" goto :boot_done
call :say "→ 首航引导：数据库迁移 + 演示数据种子（约 30 秒）…"
pushd "%RUNTIME%"
call "%TSX%" --env-file=.env scripts/migrate.ts >> "%LOG%" 2>&1
if errorlevel 1 ( popd & goto :die_migrate )
set BUNDLE_DIR=bundles/hotel
call "%TSX%" --env-file=.env scripts/seed.ts >> "%LOG%" 2>&1
if errorlevel 1 ( popd & goto :die_migrate )
popd
echo done>"%SUPPORT%\.bootstrapped"
call :say "✅ 首航引导完成"
:boot_done

call :say "→ 引导阶段完成，准备起服务…"
rem ---------- 4. 起服务：server(8787) + web preview(5173) ----------
call :say "→ 启动服务…"
pushd "%RUNTIME%\apps\server"
start "WorkLoom-Server" /min cmd /c ""%TSX%" --env-file="%RUNTIME%\.env" src\index.ts <nul >"%LOGDIR%\server.log" 2>&1"
popd
pushd "%RUNTIME%\apps\web"
start "WorkLoom-Web" /min cmd /c ""%RUNTIME%\node_modules\.bin\vite.cmd" preview --host 127.0.0.1 --port %WEB_PORT% --strictPort <nul >"%LOGDIR%\web.log" 2>&1"
popd

call :say "→ 等待服务就绪…"
set "READY="
for /l %%i in (1,1,60) do (
  curl -sf --max-time 5 "http://127.0.0.1:%SERVER_PORT%/health" >nul 2>&1 && curl -sf --max-time 5 -o nul "http://127.0.0.1:%WEB_PORT%/" && set "READY=1" && goto :ready
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

# ============================================================
# build-pgvector-win.ps1 —— Windows 上从源码编译 pgvector（供 pack-windows.sh 合入）
# 背景与两次踩坑记录：
#   ① zonky embedded PG 是纯运行时（无 include/ 无 pg_config.exe），不能当编译底座；
#   ② pgvector 官方 Makefile.win 需要 PGROOT 环境变量（非 PATH 里的 pg_config）。
# 方案：choco 装全量 PG17（含头文件+pg_config）→ PGROOT 指向它 → vcvars64 + nmake →
#       从 PGROOT 归集 vector.dll + control + sql 到 vendor/pgvector-win/。
#       运行时 ABI 兼容：pack-windows.sh 的 zonky PG 与 choco PG 同为 EDB 官方 17.x 构建。
# 用法（CI 或本机 Windows 管理员环境）：pwsh scripts/build-pgvector-win.ps1
# ============================================================
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$PgvectorVer = "v0.8.6"
$Out = "vendor/pgvector-win"

# ---------- 1. 全量 PG17（编译底座：含 include/ 与 pg_config.exe） ----------
$PgRoot = "C:\Program Files\PostgreSQL\17"
if (-not (Test-Path "$PgRoot\bin\pg_config.exe")) {
  Write-Host "→ 安装 PostgreSQL 17（choco，编译底座）…"
  $installed = $false
  foreach ($pkg in @("postgresql17", "postgresql --version=17.2.0", "postgresql")) {
    try {
      if ($pkg -like "*--version*") { choco install postgresql --version=17.2.0 -y --no-progress }
      else { choco install $pkg -y --no-progress }
      if (Test-Path "$PgRoot\bin\pg_config.exe") { $installed = $true; break }
    } catch { Write-Host "  ⚠️ $pkg 安装失败，尝试下一方案" }
  }
  if (-not $installed) { throw "PostgreSQL 17 安装失败（choco 三种方式均不可用）" }
}
& "$PgRoot\bin\pg_config.exe" --version | Write-Host

# ---------- 2. pgvector 源码 ----------
if (-not (Test-Path "vendor/pgvector-src")) {
  New-Item -ItemType Directory -Force -Path vendor | Out-Null
  git clone --depth 1 --branch $PgvectorVer https://github.com/pgvector/pgvector.git vendor/pgvector-src
}

# ---------- 3. MSVC 环境 + nmake（PGROOT 机制） ----------
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vcvars = & $vswhere -latest -find VC\Auxiliary\Build\vcvars64.bat | Select-Object -First 1
if (-not $vcvars) { throw "未找到 vcvars64.bat（需要 Visual Studio C++ 工作负载）" }
Push-Location vendor/pgvector-src
try {
  cmd /c "`"$vcvars`" && set PGROOT=$PgRoot&& nmake /F Makefile.win"
  if ($LASTEXITCODE -ne 0) { throw "nmake 编译失败（exit $LASTEXITCODE）" }
  cmd /c "`"$vcvars`" && set PGROOT=$PgRoot&& nmake /F Makefile.win install"
  if ($LASTEXITCODE -ne 0) { throw "nmake install 失败（exit $LASTEXITCODE）" }
} finally { Pop-Location }

# ---------- 4. 归集产物 ----------
New-Item -ItemType Directory -Force -Path "$Out\lib", "$Out\share\extension" | Out-Null
Copy-Item "$PgRoot\lib\vector.dll" "$Out\lib\" -Force
Copy-Item "$PgRoot\share\extension\vector.control" "$Out\share\extension\" -Force
Copy-Item "$PgRoot\share\extension\vector--*.sql" "$Out\share\extension\" -Force
if (-not (Test-Path "$Out\lib\vector.dll")) { throw "vector.dll 未产出" }
Write-Host "✅ pgvector 编译完成：$Out（vector.dll + control + sql，PGROOT=$PgRoot）"

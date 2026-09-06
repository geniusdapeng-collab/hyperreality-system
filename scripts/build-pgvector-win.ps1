# ============================================================
# build-pgvector-win.ps1 —— Windows 上从源码编译 pgvector（供 pack-windows.sh 合入）
# 背景：pgvector 官方不发 Windows 预编译件，必须在 Windows 环境用 MSVC 编译。
# 流程：下载 zonky PG 17（含头文件）→ 克隆 pgvector v0.8.6 → vcvars64 + nmake →
#       产出 vendor/pgvector-win/{lib/vector.dll, share/extension/*}
# 用法（CI 或本机 Windows）：pwsh scripts/build-pgvector-win.ps1
# ============================================================
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$ZonkyVer = "17.2.0"
$PgvectorVer = "v0.8.6"
$VendorPg = "vendor/pg-win"
$Out = "vendor/pgvector-win"

# ---------- 1. zonky PG（含 include/lib 开发文件） ----------
$jar = "embedded-postgres-binaries-windows-amd64-$ZonkyVer.jar"
$urls = @(
  "https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-windows-amd64/$ZonkyVer/$jar",
  "https://mirrors.cloud.tencent.com/nexus/repository/maven-public/io/zonky/test/postgres/embedded-postgres-binaries-windows-amd64/$ZonkyVer/$jar"
)
New-Item -ItemType Directory -Force -Path vendor, "$env:TEMP\pgv" | Out-Null
$jarPath = "$env:TEMP\pgv\pg.jar"
if (-not (Test-Path "$VendorPg\bin\pg_config.exe")) {
  foreach ($u in $urls) {
    try { Write-Host "  ↓ $u"; Invoke-WebRequest -Uri $u -OutFile $jarPath -UseBasicParsing; break }
    catch { Write-Host "  ⚠️ 失败，回退下一源" }
  }
  Expand-Archive -Path $jarPath -DestinationPath "$env:TEMP\pgv\jar" -Force
  $txz = Get-ChildItem "$env:TEMP\pgv\jar" -Recurse -Filter *.txz | Select-Object -First 1
  # git-bash tar 解 .txz（windows runner 自带 bsdtar）
  tar -xJf $txz.FullName -C vendor
  Rename-Item -Path "vendor\pgsql" -NewName "pg-win" -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path "$VendorPg\bin\pg_config.exe")) { throw "pg_config.exe 未就位（$VendorPg）" }

# ---------- 2. pgvector 源码 ----------
if (-not (Test-Path "vendor/pgvector-src")) {
  git clone --depth 1 --branch $PgvectorVer https://github.com/pgvector/pgvector.git vendor/pgvector-src
}

# ---------- 3. MSVC 环境 + nmake ----------
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vcvars = & $vswhere -latest -find VC\Auxiliary\Build\vcvars64.bat | Select-Object -First 1
if (-not $vcvars) { throw "未找到 vcvars64.bat（需要 Visual Studio C++ 工作负载）" }
$env:PATH = "$root\$VendorPg\bin;$env:PATH"
Push-Location vendor/pgvector-src
try {
  cmd /c "`"$vcvars`" && nmake /F Makefile.win"
  cmd /c "`"$vcvars`" && nmake /F Makefile.win install"
} finally { Pop-Location }

# ---------- 4. 归集产物 ----------
New-Item -ItemType Directory -Force -Path "$Out\lib", "$Out\share\extension" | Out-Null
Copy-Item "$VendorPg\lib\vector.dll" "$Out\lib\" -Force
Copy-Item "$VendorPg\share\extension\vector.control" "$Out\share\extension\" -Force
Copy-Item "$VendorPg\share\extension\vector--*.sql" "$Out\share\extension\" -Force
Write-Host "✅ pgvector 编译完成：$Out（vector.dll + control + sql）"

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

$ReleaseLock = Get-Content (Join-Path $root "scripts\release-assets.json") -Raw | ConvertFrom-Json
$PgvectorVer = [string]$ReleaseLock.sourcePins.pgvector.version
$PgvectorRepo = [string]$ReleaseLock.sourcePins.pgvector.repository
$PgvectorCommit = [string]$ReleaseLock.sourcePins.pgvector.commit
$PostgresPackage = [string]$ReleaseLock.sourcePins.windowsPostgresqlBuild.chocolateyPackage
$PostgresPackageVersion = [string]$ReleaseLock.sourcePins.windowsPostgresqlBuild.chocolateyVersion
$PostgresPackageSource = [string]$ReleaseLock.sourcePins.windowsPostgresqlBuild.chocolateySource
$ExpectedPgConfigVersion = [string]$ReleaseLock.sourcePins.windowsPostgresqlBuild.pgConfigVersion
if (-not $ReleaseLock.sourcePins.windowsPostgresqlBuild.requireChecksums) {
  throw "Windows PostgreSQL 构建底座必须要求 Chocolatey 上游校验和"
}
$Out = "vendor/pgvector-win"

# ---------- 1. 全量 PG17（编译底座：含 include/ 与 pg_config.exe） ----------
$PgRoot = "C:\Program Files\PostgreSQL\17"
# 正式发行只接受本 job 从锁定源安装的全新工具链。若 runner 预装或残留 PG，不能
# 仅凭可伪造的 pg_config 版本字符串替它生成可信 provenance。
if (Test-Path $PgRoot) {
  throw "检测到预置 PostgreSQL 目录 $PgRoot；正式构建要求干净 runner，拒绝为未知二进制生成 provenance"
}
Write-Host "→ 安装 PostgreSQL $PostgresPackageVersion（choco 固定包 + 固定源 + 强制上游校验和）…"
$PackageStage = Join-Path ([System.IO.Path]::GetTempPath()) "workloom-postgresql-package-$PID"
if (Test-Path $PackageStage) { throw "临时 Chocolatey 包目录已存在，拒绝复用：$PackageStage" }
New-Item -ItemType Directory -Path $PackageStage | Out-Null
$NupkgName = "$PostgresPackage.$PostgresPackageVersion.nupkg"
$NupkgPath = Join-Path $PackageStage $NupkgName
$NupkgUrl = "$PostgresPackageSource/package/$PostgresPackage/$PostgresPackageVersion"
curl.exe --fail --location --retry 5 --output $NupkgPath $NupkgUrl
if ($LASTEXITCODE -ne 0) { throw "固定 Chocolatey 包下载失败：$NupkgUrl" }
node scripts/release-assets.mjs verify $NupkgPath $NupkgName
if ($LASTEXITCODE -ne 0) { throw "Chocolatey 包摘要与 release-assets.json 不符" }
# 从已校验的本地 nupkg 安装；包内 EDB installer 仍由 --require-checksums 校验其独立 SHA-256。
choco install $PostgresPackage --version=$PostgresPackageVersion --source=$PackageStage --require-checksums --force -y --no-progress
if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$PgRoot\bin\pg_config.exe")) {
  throw "固定版本 PostgreSQL $PostgresPackageVersion 安装失败"
}
$InstalledPackage = @(choco list --exact $PostgresPackage --limit-output)
if ($LASTEXITCODE -ne 0 -or $InstalledPackage -notcontains "$PostgresPackage|$PostgresPackageVersion") {
  throw "Chocolatey 本地包登记与锁定版本不符：$($InstalledPackage -join ', ')"
}
Remove-Item $PackageStage -Recurse -Force -ErrorAction SilentlyContinue
$ActualPgConfigVersion = (& "$PgRoot\bin\pg_config.exe" --version).Trim()
if ($ActualPgConfigVersion -ne $ExpectedPgConfigVersion) {
  throw "PostgreSQL 编译底座版本不符：期望 '$ExpectedPgConfigVersion'，实际 '$ActualPgConfigVersion'"
}
Write-Host $ActualPgConfigVersion

# ---------- 2. pgvector 源码 ----------
$SourceRoot = Join-Path ([System.IO.Path]::GetTempPath()) "workloom-pgvector-$PID"
if (Test-Path $SourceRoot) { throw "临时源码目录已存在，拒绝复用：$SourceRoot" }
New-Item -ItemType Directory -Path $SourceRoot | Out-Null
git -C $SourceRoot init --quiet
if ($LASTEXITCODE -ne 0) { throw "pgvector 临时仓初始化失败" }
git -C $SourceRoot remote add origin $PgvectorRepo
if ($LASTEXITCODE -ne 0) { throw "pgvector 上游绑定失败" }
git -C $SourceRoot fetch --quiet --depth 1 origin $PgvectorCommit
if ($LASTEXITCODE -ne 0) { throw "pgvector 固定 commit 下载失败：$PgvectorCommit" }
git -C $SourceRoot checkout --quiet --detach FETCH_HEAD
if ($LASTEXITCODE -ne 0) { throw "pgvector 固定 commit checkout 失败" }
$ActualPgvectorCommit = (git -C $SourceRoot rev-parse HEAD).Trim()
if ($ActualPgvectorCommit -ne $PgvectorCommit) {
  throw "pgvector 源码 commit 不符：期望 $PgvectorCommit，实际 $ActualPgvectorCommit"
}
Write-Host "✓ pgvector $PgvectorVer source=$ActualPgvectorCommit"

# ---------- 3. MSVC 环境 + nmake（PGROOT 机制） ----------
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vcvars = & $vswhere -latest -find VC\Auxiliary\Build\vcvars64.bat | Select-Object -First 1
if (-not $vcvars) { throw "未找到 vcvars64.bat（需要 Visual Studio C++ 工作负载）" }
Push-Location $SourceRoot
try {
  cmd /c "`"$vcvars`" && set PGROOT=$PgRoot&& nmake /F Makefile.win"
  if ($LASTEXITCODE -ne 0) { throw "nmake 编译失败（exit $LASTEXITCODE）" }
  cmd /c "`"$vcvars`" && set PGROOT=$PgRoot&& nmake /F Makefile.win install"
  if ($LASTEXITCODE -ne 0) { throw "nmake install 失败（exit $LASTEXITCODE）" }
} finally {
  Pop-Location
  Remove-Item $SourceRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------- 3.5 暂存运行时 PG 树（与编译底座同源，ABI 绝对一致） ----------
# 背景：v2.0.13 实证 choco(17.6) 编译的 vector.dll 在 zonky(17.2) 运行时缺符号
# （"The specified procedure could not be found"）——运行时与编译底座必须同源。
# 顺带收益：EDB 全量树含 psql/pg_isready 等完整工具链（zonky 仅三件套）。
$RunPg = "vendor/pg-win"
if (Test-Path $RunPg) { Remove-Item $RunPg -Recurse -Force }
New-Item -ItemType Directory -Force -Path $RunPg | Out-Null
foreach ($d in @("bin", "lib", "share")) {
  Copy-Item "$PgRoot\$d" "$RunPg\$d" -Recurse -Force
}
if (-not (Test-Path "$RunPg\bin\postgres.exe")) { throw "固定版本 PostgreSQL 运行时归集失败" }
Set-Content -Path "$RunPg\WORKLOOM-PROVENANCE.txt" -Encoding utf8 -Value @(
  "postgresql_chocolatey_package=$PostgresPackage"
  "postgresql_chocolatey_version=$PostgresPackageVersion"
  "postgresql_chocolatey_source=$PostgresPackageSource"
  "pg_config_version=$ActualPgConfigVersion"
  "pgvector_version=$PgvectorVer"
  "pgvector_commit=$PgvectorCommit"
)
Write-Host "✓ 运行时 PG 树已暂存：$RunPg（固定版本且与编译底座同源）"

# ---------- 4. 归集产物 ----------
if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Force -Path "$Out\lib", "$Out\share\extension" | Out-Null
Copy-Item "$PgRoot\lib\vector.dll" "$Out\lib\" -Force
Copy-Item "$PgRoot\share\extension\vector.control" "$Out\share\extension\" -Force
Copy-Item "$PgRoot\share\extension\vector--*.sql" "$Out\share\extension\" -Force
if (-not (Test-Path "$Out\lib\vector.dll")) { throw "vector.dll 未产出" }
Copy-Item "$RunPg\WORKLOOM-PROVENANCE.txt" "$Out\WORKLOOM-PROVENANCE.txt" -Force
Write-Host "✅ pgvector 编译完成：$Out（vector.dll + control + sql，PGROOT=$PgRoot）"

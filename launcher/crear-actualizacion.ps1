param(
  [string]$NewVersion = ""
)

$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$StageDir = Join-Path $env:TEMP ("LoLAdvisorUpdate_" + [Guid]::NewGuid().ToString("N"))
$OutputZip = Join-Path $RootDir "update.zip"

try {
  New-Item -ItemType Directory -Path $StageDir -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $StageDir "lib") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $StageDir "public") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $StageDir "data") -Force | Out-Null

  # Copy core files
  foreach ($f in @("server.js", "package.json", "version.json", "icon.ico", "Abrir (Sin Consola).vbs", "Iniciar LoL Advisor.bat")) {
    $src = Join-Path $RootDir $f
    if (Test-Path $src) { Copy-Item $src (Join-Path $StageDir $f) -Force }
  }

  foreach ($exe in @("LoL Advisor.exe", "LoL Overlay.exe")) {
    $src = Join-Path $RootDir $exe
    if (Test-Path $src) { Copy-Item $src (Join-Path $StageDir $exe) -Force }
  }

  Copy-Item (Join-Path $RootDir "lib\*") (Join-Path $StageDir "lib") -Recurse -Force
  Copy-Item (Join-Path $RootDir "public\*") (Join-Path $StageDir "public") -Recurse -Force

  # Copy clean season & assets
  $SeasonSrc = Join-Path $RootDir "data\seasons"
  if (Test-Path $SeasonSrc) { Copy-Item $SeasonSrc (Join-Path $StageDir "data\seasons") -Recurse -Force }
  $DDragonSrc = Join-Path $RootDir "data\ddragon"
  if (Test-Path $DDragonSrc) { Copy-Item $DDragonSrc (Join-Path $StageDir "data\ddragon") -Recurse -Force }

  if (Test-Path $OutputZip) { Remove-Item $OutputZip -Force }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory($StageDir, $OutputZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

  $SizeKb = [Math]::Round(((Get-Item $OutputZip).Length / 1KB), 1)
  Write-Host "[OK] Paquete update.zip generado con exito ($SizeKb KB)"
} finally {
  if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force -ErrorAction SilentlyContinue }
}

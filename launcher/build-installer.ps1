param(
  [string]$OutputPath = "",
  [switch]$IncludeDiscord,
  [string]$BridgeUrl = "",
  [switch]$FullOffline
)

$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$CscExe = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$ZipDll = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.IO.Compression.dll"
$ZipFsDll = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.IO.Compression.FileSystem.dll"
$NodeExe = (Get-Command node).Source

if (!(Test-Path $CscExe)) { throw "No se encontró csc.exe en $CscExe" }
if (!(Test-Path $NodeExe)) { throw "No se encontró node.exe" }

$StageDir = Join-Path $env:TEMP ("LoLAdvisorStage_" + [Guid]::NewGuid().ToString("N"))
$PayloadZip = Join-Path $env:TEMP ("LoLAdvisorPayload_" + [Guid]::NewGuid().ToString("N") + ".zip")
$OutputSetup = if ($OutputPath) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath) } else { Join-Path $RootDir "Instalador LoL Advisor.exe" }
New-Item -ItemType Directory -Path (Split-Path $OutputSetup -Parent) -Force | Out-Null

try {
  New-Item -ItemType Directory -Path $StageDir -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $StageDir "nodejs") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $StageDir "lib") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $StageDir "public") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $StageDir "data\seasons") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $StageDir "data\ddragon") -Force | Out-Null

  # 1. Core launchers, runtime, and scripts
  foreach ($f in @("LoL Advisor.exe", "LoL Overlay.exe", "Iniciar LoL Advisor.bat", "Abrir (Sin Consola).vbs", "icon.ico", "server.js", "package.json", "version.json")) {
    $src = Join-Path $RootDir $f
    if (!(Test-Path $src)) { throw "Falta archivo requerido: $src" }
    Copy-Item $src (Join-Path $StageDir $f) -Force
  }

  if ($FullOffline) {
    Copy-Item $NodeExe (Join-Path $StageDir "nodejs\node.exe") -Force
  }
  Copy-Item (Join-Path $RootDir "lib\*.js") (Join-Path $StageDir "lib") -Force
  Copy-Item (Join-Path $RootDir "public\*") (Join-Path $StageDir "public") -Recurse -Force

  # 2. Bundle Patch 16.22 + Data Dragon assets + sanitized config (NO personal Riot ID or Discord token!)
  $Season1622 = Join-Path $RootDir "data\seasons\16.22.json"
  if (Test-Path $Season1622) { Copy-Item $Season1622 (Join-Path $StageDir "data\seasons\16.22.json") -Force }
  $AssetsJson = Join-Path $RootDir "data\ddragon\assets.json"
  if (Test-Path $AssetsJson) { Copy-Item $AssetsJson (Join-Path $StageDir "data\ddragon\assets.json") -Force }

  $DiscordCfg = @{
    enabled = $true
    bridgeUrl = "https://lol-advisor.ngelx360.workers.dev"
    botToken = ""
    channelId = "1569830216757411911"
    roadToChannelId = "1569855142528950282"
    webhookUrl = ""
    adminOnly = $true
    adminIds = "382962894075199488"
  }

  $LocalCfgPath = Join-Path $RootDir "data\config.json"
  if ($BridgeUrl) {
    $DiscordCfg.enabled = $true
    $DiscordCfg.bridgeUrl = $BridgeUrl.Trim().TrimEnd('/')
    $DiscordCfg.botToken = ""
  } elseif ($IncludeDiscord -and (Test-Path $LocalCfgPath)) {
    $LocalCfg = Get-Content $LocalCfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($LocalCfg.discord) {
      $DiscordCfg = @{
        enabled = [bool]$LocalCfg.discord.enabled
        bridgeUrl = if ($LocalCfg.discord.bridgeUrl) { [string]$LocalCfg.discord.bridgeUrl } else { "" }
        botToken = [string]($LocalCfg.discord.botToken)
        channelId = if ($LocalCfg.discord.channelId) { [string]$LocalCfg.discord.channelId } else { "1569830216757411911" }
        roadToChannelId = if ($LocalCfg.discord.roadToChannelId) { [string]$LocalCfg.discord.roadToChannelId } else { "1569855142528950282" }
        webhookUrl = [string]($LocalCfg.discord.webhookUrl)
        adminOnly = if ($null -ne $LocalCfg.discord.adminOnly) { [bool]$LocalCfg.discord.adminOnly } else { $true }
        adminIds = [string]($LocalCfg.discord.adminIds)
      }
    }
  }

  $CleanConfig = @{
    activeSeason = "16.22"
    myPool = @()
    defaultRoles = @("mid")
    lcuEnabled = $true
    lcuLockfilePath = ""
    autoFocusMyChampTab = $true
    riotAccount = $null
    overlayAutoInGame = $true
    overlayDemo = $false
    overlayLocked = $true
    overlayScale = 1.0
    overlayOpacity = 0.68
    overlayX = $null
    overlayY = $null
    discord = $DiscordCfg
  } | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText((Join-Path $StageDir "data\config.json"), $CleanConfig, (New-Object System.Text.UTF8Encoding $false))

  # 3. Compile tiny native Uninstaller EXE inside staging dir
  $IconPath = Join-Path $RootDir "icon.ico"
  $UninstallSrc = Join-Path $RootDir "launcher\LoLAdvisorUninstaller.cs"
  $UninstallExe = Join-Path $StageDir "Desinstalar LoL Advisor.exe"
  & $CscExe /nologo /target:winexe /optimize+ "/win32icon:$IconPath" "/out:$UninstallExe" "$UninstallSrc"
  if ($LASTEXITCODE -ne 0) { throw "Error compilando Desinstalar LoL Advisor.exe" }

  # 4. Compress payload zip
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory($StageDir, $PayloadZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

  # 5. Compile single-file Setup EXE embedding LoLAdvisorPayload.zip
  $SetupSrc = Join-Path $RootDir "launcher\LoLAdvisorSetup.cs"
  $ResArg = "/resource:$PayloadZip,LoLAdvisorPayload.zip"
  & $CscExe /nologo /target:winexe /optimize+ "/win32icon:$IconPath" "/reference:$ZipDll" "/reference:$ZipFsDll" "$ResArg" "/out:$OutputSetup" "$SetupSrc"
  if ($LASTEXITCODE -ne 0) { throw "Error compilando Instalador LoL Advisor.exe" }

  $SizeMb = [Math]::Round(((Get-Item $OutputSetup).Length / 1MB), 2)
  Write-Host "[OK] Generado: $OutputSetup ($SizeMb MB)"
} finally {
  if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path $PayloadZip) { Remove-Item $PayloadZip -Force -ErrorAction SilentlyContinue }
}

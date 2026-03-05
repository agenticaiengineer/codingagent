<#
.SYNOPSIS
    Installs the CodingAgent Gateway as a Windows Service using NSSM or native sc.exe.

.DESCRIPTION
    This script creates a Windows Service that:
    - Runs the gateway-auto-reload process via the gateway-service.js wrapper
    - Auto-starts on boot (Automatic - Delayed Start)
    - Auto-restarts on failure (up to 3 times with increasing delays)
    - Runs under SYSTEM account (or a specified user)

.PARAMETER Action
    install   - Install and start the service (requires Admin)
    uninstall - Stop and remove the service (requires Admin)
    status    - Show service status
    restart   - Restart the service (requires Admin)
    logs      - Tail the service logs

.EXAMPLE
    .\install-service.ps1 install
    .\install-service.ps1 uninstall
    .\install-service.ps1 status
    .\install-service.ps1 logs
#>

param(
    [Parameter(Position = 0)]
    [ValidateSet("install", "uninstall", "status", "restart", "logs")]
    [string]$Action = "install"
)

# -- Elevation Check (only for actions that need it) -----------------------
function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$identity
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Admin {
    if (-not (Test-IsAdmin)) {
        Write-Host ""
        Write-Error "This action requires Administrator privileges. Right-click PowerShell -> 'Run as Administrator' and try again."
        exit 1
    }
}

# -- Configuration --------------------------------------------------------
$ServiceName = "CodingAgentGateway"
$DisplayName = "CodingAgent Gateway Service"
$Description = "Runs the CodingAgent Gateway with auto-reload and watchdog. Auto-restarts on failure."
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ServiceScript = Join-Path $PSScriptRoot "gateway-service.js"
$LogDir = Join-Path $PSScriptRoot "logs"
$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $NodeExe) {
    Write-Error "Node.js is not installed or not in PATH. Please install Node.js first."
    exit 1
}

Write-Host ""
Write-Host "  CodingAgent Gateway Service Installer" -ForegroundColor Cyan
Write-Host "  ======================================" -ForegroundColor Cyan
Write-Host "  Service Name  : $ServiceName"
Write-Host "  Node.js       : $NodeExe"
Write-Host "  Service Script: $ServiceScript"
Write-Host "  Project Root  : $ProjectRoot"
Write-Host ""

# -- Helper Functions ------------------------------------------------------
function Test-ServiceExists {
    return [bool](Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)
}

function Get-NssmPath {
    $nssm = Get-Command nssm -ErrorAction SilentlyContinue
    if ($nssm) { return $nssm.Source }

    # Check common install locations
    $paths = @(
        "C:\nssm\nssm.exe",
        "C:\tools\nssm\nssm.exe",
        "$env:ChocolateyInstall\lib\nssm\tools\nssm.exe",
        (Join-Path $PSScriptRoot "nssm.exe")
    )
    foreach ($p in $paths) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

# -- Install ---------------------------------------------------------------
function Install-GatewayService {
    Assert-Admin
    if (Test-ServiceExists) {
        Write-Warning "Service '$ServiceName' already exists. Use 'uninstall' first, or 'restart'."
        return
    }

    # Ensure log directory exists
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

    $nssm = Get-NssmPath

    if ($nssm) {
        Write-Host "[1/4] Using NSSM to create service..." -ForegroundColor Green
        Install-WithNssm $nssm
    }
    else {
        Write-Host "[1/4] NSSM not found -- using native sc.exe..." -ForegroundColor Yellow
        Write-Host "       (Install NSSM for better service management: choco install nssm)" -ForegroundColor DarkGray
        Install-WithNative
    }

    # Configure recovery (restart on failure)
    Write-Host "[2/4] Configuring failure recovery..." -ForegroundColor Green
    # reset=86400 => reset failure count after 24 hours
    # actions: restart after 5s, restart after 30s, restart after 60s
    sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null

    # Enable "Restart service on 4th failure and subsequent" via registry
    $regPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
    if (Test-Path $regPath) {
        # Set FailureActionsOnNonCrashFailures = 1 so recovery kicks in even on clean exit with error code
        Set-ItemProperty -Path $regPath -Name "FailureActionsOnNonCrashFailures" -Value 1 -Type DWord -ErrorAction SilentlyContinue
    }

    # Set to Automatic (Delayed Start)
    Write-Host "[3/4] Setting service to Automatic (Delayed Start)..." -ForegroundColor Green
    sc.exe config $ServiceName start= delayed-auto | Out-Null

    # Start the service
    Write-Host "[4/4] Starting service..." -ForegroundColor Green
    Start-Service -Name $ServiceName
    Start-Sleep -Seconds 2

    $svc = Get-Service -Name $ServiceName
    if ($svc.Status -eq "Running") {
        Write-Host ""
        Write-Host "  [OK] Service installed and running!" -ForegroundColor Green
        Write-Host "     PID: $((Get-CimInstance Win32_Service -Filter "Name='$ServiceName'").ProcessId)"
        Write-Host "     Logs: $LogDir\service.log"
        Write-Host ""
    }
    else {
        Write-Warning "  Service installed but status is: $($svc.Status)"
        Write-Host "  Check logs at: $LogDir\service.log"
    }
}

function Install-WithNssm($nssm) {
    # Install service
    & $nssm install $ServiceName $NodeExe $ServiceScript
    & $nssm set $ServiceName DisplayName $DisplayName
    & $nssm set $ServiceName Description $Description
    & $nssm set $ServiceName AppDirectory $ProjectRoot
    & $nssm set $ServiceName Start SERVICE_DELAYED_AUTO_START

    # NSSM built-in restart on exit
    & $nssm set $ServiceName AppExit Default Restart
    & $nssm set $ServiceName AppRestartDelay 5000

    # Stdout / Stderr logging via NSSM (in addition to our own logs)
    $nssmStdout = Join-Path $LogDir "nssm-stdout.log"
    $nssmStderr = Join-Path $LogDir "nssm-stderr.log"
    & $nssm set $ServiceName AppStdout $nssmStdout
    & $nssm set $ServiceName AppStderr $nssmStderr
    & $nssm set $ServiceName AppStdoutCreationDisposition 4  # append
    & $nssm set $ServiceName AppStderrCreationDisposition 4  # append
    & $nssm set $ServiceName AppRotateFiles 1
    & $nssm set $ServiceName AppRotateBytes 10485760  # 10 MB

    # Environment
    & $nssm set $ServiceName AppEnvironmentExtra "NODE_ENV=production"
}

function Install-WithNative {
    # Create a wrapper batch file that sc.exe can call
    $wrapperBat = Join-Path $PSScriptRoot "gateway-service-wrapper.bat"
    $batLines = @(
        "@echo off",
        "cd /d `"$ProjectRoot`"",
        "`"$NodeExe`" `"$ServiceScript`""
    )
    Set-Content -Path $wrapperBat -Value ($batLines -join "`r`n") -Encoding ASCII

    # Create the service
    sc.exe create $ServiceName `
        binPath= "cmd.exe /c `"$wrapperBat`"" `
        DisplayName= $DisplayName `
        start= delayed-auto | Out-Null

    # Set description
    sc.exe description $ServiceName $Description | Out-Null

    Write-Host ""
    Write-Host "  WARNING: Native sc.exe services have limitations for Node.js." -ForegroundColor Yellow
    Write-Host "  For best results, install NSSM: choco install nssm" -ForegroundColor Yellow
    Write-Host "  Then re-run: .\install-service.ps1 uninstall" -ForegroundColor Yellow
    Write-Host "  Followed by: .\install-service.ps1 install" -ForegroundColor Yellow
}

# -- Uninstall -------------------------------------------------------------
function Uninstall-GatewayService {
    Assert-Admin
    if (-not (Test-ServiceExists)) {
        Write-Warning "Service '$ServiceName' does not exist."
        return
    }

    Write-Host "Stopping service..." -ForegroundColor Yellow
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    $nssm = Get-NssmPath
    if ($nssm) {
        Write-Host "Removing service via NSSM..." -ForegroundColor Yellow
        & $nssm remove $ServiceName confirm
    }
    else {
        Write-Host "Removing service via sc.exe..." -ForegroundColor Yellow
        sc.exe delete $ServiceName | Out-Null
    }

    Write-Host ""
    Write-Host "  [OK] Service removed." -ForegroundColor Green
    Write-Host "     Logs preserved at: $LogDir" -ForegroundColor DarkGray
    Write-Host ""
}

# -- Status ----------------------------------------------------------------
function Show-ServiceStatus {
    if (-not (Test-ServiceExists)) {
        Write-Host "  Service '$ServiceName' is NOT installed." -ForegroundColor Yellow
        return
    }

    $svc = Get-Service -Name $ServiceName
    $cim = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"

    Write-Host "  Service Status" -ForegroundColor Cyan
    Write-Host "  -------------------------------------"
    Write-Host "  Name        : $($svc.Name)"
    Write-Host "  Display Name: $($svc.DisplayName)"
    Write-Host "  Status      : $($svc.Status)"
    Write-Host "  Start Type  : $($svc.StartType)"
    Write-Host "  PID         : $($cim.ProcessId)"
    Write-Host "  Path        : $($cim.PathName)"
    Write-Host ""

    # Show health file if it exists
    $healthFile = Join-Path $LogDir "health.json"
    if (Test-Path $healthFile) {
        Write-Host "  Watchdog Health" -ForegroundColor Cyan
        Write-Host "  -------------------------------------"
        $health = Get-Content $healthFile | ConvertFrom-Json
        Write-Host "  Status       : $($health.status)"
        Write-Host "  Service PID  : $($health.pid)"
        Write-Host "  Child PID    : $($health.childPid)"
        Write-Host "  Restart Count: $($health.restartCount)"
        Write-Host "  Uptime       : $($health.uptime)s"
        Write-Host "  Last Check   : $($health.timestamp)"
    }
    Write-Host ""
}

# -- Restart ---------------------------------------------------------------
function Restart-GatewayService {
    Assert-Admin
    if (-not (Test-ServiceExists)) {
        Write-Warning "Service '$ServiceName' does not exist. Use 'install' first."
        return
    }

    Write-Host "Restarting service..." -ForegroundColor Yellow
    Restart-Service -Name $ServiceName -Force
    Start-Sleep -Seconds 2

    $svc = Get-Service -Name $ServiceName
    Write-Host "  Service status: $($svc.Status)" -ForegroundColor Green
}

# -- Logs ------------------------------------------------------------------
function Show-Logs {
    $logFile = Join-Path $LogDir "service.log"
    if (-not (Test-Path $logFile)) {
        Write-Warning "No log file found at: $logFile"
        return
    }

    Write-Host "Tailing $logFile (Ctrl+C to stop)..." -ForegroundColor Cyan
    Get-Content -Path $logFile -Tail 50 -Wait
}

# -- Main ------------------------------------------------------------------
switch ($Action) {
    "install"   { Install-GatewayService }
    "uninstall" { Uninstall-GatewayService }
    "status"    { Show-ServiceStatus }
    "restart"   { Restart-GatewayService }
    "logs"      { Show-Logs }
}

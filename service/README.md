# CodingAgent Gateway — Windows Service

A Windows Service wrapper that runs the `gateway-auto-reload` process with automatic restart and watchdog monitoring.

## Features

| Feature | Description |
|---|---|
| **Auto-Start** | Service starts automatically on Windows boot (Delayed Start) |
| **Watchdog** | Checks child process liveness every 30 seconds |
| **Auto-Restart** | Exponential backoff: 1s → 2s → 4s → ... → 60s max |
| **Backoff Reset** | If process runs >2 minutes, backoff resets to 1s |
| **Windows Recovery** | OS-level restart on failure: 5s → 30s → 60s |
| **Log Rotation** | Rotates logs at 10 MB, keeps last 5 files |
| **Health File** | `logs/health.json` for external monitoring |
| **Graceful Shutdown** | SIGTERM → 10s grace period → SIGKILL |

## Quick Start

### Install (requires Administrator)

```powershell
# Open PowerShell as Administrator
cd <project-root>\service
.\install-service.ps1 install
```

### Commands

```powershell
.\install-service.ps1 install     # Install & start the service
.\install-service.ps1 uninstall   # Stop & remove the service
.\install-service.ps1 status      # Show service + watchdog status
.\install-service.ps1 restart     # Restart the service
.\install-service.ps1 logs        # Tail service logs (Ctrl+C to stop)
```

### Run Without Installing (foreground)

```powershell
node service\gateway-service.js
```

## Architecture

```
Windows Service Manager (SCM)
  └── CodingAgentGateway Service
        └── gateway-service.js  (process manager + watchdog)
              └── npx tsc-watch --onSuccess "node dist/gateway/gateway.js"
                    ├── TypeScript compiler (watches for changes)
                    └── Gateway process (auto-reloaded on TS changes)
```

### Restart Layers

There are **three layers** of restart protection:

1. **`tsc-watch`** — Restarts the gateway on TypeScript file changes
2. **`gateway-service.js` watchdog** — Restarts the entire tsc-watch process if it crashes (with exponential backoff)
3. **Windows SCM recovery** — Restarts the service itself if the Node.js process dies (5s/30s/60s)

## Files

| File | Purpose |
|---|---|
| `gateway-service.js` | Node.js process manager with watchdog |
| `install-service.ps1` | PowerShell installer/manager script |
| `logs/service.log` | Current service log |
| `logs/service.N.log` | Rotated log files (0 = oldest) |
| `logs/health.json` | Watchdog health status (JSON) |

## Monitoring

### Health File

The watchdog writes `logs/health.json` every 30 seconds:

```json
{
  "status": "running",
  "pid": 1234,
  "childPid": 5678,
  "restartCount": 0,
  "lastStartTime": "2026-02-25T08:34:00.000Z",
  "uptime": 3600,
  "timestamp": "2026-02-25T09:34:00.000Z"
}
```

**Status values**: `running`, `restarting`, `error`, `watchdog-restart`, `stopping`, `stopped`

### External Monitoring

You can monitor the service from any script:

```powershell
# Check Windows service status
Get-Service CodingAgentGateway

# Check watchdog health
Get-Content <project-root>\service\logs\health.json | ConvertFrom-Json

# Alert if service is down
$svc = Get-Service CodingAgentGateway -ErrorAction SilentlyContinue
if ($svc.Status -ne 'Running') { Write-Warning "Gateway is down!" }
```

## NSSM (Recommended)

For the most reliable service management, install [NSSM](https://nssm.cc/):

```powershell
choco install nssm
# or download from https://nssm.cc/download
```

The installer auto-detects NSSM and uses it if available. NSSM provides:
- Proper service lifecycle management for Node.js
- Built-in log rotation
- Additional restart-on-exit handling
- Clean process tree termination

## Troubleshooting

| Problem | Solution |
|---|---|
| Service won't start | Check `logs/service.log` and Windows Event Viewer |
| Continuous restarts | Check `logs/health.json` for `restartCount` — may indicate a build error |
| Permission errors | Run PowerShell as Administrator |
| Node.js not found | Ensure Node.js is in the SYSTEM PATH (not just user PATH) |
| Port conflicts | Check if another gateway instance is running |

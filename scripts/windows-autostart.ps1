<#
.SYNOPSIS
  Auto-start / auto-restart for the watcher on Windows.

.DESCRIPTION
  Registers a per-user scheduled task that runs `ensure-running` every few
  minutes. That command starts the watcher when it is not running (after a
  crash, a reboot or a sign-in) and does nothing when it is already running or
  was stopped on purpose with `npm run stop`.

  The task runs only while you are signed in, which is also when Docker Desktop
  (the local Telegram API) is available. No administrator rights are needed.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows-autostart.ps1 -Install
  powershell -ExecutionPolicy Bypass -File scripts\windows-autostart.ps1 -Status
  powershell -ExecutionPolicy Bypass -File scripts\windows-autostart.ps1 -Remove
#>
param(
  [switch]$Install,
  [switch]$Remove,
  [switch]$Status,
  [int]$EveryMinutes = 5
)

$ErrorActionPreference = 'Stop'
$TaskName = 'X Watcher - keep running'
$Root = Split-Path -Parent $PSScriptRoot
$Cli = Join-Path $Root 'dist\cli.js'

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Removed scheduled task '$TaskName'."
  } else {
    Write-Output "Scheduled task '$TaskName' is not installed."
  }
  exit 0
}

if ($Install) {
  if (-not (Test-Path $Cli)) {
    throw "dist\cli.js not found. Run 'npm run build' first."
  }
  $Node = (Get-Command node -ErrorAction Stop).Source

  # conhost --headless runs the console program without flashing a window every few minutes.
  $Action = New-ScheduledTaskAction -Execute 'conhost.exe' `
    -Argument "--headless `"$Node`" `"$Cli`" ensure-running" -WorkingDirectory $Root
  $Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
  # The watcher is started detached and must outlive the task run, so there is no time limit.
  $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)

  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings `
    -Description 'Starts the X/Twitter watcher when it is not running (crash, reboot). Managed by scripts\windows-autostart.ps1.' `
    -Force | Out-Null
  Write-Output "Installed scheduled task '$TaskName' (checks every $EveryMinutes minutes)."
  Write-Output "The watcher stays stopped after 'npm run stop' until you start it again."
  exit 0
}

# Default: status
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $Task) {
  Write-Output "Scheduled task '$TaskName' is not installed."
  exit 0
}
$Info = $Task | Get-ScheduledTaskInfo
Write-Output "Task:        $TaskName"
Write-Output "State:       $($Task.State)"
Write-Output "Last run:    $($Info.LastRunTime) (result $($Info.LastTaskResult))"
Write-Output "Next run:    $($Info.NextRunTime)"

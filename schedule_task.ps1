# schedule_task.ps1
# Setup a daily Scheduled Task in Windows Task Scheduler to run the marksheet downloader.
# Configured for maximum resilience (runs even if laptop was off, and retries/restarts on failure).

$ScriptPath = "c:\Users\Ajay.AJAY\OneDrive\Desktop\test\downloader.py"

# Check if script exists
if (-not (Test-Path $ScriptPath)) {
    Write-Error "Downloader script not found at $ScriptPath. Please make sure the file exists."
    exit 1
}

# Define the action (run python on our script)
$Action = New-ScheduledTaskAction -Execute "python.exe" -Argument "`"$ScriptPath`""

# Define the trigger (runs everyday at 9:00 AM)
$Trigger = New-ScheduledTaskTrigger -Daily -At "9:00AM"

# Define resilient settings:
# - StartWhenAvailable: Runs the task immediately if the laptop was turned off during the scheduled run time (9:00 AM).
# - AllowStartIfOnBatteries/DontStopIfGoingOnBatteries: Allows running even if the laptop is on battery power.
# - RestartCount: Attempts to restart the task up to 3 times if it encounters a failure.
# - RestartInterval: Waits 10 minutes between failure restart attempts.
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 10)

# Register the scheduled task
$TaskName = "VIIT_Marksheet_Downloader"
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Daily automated download of VIIT ERP marksheets using Playwright (Missed schedules & failure restart enabled)" -Force

Write-Output "=========================================================="
Write-Output "SUCCESS: Daily scheduled task '$TaskName' has been registered!"
Write-Output "Resilience Features Activated:"
Write-Output "  1. If the laptop is OFF at 9:00 AM, the task will run immediately when turned on."
Write-Output "  2. If the task fails, Windows will automatically restart/retry it up to 3 times."
Write-Output "=========================================================="

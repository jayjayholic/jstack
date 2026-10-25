# One-time setup (Windows) for the RAM clean that heavy-lock.sh, worktree-deps.mjs and the watcher trigger.
# Run ONCE from an elevated PowerShell (Run as administrator):
#   powershell -ExecutionPolicy Bypass -File tools\setup-ram-clean.ps1 -RamMap C:\tools\RAMMap64.exe [-Watch]
# RAMMap is Sysinternals (Microsoft), not shipped here: download it yourself from
# https://learn.microsoft.com/sysinternals/downloads/rammap and unzip it. The script refuses a binary that is not
# Microsoft-signed.
# It registers an on-demand scheduled task (no trigger) that runs "RAMMap64.exe -accepteula -Ew" with highest
# privileges. Any later `schtasks /Run /TN <name>` then empties every working set without a UAC prompt, from any
# non-elevated shell or agent. -Watch also drops a hidden launcher in your Startup folder for ram-clean.ps1 -Watch.
# Battery settings are turned off on purpose: the default task "won't start on batteries", so on an unplugged laptop
# the clean silently never ran.
param(
	[Parameter(Mandatory = $true)][string]$RamMap,
	[string]$TaskName = $(if ($env:JSTACK_RAM_CLEAN_TASK) { $env:JSTACK_RAM_CLEAN_TASK } else { 'JstackRamClean' }),
	[switch]$Watch,
	[string]$LockDirs = ''
)
$ErrorActionPreference = 'Stop'
$RamMap = (Resolve-Path $RamMap).Path
$sig = Get-AuthenticodeSignature $RamMap
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
	throw "$RamMap is not a valid Microsoft-signed binary (status $($sig.Status)). Download RAMMap from Sysinternals."
}
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Run this once from an elevated PowerShell (Run as administrator).' }

$action = New-ScheduledTaskAction -Execute $RamMap -Argument '-accepteula -Ew'
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
"registered task $TaskName -> $RamMap -accepteula -Ew (highest privileges, on demand)"

if ($Watch) {
	$script = Join-Path $PSScriptRoot 'ram-clean.ps1'
	$startup = [Environment]::GetFolderPath('Startup')
	$vbs = Join-Path $startup "$TaskName-watch.vbs"
	$cmd = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$script"" -Watch -Task $TaskName"
	if ($LockDirs) { $cmd += " -LockDirs ""$LockDirs""" }
	"CreateObject(""WScript.Shell"").Run ""$($cmd -replace '"', '""')"", 0, False" | Set-Content -Path $vbs -Encoding ASCII
	Start-Process wscript.exe -ArgumentList "`"$vbs`""
	"watcher launcher: $vbs (started now, and at every logon)"
}
'test it from a normal shell: schtasks /Run /TN ' + $TaskName

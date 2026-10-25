# Windows only. Runs the RAM clean scheduled task (RAMMap -Ew under highest privileges, so no UAC prompt; create it once
# with tools/setup-ram-clean.ps1) at most once per cooldown,
# shared by every trigger on the machine, and logs free/available/system-cache before and after each run.
#   ram-clean.ps1 -Reason <why> [-SkipAbovePct 40] [-SettleSec 60]   one run, exit 0 = ran, 1 = skipped
#   ram-clean.ps1 -Watch [-EverySec 60] [-BelowPct 12] [-CacheAboveGB 10] [-MinTrees 3] [-LockDirs a;b]   safety net loop
# The watch runs the clean only while (available RAM is under -BelowPct OR the resident system file cache, which is NOT
# counted as available, is over -CacheAboveGB) AND real work is running (>= -MinTrees node/bun
# trees or a held lock dir), so an idle machine never triggers it. Available (free + standby) is the measure: the free
# list sits near 0 under load and -Ew moves trimmed pages to standby, so it never moves the free list.
param(
	[string]$Reason = 'manual',
	[string]$Task = $(if ($null -ne $env:JSTACK_RAM_CLEAN_TASK) { $env:JSTACK_RAM_CLEAN_TASK } else { 'JstackRamClean' }),
	[int]$CooldownSec = $(if ($env:JSTACK_RAM_CLEAN_COOLDOWN_S) { [int]$env:JSTACK_RAM_CLEAN_COOLDOWN_S } else { 300 }),
	[double]$SkipAbovePct = 40,
	[int]$SettleSec = 60,
	[string]$StateDir = $(if ($env:JSTACK_RAM_CLEAN_STATE_DIR) { $env:JSTACK_RAM_CLEAN_STATE_DIR } else { Join-Path $HOME '.jstack' }),
	[switch]$Watch,
	[int]$EverySec = 60,
	[double]$BelowPct = 12,
	[double]$CacheAboveGB = 10,
	[int]$MinTrees = 3,
	[string]$LockDirs = ''
)
$GB = 1GB
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$stamp = Join-Path $StateDir '.ram-clean-stamp'
$log = Join-Path $StateDir 'ram-clean.log'

function Get-Mem {
	$pm = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
	$total = (Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize * 1KB
	[pscustomobject]@{
		Free = [math]::Round($pm.FreeAndZeroPageListBytes / $GB, 1); Avail = [math]::Round($pm.AvailableBytes / $GB, 1)
		Cache = [math]::Round($pm.SystemCacheResidentBytes / $GB, 1); Pct = [math]::Round(100 * $pm.AvailableBytes / $total, 1)
	}
}
function Format-Mem($m) { 'free {0} avail {1} ({2}%) syscache {3}' -f $m.Free, $m.Avail, $m.Pct, $m.Cache }

function Invoke-RamClean([string]$why, [double]$skipAbove) {
	if (-not $Task) { return 1 }
	& schtasks.exe /Query /TN $Task 2>$null | Out-Null
	if ($LASTEXITCODE -ne 0) { return 1 }
	$mutex = New-Object System.Threading.Mutex($false, 'Local\JstackRamCleanCooldown')
	if (-not $mutex.WaitOne(0)) { return 1 }
	try {
		if ((Test-Path $stamp) -and ((Get-Date) - (Get-Item $stamp).LastWriteTime).TotalSeconds -lt $CooldownSec) { return 1 }
		$before = Get-Mem
		if ($skipAbove -gt 0 -and $before.Pct -ge $skipAbove) { return 1 }
		Set-Content -Path $stamp -Value (Get-Date -Format s)
		& schtasks.exe /Run /TN $Task 2>$null | Out-Null
		if ($LASTEXITCODE -ne 0) { return 1 }
	} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
	# RAMMap trims process by process and the system cache drains over tens of seconds (measured: still full at 20 s,
	# down 8 GB at ~60 s; another run: -13 GB within 5 s), so sample every 5 s up to SettleSec, keep the best reading and
	# stop once it has gained and starts refilling.
	$after = $null; $at = 0
	for ($t = 5; $t -le $SettleSec; $t += 5) {
		Start-Sleep -Seconds 5
		$m = Get-Mem
		if ($null -eq $after -or $m.Avail -gt $after.Avail) { $after = $m; $at = $t }
		elseif ($after.Avail -ge $before.Avail + 1) { break }
	}
	$line = '{0} {1}: before {2} | best after {3}s {4} | avail {5:+0.0;-0.0} GB' -f (Get-Date -Format s), $why, (Format-Mem $before), $at, (Format-Mem $after), ($after.Avail - $before.Avail)
	Add-Content -Path $log -Value $line
	[Console]::Out.WriteLine($line)
	return 0
}

function Get-WorkTrees {
	$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='bun.exe'")
	$ids = @{}; foreach ($p in $procs) { $ids[[int]$p.ProcessId] = $true }
	@($procs | Where-Object { -not $ids.ContainsKey([int]$_.ParentProcessId) }).Count
}

if ($Watch) {
	$single = New-Object System.Threading.Mutex($false, 'Local\JstackRamCleanWatch')
	if (-not $single.WaitOne(0)) { exit 0 }
	Add-Content -Path $log -Value ('{0} watch started (every {1}s, below {2}% or cache >= {3} GB, >= {4} trees, pid {5})' -f (Get-Date -Format s), $EverySec, $BelowPct, $CacheAboveGB, $MinTrees, $PID)
	while ($true) {
		try {
			$m = Get-Mem
			if ($m.Pct -lt $BelowPct -or $m.Cache -ge $CacheAboveGB) {
				$trees = Get-WorkTrees
				$locked = @($LockDirs -split ';' | Where-Object { $_ -and (Test-Path $_) }).Count -gt 0
				if ($trees -ge $MinTrees -or $locked) { Invoke-RamClean ('watch ({0}% avail, cache {1} GB, {2} trees, lock {3})' -f $m.Pct, $m.Cache, $trees, $locked) 0 | Out-Null }
			}
		} catch { Add-Content -Path $log -Value ('{0} watch error {1}' -f (Get-Date -Format s), $_.Exception.Message) }
		Start-Sleep -Seconds $EverySec
	}
}
exit (Invoke-RamClean $Reason $SkipAbovePct)

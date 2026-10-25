# mem-map: memory map of a Windows dev machine running parallel coding agents, with per-agent attribution.
#   mem-map.ps1                       map: totals, top groups by PRIVATE bytes, dev processes with worktree/branch/agent,
#                                     per-agent totals, WSL VM + Docker, listening dev ports, orphan candidates, locks
#   mem-map.ps1 -Json                 the same data as JSON
#   mem-map.ps1 -Kill orphans [-DryRun]   terminate orphan-candidate trees via WMI (never Claude, MCP, Docker/WSL, eval stack)
#   mem-map.ps1 -Watch [-Every 30]    sampler: appends one CSV row per dev process per tick (+ a _machine row) to -Log
#   mem-map.ps1 -Summary [-SinceMin 180]  per-agent peak/average/CPU from the log, and who held memory at the worst ticks
# Attribution: each process -> worktree (its current directory, else its command line, else an ancestor's) -> branch
# (the worktree's git HEAD) -> agent (first line of <worktree>/.agent, else a lock owner tag "@ <path>", else the
# train queue file mentioning the branch, else the branch). Subagents themselves run inside claude.exe and cannot be
# split from it; everything they launch can.
# Options: -OlderThanMin 60, -Top 12, -PortFrom 3000 -PortTo 3200, -LockDirs <dir,...>, -QueueFile <path>,
#   -Protect <regex> (extra never-kill pattern), -Log <csv> (default <this folder>\mem-samples.csv).
param(
	[switch]$Json,
	[ValidateSet('', 'orphans')][string]$Kill = '',
	[switch]$DryRun,
	[switch]$Watch,
	[int]$Every = 30,
	[switch]$Summary,
	[int]$SinceMin = 180,
	[string]$Log = '',
	[int]$OlderThanMin = 60,
	[int]$Top = 12,
	[int]$PortFrom = 3000,
	[int]$PortTo = 3200,
	[string[]]$LockDirs = @(),
	[string]$QueueFile = '',
	[string]$Protect = ''
)
$ErrorActionPreference = 'SilentlyContinue'
[Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::InvariantCulture
$GB = 1GB
$base = Split-Path $PSScriptRoot -Parent
if (-not $Log) { $Log = if ($env:MEM_MAP_LOG) { $env:MEM_MAP_LOG } else { Join-Path $base 'mem-samples.csv' } }
$header = 'time,pid,name,kind,worktree,branch,agent,private_mb,ws_mb,cpu_pct'
if (-not $QueueFile) { $QueueFile = if ($env:MEM_MAP_QUEUE) { $env:MEM_MAP_QUEUE } else { Join-Path $base 'train-queue.md' } }

$devNames = @('node.exe', 'bun.exe', 'tsc.exe', 'tsgo.exe', 'esbuild.exe', 'bash.exe', 'sh.exe', 'grep.exe', 'rg.exe', 'tail.exe', 'sleep.exe', 'find.exe', 'python.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe', 'git.exe', 'chrome-headless-shell.exe', 'chrome.exe', 'msedge.exe')
$ownerNames = @('claude.exe', 'windowsterminal.exe', 'code.exe', 'cursor.exe', 'explorer.exe', 'openconsole.exe', 'mintty.exe', 'services.exe', 'wininit.exe')
$protectRe = 'claude|@anthropic|anthropic-ai|[\\/]mcp|mcp-server|modelcontextprotocol|docker|com\.docker|vmmem|wsl|harness-eval|eval-env|mem-map\.ps1|idle-reaper|node-memory-watch|vscode|Code\.exe|cursor'
if ($Protect) { $protectRe = "$protectRe|$Protect" }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ProcCwd {
	[StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr a; public IntPtr Peb; public IntPtr b; public IntPtr c; public UIntPtr d; public IntPtr e; }
	[DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);
	[DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
	[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
	[DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow);
	[DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
	static IntPtr Ptr(IntPtr h, IntPtr addr) { byte[] b = new byte[8]; IntPtr r; if (!ReadProcessMemory(h, addr, b, 8, out r)) return IntPtr.Zero; return (IntPtr)BitConverter.ToInt64(b, 0); }
	public static string Get(int pid) {
		IntPtr h = OpenProcess(0x0410, false, pid);
		if (h == IntPtr.Zero) return null;
		try {
			bool wow; if (IsWow64Process(h, out wow) && wow) return null;
			PBI pbi = new PBI(); int ret;
			if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return null;
			IntPtr pp = Ptr(h, pbi.Peb + 0x20); if (pp == IntPtr.Zero) return null;
			byte[] us = new byte[16]; IntPtr r;
			if (!ReadProcessMemory(h, pp + 0x38, us, 16, out r)) return null;
			int len = BitConverter.ToUInt16(us, 0); IntPtr buf = (IntPtr)BitConverter.ToInt64(us, 8);
			if (len <= 0 || len > 4096) return null;
			byte[] s = new byte[len];
			if (!ReadProcessMemory(h, buf, s, len, out r)) return null;
			return System.Text.Encoding.Unicode.GetString(s);
		} finally { CloseHandle(h); }
	}
}
"@

function Get-WorktreeOf([string]$text) {
	if (-not $text) { return '' }
	$m = [regex]::Match($text, '[A-Za-z]:[\\/][^"''<>|*?\r\n]*?[\\/]\.?worktrees[\\/][^\\/"'' ]+')
	if ($m.Success) { return ($m.Value -replace '/', '\').TrimEnd('\') }
	$m = [regex]::Match($text, '([A-Za-z]:[\\/][^"''<>|*?\r\n ]*?)[\\/]node_modules[\\/]')
	if ($m.Success) { return ($m.Groups[1].Value -replace '/', '\').TrimEnd('\') }
	return ''
}
$repoCache = @{}
function Get-RepoRoot([string]$dir) {
	if (-not $dir) { return '' }
	if ($repoCache.ContainsKey($dir)) { return $repoCache[$dir] }
	$d = $dir.TrimEnd('\'); $found = ''
	for ($i = 0; $i -lt 12 -and $d; $i++) {
		if (Test-Path -LiteralPath (Join-Path $d '.git')) { $found = $d; break }
		$d = Split-Path $d -Parent
	}
	$repoCache[$dir] = $found
	return $found
}
$branchCache = @{}
function Get-Branch([string]$wt) {
	if (-not $wt) { return '' }
	if ($branchCache.ContainsKey($wt)) { return $branchCache[$wt] }
	$b = ''; $git = Join-Path $wt '.git'
	if (Test-Path -LiteralPath $git -PathType Leaf) {
		$gd = ((Get-Content -LiteralPath $git -TotalCount 1) -replace '^gitdir:\s*', '').Trim()
		if ($gd -and -not [IO.Path]::IsPathRooted($gd)) { $gd = Join-Path $wt $gd }
		$head = Join-Path $gd 'HEAD'
	} else { $head = Join-Path $git 'HEAD' }
	$h = Get-Content -LiteralPath $head -TotalCount 1
	if ($h -match '^ref:\s*refs/heads/(.+)$') { $b = $Matches[1].Trim() } elseif ($h) { $b = 'detached@' + $h.Substring(0, [Math]::Min(9, $h.Length)) }
	$branchCache[$wt] = $b
	return $b
}

function Get-LockList {
	# -File passes a list as one string, so accept "a;b" and "a,b" too.
	$dirs = @($LockDirs | ForEach-Object { $_ -split '[;,]' } | Where-Object { $_ })
	if ($dirs.Count -eq 0) {
		if ($env:MEM_MAP_LOCKS) { $dirs += $env:MEM_MAP_LOCKS -split ';' }
		if ($env:JSTACK_LOCK_DIR) { $dirs += @($env:JSTACK_LOCK_DIR, "$($env:JSTACK_LOCK_DIR)-tc-1", "$($env:JSTACK_LOCK_DIR)-tc-2") }
		$dirs += @(Join-Path $base '.heavy-lock') + @(Get-ChildItem $base -Directory -Filter '.tc-lock-*' -Force | ForEach-Object FullName)
		$j = Join-Path $HOME '.jstack'
		$dirs += @(Join-Path $j 'heavy-lock') + @(Get-ChildItem $j -Directory -Filter 'heavy-lock-tc-*' -Force | ForEach-Object FullName)
	}
	$now = Get-Date
	foreach ($d in ($dirs | Where-Object { $_ } | Select-Object -Unique)) {
		$own = Join-Path $d 'owner'
		if (-not (Test-Path -LiteralPath $own)) { continue }
		$raw = (Get-Content -LiteralPath $own -Raw).Trim()
		$where = if ($raw -match '@\s+(\S.*)$') { ($Matches[1].Trim() -replace '/', '\').TrimEnd('\') } else { '' }
		[pscustomobject]@{ Slot = Split-Path $d -Leaf; Owner = ($raw -split '\s')[0]; AgeMin = [int]($now - (Get-Item -LiteralPath $own -Force).LastWriteTime).TotalMinutes; Worktree = $where; Path = $d }
	}
}

function Get-QueueLines {
	if (-not (Test-Path -LiteralPath $QueueFile)) { return @() }
	Get-Content -LiteralPath $QueueFile
}
$agentCache = @{}
function Get-Agent([string]$wt, [string]$branch, $locks, $queue) {
	if (-not $wt) { return '' }
	$key = "$wt|$branch"
	if ($agentCache.ContainsKey($key)) { return $agentCache[$key] }
	$a = ''
	$marker = Join-Path $wt '.agent'
	if (Test-Path -LiteralPath $marker) { $a = ((Get-Content -LiteralPath $marker -TotalCount 1) -replace '\s+', ' ').Trim() }
	if (-not $a) { $l = $locks | Where-Object { $_.Worktree -and $_.Worktree -ieq $wt } | Select-Object -First 1; if ($l) { $a = "lock:$($l.Owner)" } }
	if (-not $a -and (Test-Path -LiteralPath (Join-Path $wt '.git') -PathType Container)) { $a = "main checkout ($branch)" }
	if (-not $a -and $branch -and $branch -notmatch '^(stage|main|master|production|develop)$') {
		$leaf = Split-Path $wt -Leaf
		$hit = $queue | Where-Object { $_ -match "(?<![\w/.-])$([regex]::Escape($branch))(?![\w/-])" -or $_ -match "worktrees[\\/]$([regex]::Escape($leaf))\b" } | Select-Object -First 1
		if ($hit) { $tag = ($hit -split ':')[0].Trim(); if ($tag -match '^(branch|orchestrator)') { $a = 'train orchestrator' } else { $a = "queue:$tag" } }
	}
	if (-not $a) { $a = "wt:$(Split-Path $wt -Leaf) ($branch)" }
	$agentCache[$key] = $a
	return $a
}

function Get-Kind($p) {
	$n = $p.Name.ToLower(); $c = [string]$p.CommandLine
	if ($n -eq 'claude.exe' -or $c -match 'claude-code|@anthropic-ai') { return 'claude' }
	if ($c -match 'mcp') { return 'mcp' }
	if ($c -match 'next(\.js)?["'']?\s+build|next[\\/]dist[\\/]build') { return 'next-build' }
	if ($c -match 'next(\.js)?["'']?\s+dev') { return 'next-dev' }
	if ($c -match 'next(\.js)?["'']?\s+start|next-server|start-server\.js') { return 'next-server' }
	if ($c -match 'typescript[\\/]lib[\\/]tsc|\btsc(\.exe|\.js)?\b|tsgo') { return 'tsc' }
	if ($c -match 'vitest|jest-worker|bun(\.exe)?["'']?\s+test') { return 'tests' }
	if ($c -match 'playwright|--headless|remote-debugging') { return 'browser' }
	if ($n -in @('grep.exe', 'rg.exe', 'find.exe')) { return 'grep' }
	if ($n -eq 'tail.exe') { if ($c -match '\s-[a-zA-Z]*[fF]') { return 'tail-f' } return 'tail' }
	if ($n -eq 'sleep.exe') { return 'sleep' }
	if ($n -in @('bash.exe', 'sh.exe')) { if ($c -match 'while|for\s|until|sleep') { return 'bash-loop' } return 'bash' }
	return $n -replace '\.exe$', ''
}

# One pass over the process table with attribution. $full adds the parts the sampler skips.
function Get-Snapshot([bool]$full) {
	$all = @(Get-CimInstance Win32_Process)
	$byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
	$parentOf = @{}
	foreach ($p in $all) {
		$pp = $byId[[int]$p.ParentProcessId]
		# A PID reused by a younger process is not the real parent.
		if ($pp -and $pp.CreationDate -le $p.CreationDate) { $parentOf[[int]$p.ProcessId] = $pp }
	}
	$locks = @(Get-LockList); $queue = @(Get-QueueLines)
	$now = Get-Date
	$selfChain = @{}; $cur = $byId[$PID]
	while ($cur) { $selfChain[[int]$cur.ProcessId] = $true; $cur = $parentOf[[int]$cur.ProcessId] }
	$wtOf = @{}
	$rows = foreach ($p in $all) {
		$id = [int]$p.ProcessId; $nm = $p.Name.ToLower()
		$isDev = $devNames -contains $nm
		$wt = ''
		if ($isDev) {
			$cwd = [ProcCwd]::Get($id)
			$wt = Get-WorktreeOf $cwd
			if (-not $wt -and $cwd) { $wt = Get-RepoRoot ($cwd.TrimEnd('\')) }
		}
		if (-not $wt) { $wt = Get-WorktreeOf ([string]$p.CommandLine) }
		$owned = $false; $hops = 0; $a = $parentOf[$id]
		while ($a -and $hops -lt 40) {
			if (-not $wt) { $aid = [int]$a.ProcessId; if ($wtOf.ContainsKey($aid)) { $wt = $wtOf[$aid] } else { $wt = Get-WorktreeOf ([string]$a.CommandLine) } }
			if ($ownerNames -contains $a.Name.ToLower()) { $owned = $true; break }
			$a = $parentOf[[int]$a.ProcessId]; $hops++
		}
		$wtOf[$id] = $wt
		$branch = Get-Branch $wt
		$priv = [double]$p.PrivatePageCount; $ws = [double]$p.WorkingSetSize
		[pscustomobject]@{
			Id = $id; Name = $p.Name; Kind = Get-Kind $p
			PrivMb = [int]($priv / 1MB); PrivGb = [math]::Round($priv / $GB, 2); WsGb = [math]::Round($ws / $GB, 2)
			PagedOut = [math]::Round([math]::Max(0, $priv - $ws) / $GB, 2)
			CpuSec = ([double]$p.KernelModeTime + [double]$p.UserModeTime) / 1e7
			AgeMin = if ($p.CreationDate) { [int]($now - $p.CreationDate).TotalMinutes } else { 0 }
			Ppid = [int]$p.ParentProcessId; Parent = if ($parentOf[$id]) { $parentOf[$id].Name } else { '(gone)' }
			Orphan = -not $parentOf[$id]; Owned = $owned; IsDev = $isDev
			Worktree = $wt; Branch = $branch; Agent = Get-Agent $wt $branch $locks $queue
			Cmd = ([string]$p.CommandLine) -replace '\s+', ' '
		}
	}
	[pscustomobject]@{ All = $all; ById = $byId; ParentOf = $parentOf; Rows = $rows; Locks = $locks; Self = $selfChain; Now = $now }
}

function Get-Totals {
	$os = Get-CimInstance Win32_OperatingSystem
	$pm = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
	$totalGb = $os.TotalVisibleMemorySize * 1KB / $GB; $availGb = $pm.AvailableBytes / $GB
	$t = [ordered]@{
		totalGb = [math]::Round($totalGb, 1); availableGb = [math]::Round($availGb, 1); usedPct = [math]::Round((1 - $availGb / $totalGb) * 100, 1)
		commitGb = [math]::Round($pm.CommittedBytes / $GB, 1); commitLimitGb = [math]::Round($pm.CommitLimit / $GB, 1)
		standbyGb = [math]::Round(($pm.StandbyCacheNormalPriorityBytes + $pm.StandbyCacheReserveBytes + $pm.StandbyCacheCoreBytes) / $GB, 1)
		freeZeroGb = [math]::Round($pm.FreeAndZeroPageListBytes / $GB, 1); modifiedGb = [math]::Round($pm.ModifiedPageListBytes / $GB, 2)
		nonpagedGb = [math]::Round($pm.PoolNonpagedBytes / $GB, 2); pagedPoolGb = [math]::Round($pm.PoolPagedBytes / $GB, 2)
		sysCacheGb = [math]::Round($pm.SystemCacheResidentBytes / $GB, 1)
	}
	$t.status = if ($t.usedPct -ge 90) { 'CRITICAL' } elseif ($t.usedPct -ge 80) { 'HIGH' } else { 'OK' }
	$t
}

function Get-AgentLabel($r) { if ($r.Kind -eq 'claude') { 'claude.exe (sessions + subagents reasoning)' } elseif ($r.Agent) { $r.Agent } elseif ($r.IsDev) { '(no worktree)' } else { '' } }

# ---------- sampler ----------
if ($Watch) {
	$cores = [Environment]::ProcessorCount
	$prev = @{}; $prevAt = $null
	# A log in another format (an older sampler) is kept beside it as *.legacy-<date>.csv; -Summary still reads it.
	if ((Test-Path -LiteralPath $Log) -and ((Get-Content -LiteralPath $Log -TotalCount 1) -replace '^﻿', '') -ne $header) {
		Move-Item -LiteralPath $Log ($Log -replace '\.csv$', ".legacy-$(Get-Date -Format yyyyMMdd-HHmmss).csv") -Force
	}
	if (-not (Test-Path -LiteralPath $Log)) { $header | Set-Content -LiteralPath $Log -Encoding utf8 }
	"mem-map sampler: every $Every s -> $Log (pid $PID)" | Write-Host
	while ($true) {
		try {
			if ((Get-Item -LiteralPath $Log).Length -gt 50MB) { Move-Item -LiteralPath $Log "$Log.1" -Force; $header | Set-Content -LiteralPath $Log -Encoding utf8 }
			$repoCache.Clear(); $branchCache.Clear(); $agentCache.Clear()
			$s = Get-Snapshot $false; $t = Get-Totals
			$at = Get-Date; $stamp = $at.ToString('s'); $dt = if ($prevAt) { ($at - $prevAt).TotalSeconds } else { 0 }
			$lines = New-Object System.Collections.Generic.List[string]
			$lines.Add(('{0},0,_machine,_machine,,,,{1},{2},{3}' -f $stamp, [int](($t.totalGb - $t.availableGb) * 1024), [int]($t.commitGb * 1024), $t.usedPct))
			$lines.Add(('{0},0,_syscache,_syscache,,,system file cache,{1},{1},0' -f $stamp, [int]($t.sysCacheGb * 1024)))
			$vm = Get-Process vmmemWSL, vmmem -ErrorAction SilentlyContinue | Select-Object -First 1
			if ($vm) { $lines.Add(('{0},{1},{2},wsl-vm,,,wsl+docker,{3},{3},0' -f $stamp, $vm.Id, $vm.Name, [int]([math]::Max($vm.PrivateMemorySize64, $vm.WorkingSet64) / 1MB))) }
			$next = @{}
			foreach ($r in $s.Rows) {
				$next[$r.Id] = $r.CpuSec
				if (-not ($r.IsDev -or $r.Kind -eq 'claude')) { continue }
				if ($r.PrivMb -lt 40 -and $r.Kind -ne 'claude') { continue }
				$cpu = if ($dt -gt 0 -and $prev.ContainsKey($r.Id)) { [math]::Round(100 * ($r.CpuSec - $prev[$r.Id]) / $dt / $cores, 1) } else { 0 }
				$f = @($stamp, $r.Id, $r.Name, $r.Kind, $r.Worktree, $r.Branch, (Get-AgentLabel $r), $r.PrivMb, [int]($r.WsGb * 1024), $cpu) | ForEach-Object { $v = [string]$_; if ($v -match '[,"]') { '"' + ($v -replace '"', '""') + '"' } else { $v } }
				$lines.Add(($f -join ','))
			}
			$prev = $next; $prevAt = $at
			Add-Content -LiteralPath $Log -Value $lines -Encoding utf8
		} catch { Write-Host "sampler error: $($_.Exception.Message)" }
		Start-Sleep -Seconds $Every
	}
}

# ---------- summary ----------
if ($Summary) {
	if (-not (Test-Path -LiteralPath $Log)) { "no sampler log at $Log (start one: mem-map.ps1 -Watch)"; return }
	$since = (Get-Date).AddMinutes(-$SinceMin).ToString('s')
	$data = @(Import-Csv -LiteralPath $Log | Where-Object { $_.time -ge $since })
	# Legacy sampler rows (time,avail_mb,pid,name,priv_mb,worktree,cmd): agent from the worktree folder name.
	$legacyDir = Split-Path $Log -Parent; $legacyName = [IO.Path]::GetFileNameWithoutExtension($Log)
	foreach ($lf in (Get-ChildItem -LiteralPath $legacyDir -Filter "$legacyName.legacy-*.csv")) {
		$wtRoot = if ($env:JSTACK_WORKTREES_DIR) { $env:JSTACK_WORKTREES_DIR } else { @(Get-Item -LiteralPath (Join-Path $base '.worktrees') -Force) + @(Get-ChildItem $base -Directory | ForEach-Object { Get-Item -LiteralPath (Join-Path $_.FullName '.worktrees') -Force }) | Select-Object -First 1 -ExpandProperty FullName }
		$legacy = Import-Csv -LiteralPath $lf.FullName | ForEach-Object {
			$tm = ($_.time -replace ' ', 'T'); if ($tm -lt $since) { return }
			$wt = if ($_.worktree -and $_.worktree -ne 'docker') { Join-Path $wtRoot $_.worktree } else { '' }
			$ag = if ($_.name -eq 'vmmemWSL') { 'wsl+docker' } elseif ($wt -and (Test-Path -LiteralPath $wt)) { Get-Agent $wt (Get-Branch $wt) @(Get-LockList) @(Get-QueueLines) } elseif ($_.worktree) { "wt:$($_.worktree)" } else { '(no worktree)' }
			[pscustomobject]@{ time = $tm; pid = $_.pid; name = $_.name; kind = ''; worktree = $wt; branch = ''; agent = $ag; private_mb = $_.priv_mb; ws_mb = ''; cpu_pct = 0 }
		}
		$totalMb = (Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize / 1KB
		$availAt = @{}; Import-Csv -LiteralPath $lf.FullName | ForEach-Object { $availAt[($_.time -replace ' ', 'T')] = [double]$_.avail_mb }
		$machineRows = $legacy | Group-Object time | ForEach-Object { [pscustomobject]@{ time = $_.Name; pid = 0; name = '_machine'; kind = '_machine'; worktree = ''; branch = ''; agent = ''; private_mb = ''; ws_mb = ''; cpu_pct = [math]::Round(100 * (1 - $availAt[$_.Name] / $totalMb), 1) } }
		$data += @($legacy) + @($machineRows)
	}
	if (-not $data) { "no samples in the last $SinceMin min"; return }
	$machine = $data | Where-Object name -eq '_machine'
	$procs = $data | Where-Object { $_.name -ne '_machine' }
	$ticks = @($machine).Count
	$perTick = $procs | Group-Object { "$($_.agent)|$($_.time)" } | ForEach-Object {
		$k = $_.Name -split '\|', 2
		[pscustomobject]@{ Agent = $k[0]; Time = $k[1]; Mb = ($_.Group | Measure-Object private_mb -Sum).Sum; Cpu = ($_.Group | Measure-Object cpu_pct -Sum).Sum }
	}
	$byAgent = $perTick | Group-Object Agent | ForEach-Object {
		$m = $_.Group | Measure-Object Mb -Maximum -Average; $c = $_.Group | Measure-Object Cpu -Maximum -Average
		$peak = $_.Group | Sort-Object Mb -Descending | Select-Object -First 1
		[pscustomobject]@{ Agent = $_.Name; PeakGb = [math]::Round($m.Maximum / 1024, 2); AvgGb = [math]::Round($m.Average / 1024, 2); PeakAt = $peak.Time; PeakCpuPct = [math]::Round($c.Maximum, 0); AvgCpuPct = [math]::Round($c.Average, 1); Ticks = $m.Count }
	} | Sort-Object PeakGb -Descending
	"== per-agent memory, last $SinceMin min ($ticks ticks, $Log)"
	$byAgent | Format-Table -AutoSize | Out-String -Width 220
	"== worst machine ticks and who held the memory"
	foreach ($w in ($machine | Sort-Object { [double]$_.cpu_pct } -Descending | Select-Object -First 5)) {
		$who = $perTick | Where-Object Time -eq $w.time | Sort-Object Mb -Descending | Select-Object -First 5 | ForEach-Object { "{0} {1:N1} GB" -f $_.Agent, ($_.Mb / 1024) }
		"{0}  used {1}%  ->  {2}" -f $w.time, $w.cpu_pct, ($who -join ' | ')
	}
	return
}

# ---------- map ----------
$s = Get-Snapshot $true
$totals = Get-Totals
$rows = $s.Rows
$groups = $rows | Group-Object { if ($_.Name -in @('node.exe', 'bun.exe')) { "$($_.Name -replace '\.exe$','')/$($_.Kind)" } else { $_.Name -replace '\.exe$', '' } } |
	ForEach-Object { [pscustomobject]@{ Group = $_.Name; Count = $_.Count; PrivGb = [math]::Round(($_.Group | Measure-Object PrivGb -Sum).Sum, 2); WsGb = [math]::Round(($_.Group | Measure-Object WsGb -Sum).Sum, 2) } } |
	Sort-Object PrivGb -Descending | Select-Object -First $Top
$devRows = @($rows | Where-Object { $_.Name.ToLower() -in @('node.exe', 'bun.exe', 'tsc.exe', 'tsgo.exe', 'bash.exe') -and $_.Kind -ne 'claude' } | Sort-Object PrivGb -Descending)
$agents = $rows | Where-Object { $_.IsDev -or $_.Kind -eq 'claude' } | Group-Object { Get-AgentLabel $_ } | Where-Object Name |
	ForEach-Object { [pscustomobject]@{ Agent = $_.Name; Procs = $_.Count; PrivGb = [math]::Round(($_.Group | Measure-Object PrivGb -Sum).Sum, 2); Kinds = (($_.Group | Group-Object Kind | Sort-Object Count -Descending | ForEach-Object { "$($_.Name)x$($_.Count)" }) -join ' '); Worktree = ($_.Group | Where-Object Worktree | Select-Object -First 1).Worktree } } |
	Sort-Object PrivGb -Descending

$vm = Get-Process vmmemWSL, vmmem -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ Name = $_.Name; WsGb = [math]::Round($_.WorkingSet64 / $GB, 2); PrivGb = [math]::Round($_.PrivateMemorySize64 / $GB, 2) } }
$docker = @()
if (Get-Command docker -ErrorAction SilentlyContinue) {
	$psi = New-Object System.Diagnostics.ProcessStartInfo
	$psi.FileName = 'docker'; $psi.Arguments = 'stats --no-stream --format "{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}"'
	$psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
	$dp = [System.Diagnostics.Process]::Start($psi)
	$out = $dp.StandardOutput.ReadToEndAsync()
	if ($dp.WaitForExit(20000)) {
		$docker = $out.Result -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { $f = $_.Trim() -split '\|'; [pscustomobject]@{ Container = $f[0]; Mem = $f[1]; Cpu = $f[2] } }
	} else { $dp.Kill(); $docker = @([pscustomobject]@{ Container = '(docker stats timed out)'; Mem = ''; Cpu = '' }) }
}

$ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge $PortFrom -and $_.LocalPort -le $PortTo } |
	Sort-Object LocalPort -Unique | ForEach-Object {
		$r = $rows | Where-Object Id -eq ([int]$_.OwningProcess) | Select-Object -First 1
		[pscustomobject]@{ Port = $_.LocalPort; Id = [int]$_.OwningProcess; Kind = $r.Kind; PrivGb = $r.PrivGb; AgeMin = $r.AgeMin; Orphan = $r.Orphan; Agent = (Get-AgentLabel $r) }
	}
$portIds = @{}; foreach ($pt in $ports) { $portIds[$pt.Id] = $pt.Port }

$candidates = @(foreach ($r in $rows) {
	if (-not $r.IsDev -or $s.Self.ContainsKey($r.Id) -or $r.Kind -in @('claude', 'mcp') -or $r.Cmd -match $protectRe) { continue }
	if ($r.Name -match '^(chrome|msedge)\.exe$' -and $r.Kind -ne 'browser') { continue }
	$why = $null
	if ($r.Orphan -and $r.AgeMin -ge 2) { $why = 'parent gone' }
	elseif (-not $r.Owned -and $r.AgeMin -ge 2) { $why = 'no agent or terminal above it' }
	elseif ($r.Kind -in @('grep', 'tail-f', 'sleep') -and $r.AgeMin -ge $OlderThanMin) { $why = "$($r.Kind) older than $OlderThanMin min" }
	if (-not $why) { continue }
	$r | Select-Object Id, Name, Kind, PrivGb, AgeMin, Parent, Agent, Worktree, @{ n = 'Why'; e = { $why } }, @{ n = 'Port'; e = { $portIds[$r.Id] } }, Cmd
})
# A candidate's own descendants are listed once, under it.
$candIds = @{}; foreach ($c in $candidates) { $candIds[$c.Id] = $true }
$candidates = @($candidates | Where-Object { $a = $s.ParentOf[$_.Id]; $inner = $false; while ($a) { if ($candIds.ContainsKey([int]$a.ProcessId)) { $inner = $true; break }; $a = $s.ParentOf[[int]$a.ProcessId] }; -not $inner })

$kids = @{}
foreach ($p in $s.All) { $pp = $s.ParentOf[[int]$p.ProcessId]; if ($pp) { $k = [int]$pp.ProcessId; if (-not $kids[$k]) { $kids[$k] = @() }; $kids[$k] += [int]$p.ProcessId } }
function Get-Tree([int]$id) { $out = @(); foreach ($c in @($kids[$id])) { if ($c) { $out += Get-Tree $c } }; $out + $id }
# A tree still burning CPU is working (an install's postinstall, a detached job), not leftover: it is listed, never killed.
if ($candidates) {
	$treeCpu = { param($ids) $sum = 0.0; foreach ($i in $ids) { $q = Get-CimInstance Win32_Process -Filter "ProcessId=$i"; if ($q) { $sum += ([double]$q.KernelModeTime + [double]$q.UserModeTime) / 1e7 } }; $sum }
	$before = @{}; foreach ($c in $candidates) { $before[$c.Id] = & $treeCpu (Get-Tree $c.Id) }
	Start-Sleep -Seconds 3
	foreach ($c in $candidates) { $busy = ((& $treeCpu (Get-Tree $c.Id)) - $before[$c.Id]) -gt 0.05; $c | Add-Member -NotePropertyName Busy -NotePropertyValue $busy -Force }
}
$killed = @()
if ($Kill -eq 'orphans' -and $candidates) {
	foreach ($c in ($candidates | Where-Object { -not $_.Busy })) {
		foreach ($tid in (Get-Tree $c.Id)) {
			$t = $s.ById[$tid]
			if (-not $t -or $s.Self.ContainsKey($tid) -or ([string]$t.CommandLine) -match $protectRe -or $t.Name -eq 'claude.exe') { continue }
			if ($DryRun) { $killed += "WOULD terminate $tid $($t.Name)"; continue }
			$res = Invoke-CimMethod -InputObject $t -MethodName Terminate
			$killed += "terminated $tid $($t.Name) rc=$($res.ReturnValue)"
		}
	}
}

$result = [ordered]@{ at = $s.Now.ToString('s'); totals = $totals; groups = $groups; agents = $agents; dev = $devRows; wsl = $vm; docker = $docker; ports = $ports; candidates = $candidates; locks = @($s.Locks); killed = $killed }
if ($Json) { $result | ConvertTo-Json -Depth 5; return }

$t = $totals
"== memory  {0}  used {1}%  available {2}/{3} GB  commit {4}/{5} GB  standby {6}  free {7}  modified {8}  nonpaged pool {9}  paged pool {10} GB" -f $t.status, $t.usedPct, $t.availableGb, $t.totalGb, $t.commitGb, $t.commitLimitGb, $t.standbyGb, $t.freeZeroGb, $t.modifiedGb, $t.nonpagedGb, $t.pagedPoolGb
$procPriv = [math]::Round((($rows | Measure-Object PrivGb -Sum).Sum), 1)
$vmWs = [math]::Round((Get-Process vmmemWSL, vmmem -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum / $GB, 1)
"   in use {0} GB: processes ~{1} GB private (WSL VM {2} GB resident), system file cache {3} GB, pools {4} GB" -f [math]::Round($t.totalGb - $t.availableGb, 1), $procPriv, $vmWs, $t.sysCacheGb, [math]::Round($t.nonpagedGb + $t.pagedPoolGb, 1)
if ($t.sysCacheGb -ge 6) { "   !! system file cache {0} GB is resident, not standby: NTFS metadata/file cache from mass file I/O (installs, git over many worktrees, indexer, antivirus). RAMMap > Use Counts > Metafile / Mapped File confirms; RAMMap > Empty > Empty System Working Set frees it." -f $t.sysCacheGb }
if ($t.nonpagedGb -ge 1.5) { "   !! nonpaged pool {0} GB: a driver leak; PoolMon (WDK) sorted by bytes names the tag" -f $t.nonpagedGb }
"`n== top groups by private bytes (commit; a paged-out process shows here, not in working set)"
$groups | Format-Table -AutoSize | Out-String -Width 200
"== per agent (worktree -> branch -> .agent / lock tag / train queue)"
$agents | Format-Table -AutoSize | Out-String -Width 240
"== node / bun / tsc / bash"
$devRows | Select-Object Id, Kind, PrivGb, WsGb, PagedOut, AgeMin, Parent, Agent, @{ n = 'Cmd'; e = { $_.Cmd.Substring(0, [Math]::Min(80, $_.Cmd.Length)) } } | Format-Table -AutoSize | Out-String -Width 260
"== WSL VM and Docker"
if ($vm) { $vm | Format-Table -AutoSize | Out-String -Width 200 } else { "  no vmmem process (WSL VM stopped)`n" }
if ($docker) { $docker | Format-Table -AutoSize | Out-String -Width 200 } else { "  docker: not running or no containers`n" }
"== listening ports $PortFrom-$PortTo"
if ($ports) { $ports | Format-Table -AutoSize | Out-String -Width 200 } else { "  none`n" }
"== orphan candidates (-Kill orphans terminates idle trees via WMI; Busy trees are still working and are left alone)"
if ($candidates) { $candidates | Select-Object Id, Kind, PrivGb, AgeMin, Port, Why, Busy, Agent, @{ n = 'Cmd'; e = { $_.Cmd.Substring(0, [Math]::Min(70, $_.Cmd.Length)) } } | Format-Table -AutoSize | Out-String -Width 260 } else { "  none`n" }
"== heavy-lock slots"
if ($s.Locks) { $s.Locks | Format-Table Slot, Owner, AgeMin, Worktree -AutoSize | Out-String -Width 200 } else { "  all free" }
if ($killed) { "== killed"; $killed }

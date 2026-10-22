# Every 5 s: when system memory is at or above PressurePercent, kills every node.exe / bun.exe above the limit
# (whole process tree), biggest first, with no exceptions. Log: node-memory-watch.log next to this file.
param([double]$LimitGB = 5, [int]$EverySeconds = 5, [int]$PressurePercent = 98)
$log = Join-Path $PSScriptRoot 'node-memory-watch.log'
"$(Get-Date -Format s) watcher started (limit $LimitGB GB, every $EverySeconds s, pressure $PressurePercent%, pid $PID)" | Add-Content $log

while ($true) {
  try {
    $os = Get-CimInstance Win32_OperatingSystem
    $usedPercent = [math]::Round((1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize) * 100, 1)
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='bun.exe'" |
      ForEach-Object { [pscustomobject]@{ Id = $_.ProcessId; Gb = [math]::Max($_.WorkingSetSize, $_.PrivatePageCount) / 1GB; Cmd = [string]$_.CommandLine } } |
      Sort-Object Gb -Descending
    foreach ($p in $procs) {
      if ($usedPercent -lt $PressurePercent -or $p.Gb -le $LimitGB) { continue }
      $why = "memory $usedPercent%"
      "$(Get-Date -Format s) KILL pid $($p.Id) $([math]::Round($p.Gb,2)) GB ($why) :: $($p.Cmd.Substring(0,[Math]::Min(250,$p.Cmd.Length)))" | Add-Content $log
      & taskkill /PID $p.Id /T /F 2>$null | Out-Null
    }
  } catch {
    "$(Get-Date -Format s) ERROR $($_.Exception.Message)" | Add-Content $log
  }
  Start-Sleep -Seconds $EverySeconds
}

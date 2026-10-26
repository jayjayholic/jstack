# Windows only. Runs a command inside a Windows Job Object with a hard memory ceiling for the whole process tree
# (the build and every worker it spawns). Past the limit, allocations fail and the build dies with OOM instead of
# taking the PC down. The limit is job COMMIT memory, not working set, so it reads higher than Task Manager shows.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File run-capped.ps1 -LimitGB 12 -Command "npm run build"
#   powershell ... -File run-capped.ps1 -LimitGB 12 -Exe "C:\Program Files\Git\bin\bash.exe" -Command "C:\tmp\build.sh"
# Without -Exe the command runs through cmd.exe. heavy_capped in heavy-lock.sh uses the -Exe form with bash.
# At the cap a process can stall instead of dying: TypeScript 7's native tsc (Go) froze at ~7.9 GB of an 8 GB cap with
# zero CPU, four times on 2026-10-26, holding its slot and its RAM until killed. So the job is watched: once it is at
# the cap (the job's memory-limit message, or private bytes within NearCapGB of it) and its CPU time has not grown for
# StallSec, the whole job is terminated and this exits 137 with "hit the N GB memory cap". A job that dies on its own
# at the cap keeps its exit code; the message says it hit the cap. Unless the caller set it, GOMEMLIMIT is set a bit
# under the cap so a Go tool collects harder before the wall. NoticeFile gets one "cap-killed" line per kill.
param(
	[double]$LimitGB = 12,
	[Parameter(Mandatory = $true)][string]$Command,
	[string]$Exe = "",
	[string]$WorkingDirectory = (Get-Location).Path,
	[string]$PeakFile = "",
	[string]$StatusFile = "",
	[int]$StatusEverySec = 15,
	[int]$StallSec = 60,
	[double]$NearCapGB = 0.2,
	[string]$NoticeFile = ""
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class JobCap {
	[StructLayout(LayoutKind.Sequential)]
	struct BASIC { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
	[StructLayout(LayoutKind.Sequential)]
	struct IO { public ulong a, b, c, d, e, f; }
	[StructLayout(LayoutKind.Sequential)]
	struct EXT { public BASIC Basic; public IO Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string n);
	[DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, uint l);
	[DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
	[DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr j, int c, ref EXT i, uint l, IntPtr r);
	[StructLayout(LayoutKind.Sequential)]
	struct PORT { public IntPtr CompletionKey; public IntPtr CompletionPort; }
	[DllImport("kernel32.dll", EntryPoint = "SetInformationJobObject")] static extern bool SetPort(IntPtr j, int c, ref PORT i, uint l);
	[DllImport("kernel32.dll")] static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, UIntPtr key, uint threads);
	[DllImport("kernel32.dll")] static extern bool GetQueuedCompletionStatus(IntPtr port, out uint code, out UIntPtr key, out IntPtr overlapped, uint ms);
	[DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr j, uint code);
	const uint JOB_MEMORY = 0x200, KILL_ON_CLOSE = 0x2000;
	const uint MSG_PROCESS_MEMORY_LIMIT = 9, MSG_JOB_MEMORY_LIMIT = 10;
	// Set by the port thread when the job (or one process in it) runs into the memory limit.
	public static volatile bool LimitHit;
	public static IntPtr Create(ulong bytes) {
		IntPtr job = CreateJobObject(IntPtr.Zero, null);
		EXT info = new EXT();
		info.Basic.LimitFlags = JOB_MEMORY | KILL_ON_CLOSE;
		info.JobMemoryLimit = new UIntPtr(bytes);
		if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(EXT)))) throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
		// Limit messages arrive on a completion port (JobObjectAssociateCompletionPortInformation); without one the
		// kernel only refuses the commit and nobody hears about it.
		IntPtr port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
		PORT p = new PORT();
		p.CompletionKey = job;
		p.CompletionPort = port;
		if (port != IntPtr.Zero && SetPort(job, 7, ref p, (uint)Marshal.SizeOf(typeof(PORT)))) {
			var t = new System.Threading.Thread(() => {
				uint code; UIntPtr key; IntPtr ov;
				while (GetQueuedCompletionStatus(port, out code, out key, out ov, uint.MaxValue)) {
					if (code == MSG_JOB_MEMORY_LIMIT || code == MSG_PROCESS_MEMORY_LIMIT) LimitHit = true;
				}
			});
			t.IsBackground = true;
			t.Start();
		}
		return job;
	}
	public static void Kill(IntPtr job, uint code) { TerminateJobObject(job, code); }
	public static void Assign(IntPtr job, IntPtr process) {
		if (!AssignProcessToJobObject(job, process)) throw new Exception("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
	}
	public static double PeakGB(IntPtr job) {
		EXT info = new EXT();
		QueryInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(EXT)), IntPtr.Zero);
		return info.PeakJobMemoryUsed.ToUInt64() / 1073741824.0;
	}
	[StructLayout(LayoutKind.Sequential)]
	struct ACCT { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
	[DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject")] static extern bool QueryAcct(IntPtr j, int c, ref ACCT i, uint l, IntPtr r);
	[DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject")] static extern bool QueryRaw(IntPtr j, int c, IntPtr buf, uint l, IntPtr r);
	public static double CpuSec(IntPtr job) {
		ACCT a = new ACCT();
		QueryAcct(job, 1, ref a, (uint)Marshal.SizeOf(typeof(ACCT)), IntPtr.Zero);
		return (a.TotalUserTime + a.TotalKernelTime) / 1e7;
	}
	// Private bytes summed over the job's live processes (JobObjectBasicProcessIdList).
	public static double UsedGB(IntPtr job) {
		int n = 2048, size = 8 + IntPtr.Size * n;
		IntPtr buf = Marshal.AllocHGlobal(size);
		try {
			if (!QueryRaw(job, 3, buf, (uint)size, IntPtr.Zero)) return -1;
			int count = Marshal.ReadInt32(buf, 4);
			long sum = 0;
			for (int i = 0; i < count; i++) {
				long pid = Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size).ToInt64();
				try { using (var p = System.Diagnostics.Process.GetProcessById((int)pid)) sum += p.PrivateMemorySize64; } catch { }
			}
			return sum / 1073741824.0;
		} finally { Marshal.FreeHGlobal(buf); }
	}
}
"@

$job = [JobCap]::Create([uint64]($LimitGB * 1GB))
$psi = New-Object System.Diagnostics.ProcessStartInfo
if ($Exe) {
	$psi.FileName = $Exe
	$psi.Arguments = $Command
} else {
	$psi.FileName = "cmd.exe"
	$psi.Arguments = "/d /c $Command"
}
$psi.WorkingDirectory = $WorkingDirectory
$psi.UseShellExecute = $false
# A soft limit for Go tools (ignored by everything else): cap minus 10% (at least 0.5 GB), unless the caller set one.
if (-not $psi.EnvironmentVariables.ContainsKey("GOMEMLIMIT")) {
	$psi.EnvironmentVariables["GOMEMLIMIT"] = "{0}MiB" -f [int64](($LimitGB - [Math]::Max(0.5, $LimitGB * 0.1)) * 1024)
}
$proc = [System.Diagnostics.Process]::Start($psi)
# Children started after this line inherit the job; the shell itself starts in microseconds, so assign at once.
[JobCap]::Assign($job, $proc.Handle)
# Status for heavy-lock.sh admission, every StatusEverySec: "<pid> <used GB> <cpu s> <cpu idle since> <now>" (epoch s).
# used = the job's private bytes now (admission subtracts only the reservation not yet used); cpu idle since = last
# time the job's CPU time grew by 0.5 s or more (a job idle for minutes while holding a slot is hung).
$inv = [Globalization.CultureInfo]::InvariantCulture
$lastCpu = -1.0
$idleSince = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$atCap = $false
$killed = $false
$usedAtKill = 0.0
function Track {
	$cpu = [JobCap]::CpuSec($job)
	$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
	if ($cpu -ge $script:lastCpu + 0.5) { $script:lastCpu = $cpu; $script:idleSince = $now }
	$used = [JobCap]::UsedGB($job)
	if ([JobCap]::LimitHit -or $used -ge $LimitGB - $NearCapGB) { $script:atCap = $true }
	return @{ cpu = $cpu; now = $now; used = $used }
}
function Write-Status($t) {
	if (-not $StatusFile) { return }
	$line = "{0} {1} {2} {3} {4}" -f $PID, $t.used.ToString("F2", $inv), $t.cpu.ToString("F1", $inv), $script:idleSince, $t.now
	try { [IO.File]::WriteAllText($StatusFile, $line) } catch { }
}
$t = Track
Write-Status $t
$lastStatus = $t.now
# Poll every second: the stall check needs it, the status file keeps its own cadence.
while (-not $proc.WaitForExit(1000)) {
	$t = Track
	if ($t.now - $lastStatus -ge [Math]::Max(1, $StatusEverySec)) { Write-Status $t; $lastStatus = $t.now }
	if ($atCap -and $t.now - $idleSince -ge $StallSec) {
		$usedAtKill = $t.used
		$killed = $true
		[JobCap]::Kill($job, 137)
		break
	}
}
$proc.WaitForExit(30000) | Out-Null
$peak = [JobCap]::PeakGB($job)
$code = if ($killed) { 137 } else { $proc.ExitCode }
if ($killed) {
	$msg = [string]::Format($inv, "run-capped: hit the {0} GB memory cap and stalled (no CPU progress for {1} s at {2:N2} GB), killed the job", $LimitGB, $StallSec, $usedAtKill)
	[Console]::Error.WriteLine($msg)
	if ($NoticeFile) {
		$row = [ordered]@{ at = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"); type = "cap-killed"; pid = $proc.Id; name = "run-capped"; wt = $WorkingDirectory.Replace("\", "/"); capGb = $LimitGB; usedGb = [Math]::Round($usedAtKill, 2); stallSec = $StallSec; cmd = $msg }
		try {
			[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($NoticeFile)) | Out-Null
			[IO.File]::AppendAllText($NoticeFile, ($row | ConvertTo-Json -Compress) + "`n")
		} catch { }
	}
} elseif ($code -ne 0 -and ($atCap -or [JobCap]::LimitHit -or $peak -ge $LimitGB - $NearCapGB)) {
	[Console]::Error.WriteLine([string]::Format($inv, "run-capped: hit the {0} GB memory cap; the job exited {1}", $LimitGB, $code))
}
"run-capped: exit {0}, peak {1:N2} GB of {2} GB" -f $code, $peak, $LimitGB | Write-Host
# heavy_capped reads this to record the job's measured peak for admission (heavy-lock.sh job_need_gb).
if ($PeakFile) { [IO.File]::WriteAllText($PeakFile, ("{0:N2}" -f $peak).Replace(",", ".")) }
exit $code

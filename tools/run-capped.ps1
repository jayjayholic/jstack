# Windows only. Runs a command inside a Windows Job Object with a hard memory ceiling for the whole process tree
# (the build and every worker it spawns). Past the limit, allocations fail and the build dies with OOM instead of
# taking the PC down. The limit is job COMMIT memory, not working set, so it reads higher than Task Manager shows.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File run-capped.ps1 -LimitGB 12 -Command "npm run build"
#   powershell ... -File run-capped.ps1 -LimitGB 12 -Exe "C:\Program Files\Git\bin\bash.exe" -Command "C:\tmp\build.sh"
# Without -Exe the command runs through cmd.exe. heavy_capped in heavy-lock.sh uses the -Exe form with bash.
param(
	[double]$LimitGB = 12,
	[Parameter(Mandatory = $true)][string]$Command,
	[string]$Exe = "",
	[string]$WorkingDirectory = (Get-Location).Path,
	[string]$PeakFile = "",
	[string]$StatusFile = "",
	[int]$StatusEverySec = 15
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
	const uint JOB_MEMORY = 0x200, KILL_ON_CLOSE = 0x2000;
	public static IntPtr Create(ulong bytes) {
		IntPtr job = CreateJobObject(IntPtr.Zero, null);
		EXT info = new EXT();
		info.Basic.LimitFlags = JOB_MEMORY | KILL_ON_CLOSE;
		info.JobMemoryLimit = new UIntPtr(bytes);
		if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(EXT)))) throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
		return job;
	}
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
$proc = [System.Diagnostics.Process]::Start($psi)
# Children started after this line inherit the job; the shell itself starts in microseconds, so assign at once.
[JobCap]::Assign($job, $proc.Handle)
# Status for heavy-lock.sh admission, every StatusEverySec: "<pid> <used GB> <cpu s> <cpu idle since> <now>" (epoch s).
# used = the job's private bytes now (admission subtracts only the reservation not yet used); cpu idle since = last
# time the job's CPU time grew by 0.5 s or more (a job idle for minutes while holding a slot is hung).
$inv = [Globalization.CultureInfo]::InvariantCulture
$lastCpu = -1.0
$idleSince = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
function Write-Status {
	if (-not $StatusFile) { return }
	$cpu = [JobCap]::CpuSec($job)
	$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
	if ($cpu -ge $script:lastCpu + 0.5) { $script:lastCpu = $cpu; $script:idleSince = $now }
	$line = "{0} {1} {2} {3} {4}" -f $PID, [JobCap]::UsedGB($job).ToString("F2", $inv), $cpu.ToString("F1", $inv), $script:idleSince, $now
	try { [IO.File]::WriteAllText($StatusFile, $line) } catch { }
}
Write-Status
while (-not $proc.WaitForExit([Math]::Max(1, $StatusEverySec) * 1000)) { Write-Status }
$proc.WaitForExit()
$peak = [JobCap]::PeakGB($job)
"run-capped: exit {0}, peak {1:N2} GB of {2} GB" -f $proc.ExitCode, $peak, $LimitGB | Write-Host
# heavy_capped reads this to record the job's measured peak for admission (heavy-lock.sh job_need_gb).
if ($PeakFile) { [IO.File]::WriteAllText($PeakFile, ("{0:N2}" -f $peak).Replace(",", ".")) }
exit $proc.ExitCode

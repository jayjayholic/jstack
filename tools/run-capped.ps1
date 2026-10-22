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
	[string]$WorkingDirectory = (Get-Location).Path
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
$proc.WaitForExit()
"run-capped: exit {0}, peak {1:N2} GB of {2} GB" -f $proc.ExitCode, [JobCap]::PeakGB($job), $LimitGB | Write-Host
exit $proc.ExitCode

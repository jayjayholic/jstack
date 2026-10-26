// perf-snap: one cheap snapshot of every process and the machine, for tools/perf/collect.mjs (Windows).
// Built from source at install time with the C# compiler that ships with Windows (.NET Framework 4), no binary in git.
//   perf-snap.exe snap        stdin: known "pid:createTime" keys, one per line. stdout (tab separated):
//                             M machine line, P one line per process, D cwd + command line for keys not in stdin,
//                             S this run's own CPU and memory.
//   perf-snap.exe snap light  the same without D lines: no process memory is read, so a machine that is paging hard
//                             still gets its tick (the collector's retry when a full snap fails or times out).
//   perf-snap.exe run <out> <command line>
//                             runs the command line inside a Job Object, stdout+stderr to <out>, waits for the whole
//                             tree, prints JSON: wall, CPU (user+kernel of every process in the tree), peak job memory.
// One NtQuerySystemInformation call gives every process's CPU times, private bytes, working set and I/O counters,
// so a tick costs milliseconds; only processes the collector has not seen yet get their command line read.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class PerfSnap {
	[DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
	[DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int ret);
	[DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);
	[DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
	[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
	[DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow);
	[DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
	[DllImport("kernel32.dll")] static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
	[DllImport("psapi.dll")] static extern bool GetPerformanceInfo(out PERF pi, int cb);
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
	[DllImport("kernel32.dll")] static extern bool DeviceIoControl(IntPtr h, uint code, IntPtr inBuf, int inLen, byte[] outBuf, int outLen, out int ret, IntPtr ov);

	[StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr a; public IntPtr Peb; public IntPtr b; public IntPtr c; public UIntPtr d; public IntPtr e; }
	[StructLayout(LayoutKind.Sequential)] struct PERF {
		public int cb; public UIntPtr CommitTotal, CommitLimit, CommitPeak, PhysicalTotal, PhysicalAvailable, SystemCache, KernelTotal, KernelPaged, KernelNonpaged, PageSize;
		public int HandleCount, ProcessCount, ThreadCount;
	}

	static int Main(string[] args) {
		try {
			if (args.Length >= 3 && args[0] == "run") return Run(args[1], args[2]);
			if (args.Length >= 1 && args[0] == "snap") { Snap(args.Length >= 2 && args[1] == "light"); return 0; }
			Console.Error.WriteLine("usage: perf-snap snap [light] | perf-snap run <outfile> <command line>");
			return 2;
		} catch (Exception e) { Console.Error.WriteLine("perf-snap: " + e.Message); return 1; }
	}

	static IntPtr QueryAll(int cls) {
		int len = 1 << 20, ret;
		for (int i = 0; i < 8; i++) {
			IntPtr buf = Marshal.AllocHGlobal(len);
			int st = NtQuerySystemInformation(cls, buf, len, out ret);
			if (st == 0) return buf;
			Marshal.FreeHGlobal(buf);
			if (st != unchecked((int)0xC0000004)) return IntPtr.Zero;
			len = Math.Max(len * 2, ret + 65536);
		}
		return IntPtr.Zero;
	}

	static string Clean(string s) { return s == null ? "" : s.Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' '); }

	static void Snap(bool light) {
		var known = new HashSet<string>();
		if (Console.IsInputRedirected) { string line; while ((line = Console.In.ReadLine()) != null) { line = line.Trim(); if (line.Length > 0) known.Add(line); } }
		var o = new StringBuilder(1 << 16);
		long idle, kern, user; GetSystemTimes(out idle, out kern, out user);
		PERF pi; GetPerformanceInfo(out pi, Marshal.SizeOf(typeof(PERF)));
		long page = (long)pi.PageSize.ToUInt64();
		long cache = 0;
		IntPtr fc = Marshal.AllocHGlobal(64); int r0;
		if (NtQuerySystemInformation(21, fc, 64, out r0) == 0) cache = Marshal.ReadInt64(fc);
		Marshal.FreeHGlobal(fc);
		long pfTotal = 0, pfUsed = 0;
		IntPtr pf = QueryAll(18);
		if (pf != IntPtr.Zero) {
			int off = 0;
			while (true) {
				int next = Marshal.ReadInt32(pf, off);
				pfTotal += (long)(uint)Marshal.ReadInt32(pf, off + 4) * page;
				pfUsed += (long)(uint)Marshal.ReadInt32(pf, off + 8) * page;
				if (next == 0) break; off += next;
			}
			Marshal.FreeHGlobal(pf);
		}
		// Disk queue and idle time straight from the disk driver (IOCTL_DISK_PERFORMANCE); PDH cost 600 ms of CPU a tick.
		long dq = 0, dIdle = 0, dQuery = 0, dRead = 0, dWrite = 0; int disks = 0;
		byte[] dp = new byte[88];
		for (int i = 0; i < 8; i++) {
			IntPtr h = CreateFile("\\\\.\\PhysicalDrive" + i, 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
			if (h == new IntPtr(-1)) continue;
			int got;
			if (DeviceIoControl(h, 0x70020, IntPtr.Zero, 0, dp, dp.Length, out got, IntPtr.Zero)) {
				dRead += BitConverter.ToInt64(dp, 0); dWrite += BitConverter.ToInt64(dp, 8);
				dIdle += BitConverter.ToInt64(dp, 32); dQuery += BitConverter.ToInt64(dp, 56);
				dq += BitConverter.ToUInt32(dp, 48); disks++;
			}
			CloseHandle(h);
		}
		o.Append("M\t").Append(idle).Append('\t').Append(kern).Append('\t').Append(user).Append('\t')
			.Append((long)pi.PhysicalTotal.ToUInt64() * page).Append('\t').Append((long)pi.PhysicalAvailable.ToUInt64() * page).Append('\t')
			.Append((long)pi.CommitTotal.ToUInt64() * page).Append('\t').Append((long)pi.CommitLimit.ToUInt64() * page).Append('\t')
			.Append(cache).Append('\t').Append((long)pi.KernelPaged.ToUInt64() * page).Append('\t').Append((long)pi.KernelNonpaged.ToUInt64() * page).Append('\t')
			.Append(pfTotal).Append('\t').Append(pfUsed).Append('\t').Append(dq).Append('\t').Append(disks).Append('\t').Append(dIdle).Append('\t').Append(dQuery).Append('\t').Append(dRead).Append('\t').Append(dWrite).Append('\t')
			.Append(pi.ProcessCount).Append('\t').Append(Environment.ProcessorCount).Append('\n');

		IntPtr sp = QueryAll(5);
		if (sp == IntPtr.Zero) throw new Exception("NtQuerySystemInformation(SystemProcessInformation) failed");
		var detail = new List<KeyValuePair<int, long>>();
		try {
			int off = 0;
			while (true) {
				int next = Marshal.ReadInt32(sp, off);
				long create = Marshal.ReadInt64(sp, off + 32);
				long cpu = Marshal.ReadInt64(sp, off + 40) + Marshal.ReadInt64(sp, off + 48);
				int nameLen = Marshal.ReadInt16(sp, off + 56) & 0xFFFF;
				IntPtr nameBuf = Marshal.ReadIntPtr(sp, off + 64);
				string name = nameBuf == IntPtr.Zero ? "System Idle Process" : Marshal.PtrToStringUni(nameBuf, nameLen / 2);
				long pid = Marshal.ReadInt64(sp, off + 80), ppid = Marshal.ReadInt64(sp, off + 88);
				int threads = Marshal.ReadInt32(sp, off + 4), handles = Marshal.ReadInt32(sp, off + 96);
				long ws = Marshal.ReadInt64(sp, off + 144), priv = Marshal.ReadInt64(sp, off + 184);
				long rd = Marshal.ReadInt64(sp, off + 232), wr = Marshal.ReadInt64(sp, off + 240);
				if (pid != 0) {
					o.Append("P\t").Append(pid).Append('\t').Append(ppid).Append('\t').Append(create).Append('\t').Append(Clean(name)).Append('\t')
						.Append(cpu).Append('\t').Append(priv).Append('\t').Append(ws).Append('\t').Append(rd).Append('\t').Append(wr).Append('\t')
						.Append(threads).Append('\t').Append(handles).Append('\n');
					if (!light && !known.Contains(pid + ":" + create)) detail.Add(new KeyValuePair<int, long>((int)pid, create));
				}
				if (next == 0) break; off += next;
			}
		} finally { Marshal.FreeHGlobal(sp); }

		foreach (var d in detail) {
			string cmd = CommandLine(d.Key), cwd = Cwd(d.Key);
			o.Append("D\t").Append(d.Key).Append('\t').Append(d.Value).Append('\t').Append(Clean(cwd)).Append('\t').Append(Clean(cmd)).Append('\n');
		}
		var me = Process.GetCurrentProcess();
		o.Append("S\t").Append(me.TotalProcessorTime.Ticks).Append('\t').Append(me.PeakWorkingSet64).Append('\t').Append(me.PrivateMemorySize64).Append('\n');
		var stdout = Console.OpenStandardOutput();
		var bytes = new UTF8Encoding(false).GetBytes(o.ToString());
		stdout.Write(bytes, 0, bytes.Length);
		stdout.Flush();
	}

	static string CommandLine(int pid) {
		IntPtr h = OpenProcess(0x1000, false, pid);
		if (h == IntPtr.Zero) return null;
		IntPtr buf = IntPtr.Zero;
		try {
			int len = 4096, ret;
			for (int i = 0; i < 4; i++) {
				buf = Marshal.AllocHGlobal(len);
				int st = NtQueryInformationProcess(h, 60, buf, len, out ret);
				if (st == 0) {
					int n = Marshal.ReadInt16(buf) & 0xFFFF;
					IntPtr s = Marshal.ReadIntPtr(buf, 8);
					return n == 0 || s == IntPtr.Zero ? "" : Marshal.PtrToStringUni(s, n / 2);
				}
				Marshal.FreeHGlobal(buf); buf = IntPtr.Zero;
				if (ret <= len) return null;
				len = ret + 64;
			}
			return null;
		} finally { if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf); CloseHandle(h); }
	}

	static IntPtr Ptr(IntPtr h, IntPtr addr) { byte[] b = new byte[8]; IntPtr r; if (!ReadProcessMemory(h, addr, b, 8, out r)) return IntPtr.Zero; return (IntPtr)BitConverter.ToInt64(b, 0); }

	// Same PEB walk as mem-map.ps1's ProcCwd: PEB -> ProcessParameters (+0x20) -> CurrentDirectory.DosPath (+0x38).
	static string Cwd(int pid) {
		IntPtr h = OpenProcess(0x0410, false, pid);
		if (h == IntPtr.Zero) return null;
		try {
			bool wow; if (IsWow64Process(h, out wow) && wow) return null;
			PBI pbi = new PBI(); int ret;
			if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return null;
			IntPtr pp = Ptr(h, pbi.Peb + 0x20); if (pp == IntPtr.Zero) return null;
			byte[] us = new byte[16]; IntPtr r;
			if (!ReadProcessMemory(h, pp + 0x38, us, 16, out r)) return null;
			int len = BitConverter.ToUInt16(us, 0); IntPtr b = (IntPtr)BitConverter.ToInt64(us, 8);
			if (len <= 0 || len > 4096) return null;
			byte[] s = new byte[len];
			if (!ReadProcessMemory(h, b, s, len, out r)) return null;
			return Encoding.Unicode.GetString(s);
		} finally { CloseHandle(h); }
	}

	// ---------- run: measure one command line's whole process tree ----------
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
	[DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
	[DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, int len, IntPtr ret);
	[DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, int len);
	[DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr t);
	[DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
	[DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCINFO pi);
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
		public int cb; public string r, desk, title; public int x, y, w, h, cx, cy, fill, flags; public short show, r2; public IntPtr r3, stdin, stdout, stderr;
	}
	[StructLayout(LayoutKind.Sequential)] struct PROCINFO { public IntPtr hProcess, hThread; public int pid, tid; }

	static int Run(string outFile, string cmdLine) {
		IntPtr job = CreateJobObject(IntPtr.Zero, null);
		// JOBOBJECT_EXTENDED_LIMIT_INFORMATION with KILL_ON_JOB_CLOSE, so nothing outlives the measurement.
		int extLen = 144; IntPtr ext = Marshal.AllocHGlobal(extLen);
		for (int i = 0; i < extLen; i++) Marshal.WriteByte(ext, i, 0);
		Marshal.WriteInt32(ext, 16, 0x2000);
		SetInformationJobObject(job, 9, ext, extLen);
		using (var fs = new FileStream(outFile, FileMode.Create, FileAccess.Write, FileShare.ReadWrite)) {
			IntPtr fh = fs.SafeFileHandle.DangerousGetHandle();
			SetHandleInformation(fh, 1, 1);
			var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); si.flags = 0x100; si.stdout = fh; si.stderr = fh; si.stdin = IntPtr.Zero;
			PROCINFO pi;
			var sw = Stopwatch.StartNew();
			if (!CreateProcess(null, new StringBuilder(cmdLine), IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x08000000, IntPtr.Zero, null, ref si, out pi))
				throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
			AssignProcessToJobObject(job, pi.hProcess);
			ResumeThread(pi.hThread);
			WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
			// The tree may outlive the root process: wait until the job has no active process (BasicAccounting +40).
			IntPtr acct = Marshal.AllocHGlobal(48);
			for (int i = 0; i < 6000; i++) {
				QueryInformationJobObject(job, 1, acct, 48, IntPtr.Zero);
				if (Marshal.ReadInt32(acct, 40) == 0) break;
				System.Threading.Thread.Sleep(10);
			}
			sw.Stop();
			QueryInformationJobObject(job, 1, acct, 48, IntPtr.Zero);
			long cpu = Marshal.ReadInt64(acct, 0) + Marshal.ReadInt64(acct, 8);
			QueryInformationJobObject(job, 9, ext, extLen, IntPtr.Zero);
			long peakJob = Marshal.ReadInt64(ext, 136);
			uint code; GetExitCodeProcess(pi.hProcess, out code);
			CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
			Console.WriteLine("{\"wallMs\":" + sw.ElapsedMilliseconds + ",\"cpuMs\":" + (cpu / 10000) + ",\"peakMb\":" + (peakJob / 1048576.0).ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + ",\"exit\":" + code + "}");
			return 0;
		}
	}
	[DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
}

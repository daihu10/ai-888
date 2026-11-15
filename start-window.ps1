# Invoked in a dedicated PowerShell process by the double-click launcher.
$ErrorActionPreference = 'Stop'

try {
    # A console close does not reliably run PowerShell finally blocks. Windows
    # closes this non-inherited job handle on process exit, killing descendants.
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class WindowProcessJob
{
    private static IntPtr job;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr handle, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr handle, IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static void Attach()
    {
        if (job != IntPtr.Zero) return;
        IntPtr handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new Win32Exception();
        try
        {
            ExtendedLimits limits = new ExtendedLimits();
            limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
            int size = Marshal.SizeOf(typeof(ExtendedLimits));
            IntPtr info = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, info, false);
                if (!SetInformationJobObject(handle, 9, info, (uint)size))
                    throw new Win32Exception();
            }
            finally { Marshal.FreeHGlobal(info); }
            if (!AssignProcessToJobObject(handle, GetCurrentProcess()))
                throw new Win32Exception();
            // Keep the sole handle open until this dedicated process exits.
            job = handle;
        }
        catch
        {
            CloseHandle(handle);
            throw;
        }
    }
}
'@
    [WindowProcessJob]::Attach()

    # The click launcher owns these explicit ports. Refuse occupied ports before
    # delegating: dev.ps1's ordinary port cleanup can terminate their owners.
    foreach ($port in @(3018, 3011)) {
        $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
        if ($listeners | Where-Object { $_.Port -eq $port }) {
            throw "Port $port is already in use. Stop the existing service before starting again."
        }
    }

    Set-Location -LiteralPath $PSScriptRoot
    if (-not (Test-Path -LiteralPath '.env')) {
        Copy-Item -LiteralPath '.env.example' -Destination '.env'
    }
    Write-Host 'Open http://localhost:3011 after startup.' -ForegroundColor Green
    Write-Host 'Keep this window open. Closing it stops both services.' -ForegroundColor Yellow
    & (Join-Path $PSScriptRoot 'dev.ps1') -NoReload -BackendPort 3018 -FrontendPort 3011
}
catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

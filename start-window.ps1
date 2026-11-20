# Invoked in a dedicated PowerShell process by the double-click launcher.
$ErrorActionPreference = 'Stop'

function Get-ProjectProcessRoots {
    param([object[]]$Processes, [string]$ProjectRoot, [int]$LauncherId = $PID)

    $root = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
    $python = Join-Path $root 'backend\.venv\Scripts\python.exe'
    $envFile = [Regex]::Escape((Join-Path $root '.env'))
    $frontend = [Regex]::Escape((Join-Path $root 'frontend\node_modules\'))
    $launcher = [Regex]::Escape($root) + '\\(?:start-window|dev)\.ps1'
    $byId = @{}
    foreach ($process in $Processes) { $byId[[int]$process.ProcessId] = $process }

    # Never terminate this launcher or the shell/agent that invoked it.
    $protected = @{}
    $cursor = $LauncherId
    while ($byId.ContainsKey($cursor) -and -not $protected.ContainsKey($cursor)) {
        $protected[$cursor] = $true
        $cursor = [int]$byId[$cursor].ParentProcessId
    }
    $protected[$LauncherId] = $true
    $owned = @{}
    foreach ($process in $Processes) {
        $processId = [int]$process.ProcessId
        if ($protected.ContainsKey($processId)) { continue }
        $command = [string]$process.CommandLine
        $isBackend = $process.Name -match '^(?:pythonw?|uv)\.exe$' -and
            $command -match '\buvicorn\s+app\.main:app\b' -and
            ($process.ExecutablePath -ieq $python -or
             $command -match ('(?:^|[\s"])' + [Regex]::Escape($python) + '(?:[\s"]|$)') -or
             $command -match ('--env-file(?:\s+|=)"?' + $envFile + '(?:"|\s|$)'))
        $isFrontend = $process.Name -ieq 'node.exe' -and
            $command -match $frontend -and $command -match '\bvite(?:\.js)?\b'
        $isLauncher = $process.Name -match '^(?:powershell|pwsh)\.exe$' -and
            $command -match ('-File\s+"?' + $launcher + '(?:"|\s|$)')
        if ($isBackend -or $isFrontend -or $isLauncher) { $owned[$processId] = $true }
    }

    # A server's reload parent/old launcher must stop too, or it can respawn.
    # Only climb through verified project processes, never a generic shell.
    foreach ($processId in @($owned.Keys)) {
        $cursor = [int]$byId[$processId].ParentProcessId
        $seen = @{}
        while ($byId.ContainsKey($cursor) -and -not $seen.ContainsKey($cursor)) {
            $seen[$cursor] = $true
            if ($owned.ContainsKey($cursor)) { $owned.Remove($processId); break }
            $parent = $byId[$cursor]
            if ($parent.CreationDate -and $byId[$processId].CreationDate -and
                $parent.CreationDate -gt $byId[$processId].CreationDate) { break }
            $cursor = [int]$parent.ParentProcessId
        }
    }
    return @($owned.Keys | Sort-Object)
}

function Stop-ProjectInstance {
    param([string]$ProjectRoot, [int[]]$Ports = @(3018, 3011))

    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $roots = @(Get-ProjectProcessRoots -Processes $processes -ProjectRoot $ProjectRoot)
    $byId = @{}
    foreach ($process in $processes) { $byId[[int]$process.ProcessId] = $process }
    $owned = @{}
    foreach ($process in $processes) {
        $cursor = [int]$process.ProcessId
        $seen = @{}
        while ($byId.ContainsKey($cursor) -and -not $seen.ContainsKey($cursor)) {
            if ($cursor -in $roots) { $owned[[int]$process.ProcessId] = $true; break }
            $seen[$cursor] = $true
            $parentId = [int]$byId[$cursor].ParentProcessId
            if ($byId.ContainsKey($parentId) -and $byId[$parentId].CreationDate -gt $byId[$cursor].CreationDate) { break }
            $cursor = $parentId
        }
    }

    # Check every port before stopping anything; an unrelated program stays open.
    foreach ($port in $Ports) {
        foreach ($connection in @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
            $ownerId = [int]$connection.OwningProcess
            if (-not $owned.ContainsKey($ownerId)) {
                throw "Port $port is used by another program (PID $ownerId, $($byId[$ownerId].Name)). Close it or change its port, then retry."
            }
        }
    }
    foreach ($processId in $roots) {
        # Recheck creation time so a recycled PID cannot target a new process.
        $current = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
        if (-not $current) { continue }
        if ($current.CreationDate -ne $byId[$processId].CreationDate) { throw "Process $processId changed. Retry startup." }
        Write-Host "Stopping previous project process: $($current.Name) (PID $processId)" -ForegroundColor Yellow
        $previousErrorAction = $ErrorActionPreference
        try {
            # Windows PowerShell treats native stderr as an error. Use the exit
            # code below so permission failures still get an actionable message.
            $ErrorActionPreference = 'Continue'
            & taskkill.exe /F /T /PID $processId 2>&1 | Out-Null
            $killExitCode = $LASTEXITCODE
        }
        finally { $ErrorActionPreference = $previousErrorAction }
        if ($killExitCode -ne 0 -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
            throw "Cannot stop project process $processId. Close its old window or run with the same permissions as the old service."
        }
    }
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $remaining = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $owned.ContainsKey([int]$_.ProcessId) -and $_.CreationDate -eq $byId[[int]$_.ProcessId].CreationDate })
        $listeners = @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -in $Ports })
        if ($remaining.Count -eq 0 -and $listeners.Count -eq 0) { return }
        Start-Sleep -Milliseconds 500
    }
    throw 'Previous services have not released their processes or ports. Wait a few seconds and retry.'
}

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

    Stop-ProjectInstance -ProjectRoot $PSScriptRoot

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

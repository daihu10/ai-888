"""Exercise the click launcher's process ownership/stop logic on Windows."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows launcher")
LAUNCHER = Path(__file__).resolve().parents[2] / "start-window.ps1"
ROOT = r"C:\Projects\股票 Panel"


def run_launcher_functions(tmp_path, body, processes):
    fixture = tmp_path / "processes.json"
    fixture.write_text(json.dumps(processes), encoding="utf-8")
    script = tmp_path / "verify.ps1"
    script.write_text(
        """param($SourcePath, $FixturePath, $ProjectRoot)
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SourcePath, [ref]$null, [ref]$null)
foreach ($function in $ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $false)) {
    . ([scriptblock]::Create($function.Extent.Text))
}
$script:processes = Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json
"""
        + body,
        encoding="utf-8-sig",
    )
    return subprocess.run(
        [
            "powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", str(script), str(LAUNCHER), str(fixture), ROOT,
        ],
        capture_output=True, text=True, timeout=20,
    )


def process(pid, parent, name, command, executable=""):
    return {
        "ProcessId": pid, "ParentProcessId": parent, "Name": name,
        "CommandLine": command, "ExecutablePath": executable,
        "CreationDate": "2026-11-19T10:00:00",
    }


def test_identifies_reload_trees_background_servers_and_excludes_other_projects(tmp_path):
    python = ROOT + r"\backend\.venv\Scripts\python.exe"
    processes = [
        process(10, 0, "powershell.exe", f'powershell -File "{ROOT}\\dev.ps1"'),
        process(11, 10, "python.exe", 'python -m uvicorn app.main:app --reload', python),
        process(12, 11, "python.exe", 'python multiprocessing.spawn'),
        process(20, 0, "uv.exe", f'uv run python -m uvicorn app.main:app --env-file "{ROOT}\\.env"'),
        process(21, 20, "python.exe", 'python -m uvicorn app.main:app', python),
        process(30, 0, "node.exe", f'node "{ROOT}\\frontend\\node_modules\\vite\\bin\\vite.js"'),
        process(40, 0, "python.exe", 'python -m uvicorn app.main:app', r"C:\other\python.exe"),
        process(41, 0, "uv.exe", f'uv run uvicorn app.main:app --env-file "{ROOT}-other\\.env"'),
        process(42, 0, "node.exe", f'node "{ROOT}-other\\frontend\\node_modules\\vite\\bin\\vite.js"'),
        process(43, 0, "node.exe", f'node "{ROOT}\\frontend\\node_modules\\vitest\\vitest.mjs"'),
    ]
    result = run_launcher_functions(tmp_path, "@(Get-ProjectProcessRoots $processes $ProjectRoot -LauncherId 999) | ConvertTo-Json -Compress", processes)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == [10, 20, 30]


def test_excludes_current_launcher_and_its_ancestors(tmp_path):
    processes = [
        process(10, 0, "powershell.exe", f'powershell -File "{ROOT}\\start-window.ps1"'),
        process(11, 10, "powershell.exe", f'powershell -File "{ROOT}\\start-window.ps1"'),
    ]
    result = run_launcher_functions(tmp_path, "@(Get-ProjectProcessRoots $processes $ProjectRoot -LauncherId 11).Count", processes)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "0"


def test_refuses_unrelated_port_before_stopping_anything(tmp_path):
    result = run_launcher_functions(tmp_path, """
function Get-CimInstance { return $script:processes }
function Get-NetTCPConnection { [pscustomobject]@{ OwningProcess = 50 } }
function taskkill.exe { throw 'MUST NOT KILL' }
Stop-ProjectInstance -ProjectRoot $ProjectRoot -Ports @(3018)
""", [
        process(50, 0, "other.exe", "other.exe"),
        process(51, 0, "node.exe", f'node "{ROOT}\\frontend\\node_modules\\vite\\bin\\vite.js"'),
    ])
    assert result.returncode != 0
    assert "another program" in result.stderr
    assert "PID 50" in result.stderr
    assert "MUST NOT KILL" not in result.stderr


@pytest.mark.parametrize("failure", [None, "permission", "recycled"])
def test_stop_success_and_fail_closed(tmp_path, failure):
    processes = [process(50, 0, "node.exe", f'node "{ROOT}\\frontend\\node_modules\\vite\\bin\\vite.js"')]
    body = """
$script:stopped = $false
function Get-CimInstance {
    param($ClassName, $Filter)
    if ($script:stopped) { return @() }
    if ($Filter -and 'FAILURE' -eq 'recycled') {
        return [pscustomobject]@{ ProcessId = 50; CreationDate = '2026-11-19T11:00:00' }
    }
    return $script:processes
}
function taskkill.exe {
    if ('FAILURE' -eq 'permission') { $global:LASTEXITCODE = 5; return }
    $script:stopped = $true
    $global:LASTEXITCODE = 0
}
function Get-Process { return [pscustomobject]@{ Id = 50 } }
Stop-ProjectInstance -ProjectRoot $ProjectRoot -Ports @()
if (-not $script:stopped) { throw 'Old process was not stopped' }
""".replace("FAILURE", failure or "none")
    result = run_launcher_functions(tmp_path, body, processes)
    if failure:
        assert result.returncode != 0
        assert ("Cannot stop project process" if failure == "permission" else "changed. Retry") in result.stderr
    else:
        assert result.returncode == 0, result.stderr

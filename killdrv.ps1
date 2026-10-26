# killdrv.ps1 — kill driver + its host child so the supervisor restarts with fresh code.
# Verifies death: the 13:51 hotfix "succeeded" while both drivers kept running, so a
# Stop-Process that does not take must fail the chain instead of echoing a false DEPLOY_OK.
for ($try = 1; $try -le 5; $try++) {
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'driver\.mjs|automation-host' }
    if (-not $procs) {
        if ($try -gt 1) { Write-Output "dead after $($try - 1) kill pass(es)" }
        exit 0
    }
    foreach ($p in $procs) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction Continue
        Write-Output ("killed " + $p.ProcessId)
    }
    Start-Sleep -Milliseconds 700
}
$left = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'driver\.mjs|automation-host' })
if ($left.Count -eq 0) { exit 0 }
foreach ($p in $left) { Write-Output ("SURVIVED " + $p.ProcessId) }
exit 1

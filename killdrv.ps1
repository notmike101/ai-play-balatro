# killdrv.ps1 — kill driver + its host child so the supervisor restarts with fresh code
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'driver\.mjs|automation-host' }
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force; Write-Output ("killed " + $p.ProcessId) }

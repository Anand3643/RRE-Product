[Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $null, 'Process')
$exe = "$env:LOCALAPPDATA\Programs\RRE Tally\RRE Tally.exe"
if (Test-Path $exe) {
    Start-Process -FilePath $exe
} else {
    Start-Process -FilePath "dist\win-unpacked\RRE Tally.exe"
}
Start-Sleep -Seconds 3
Get-Process | Where-Object { $_.Path -like '*RRE Tally*' } | Select-Object Id, ProcessName, Responding

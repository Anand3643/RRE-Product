param (
    [string]$AppDir = $PSScriptRoot
)

$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [System.Environment]::GetFolderPath('Desktop')
$ProgramsPath = [System.Environment]::GetFolderPath('Programs')
$IconPath = Join-Path $AppDir "tally_icon.ico"
$VbsPath = Join-Path $AppDir "Launch-TallyPrime.vbs"

# 1. Create Desktop Shortcut
$DesktopShortcutPath = Join-Path $DesktopPath "RRE Tally.lnk"
$Shortcut = $WshShell.CreateShortcut($DesktopShortcutPath)
$Shortcut.TargetPath = "wscript.exe"
$Shortcut.Arguments = "`"$VbsPath`""
$Shortcut.WorkingDirectory = $AppDir
$Shortcut.WindowStyle = 1
$Shortcut.Description = "RRE Tally (V5 Edition) - Enterprise Suite"
if (Test-Path $IconPath) {
    $Shortcut.IconLocation = "$IconPath, 0"
}
$Shortcut.Save()
Write-Host "Created Desktop Shortcut at: $DesktopShortcutPath" -ForegroundColor Green

# 2. Create Start Menu Shortcut
$StartMenuShortcutPath = Join-Path $ProgramsPath "RRE Tally.lnk"
$SmShortcut = $WshShell.CreateShortcut($StartMenuShortcutPath)
$SmShortcut.TargetPath = "wscript.exe"
$SmShortcut.Arguments = "`"$VbsPath`""
$SmShortcut.WorkingDirectory = $AppDir
$SmShortcut.WindowStyle = 1
$SmShortcut.Description = "RRE Tally (V5 Edition) - Enterprise Suite"
if (Test-Path $IconPath) {
    $SmShortcut.IconLocation = "$IconPath, 0"
}
$SmShortcut.Save()
Write-Host "Created Start Menu Shortcut at: $StartMenuShortcutPath" -ForegroundColor Green

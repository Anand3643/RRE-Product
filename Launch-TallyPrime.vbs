' TallyPrime Gold Silent Native Desktop Launcher
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

ScriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Paths
DistExe = ScriptDir & "\dist\win-unpacked\TallyPrime Gold.exe"
ElectronExe = ScriptDir & "\node_modules\electron\dist\electron.exe"
EdgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
ChromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"

' Ensure ELECTRON_RUN_AS_NODE is cleared
On Error Resume Next
WshShell.Environment("PROCESS").Remove("ELECTRON_RUN_AS_NODE")
On Error GoTo 0

If fso.FileExists(DistExe) Then
    ' 1. Launch via Standalone Built Windows Executable
    WshShell.CurrentDirectory = ScriptDir
    WshShell.Run """" & DistExe & """", 1, False
ElseIf fso.FileExists(ElectronExe) Then
    ' 2. Launch via Native Electron Desktop Shell
    WshShell.CurrentDirectory = ScriptDir
    WshShell.Run """" & ElectronExe & """ .", 1, False
Else
    ' 2. Fallback to Background Node + App-Window Browser
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    On Error Resume Next
    http.Open "GET", "http://localhost:4000/api/gateway/info", False
    http.Send ""
    IsRunning = (http.Status = 200)
    On Error GoTo 0

    If Not IsRunning Then
        WshShell.Run "cmd /c cd /d """ & ScriptDir & """ && node server.js", 0, False
        WScript.Sleep 1500
    End If

    Dim AppCmd
    If fso.FileExists(ChromePath) Then
        AppCmd = """" & ChromePath & """ --app=http://localhost:4000 --window-size=1366,820 --user-data-dir=""" & ScriptDir & "\.tally-profile"""
    ElseIf fso.FileExists(EdgePath) Then
        AppCmd = """" & EdgePath & """ --app=http://localhost:4000 --window-size=1366,820 --user-data-dir=""" & ScriptDir & "\.tally-profile"""
    Else
        AppCmd = "cmd /c start http://localhost:4000"
    End If

    WshShell.Run AppCmd, 1, False
End If

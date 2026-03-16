Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
lockFile = scriptDir & "\server.lock"

' 중복 실행 방지: lock 파일이 있고 node.exe가 실행 중이면 종료
If fso.FileExists(lockFile) Then
    Set wmi = GetObject("winmgmts:\\.\root\cimv2")
    Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='node.exe'")
    If procs.Count > 0 Then
        WScript.Quit
    End If
End If

' lock 파일 생성
Set f = fso.CreateTextFile(lockFile, True)
f.Close

WshShell.CurrentDirectory = scriptDir

' 루프: CMD 창이 닫혀도 자동 재실행
Do
    WshShell.Run "cmd /c start.bat", 7, True
    WScript.Sleep 5000
Loop

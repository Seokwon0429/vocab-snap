Option Explicit

Dim fileSystem, shell, projectRoot, managerPath, powershellPath, arguments

If WScript.Arguments.Named.Exists("verify") Then
  WScript.Quit 0
End If

Set fileSystem = CreateObject("Scripting.FileSystemObject")
projectRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)
managerPath = fileSystem.BuildPath(projectRoot, "scripts\wordlens-server-manager.ps1")

If Not fileSystem.FileExists(managerPath) Then
  MsgBox "WordLens server manager script was not found.", vbCritical, "WordLens Server Manager"
  WScript.Quit 1
End If

powershellPath = fileSystem.BuildPath(CreateObject("WScript.Shell").ExpandEnvironmentStrings("%SystemRoot%"), "System32\WindowsPowerShell\v1.0\powershell.exe")
arguments = "-NoLogo -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & managerPath & """"

Set shell = CreateObject("Shell.Application")
shell.ShellExecute powershellPath, arguments, projectRoot, "open", 0

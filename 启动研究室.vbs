Option Explicit
' Start HBR Lab: pythonw hbr_app.py (only opens the window if the service is already running).
' Keep this file ASCII-only: WSH reads it with the system code page, and UTF-8 Chinese comments
' can swallow the next line (that broke 'Dim shell' before).
Dim shell, fs, root
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
shell.Run "pythonw.exe """ & root & "\hbr_app.py""", 0, False

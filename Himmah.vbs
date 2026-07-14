' Himmah launcher - opens Himmah as a clean standalone app window with NO black command window.
' Double-click this file, or use the desktop shortcut made by "Create Desktop Shortcut.vbs".
' First time only: run "Start Himmah.bat" once so Python gets installed - after that this is all you need.
Option Explicit
Dim sh, fso, root, server, url, i, edge, chrome, udd, started
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
server = root & "\server.py"
url = "http://127.0.0.1:7777/"

' Only start a server if one is not already answering (so a second double-click just re-opens the window).
If Not IsUp(url) Then
  started = False
  On Error Resume Next
  ' Prefer pythonw.exe: it runs Python with NO console window at all. Window style 0 keeps it hidden either way.
  Err.Clear : sh.Run "pythonw.exe """ & server & """ --port 7777", 0, False
  If Err.Number = 0 Then started = True
  If Not started Then Err.Clear : sh.Run "py -3 """ & server & """ --port 7777", 0, False : If Err.Number = 0 Then started = True
  If Not started Then Err.Clear : sh.Run "python """ & server & """ --port 7777", 0, False : If Err.Number = 0 Then started = True
  On Error GoTo 0
  If Not started Then
    MsgBox "Python is not installed yet." & vbCrLf & vbCrLf & _
           "Please double-click ""Start Himmah.bat"" ONCE first - it installs Python for you (free, no admin)." & vbCrLf & _
           "After that, this launcher opens Himmah with no command window.", 48, "Himmah"
    WScript.Quit
  End If
  ' Wait until the server answers (up to ~12 seconds).
  For i = 1 To 60
    WScript.Sleep 200
    If IsUp(url) Then Exit For
  Next
End If

' Open Himmah as a STANDALONE APP WINDOW (no tabs, no address bar). Prefer Edge, then Chrome, else the default browser.
udd = root & "\.appwindow"
edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
If fso.FileExists(edge) Then
  sh.Run """" & edge & """ --app=" & url & " --user-data-dir=""" & udd & """ --start-maximized --window-position=0,0", 1, False
ElseIf fso.FileExists(chrome) Then
  sh.Run """" & chrome & """ --app=" & url & " --user-data-dir=""" & udd & """ --start-maximized --window-position=0,0", 1, False
Else
  sh.Run url, 1, False
End If

' True when Himmah is already serving on the URL. Uses a silent HTTP check (no window).
Function IsUp(u)
  Dim h
  IsUp = False
  On Error Resume Next
  Set h = CreateObject("MSXML2.XMLHTTP")
  h.Open "GET", u, False
  h.Send
  If Err.Number = 0 Then If h.Status = 200 Then IsUp = True
  On Error GoTo 0
End Function

' Puts a "Himmah" shortcut on your desktop (with the Himmah icon) that opens the app in one click.
' Double-click this once. You can then delete nothing - just use the desktop shortcut from now on.
Option Explicit
Dim sh, fso, root, desktop, lnk
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
desktop = sh.SpecialFolders("Desktop")

Set lnk = sh.CreateShortcut(desktop & "\Himmah.lnk")
lnk.TargetPath = root & "\Himmah.vbs"
lnk.WorkingDirectory = root
lnk.IconLocation = root & "\Himmah.ico"
lnk.Description = "Himmah - your calm home for tasks, habits and your week"
lnk.Save

MsgBox "Done." & vbCrLf & vbCrLf & _
       "A ""Himmah"" shortcut is now on your desktop." & vbCrLf & _
       "Double-click it any time to open Himmah - it starts as a clean app window, with no command box.", 64, "Himmah"

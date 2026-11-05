; ---------------------------------------------------------------------------
; Force-close the app before install / uninstall.
;
; Why this file exists:
; electron-builder's stock CHECK_APP_RUNNING (allowOnlyOneInstallerInstance.nsh)
; only politely asks the app to close (taskkill WITHOUT /F) and then retries twice.
; An Electron app is multi-process: main + GPU + renderer + utility processes all
; carry the same image name, so the children usually outlive the polite request and
; the installer gives up with:
;   "CKD SOP Cloud cannot be closed. Please close it manually and click Retry."
;
; Replacing the macro with a forced process-tree kill (taskkill /F /T) removes that
; stop. This file is included in both the installer and the uninstaller.
;
; Keep this file ASCII-only: NSIS compiles it as ANSI.
; ---------------------------------------------------------------------------

!macro customCheckAppRunning
  Push $0

  ; 1st pass: kill the whole tree (parent first, /T takes the children with it).
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 700

  ; 2nd pass: covers the case where a child process respawned while the tree
  ; was collapsing, or a second instance was still shutting down.
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 400

  Pop $0
!macroend

; PKB installerHooks for Tauri v2 — bundled by NSIS via
; `bundle.windows.nsis.installerHooks` in tauri.conf.json.
;
; Purpose: before NSIS copies the binary, detect if a running instance of
; paintkiduakan-master.exe holds the file locked. If so, ask it to gracefully
; quit via `--graceful-quit` (forwards through tauri_plugin_single_instance,
; emits 'app://graceful-quit-requested' to the React tree, processes drafts
; via cmd_save_draft, then std::process::exits). Poll up to ~10s. If still
; running, show a single clear MessageBox and Abort (no generic NSIS dialog).
;
; Replaces the "Error opening file for writing: paintkiduakan-master.exe"
; Abort/Retry/Ignore dialog that users hit when they double-click setup.exe
; while the app is already running (foreground, tray-minimised, or autostart).
;
; ponytail: nsProcess macro stubs inlined here. The Tauri v2 NSIS bundler
; invokes this file from a temp build directory, so a relative !include
; ("nsis-plugins\nsProcess.nsh") fails to resolve. Inlining avoids the path
; resolution problem; the plugin DLLs (nsProcess.dll, nsProcess-x86.dll) still
; must be vendored into installer/nsis-plugins/ (see README.md). The DLLs
; themselves are NOT loaded by name — they're discovered by the NSIS plugin
; loader from the installer directory — so inlining the macros does not
; change DLL resolution.

!macro nsProcessFindProcess PROCESS OUTPUTVAR
    nsProcess::FindProcess "${PROCESS}"
    Pop ${OUTPUTVAR}
!macroend

!macro nsProcessKillProcess PROCESS
    nsProcess::KillProcess "${PROCESS}"
!macroend

!macro nsProcessCloseProcess PROCESS CLOSE_TYPE
    nsProcess::CloseProcess "${PROCESS}" "${CLOSE_TYPE}"
!macroend

!macro nsProcessGetProcessName PID OUTVAR
    nsProcess::GetProcessName "${PID}"
    Pop ${OUTVAR}
!macroend

!macro nsProcessGetProcessPath PID OUTVAR
    nsProcess::GetProcessPath "${PID}"
    Pop ${OUTVAR}
!macroend

!macro nsProcessExitProcess PID
    nsProcess::ExitProcess "${PID}"
!macroend

!macro nsProcessListProcesses COUNT OUTVAR
    nsProcess::ListProcesses "${COUNT}"
    Pop ${OUTVAR}
!macroend

; Tauri v2 calls `HookMacro PreInstall` from the NSIS template. We define
; the macro if not already defined so this file is safe even if the calling
; site is missing (e.g. Tauri version drift). The function pkbPreInstall is
; callable independently for direct NSIS includes.

!ifndef HookPreInstall
  !macro HookPreInstall
    Call pkbPreInstall
  !macroend
!endif

Function pkbPreInstall
    ; bail early if we don't have a $INSTDIR yet (first install mode)
    ${IfNot} ${FileExists} "$INSTDIR\paintkiduakan-master.exe"
        Return
    ${EndIf}

    ; 0 = not found, positive PID = running
    nsProcess::FindProcess "paintkiduakan-master.exe"
    Pop $R0

    ${If} $R0 == "0"
        ; not running — proceed silently
        Return
    ${EndIf}

    ; running — ask it to gracefully quit. The new invocation forwards
    ; `--graceful-quit` via tauri_plugin_single_instance; the existing
    ; instance (if any) handles the ack loop. If there's no instance, the
    ; argv short-circuit in lib.rs (before Builder.build) exits(0) the
    ; new process instantly, and ExecWait returns 0.
    ExecWait '"$INSTDIR\paintkiduakan-master.exe" --graceful-quit' $R1

    ; poll up to ~10s (20 × 500ms). Bail as soon as it's gone.
    ${For} $R2 1 20
        Sleep 500
        nsProcess::FindProcess "paintkiduakan-master.exe"
        Pop $R0
        ${If} $R0 == "0"
            Return
        ${EndIf}
    ${Next}

    ; still running after the timeout — single clear message + Abort
    MessageBox MB_OK|MB_ICONEXCLAMATION "PaintKiDukaan is still running and could not be closed automatically. Please close it manually and re-run Setup." /SD IDOK
    Abort
FunctionEnd

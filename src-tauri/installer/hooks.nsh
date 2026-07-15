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
; ponytail: nsProcess plugin (3rd-party) is NOT vendored and is unavailable
; in Tauri-bundled NSIS 3.11. Use `nsExec` (always available) + `tasklist`
; (always present on Windows) piped through `find /I` instead. `tasklist`
; returns 0 regardless of whether a filter match was found, so we cannot
; branch on its exit code — we branch on `find`'s exit code (0 = match found,
; 1 = no match). This is the standard NSIS pattern for "is process X
; running?" without a 3rd-party plugin.

!macro HookPreInstall
    Call pkbPreInstall
!macroend

!macro HookPreUninstall
    Call pkbPreUninstall
!macroend

!macro HookPostUninstall
    Call pkbPostUninstall
!macroend

; Helper: returns 1 in $0 if paintkiduakan-master.exe is running, 0 otherwise.
; Branches on `find`'s exit code (0=found, 1=not-found), not on `tasklist`'s
; exit code (always 0).
Function pkbIsProcessRunning
    nsExec::ExecToStack 'cmd /c "tasklist /FI "IMAGENAME eq paintkiduakan-master.exe" /NH 2>NUL | find /I "paintkiduakan-master.exe""'
    Pop $0
    Pop $1
    ${If} $0 == 0
        Push 1
    ${Else}
        Push 0
    ${EndIf}
FunctionEnd

Function pkbPreInstall
    ; bail early if we don't have a $INSTDIR yet (first install mode)
    ${IfNot} ${FileExists} "$INSTDIR\paintkiduakan-master.exe"
        Return
    ${EndIf}

    Call pkbIsProcessRunning
    ${If} $0 == 0
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
        Call pkbIsProcessRunning
        ${If} $0 == 0
            Return
        ${EndIf}
    ${Next}

    ; still running after the timeout — single clear message + Abort
    MessageBox MB_OK|MB_ICONEXCLAMATION "PaintKiDukaan is still running and could not be closed automatically. Please close it manually and re-run Setup." /SD IDOK
    Abort
FunctionEnd

; audit(F11): uninstaller hooks — same Single-Instance handshake as install,
; but with the data-protection guard. The pre-uninstall hook mirrors the
; pre-install pattern: ask the running instance to gracefully quit via
; --graceful-quit, poll up to ~10s, then Abort with a single clear MessageBox
; if it still hasn't gone. The post-uninstall hook is best-effort cleanup of
; the per-user app-data directory if the user opted in via the data-wipe flow.
Function pkbPreUninstall
    ; Same running-process check as pkbPreInstall.
    Call pkbIsProcessRunning
    ${If} $0 == 0
        ; not running — proceed silently
        Return
    ${EndIf}

    ; running — forward --graceful-quit through single_instance. The existing
    ; instance will emit app://graceful-quit-requested, wait 3s, then exit.
    ExecWait '"$INSTDIR\paintkiduakan-master.exe" --graceful-quit' $R1

    ; poll up to ~10s (20 × 500ms). Bail as soon as it's gone.
    ${For} $R2 1 20
        Sleep 500
        Call pkbIsProcessRunning
        ${If} $0 == 0
            Return
        ${EndIf}
    ${Next}

    ; still running after the timeout — single clear message + Abort
    MessageBox MB_OK|MB_ICONEXCLAMATION "PaintKiDukaan is still running and could not be closed automatically. Please close it manually and re-run the uninstaller." /SD IDOK
    Abort
FunctionEnd

Function pkbPostUninstall
    ; audit(F11): post-uninstall cleanup. If the user opted in via the in-app
    ; data-wipe flow (security::install_cleanup writes a marker file), wipe
    ; the app-data directory on the way out. Otherwise leave user data alone
    ; — Windows installer convention is "don't destroy user data on uninstall".
    ${IfNot} ${FileExists} "$APPDATA\in.paintkiduakan.master\pkb-wipe-on-uninstall.marker"
        Return
    ${EndIf}

    ; RMDir /r recursively removes the directory and its contents. We ignore
    ; the error code — this is best-effort, and a future reinstall will
    ; recreate the directory anyway.
    RMDir /r "$APPDATA\in.paintkiduakan.master"
FunctionEnd

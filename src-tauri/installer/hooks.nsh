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
; (always present on Windows) instead. `tasklist /FI "IMAGENAME eq X"`
; exits 0 when at least one matching process exists, 1 otherwise — that's
; our "is running?" signal. The polling loop sleeps 500ms and re-checks.

!macro HookPreInstall
    Call pkbPreInstall
!macroend

Function pkbPreInstall
    ; bail early if we don't have a $INSTDIR yet (first install mode)
    ${IfNot} ${FileExists} "$INSTDIR\paintkiduakan-master.exe"
        Return
    ${EndIf}

    ; nsExec returns the tasklist exit code in $0. 0 = process exists, 1 = not.
    ; Output goes to the installer log; we only care about the exit code.
    nsExec::ExecToLog 'tasklist /FI "IMAGENAME eq paintkiduakan-master.exe" /NH'
    ${If} $0 != 0
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
        nsExec::ExecToLog 'tasklist /FI "IMAGENAME eq paintkiduakan-master.exe" /NH'
        ${If} $0 != 0
            Return
        ${EndIf}
    ${Next}

    ; still running after the timeout — single clear message + Abort
    MessageBox MB_OK|MB_ICONEXCLAMATION "PaintKiDukaan is still running and could not be closed automatically. Please close it manually and re-run Setup." /SD IDOK
    Abort
FunctionEnd
; nsProcess.nsh - NSIS plugin header for nsProcess 2.0
;
; Subset required by installer/hooks.nsh. The plugin allows NSIS scripts to
; find/process-kill Windows processes by name or PID.
;
; Source archive: https://nsis.sourceforge.io/NsProcess_plugin
; License: zlib/libpng (free for commercial and non-commercial use)
;
; DLLs (NOT included here - see README.md for vendoring):
;   - nsProcess.dll       (x64)
;   - nsProcess-x86.dll   (i386)
;
; This file is text. The binary DLLs must be vendored once per machine.

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

; Legacy aliases used by some older installs of this plugin
!define nsProcess::FindProcess "!insertmacro nsProcessFindProcess"
!define nsProcess::KillProcess  "!insertmacro nsProcessKillProcess"
!define nsProcess::CloseProcess "!insertmacro nsProcessCloseProcess"
!define nsProcess::ExitProcess  "!insertmacro nsProcessExitProcess"
!define nsProcess::ListProcesses "!insertmacro nsProcessListProcesses"

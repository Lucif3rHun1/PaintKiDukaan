pub mod amsi_check;
pub mod anti_debug;
pub mod anti_dump;
pub mod anti_forensic;
pub mod anti_hook;
pub mod anti_injection;
pub mod anti_screenshot;
pub mod anti_sniff;
pub mod anti_vm;
pub mod clock_guard;
pub mod firewall;
pub mod hostile_env;
pub mod install_cleanup;
pub mod ipc_auth;
pub mod mitigation_policy;
pub mod ntdll_integrity;
pub mod pde;
pub mod pin_entry;
pub mod priv_strip;
pub mod raw_input;
pub mod registry_watch;
pub mod secrets_compat;
pub mod secure_delete;
pub mod secure_desktop;
pub mod secure_log;
pub mod self_integrity;
pub mod string_obfusc;
pub mod syscall;
pub mod usb_watch;

pub use amsi_check::*;
pub use anti_dump::*;
pub use clock_guard::*;
pub use firewall::*;
pub use hostile_env::{HostileEnvReport, HostileResponse, ResponseAction};
pub use mitigation_policy::*;
pub use ntdll_integrity::NtdllReport;
pub use priv_strip::*;
pub use registry_watch::*;
pub use secrets_compat::*;
pub use secure_delete::*;
pub use secure_log::*;
pub use self_integrity::*;
pub use syscall::{clear_ssn_cache, resolve_ssn_with_fallback, SyscallProvider};
pub use usb_watch::*;

pub fn install<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    state: &crate::commands::auth::AppState,
) -> tauri::Builder<R> {
    let builder = ipc_auth::install(builder, state);
    builder
}

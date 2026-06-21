pub mod anti_debug;
pub mod anti_forensic;
pub mod anti_sniff;
pub mod anti_vm;
pub mod hostile_env;
pub mod install_cleanup;
pub mod ipc_auth;

pub use hostile_env::{HostileEnvReport, HostileResponse, ResponseAction};

pub fn install<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    state: &crate::commands::auth::AppState,
) -> tauri::Builder<R> {
    let builder = ipc_auth::install(builder, state);
    builder
}

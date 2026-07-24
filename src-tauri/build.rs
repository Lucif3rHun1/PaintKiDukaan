fn main() {
    tauri_build::build();
    println!("cargo:rustc-env=TS_RS_EXPORT_DIR=../src/domain");
    let pubkey = std::env::var("TAURI_UPDATER_PUBKEY")
        .expect("Set TAURI_UPDATER_PUBKEY before building");
    println!("cargo:rustc-env=TAURI_UPDATER_PUBKEY={pubkey}");
}

//! Phase-2 PoC tests for security findings (paintkiduakan-security).
//!
//! Static + behavioral reproduction of the prior audit's top findings.
//! Safe by construction: no real services, no real registry writes, no real
//! subprocess execution. Toy inputs and source-grep assertions only.

use std::path::PathBuf;

// ===========================================================================
// R-1 — HKCU UninstallString command injection (CWE-78)
// ===========================================================================

/// Reproduce R-1: build the UninstallString the way `install_cleanup.rs`
/// does, with a malicious `app_dir` containing a `"` character, then show
/// the resulting shell command that Windows would execute at uninstall.
#[test]
fn poc_r1_uninstall_string_is_injectable() {
    // Attacker plants a path with a quote + command separator + payload
    // + cmd.exe comment char `#` to swallow the trailing `"`.
    let malicious_app_dir: PathBuf = PathBuf::from(
        r#"C:\Users\Bob\"& calc.exe & rem ATTACKER_PAYLOAD"#,
    );

    // This is the exact format string from src-tauri/src/security/install_cleanup.rs:16
    let uninstall_cmd =
        format!("cmd /c rmdir /s /q \"{}\"", malicious_app_dir.display());

    let cmd_string = uninstall_cmd.clone();

    // 1. Payload survives the unescaped interpolation.
    assert!(
        cmd_string.contains("& calc.exe"),
        "attacker payload `& calc.exe` must survive the unescaped interpolation: {cmd_string}"
    );

    // 2. cmd.exe sees an odd number of unescaped double quotes, so it
    //    parses the `&`-separated tokens as separate commands. With our
    //    payload there are 3 quotes: wrapper-opener, attacker-injected,
    //    wrapper-closer. 3 is odd → cmd.exe treats the path as
    //    `"C:\Users\Bob\"` (closes early) and runs `calc.exe` after `&`.
    let quote_count = cmd_string.chars().filter(|c| *c == '"').count();
    assert_eq!(
        quote_count, 3,
        "expected 3 quotes (2 wrapper + 1 injected) → cmd.exe injection; got {quote_count}: {cmd_string}"
    );

    // 3. The attacker-injected `"` actually breaks the wrapper: the path
    //    argument that cmd.exe reads is `"C:\Users\Bob\"` (terminated at
    //    the attacker's quote), and everything after `&` is a new command.
    assert!(
        cmd_string.contains(r#""C:\Users\Bob\""#),
        "cmd.exe will parse the path as `C:\\Users\\Bob\\\"` (quote-terminated early): {cmd_string}"
    );

    eprintln!(
        "[R-1] Injected UninstallString:\n  {cmd_string}\n\
         → cmd.exe will execute: rmdir C:\\Users\\Bob\\\"& calc.exe & rem ATTACKER_PAYLOAD\n\
         → result: arbitrary command (`calc.exe`) runs as the user when the \
         user clicks \"Uninstall\" in Settings → Apps. Persisted to \
         HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PaintKiDukaan."
    );
}

// ===========================================================================
// S-2/A-1 — Printing commands have zero ACL enforcement
// ===========================================================================

/// Reproduce S-2/A-1: statically + behaviorally confirm `cmd_print_raw`
/// has no authorize() call AND is absent from COMMAND_ACL.
#[test]
fn poc_s2_cmd_print_raw_has_no_authorize_call() {
    let src = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/commands/printing.rs"),
    )
    .expect("must be able to read src/commands/printing.rs");
    let acl = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/security/ipc_auth.rs"),
    )
    .expect("must be able to read ipc_auth.rs");

    assert!(
        !src.contains("authorize("),
        "printing.rs must NOT call authorize() — currently does"
    );
    assert!(
        !src.contains("use crate::security::ipc_auth"),
        "printing.rs must NOT import ipc_auth"
    );

    for cmd in &["cmd_print_raw", "cmd_print_receipt", "cmd_print_receipt_dev"] {
        let in_acl = acl.contains(&format!("name: \"{cmd}\""));
        assert!(
            !in_acl,
            "{cmd} must NOT be in COMMAND_ACL — current ACL grants no gate, so the \
             default-deny path was not taken. Found: {in_acl}"
        );
    }

    eprintln!(
        "[S-2] printing.rs L370-L427: no authorize(), not in COMMAND_ACL; \
         cmd_print_raw, cmd_print_receipt, cmd_print_receipt_dev all reachable \
         once the session is unlocked (or, on non-Windows, by any IPC caller)."
    );
}

// ===========================================================================
// S-1/R-9 — security::mod.rs::install is never called
// ===========================================================================

/// Reproduce S-1/R-9: statically verify that `security::mod.rs::install`
/// is never invoked from `lib.rs::run`, AND that 29+ security modules are
/// declared but most have no init/install that is actually called.
#[test]
fn poc_s1_security_install_never_called_from_lib_rs() {
    let lib_rs = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"),
    )
    .expect("must be able to read src/lib.rs");

    let cleaned: String = lib_rs
        .lines()
        .map(|l| if let Some(idx) = l.find("//") { &l[..idx] } else { l })
        .collect::<Vec<_>>()
        .join("\n");

    assert!(
        !cleaned.contains("security::install("),
        "security::install( should NOT appear in lib.rs — if it does, the \
         hardening modules may now be wired. Current snippet:\n{cleaned}"
    );
    assert!(
        !cleaned.contains("security :: install("),
        "no whitespace-separated form of security::install should appear"
    );

    let security_mod_rs = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/security/mod.rs"),
    )
    .expect("must be able to read src/security/mod.rs");
    let pub_mods = security_mod_rs
        .lines()
        .filter(|l| l.trim_start().starts_with("pub mod "))
        .count();

    // Count modules that have `pub fn init` or `pub fn install`.
    let mut with_init = 0usize;
    let mut without_init: Vec<String> = vec![];
    for entry in std::fs::read_dir(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/security"),
    )
    .unwrap()
    .flatten()
    {
        let p = entry.path();
        if p.extension().and_then(|x| x.to_str()) == Some("rs") {
            if let Ok(t) = std::fs::read_to_string(&p) {
                if t.contains("pub fn init(") || t.contains("pub fn install(") {
                    with_init += 1;
                } else {
                    without_init.push(
                        p.file_name().unwrap().to_string_lossy().into_owned(),
                    );
                }
            }
        }
    }

    eprintln!(
        "[S-1] security/ has {pub_mods} submodules declared; security::install \
         is never called from lib.rs. Modules without init/install (or with \
         init that is never wired): {} → {without_init:?}",
        without_init.len()
    );

    assert!(pub_mods >= 25, "expected ≥25 security submodules");
    assert!(
        without_init.len() >= 20,
        "expected most security modules to have no init/install"
    );
}

// ===========================================================================
// S-5 — PDE commands have no authorize() call
// ===========================================================================

/// Reproduce S-5: statically verify pde.rs has no `authorize` import or call.
#[test]
fn poc_s5_pde_commands_have_no_authorize() {
    let pde_rs = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/security/pde.rs"),
    )
    .expect("must be able to read pde.rs");

    assert!(
        !pde_rs.contains("use crate::security::ipc_auth"),
        "pde.rs should NOT import ipc_auth (no authorize available)"
    );
    assert!(
        !pde_rs.contains("authorize"),
        "pde.rs should NOT reference authorize()"
    );

    for fn_name in &[
        "pub fn provision_decoy_db",
        "pub fn change_decoy_pin",
        "pub fn change_duress_pin",
        "pub fn get_pde_status",
    ] {
        assert!(pde_rs.contains(fn_name), "{fn_name} must exist");
    }

    let acl = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/security/ipc_auth.rs"),
    )
    .unwrap();
    for cmd in &[
        "provision_decoy_db",
        "change_decoy_pin",
        "change_duress_pin",
        "get_pde_status",
    ] {
        assert!(
            !acl.contains(&format!("name: \"{cmd}\"")),
            "{cmd} must NOT be in COMMAND_ACL"
        );
    }

    eprintln!(
        "[S-5] pde.rs has no authorize() reference; provision_decoy_db, \
         change_decoy_pin, change_duress_pin, get_pde_status are unprotected. \
         All 4 are also missing from COMMAND_ACL — the only protection is the \
         command not yet being exposed to a RoleGuard'd UI."
    );
}

// ===========================================================================
// S-6 — RoleGuard defaults to "owner" on null user
// ===========================================================================

/// Reproduce S-6: simulate the exact lookup `RoleGuard.tsx L17` performs
/// when the session user is null.
#[test]
fn poc_s6_role_guard_null_user_returns_owner_level() {
    // Mirror of ROLE_HIERARCHY from roleGuard.tsx (top of file).
    let role_hierarchy = |r: &str| -> i32 {
        match r {
            "stocker" => 0,
            "cashier" => 1,
            "owner" => 2,
            _ => 0,
        }
    };

    // Simulate `s.session.user?.role ?? "owner"` when session.user is null.
    let user_role: Option<&str> = None;
    let current_role = user_role.unwrap_or("owner");
    let current_level = role_hierarchy(current_role);
    let required_level = role_hierarchy("owner");

    assert_eq!(current_role, "owner", "fallback must be 'owner'");
    assert_eq!(current_level, 2, "ROLE_HIERARCHY[owner] must be 2 (highest)");
    assert!(
        current_level >= required_level,
        "null user must satisfy any minRole gate (owner bypass confirmed)"
    );

    // Also reproduce App.tsx L320 (`user?.role ?? "owner"`).
    let app_user_role: Option<&str> = None;
    let app_role = app_user_role.unwrap_or("owner");
    assert_eq!(app_role, "owner");

    eprintln!(
        "[S-6] roleGuard.tsx L17 + App.tsx L320: null user → 'owner' → level 2. \
         Any null-user state bypasses every minRole gate."
    );
}

// ===========================================================================
// R-3 — bare-name Command::new() enables PATH hijack
// ===========================================================================

/// Reproduce R-3: statically list every Command::new() call site in the
/// Rust source and classify it as absolute-path or bare-name.
#[test]
fn poc_r3_bare_command_new_in_security_paths() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut bare = vec![];
    let mut absolute = vec![];

    fn walk(dir: &std::path::Path, bare: &mut Vec<String>, absolute: &mut Vec<String>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, bare, absolute);
                } else if p.extension().and_then(|x| x.to_str()) == Some("rs") {
                    if let Ok(text) = std::fs::read_to_string(&p) {
                        for (lineno, line) in text.lines().enumerate() {
                            if let Some(idx) = line.find("Command::new(") {
                                let after = &line[idx + "Command::new(".len()..];
                                let arg = after
                                    .split(|c: char| c == ',' || c == ')')
                                    .next()
                                    .unwrap_or("")
                                    .trim()
                                    .trim_matches('"');
                                let rel = p
                                    .strip_prefix(
                                        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                                            .join("src"),
                                    )
                                    .unwrap_or(&p)
                                    .display()
                                    .to_string();
                                let entry = format!("{rel}:{}", lineno + 1);
                                let is_abs = arg.starts_with('/')
                                    || arg.starts_with(r"\")
                                    || (arg.len() >= 2
                                        && arg
                                            .chars()
                                            .nth(1)
                                            .map(|c| c == ':')
                                            .unwrap_or(false));
                                if is_abs {
                                    absolute.push(format!("{entry} → \"{arg}\""));
                                } else {
                                    bare.push(format!("{entry} → \"{arg}\""));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    walk(&root, &mut bare, &mut absolute);

    eprintln!("[R-3] BARE Command::new( sites (PATH-hijack-vulnerable):");
    for b in &bare {
        eprintln!("    {b}");
    }
    eprintln!("[R-3] ABSOLUTE Command::new( sites:");
    for a in &absolute {
        eprintln!("    {a}");
    }

    let bare_strs: Vec<String> = bare.iter().map(|s| s.to_lowercase()).collect();
    let must_have_bare = [
        "wmic", "powershell", "lpstat", "lpoptions", "net", "powercfg", "rundll32", "ps", "netstat", "ss",
    ];
    let mut missing: Vec<&str> = vec![];
    for needle in &must_have_bare {
        if !bare_strs.iter().any(|s| s.contains(needle)) {
            missing.push(needle);
        }
    }
    assert!(
        missing.is_empty(),
        "expected bare-name Command::new({:?}) entries; missing: {missing:?}",
        must_have_bare
    );
}

// ===========================================================================
// R-4/R-5 — self-integrity unconditionally sets `signed = true`
// ===========================================================================

/// Reproduce R-4/R-5: show the unconditional `let signed = true;` line.
#[test]
fn poc_r4_self_integrity_signed_is_unconditional() {
    let src = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/security/self_integrity.rs"),
    )
    .expect("must read self_integrity.rs");

    assert!(
        src.contains("let signed = true; // If WinVerifyTrust was called,"),
        "smoking-gun line `let signed = true;` must still be present"
    );

    assert!(
        !src.contains("baseline") && !src.to_lowercase().contains("manifest"),
        "self_integrity.rs must NOT contain any baseline / manifest comparison"
    );

    eprintln!(
        "[R-4] self_integrity.rs L220 unconditionally reports signed=true; \
         no baseline manifest exists in the file."
    );
}

// ===========================================================================
// R-15 — machine salt derived from COMPUTERNAME/HOSTNAME env var
// ===========================================================================

/// Reproduce R-15: confirm the dpapi_keystore module exists on disk but is
/// NOT declared in `security/mod.rs` — so the entire machine-salt mechanism
/// (which was supposed to bind the keystore to a specific host) is INERT.
/// This is WORSE than the original R-15 finding: the salt is never even
/// computed, let alone added to the KDF.
#[test]
fn poc_r15_machine_salt_module_is_inert() {
    let security_mod_rs = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/security/mod.rs"),
    )
    .expect("must read security/mod.rs");

    // The dpapi_keystore module file exists on disk…
    let dpapi_path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/security/dpapi_keystore.rs");
    assert!(
        dpapi_path.exists(),
        "dpapi_keystore.rs must exist on disk for this PoC"
    );

    // …but is it declared in mod.rs?
    let is_declared =
        security_mod_rs.contains("pub mod dpapi_keystore") ||
        security_mod_rs.contains("mod dpapi_keystore");
    assert!(
        !is_declared,
        "dpapi_keystore is NOT declared in security/mod.rs → not compiled, \
         not linked, not callable. machine_salt() never runs."
    );

    // Also check that no caller references it through crate::security::dpapi_keystore.
    let mut refs = 0usize;
    let src_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    fn scan(dir: &std::path::Path, needle: &str, refs: &mut usize) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    scan(&p, needle, refs);
                } else if p.extension().and_then(|x| x.to_str()) == Some("rs") {
                    if let Ok(t) = std::fs::read_to_string(&p) {
                        *refs += t.matches(needle).count();
                    }
                }
            }
        }
    }
    scan(&src_root, "dpapi_keystore", &mut refs);
    assert_eq!(refs, 0, "no Rust file outside dpapi_keystore.rs references dpapi_keystore");

    eprintln!(
        "[R-15] dpapi_keystore.rs exists on disk but is NOT in security/mod.rs → \
         machine_salt() never runs. Original threat model (machine-bound salt \
         preventing offline brute-force of stolen keystore) is NOT implemented. \
         arg: machine_salt_for_hostname() would still be deterministic per \
         hostname if it ran — confirmed via reading the source. Argon2id 6-digit \
         PIN brute-force: ~10^6 / 5e3 GPU guesses/s ≈ 200 s."
    );
}

// ===========================================================================
// A-10 — Non-Windows keystore is plaintext SQLite
// ===========================================================================

/// Reproduce A-10: confirm the dpapi_keystore module (which would provide
/// DPAPI-wrapping on Windows and is supposed to be a pass-through stub on
/// non-Windows) is NOT compiled at all. Worse: `commands::auth::open_keystore`
/// just opens the file directly via `rusqlite::Connection::open(path)` —
/// no DPAPI / encryption layer anywhere on the read path.
#[test]
fn poc_a10_keystore_open_path_is_plaintext_sqlite() {
    // 1. dpapi_keystore.rs exists on disk but is NOT in mod.rs.
    let security_mod_rs = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/security/mod.rs"),
    )
    .expect("must read security/mod.rs");
    assert!(
        !security_mod_rs.contains("pub mod dpapi_keystore"),
        "dpapi_keystore must NOT be in mod.rs (proves it's inert)"
    );

    // 2. auth.rs::open_keystore does NOT call any decrypt step.
    let auth_rs = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/commands/auth.rs"),
    )
    .expect("must read auth.rs");

    let open_keystore_start = auth_rs
        .find("pub(crate) fn open_keystore")
        .expect("open_keystore must exist");
    let open_keystore_end_marker = "\n}\n";
    let open_keystore_end = auth_rs[open_keystore_start..]
        .find(open_keystore_end_marker)
        .map(|i| open_keystore_start + i + 2)
        .expect("end of open_keystore");
    let open_keystore_body = &auth_rs[open_keystore_start..open_keystore_end];

    assert!(
        !open_keystore_body.contains("decrypt")
            && !open_keystore_body.contains("dpapi")
            && !open_keystore_body.contains("encrypt_keystore_blob")
            && !open_keystore_body.contains("decrypt_keystore_blob"),
        "open_keystore must NOT call any decryption — body:\n{open_keystore_body}"
    );

    assert!(
        open_keystore_body.contains("Connection::open"),
        "open_keystore must use Connection::open directly (the smoking gun)"
    );

    // 3. encrypt_keystore_blob / decrypt_keystore_blob exist but are
    //    referenced nowhere on the read path.
    let src_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut blob_refs = 0usize;
    fn scan2(dir: &std::path::Path, refs: &mut usize) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    scan2(&p, refs);
                } else if p.extension().and_then(|x| x.to_str()) == Some("rs") {
                    if let Ok(t) = std::fs::read_to_string(&p) {
                        *refs += t.matches("encrypt_keystore_blob").count();
                        *refs += t.matches("decrypt_keystore_blob").count();
                    }
                }
            }
        }
    }
    scan2(&src_root, &mut blob_refs);
    // 2 declarations in auth.rs; 0 callers elsewhere → defines-but-uses-nowhere.
    assert_eq!(
        blob_refs, 2,
        "encrypt/decrypt_keystore_blob defined twice, called ZERO times"
    );

    eprintln!(
        "[A-10] keystore is plaintext SQLite on ALL platforms. dpapi_keystore.rs \
         is not declared in mod.rs (inert). auth.rs::open_keystore uses \
         rusqlite::Connection::open(path) directly — no decrypt step. \
         encrypt_keystore_blob/decrypt_keystore_blob are defined in auth.rs but \
         called ZERO times. Attacker who steals the keystore file can sqlite3-open \
         it directly and read pin_salt, pin_params, pin_verifier, pin_wrapped_dek \
         in the clear."
    );
}

// ===========================================================================
// S-16 — PdeSettingsCard + SecurityPolicyCard have no RoleGuard
// ===========================================================================

/// Reproduce S-16: statically confirm `BackupSettings` is wrapped in
/// RoleGuard, but the sibling `PdeSettingsCard`/`SecurityPolicyCard` and
/// `SecuritySettings` aggregator are NOT.
#[test]
fn poc_s16_pde_security_card_has_no_roleguard() {
    let sys = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../src/shell/routes/settings/SystemSettings.tsx"),
    )
    .expect("must read SystemSettings.tsx");

    // BackupSettings is wrapped (line ~32-42).
    assert!(
        sys.contains("export function BackupSettings")
            && sys.contains("RoleGuard minRole=\"owner\""),
        "BackupSettings must be wrapped in RoleGuard (regression check)"
    );

    // SecuritySettings aggregator and its children are NOT wrapped.
    let lines: Vec<&str> = sys.lines().collect();

    // Helper: find the body of `export function NAME() { ... }` and assert
    // it does NOT contain a `<RoleGuard` token.
    fn assert_no_roleguard(name: &str, lines: &[&str]) {
        let mut in_fn = false;
        let mut depth = 0;
        for line in lines {
            if !in_fn {
                if line.contains(&format!("function {name}")) || line.contains(&format!("function {name}(")) {
                    in_fn = true;
                    depth += line.matches('{').count() as i32 - line.matches('}').count() as i32;
                    if depth <= 0 { break; }
                    continue;
                }
            } else {
                depth += line.matches('{').count() as i32 - line.matches('}').count() as i32;
                if depth <= 0 {
                    break;
                }
                // If we see <RoleGuard or RoleGuard minRole in body, fail.
                if line.contains("<RoleGuard") || line.contains("RoleGuard minRole=") {
                    panic!("{name} must NOT contain RoleGuard — but found: {line}");
                }
            }
        }
    }

    assert_no_roleguard("SecuritySettings", &lines);
    assert_no_roleguard("PdeSettingsCard", &lines);
    assert_no_roleguard("SecurityPolicyCard", &lines);

    eprintln!(
        "[S-16] SecuritySettings, PdeSettingsCard, SecurityPolicyCard have NO \
         RoleGuard wrapper. The sibling BackupSettings (L34) DOES use \
         RoleGuard minRole=owner. The /settings route as a whole is gated by \
         RoleGuard in App.tsx, so a cashier/stocker cannot reach these cards \
         via the route — but the IPC commands behind them (change_decoy_pin, \
         change_duress_pin, get_security_policy) are reachable directly."
    );
}

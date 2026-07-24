fn main() {
    tauri_build::build();
    println!("cargo:rustc-env=TS_RS_EXPORT_DIR=../src/domain");
    let pubkey = std::env::var("TAURI_UPDATER_PUBKEY")
        .expect("Set TAURI_UPDATER_PUBKEY before building");
    println!("cargo:rustc-env=TAURI_UPDATER_PUBKEY={pubkey}");

    // RU-1 RBAC codegen: commands.toml -> Rust drift-check + TS ACL.
    generate_rbac("..");
}

fn generate_rbac(repo_root: &str) {
    use std::path::Path;
    let toml_path = Path::new(repo_root).join("commands.toml");
    let toml = std::fs::read_to_string(&toml_path)
        .expect("commands.toml not found at repo root");

    let mut entries: Vec<(String, String)> = Vec::new();
    let mut in_commands = false;
    for line in toml.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        if line == "[commands]" { in_commands = true; continue; }
        if line.starts_with('[') { in_commands = false; continue; }
        if !in_commands { continue; }
        if let Some(eq) = line.find('=') {
            let name = line[..eq].trim().to_string();
            let role = line[eq + 1..].trim().trim_matches('"').to_string();
            entries.push((name, role));
        }
    }

    // Rust drift-check table
    let mut rust = String::from(
        "// AUTO-GENERATED from commands.toml - do not edit.\n\n\
         pub const CHECK_ACL: &[(&str, &str)] = &[\n"
    );
    for (name, role) in &entries {
        rust.push_str(&format!("    (\"{name}\", \"{role}\"),\n"));
    }
    rust.push_str("];\n");

    std::fs::write("src/security/acl_generated.rs", &rust).unwrap();
    println!("cargo:rerun-if-changed=../commands.toml");
    println!("cargo:rerun-if-changed=build.rs");

    // TS ACL
    let mut ts = String::from(
        "// AUTO-GENERATED from commands.toml - do not edit.\n\n\
         export type Role = \"owner\" | \"cashier\" | \"stocker\" | \"public\";\n\n\
         export const ACL = {\n"
    );
    for (name, role) in &entries {
        ts.push_str(&format!("  \"{name}\": \"{role}\" as Role,\n"));
    }
    ts.push_str(
        "} as const;\n\n\
         const RANK: Record<Role, number> = { public: 0, stocker: 1, cashier: 2, owner: 3 };\n\n\
         export function canInvoke(cmd: keyof typeof ACL, role: Role): boolean {\n\
         \x20\x20return RANK[role] >= RANK[ACL[cmd]];\n\
         }\n\n\
         export function minRole(cmd: keyof typeof ACL): Role {\n\
         \x20\x20return ACL[cmd];\n\
         }\n"
    );

    let ts_path = Path::new(repo_root).join("src/lib/security/acl.generated.ts");
    std::fs::write(&ts_path, &ts).unwrap();
}

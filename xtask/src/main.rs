//! xtask — Rust-native drift detector for PaintKiDukaan
//!
//! Replaces the legacy Python drift scripts at /tmp/drift-check/.
//! Two checks:
//!   1. arg-shape: cross-references `#[tauri::command]` Rust signatures vs
//!      `invoke<T>(...)` TypeScript call sites.
//!   2. SQL columns: extracts column refs from Rust SQL strings and verifies
//!      they exist in canonical schema.sql.
//!
//! Usage:
//!   cargo run -p xtask -- check    (run all drift checks, exit 1 on mismatch)
//!   cargo run -p xtask -- check --arg-shape
//!   cargo run -p xtask -- check --sql
//!
//! Wired into CI via .github/workflows/drift.yml.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use walkdir::WalkDir;

const RUST_SRC: &str = "src-tauri/src/commands";
const FRONTEND_SRC: &str = "src";
const SCHEMA_PATH: &str = "src-tauri/src/db/schema.sql";

fn project_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask must be a workspace member")
        .to_path_buf()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let check_arg_shape = args.is_empty() || args.contains(&"--arg-shape".to_string());
    let check_sql = args.is_empty() || args.contains(&"--sql".to_string());

    let mut failures = 0u32;

    if check_arg_shape {
        println!("=== Phase 1.A: Tauri command arg-shape drift ===");
        let n = check_arg_shape_drift();
        if n > 0 {
            eprintln!("  FAIL — {} arg-shape mismatches", n);
            failures += n;
        } else {
            println!("  OK — no arg-shape drift");
        }
        println!();
    }

    if check_sql {
        println!("=== Phase 1.B: SQL column drift ===");
        let n = check_sql_drift();
        if n > 0 {
            eprintln!("  FAIL — {} SQL column drift(s)", n);
            failures += n;
        } else {
            println!("  OK — no SQL column drift");
        }
        println!();
    }

    if failures > 0 {
        eprintln!("Drift check FAILED ({} issue(s))", failures);
        ExitCode::from(1)
    } else {
        println!("Drift check PASSED");
        ExitCode::SUCCESS
    }
}

// ============================================================================
// Phase 1.A: Tauri command arg-shape drift
// ============================================================================

#[derive(Debug, Clone)]
struct RustCmd {
    name: String,
    expected_args: Vec<String>,
}

fn extract_balanced(s: &str, start: usize, open: char, close: char) -> Option<(&str, usize)> {
    let bytes = s.as_bytes();
    if bytes.get(start).copied() != Some(open as u8) {
        return None;
    }
    let mut depth = 0i32;
    for i in start..bytes.len() {
        let c = bytes[i] as char;
        if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return Some((&s[start..=i], i + 1));
            }
        }
    }
    None
}

/// Extract param names from `pub fn cmd_xxx(...)` signature.
fn parse_rust_signature(sig: &str) -> Vec<String> {
    // sig is "name: Type, name: Type, ..."
    let mut args = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();
    for c in sig.chars() {
        if c == '<' || c == '(' || c == '[' || c == '{' {
            depth += 1;
            current.push(c);
        } else if c == '>' || c == ')' || c == ']' || c == '}' {
            depth -= 1;
            current.push(c);
        } else if c == ',' && depth == 0 {
            let part = current.trim().to_string();
            if !part.is_empty() {
                args.push(part);
            }
            current.clear();
        } else {
            current.push(c);
        }
    }
    if !current.trim().is_empty() {
        args.push(current.trim().to_string());
    }
    args
}

fn extract_param_name(param: &str) -> Option<String> {
    let trimmed = param.trim();
    // Skip `self`, `state: tauri::State<...>`, `app: tauri::AppHandle`
    if trimmed.starts_with("self") || trimmed.contains("State<") || trimmed.contains("AppHandle") {
        return None;
    }
    let name = trimmed.split(':').next()?.trim();
    // Strip `&` and `mut`
    let name = name
        .trim_start_matches('&')
        .trim_start_matches("mut")
        .trim();
    if name.is_empty()
        || !name
            .chars()
            .next()
            .map_or(false, |c| c.is_alphabetic() || c == '_')
    {
        return None;
    }
    Some(name.to_string())
}

fn collect_rust_commands(dir: &Path) -> Result<Vec<RustCmd>, String> {
    let mut commands = Vec::new();
    for entry in WalkDir::new(dir).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("rs") {
            continue;
        }
        if path.file_name().and_then(|s| s.to_str()) == Some("mod.rs") {
            continue;
        }
        let content =
            fs::read_to_string(path).map_err(|e| format!("read {}: {}", path.display(), e))?;

        // Find each `pub fn cmd_X(...)` (with balanced-paren signature extraction)
        let mut search_from = 0usize;
        while let Some(idx) = content[search_from..].find("pub fn ") {
            let abs_idx = search_from + idx;
            let after_pub_fn = abs_idx + "pub fn ".len();
            // Skip whitespace, extract function name
            let rest = &content[after_pub_fn..];
            let name_end = rest
                .find(|c: char| c == '(' || c.is_whitespace())
                .unwrap_or(rest.len());
            let fn_name = &rest[..name_end];
            if !fn_name.starts_with("cmd_") {
                search_from = after_pub_fn + name_end;
                continue;
            }
            // Find the `(` after fn name
            let paren_offset = rest[name_end..]
                .find('(')
                .ok_or_else(|| format!("no `(` after fn name in {}", path.display()))?;
            let paren_abs = after_pub_fn + name_end + paren_offset;
            // Extract balanced signature
            let (sig_with_parens, _end) = extract_balanced(&content, paren_abs, '(', ')')
                .ok_or_else(|| format!("unbalanced parens in {}", path.display()))?;
            // Strip outer parens
            let sig_inner = &sig_with_parens[1..sig_with_parens.len() - 1];
            let params = parse_rust_signature(sig_inner);
            let arg_names: Vec<String> = params
                .into_iter()
                .filter_map(|p| extract_param_name(&p))
                .collect();
            commands.push(RustCmd {
                name: fn_name.to_string(),
                expected_args: arg_names,
            });
            search_from = paren_abs + sig_with_parens.len();
        }
    }
    Ok(commands)
}

#[derive(Debug, Clone)]
struct FrontendInvoke {
    cmd: String,
    keys: Vec<String>,
    file: PathBuf,
    line: usize,
}

fn parse_frontend_invokes(dir: &Path) -> Result<Vec<FrontendInvoke>, String> {
    let mut invokes = Vec::new();
    for entry in WalkDir::new(dir).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        let ext = path.extension().and_then(|s| s.to_str());
        if !matches!(ext, Some("ts") | Some("tsx")) {
            continue;
        }
        if path.to_string_lossy().contains(".test.") {
            continue;
        }
        let content =
            fs::read_to_string(path).map_err(|e| format!("read {}: {}", path.display(), e))?;

        // Find each `invoke<T>("cmd_name", { ... })`
        let mut search_from = 0usize;
        while let Some(idx) = content[search_from..].find("invoke") {
            let abs_idx = search_from + idx;
            // Skip past `invoke` keyword — expect `<` or `(` next
            let after_invoke = abs_idx + "invoke".len();
            let rest = &content[after_invoke..];
            // Optional <...> generic
            let mut after_generic = after_invoke;
            if rest.starts_with('<') {
                if let Some((_g, end)) = extract_balanced(rest, 0, '<', '>') {
                    after_generic = after_invoke + end;
                }
            }
            // Skip whitespace
            while content[after_generic..].starts_with(|c: char| c.is_whitespace()) {
                after_generic += 1;
            }
            // Must be `(` next
            if !content[after_generic..].starts_with('(') {
                search_from = abs_idx + "invoke".len();
                continue;
            }
            let mut after_paren = after_generic + 1;
            while content[after_paren..].starts_with(|c: char| c.is_whitespace()) {
                after_paren += 1;
            }
            // Expect quoted string for command name
            let cmd_char = content[after_paren..].chars().next();
            if cmd_char != Some('"') && cmd_char != Some('\'') {
                search_from = after_paren;
                continue;
            }
            // Extract quoted cmd name
            let quote = cmd_char.unwrap();
            let after_quote = after_paren + 1;
            let cmd_end = content[after_quote..].find(quote).unwrap_or(content.len());
            let cmd_name = content[after_quote..after_quote + cmd_end].to_string();
            // Find object literal `{` after the comma
            let after_cmd = after_quote + cmd_end + 1;
            let mut search_obj = after_cmd;
            while search_obj < content.len() && !content[search_obj..].starts_with('{') {
                search_obj += 1;
            }
            if search_obj >= content.len() {
                search_from = after_cmd;
                continue;
            }
            // Extract balanced braces
            let (obj, _end) = match extract_balanced(&content, search_obj, '{', '}') {
                Some(v) => v,
                None => {
                    search_from = after_cmd;
                    continue;
                }
            };
            // Extract keys from object
            let keys = extract_object_keys(obj);
            let line_no = content[..abs_idx].matches('\n').count() + 1;
            invokes.push(FrontendInvoke {
                cmd: cmd_name,
                keys,
                file: path.to_path_buf(),
                line: line_no,
            });
            search_from = search_obj + obj.len();
        }
    }
    Ok(invokes)
}

fn extract_object_keys(obj: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();
    let mut in_string: Option<char> = None;
    let bytes = obj.as_bytes();

    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if let Some(q) = in_string {
            current.push(c);
            if c == q && (i == 0 || bytes[i - 1] != b'\\') {
                in_string = None;
            }
            i += 1;
            continue;
        }
        if c == '"' || c == '\'' || c == '`' {
            in_string = Some(c);
            current.push(c);
            i += 1;
            continue;
        }
        if c == '\n' {
            // Skip newlines outside strings
            i += 1;
            continue;
        }
        if c == '(' || c == '[' || c == '{' || c == '<' {
            depth += 1;
            current.push(c);
        } else if c == ')' || c == ']' || c == '}' || c == '>' {
            depth -= 1;
            current.push(c);
        } else if c == ',' && depth == 0 {
            let part = current.trim().trim_end_matches(',').trim();
            if !part.is_empty() && !part.starts_with("...") {
                if let Some(k) = extract_key_from_part(part) {
                    keys.push(k);
                }
            }
            current.clear();
        } else {
            current.push(c);
        }
        i += 1;
    }
    let part = current.trim().trim_end_matches(',').trim();
    if !part.is_empty() && !part.starts_with("...") {
        if let Some(k) = extract_key_from_part(part) {
            keys.push(k);
        }
    }
    keys
}

fn extract_key_from_part(part: &str) -> Option<String> {
    let part = part.trim();
    if let Some(colon_idx) = part.find(':') {
        let key = part[..colon_idx].trim();
        let key = key
            .strip_prefix('[')
            .and_then(|s| s.strip_suffix(']'))
            .unwrap_or(key)
            .trim();
        let key = key.trim_matches(|c| c == '"' || c == '\'' || c == '`');
        if !key.is_empty() && key.chars().all(|c| c.is_alphanumeric() || c == '_') {
            return Some(key.to_string());
        }
    } else if part.chars().all(|c| c.is_alphanumeric() || c == '_') && !part.is_empty() {
        // Shorthand `key`
        return Some(part.to_string());
    }
    None
}

fn is_false_positive(cmd: &str, missing: &BTreeSet<String>, extra: &BTreeSet<String>) -> bool {
    if cmd == "unlock" && extra.contains("error") && extra.contains("message") {
        return true;
    }
    let _ = missing;
    false
}

fn check_arg_shape_drift() -> u32 {
    let project_root = project_root();
    let rust_dir = project_root.join(RUST_SRC);
    let frontend_dir = project_root.join(FRONTEND_SRC);

    let rust_cmds: BTreeMap<String, Vec<String>> = match collect_rust_commands(&rust_dir) {
        Ok(cmds) => cmds
            .into_iter()
            .map(|c| (c.name, c.expected_args))
            .collect(),
        Err(e) => {
            eprintln!("  rust parse error: {}", e);
            return 1;
        }
    };

    let invokes = match parse_frontend_invokes(&frontend_dir) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("  frontend parse error: {}", e);
            return 1;
        }
    };

    println!("  Indexed {} Rust Tauri commands", rust_cmds.len());
    println!("  Indexed {} frontend invoke calls", invokes.len());

    let mut failures = 0u32;
    for inv in &invokes {
        let Some(expected) = rust_cmds.get(&inv.cmd) else {
            continue; // frontend calls a command not in Rust (stub or stub-deletion)
        };
        let sent: BTreeSet<String> = inv.keys.iter().cloned().collect();
        let expected_set: BTreeSet<String> = expected.iter().cloned().collect();
        let missing: BTreeSet<String> = expected_set.difference(&sent).cloned().collect();
        let extra: BTreeSet<String> = sent.difference(&expected_set).cloned().collect();
        if missing.is_empty() && extra.is_empty() {
            continue;
        }
        if is_false_positive(&inv.cmd, &missing, &extra) {
            continue;
        }
        failures += 1;
        let rel_path = inv
            .file
            .strip_prefix(&project_root)
            .unwrap_or(&inv.file)
            .display()
            .to_string();
        println!("  {}() at {}:{}", inv.cmd, rel_path, inv.line);
        println!("    Rust expects: {:?}", expected);
        println!("    Frontend sends: {:?}", inv.keys);
        if !missing.is_empty() {
            println!("    ❌ MISSING: {:?}", missing);
        }
        if !extra.is_empty() {
            println!("    ⚠️  EXTRA:   {:?}", extra);
        }
    }
    if failures > 0 {
        failures
    } else {
        0
    }
}

// ============================================================================
// Phase 1.B: SQL column drift
// ============================================================================

fn parse_schema_columns(path: &Path) -> Result<BTreeMap<String, BTreeSet<String>>, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("read schema: {}", e))?;
    let mut tables: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut current_table: Option<String> = None;
    let mut current_cols: Vec<String> = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim_start();
        // CREATE TABLE table_name (
        if trimmed.to_uppercase().starts_with("CREATE TABLE ") {
            if let Some(name) = current_table.take() {
                tables.insert(name, current_cols.iter().cloned().collect());
            }
            // Extract table name
            if let Some(idx) = trimmed.find('(') {
                let header = &trimmed[12..idx]; // skip "CREATE TABLE "
                let name = header.trim().to_string();
                current_table = Some(name);
                current_cols.clear();
            }
            continue;
        }
        if current_table.is_some() {
            // Column: `name TYPE ...`
            // Match `word TYPE` not preceded by PRIMARY/FOREIGN/UNIQUE/CHECK/CONSTRAINT
            let upper = trimmed.to_uppercase();
            let skip_words = ["PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "CONSTRAINT"];
            if skip_words.iter().any(|w| upper.starts_with(w)) {
                if trimmed.contains(");") {
                    if let Some(name) = current_table.take() {
                        tables.insert(name, current_cols.iter().cloned().collect());
                    }
                }
                continue;
            }
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if parts.len() >= 2 {
                let col_name = parts[0].trim_matches(|c: char| c == ',' || c == '(' || c == ')');
                let col_type = parts[1].to_uppercase();
                if matches!(
                    col_type.as_str(),
                    "INTEGER" | "TEXT" | "REAL" | "BLOB" | "NUMERIC" | "INT" | "BIGINT" | "VARCHAR"
                ) {
                    current_cols.push(col_name.to_string());
                }
            }
            if trimmed.contains(");") {
                if let Some(name) = current_table.take() {
                    tables.insert(name, current_cols.iter().cloned().collect());
                }
            }
        }
    }
    // Final
    if let Some(name) = current_table {
        tables.insert(name, current_cols.iter().cloned().collect());
    }
    Ok(tables)
}

fn extract_sql_columns(sql: &str, tables: &[String]) -> BTreeSet<String> {
    let mut cols = BTreeSet::new();
    let sql_upper = sql.to_uppercase();

    // SELECT clause: between SELECT and FROM (skipping subqueries)
    if let Some(sel_start) = sql_upper.find("SELECT ") {
        if let Some(from_off) = sql_upper[sel_start..].find(" FROM ") {
            let select_clause = &sql[sel_start + 7..sel_start + from_off];
            for c in select_clause.split(',') {
                let c = c.trim();
                let c = c
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .trim_start_matches(|x: char| x == '(' || x.is_alphanumeric() || x == '.')
                    .trim_end_matches(|x: char| x == ')' || x == '.');
                // Strip aliases (col AS name) — handled by split_whitespace taking first word
                let c = c.rsplit_once(" AS ").map(|(before, _)| before).unwrap_or(c);
                // Strip COALESCE wrappers
                let c = c.trim_start_matches("COALESCE(").trim_end_matches(')');
                // Strip function calls like SUM(qty)
                if !c.is_empty() && c != "*" && !c.contains('(') && !c.starts_with('?') {
                    let col = c.split('.').next_back().unwrap_or(c).trim();
                    if !col.is_empty() && !col.to_uppercase().contains("DISTINCT") {
                        cols.insert(col.to_string());
                    }
                }
            }
        }
    }

    // INSERT col list: after ( before VALUES
    if let Some(ins_idx) = sql_upper.find("INSERT INTO ") {
        let after = &sql[ins_idx..];
        if let Some(paren_open) = after.find('(') {
            if let Some((_, _)) = extract_balanced(after, paren_open, '(', ')') {
                let close_paren = after[paren_open..].find(')').unwrap_or(0);
                let inner = &after[paren_open + 1..paren_open + close_paren];
                for c in inner.split(',') {
                    let c = c.trim();
                    if !c.is_empty()
                        && !c.starts_with('?')
                        && c.chars()
                            .next()
                            .map_or(false, |c| c.is_alphabetic() || c == '_')
                    {
                        cols.insert(c.to_string());
                    }
                }
            }
        }
    }

    // UPDATE SET
    if let Some(set_idx) = sql_upper.find(" SET ") {
        if let Some(where_off) = sql_upper[set_idx..].find(" WHERE ") {
            let set_clause = &sql[set_idx + 5..set_idx + where_off];
            for part in set_clause.split(',') {
                let name = part.split('=').next().unwrap_or("").trim();
                if !name.is_empty() && !name.starts_with('?') {
                    cols.insert(name.to_string());
                }
            }
        } else {
            // No WHERE clause — set runs to end
            let set_clause = &sql[set_idx + 5..];
            for part in set_clause.split(',') {
                let name = part.split('=').next().unwrap_or("").trim();
                if !name.is_empty() && !name.starts_with('?') {
                    cols.insert(name.to_string());
                }
            }
        }
    }

    // WHERE clause
    if let Some(where_idx) = sql_upper.find(" WHERE ") {
        let after = &sql[where_idx + 7..];
        // Find end of WHERE clause (next ORDER/GROUP/LIMIT or end)
        let end = ["ORDER ", "GROUP ", "LIMIT ", "RETURNING "]
            .iter()
            .filter_map(|kw| after.to_uppercase().find(kw))
            .min()
            .unwrap_or(after.len());
        let where_clause = &after[..end];
        // Split on AND/OR (delimiters, not within string literals or parens)
        for piece in split_on_and_or(where_clause) {
            let piece = piece.trim();
            // Match `col OP` or `col.col OP`
            if let Some(op_idx) =
                piece.find(|c: char| c == '=' || c == '<' || c == '>' || c == 'I' || c == 'L')
            {
                let name_part = if piece[op_idx..].starts_with("IS")
                    || piece[op_idx..].starts_with("IN")
                    || piece[op_idx..].starts_with("LIKE")
                {
                    piece[..op_idx].trim()
                } else {
                    piece[..op_idx].trim()
                };
                let col = name_part.split('.').next_back().unwrap_or(name_part).trim();
                if !col.is_empty()
                    && !col.starts_with('?')
                    && col
                        .chars()
                        .next()
                        .map_or(false, |c| c.is_alphabetic() || c == '_')
                {
                    cols.insert(col.to_string());
                }
            }
        }
    }

    let _ = tables;
    cols
}

fn split_on_and_or(s: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut i = 0;
    let bytes = s.as_bytes();
    while i < bytes.len() {
        let slice = &s[i..];
        let upper_slice = slice.to_uppercase();
        if upper_slice.starts_with(" AND ") || upper_slice.starts_with(" OR ") {
            parts.push(current.clone());
            current.clear();
            if upper_slice.starts_with(" AND ") {
                i += 5;
            } else {
                i += 4;
            }
            continue;
        }
        // Safely push one char by walking UTF-8 boundary
        let ch = slice.chars().next().unwrap();
        current.push(ch);
        i += ch.len_utf8();
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

fn check_sql_drift() -> u32 {
    let project_root = project_root();
    let schema_path = project_root.join(SCHEMA_PATH);
    let tables = match parse_schema_columns(&schema_path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("  schema parse error: {}", e);
            return 1;
        }
    };

    let rust_dir = project_root.join(RUST_SRC);
    let mut failures = 0u32;
    let mut seen = BTreeSet::new();

    for entry in WalkDir::new(&rust_dir).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("rs") {
            continue;
        }
        // Skip non-command files (db/, security/)
        if path.to_string_lossy().contains("/db/") || path.to_string_lossy().contains("/security/")
        {
            continue;
        }
        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // Find all string literals that look like SQL
        let mut search_from = 0usize;
        while let Some(idx) = content[search_from..].find('"') {
            let abs_idx = search_from + idx + 1;
            // Find closing quote (ignore escaped)
            let close = find_string_end(&content[abs_idx..]);
            if close == 0 {
                search_from = abs_idx;
                continue;
            }
            let sql = &content[abs_idx..abs_idx + close];
            let sql_upper = sql.to_uppercase();
            if !sql_upper.starts_with("SELECT")
                && !sql_upper.starts_with("INSERT INTO")
                && !sql_upper.starts_with("UPDATE")
                && !sql_upper.starts_with("DELETE FROM")
            {
                search_from = abs_idx + close + 1;
                continue;
            }

            // Extract tables referenced
            let mut referenced_tables = Vec::new();
            for kw in &["FROM ", "JOIN ", "INSERT INTO ", "UPDATE "] {
                let mut s = 0;
                while let Some(i) = sql_upper[s..].find(kw) {
                    let after = s + i + kw.len();
                    let mut end = after;
                    while end < sql.len() {
                        let c = sql.as_bytes()[end] as char;
                        if c == ' ' || c == '(' || c == ')' || c == ',' || c == ';' {
                            break;
                        }
                        end += 1;
                    }
                    let table_name = sql[after..end].trim().to_string();
                    if !table_name.is_empty() && tables.contains_key(&table_name) {
                        referenced_tables.push(table_name);
                    }
                    s = end;
                    if s >= sql.len() {
                        break;
                    }
                }
            }
            if referenced_tables.is_empty() {
                search_from = abs_idx + close + 1;
                continue;
            }

            let cols = extract_sql_columns(sql, &referenced_tables);
            for col in &cols {
                // Skip false positives: digits, special chars, common keywords
                if col.is_empty()
                    || col
                        .chars()
                        .next()
                        .map_or(true, |c| !c.is_alphabetic() && c != '_')
                    || col.to_uppercase() == "DISTINCT"
                    || col.contains('?')
                {
                    continue;
                }
                let found = referenced_tables
                    .iter()
                    .any(|t| tables.get(t).map_or(false, |c| c.contains(col)));
                if !found {
                    let key = (path.to_path_buf(), col.clone());
                    if seen.insert(key) {
                        let rel_path = path
                            .strip_prefix(&project_root)
                            .unwrap_or(path)
                            .display()
                            .to_string();
                        let line_no = content[..search_from + idx].matches('\n').count() + 1;
                        println!(
                            "  {}:{} col={:?} not in tables {:?}",
                            rel_path, line_no, col, referenced_tables
                        );
                        failures += 1;
                    }
                }
            }
            search_from = abs_idx + close + 1;
        }
    }

    if failures > 0 {
        failures
    } else {
        0
    }
}

fn find_string_end(s: &str) -> usize {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'"' && (i == 0 || bytes[i - 1] != b'\\') {
            return i;
        }
        i += 1;
    }
    bytes.len()
}

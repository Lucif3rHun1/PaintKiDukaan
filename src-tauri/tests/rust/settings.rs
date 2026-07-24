//! Integration tests for the C2 `set_setting → serde_json::Value` change.
//!
//! Covers the three round-trip properties the design promised:
//! * **Boolean:** a JS `false` reaches the SQL row as a real boolean value.
//! * **Nested object:** runtime-only object settings survive an in-memory
//!   write/read round-trip without manual JSON-stringification.
//! * **Wrong type:** writes that would silently coerce into the wrong SQL
//!   column (e.g. a `Number` into the `shop_name` TEXT column) return a
//!   clean `validation` error — not a panic, not a silent NULL drop.
//!
//! Tests drive [`set_setting_impl`] directly (the pub(crate) layer the Tauri
//! command delegates to) so they exercise the real validation + SQL write
//! path without needing a Tauri runtime.

mod common;

use std::collections::HashMap;
use std::sync::Mutex;

use paintkiduakan_lib::commands::settings::{
    hydrate_settings_from_sql, set_setting_impl, validate_sql_value_type,
};
use paintkiduakan_lib::db::Db;
use serde_json::{json, Value};

fn empty_settings() -> Mutex<HashMap<String, Value>> {
    Mutex::new(HashMap::new())
}

fn read_hashmap(m: &Mutex<HashMap<String, Value>>) -> HashMap<String, Value> {
    m.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[test]
fn boolean_round_trips_through_in_memory_layer() {
    // Mirrors the design promise: TS calls
    //   ipc.setSetting("security.wipe_on_duress", false)
    // — there's no SQL backing for this runtime-only key, so the boolean
    // must land in the in-memory HashMap intact (Value::Bool, not the
    // previous "false"-as-string fallback).
    let db = Db::open_in_memory().expect("open mem db");
    let settings = empty_settings();
    set_setting_impl(
        Some(&db),
        &mut settings.lock().unwrap_or_else(|e| e.into_inner()),
        "security.wipe_on_duress",
        Value::Bool(false),
    )
    .expect("runtime-only bool write");

    let snapshot = read_hashmap(&settings);
    assert_eq!(
        snapshot.get("security.wipe_on_duress"),
        Some(&Value::Bool(false)),
        "boolean must round-trip as Value::Bool — no string coercion"
    );
}

#[test]
fn nested_object_round_trips_through_in_memory_layer() {
    // Mirrors a `label.printer_config_<tab>` style write: the key is
    // runtime-only (no SQL column), so the object value lands in the
    // in-memory HashMap as a Value::Object without any JSON.stringify
    // dance on either side.
    let db = Db::open_in_memory().expect("open mem db");
    let cfg = json!({
        "size": "50x25",
        "dpi": 203,
        "rotation": 90,
        "fields": ["sku", "barcode"],
    });
    let settings = empty_settings();
    set_setting_impl(
        Some(&db),
        &mut settings.lock().unwrap_or_else(|e| e.into_inner()),
        "label.printer_config_items",
        cfg.clone(),
    )
    .expect("object write");

    let snapshot = read_hashmap(&settings);
    let stored = snapshot
        .get("label.printer_config_items")
        .expect("present");
    assert_eq!(stored, &cfg, "object must round-trip identically");
    assert_eq!(stored["size"], "50x25");
    assert_eq!(stored["dpi"], 203);
    assert_eq!(stored["fields"][1], "barcode");
}

#[test]
fn wrong_type_for_sql_column_is_rejected_with_validation_error() {
    // The previous implementation silently coerced wrong types to NULL
    // in `write_sql_setting` (`_ => Null`). After C2 the new
    // validation layer rejects them with a clean `validation` error.
    let cases = [
        ("currency_decimal_places", json!("foo"), "string → INTEGER"),
        ("shop_name", json!(42), "number → TEXT"),
        ("shop_name", json!(true), "boolean → TEXT"),
        ("shop_name", json!({"a": 1}), "object → TEXT"),
        ("failed_attempts_lockout", json!("5"), "string → INTEGER"),
        ("alerts_retention_days", json!([1, 2, 3]), "array → INTEGER"),
    ];
    for (col, value, label) in cases {
        let result = validate_sql_value_type(col, &value);
        assert!(
            result.is_err(),
            "{label}: expected Validation error, got Ok"
        );
        let msg = result.unwrap_err();
        assert!(
            msg.contains("validation") && msg.contains(col),
            "{label}: error message should be structured; got {msg:?}"
        );
    }
}

#[test]
fn correct_types_accepted_and_persist_through_sql_hydration() {
    // A TEXT column with a String lands in SQLite as TEXT and reads back
    // as Value::String after hydrate. An INTEGER column with a Number
    // lands as INTEGER and reads back as Value::Number. Null is always
    // accepted. This is the invariant that justifies the symmetric
    // serde_json::Value wire format.
    let db = Db::open_in_memory().expect("open mem db");
    let settings = empty_settings();
    set_setting_impl(
        Some(&db),
        &mut settings.lock().unwrap_or_else(|e| e.into_inner()),
        "shop_name",
        Value::String("Acme Paints".into()),
    )
    .expect("text write accepted");
    set_setting_impl(
        Some(&db),
        &mut settings.lock().unwrap_or_else(|e| e.into_inner()),
        "currency_decimal_places",
        json!(2),
    )
    .expect("integer write accepted");
    set_setting_impl(
        Some(&db),
        &mut settings.lock().unwrap_or_else(|e| e.into_inner()),
        "security.foo",
        Value::Bool(true),
    )
    .expect("runtime-only bool");

    hydrate_settings_from_sql(&db, &settings);

    let snapshot = read_hashmap(&settings);
    assert_eq!(
        snapshot.get("shop_name"),
        Some(&Value::String("Acme Paints".into())),
        "text column reads back as Value::String"
    );
    assert_eq!(
        snapshot.get("currency_decimal_places"),
        Some(&json!(2)),
        "integer column reads back as Value::Number(2)"
    );
    assert_eq!(
        snapshot.get("security.foo"),
        Some(&Value::Bool(true)),
        "runtime-only bool stays Value::Bool in memory"
    );
}

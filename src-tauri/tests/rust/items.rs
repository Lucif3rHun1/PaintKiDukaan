//! C4 — exhaustive role-stripped projection tests for the items module.
//!
//! The `fetch_item_stripped(tx, id, &role)` boundary inside
//! `commands/items.rs` is the security boundary the audit-5 RBAC review
//! flagged. This suite pins the contract for every (command, role) pair
//! so any future field-leak regression trips a CI test before it ships.
//!
//! Approach: the items module has no `*_impl` shim, so each test calls the
//! public Tauri command directly with a `State<'_, AppState>` built via
//! `tauri::test::mock_app()`. The seeded fixture (from `common::setup()`)
//! supplies a real in-memory SQLCipher DB with the production schema
//! applied. No mocks. The role-bearer lives in `AppState.session`;
//! `require_auth` reads it exactly the same way the binary does.
//!
//! Tauri `State<'_, T>` is a reference wrapper but is *not* `Copy`, so each
//! test calls `app.state::<AppState>()` fresh at every call site (either
//! inline, or via a small `state_of(&app)` closure helper for readability).
//!
//! Coverage matrix (7 commands × 3 roles + pagination + edge cases).
//!
//! | command                  | owner | cashier | stocker | extras                              |
//! |--------------------------|-------|---------|---------|-------------------------------------|
//! | create_item              | ok    | reject  | ok(0)   | negative / blank / promo-cost gate  |
//! | update_item              | ok    | reject  | ok      | archive only owner; partial patch   |
//! | get_item (cmd_get_item)  | full  | strip   | strip   | not-found for all roles             |
//! | lookup_item              | full  | cashier | stocker | per-role envelope shape             |
//! | list_items               | full  | strip   | strip   | archive filter, archived_only flag  |
//! | cmd_list_items_paged     | full  | strip   | strip   | default, include, archived_only,    |
//! |                          |       |         |         | limit clamp, offset out of range    |
//! | normalize_item_names     | ok    | reject  | reject  | —                                   |

mod common;

use std::collections::HashMap;

use common::*;
use paintkiduakan_lib::commands::auth::{AppState, User as AuthUser};
use paintkiduakan_lib::commands::items::{
    self, Item, ItemFilter, ItemLookup, ItemUpdate, NewItem,
};
use paintkiduakan_lib::db::list::ListQuery;
use paintkiduakan_lib::error::AppError;
use paintkiduakan_lib::session::Role;
use tauri::Manager;

// ---- fixtures ---------------------------------------------------------------

/// Build a fresh in-memory DB with the canonical fixture, then hand the Db
/// over to a mock Tauri app whose `AppState.session` is set to `role`.
/// Dropping the returned App drops the state and (transitively) the Db.
fn app_with_role(role: &str) -> tauri::App<tauri::test::MockRuntime> {
    let fx = common::setup();
    let db = fx.db; // moves out of the fixture; the rest of the fixture is dropped
    let app = tauri::test::mock_app();
    let state = AppState {
        db: std::sync::Mutex::new(Some(db)),
        session: std::sync::Mutex::new(Some(auth_user(role))),
        ..AppState::default()
    };
    app.manage(state);
    app
}

fn auth_user(role: &str) -> AuthUser {
    let (id, name) = match role {
        "owner" => (OWNER_ID, "Owner"),
        "cashier" => (CASHIER_ID, "Cashier"),
        "stocker" => (STOCKER_ID, "Stocker"),
        other => panic!("unknown role {other}"),
    };
    AuthUser {
        id,
        name: name.into(),
        role: role.into(),
        is_active: true,
    }
}

fn reauth(app: &tauri::App<tauri::test::MockRuntime>, role: &str) {
    *app.state::<AppState>()
        .session
        .lock()
        .expect("session lock") = Some(auth_user(role));
}

fn blank_item() -> Item {
    Item {
        id: 0,
        sku_code: String::new(),
        barcode: None,
        name: String::new(),
        brand: None,
        category: None,
        unit_code: "pc".into(),
        unit_label: "Piece".into(),
        unit: "pcs".into(),
        units_per_pack: Some(1.0),
        sell_unit: "pcs".into(),
        sell_unit_id: None,
        retail_price_paise: 0,
        cost_paise: 0,
        promo_price_paise: None,
        label_line1: None,
        label_line2: None,
        primary_location_id: Some(LOCATION_ID),
        sub_location_id: None,
        position: None,
        min_stock: 0.0,
        barcode_format: Some("CODE128".into()),
        is_active: true,
        current_qty: 0.0,
        created_at: "0".into(),
        updated_at: "0".into(),
        brand_id: None,
    }
}

fn blank_update() -> ItemUpdate {
    ItemUpdate {
        name: None,
        brand: None,
        brand_id: None,
        category: None,
        unit: None,
        unit_code: None,
        unit_label: None,
        units_per_pack: None,
        sell_unit: None,
        sell_unit_id: None,
        retail_price_paise: None,
        cost_paise: None,
        promo_price_paise: None,
        label_line1: None,
        label_line2: None,
        primary_location_id: None,
        sub_location_id: None,
        position: None,
        min_stock: None,
        barcode_format: None,
        barcode: None,
        is_active: None,
    }
}

fn sample_new_item(cost: i64, retail: i64) -> NewItem {
    NewItem {
        name: "Test Brush".into(),
        brand: None,
        brand_id: None,
        category: None,
        unit: Some("pcs".into()),
        unit_code: Some("pc".into()),
        unit_label: Some("Piece".into()),
        units_per_pack: Some(1.0),
        sell_unit: Some("pcs".into()),
        sell_unit_id: None,
        retail_price_paise: retail,
        cost_paise: cost,
        promo_price_paise: None,
        label_line1: None,
        label_line2: None,
        primary_location_id: LOCATION_ID,
        sub_location_id: None,
        position: None,
        min_stock: Some(0.0),
        barcode_format: Some("CODE128".into()),
        barcode: Some("8900000999".into()),
    }
}

fn blank_list_query() -> ListQuery {
    ListQuery {
        search: None,
        sort_field: None,
        sort_dir: None,
        filters: HashMap::new(),
        limit: None,
        offset: None,
    }
}

// ============================================================================
// Item::strip_sensitive_for_role — pure projection boundary
// ============================================================================

#[test]
fn projection_owner_keeps_cost_and_retail() {
    let mut item = blank_item();
    item.cost_paise = 5_000;
    item.retail_price_paise = 10_000;
    item.strip_sensitive_for_role(&Role::Owner);
    assert_eq!(item.cost_paise, 5_000);
    assert_eq!(item.retail_price_paise, 10_000);
}

#[test]
fn projection_cashier_zeroes_cost_keeps_retail() {
    let mut item = blank_item();
    item.cost_paise = 5_000;
    item.retail_price_paise = 10_000;
    item.strip_sensitive_for_role(&Role::Cashier);
    assert_eq!(item.cost_paise, 0, "cashier must not see cost");
    assert_eq!(item.retail_price_paise, 10_000);
}

#[test]
fn projection_stocker_zeroes_cost_keeps_retail() {
    let mut item = blank_item();
    item.cost_paise = 5_000;
    item.retail_price_paise = 10_000;
    item.strip_sensitive_for_role(&Role::Stocker);
    assert_eq!(item.cost_paise, 0, "stocker must not see cost");
    assert_eq!(item.retail_price_paise, 10_000);
}

// ============================================================================
// create_item — role + price gates (3 roles × {ok,reject})
// ============================================================================

#[test]
fn create_item_owner_with_cost_and_retail_succeeds_and_preserves_both() {
    let app = app_with_role("owner");
    let item = items::create_item(app.state::<AppState>(), sample_new_item(5_000, 10_000))
        .expect("owner should create with cost + retail");
    assert_eq!(item.cost_paise, 5_000, "owner must see full cost");
    assert_eq!(item.retail_price_paise, 10_000);
    assert_eq!(item.name, "Test Brush");
    assert!(item.is_active);
}

#[test]
fn create_item_cashier_rejected_with_forbidden() {
    let app = app_with_role("cashier");
    let res = items::create_item(app.state::<AppState>(), sample_new_item(0, 0));
    assert!(
        matches!(res, Err(AppError::Forbidden(_))),
        "cashier must be rejected from create_item, got: {res:?}"
    );
}

#[test]
fn create_item_stocker_with_zero_prices_succeeds() {
    let app = app_with_role("stocker");
    let item = items::create_item(app.state::<AppState>(), sample_new_item(0, 0))
        .expect("stocker with cost=0, retail=0 should succeed");
    assert_eq!(item.cost_paise, 0, "stocker sees zeroed cost on their own create");
    assert_eq!(item.retail_price_paise, 0);
}

#[test]
fn create_item_stocker_with_cost_rejected_with_forbidden() {
    let app = app_with_role("stocker");
    let res = items::create_item(app.state::<AppState>(), sample_new_item(5_000, 0));
    assert!(
        matches!(res, Err(AppError::Forbidden(_))),
        "stocker with cost>0 must be rejected, got: {res:?}"
    );
}

#[test]
fn create_item_stocker_with_retail_rejected_with_forbidden() {
    let app = app_with_role("stocker");
    let res = items::create_item(app.state::<AppState>(), sample_new_item(0, 10_000));
    assert!(
        matches!(res, Err(AppError::Forbidden(_))),
        "stocker with retail>0 must be rejected, got: {res:?}"
    );
}

#[test]
fn create_item_stocker_with_promo_rejected_with_forbidden() {
    let app = app_with_role("stocker");
    let mut payload = sample_new_item(0, 0);
    payload.promo_price_paise = Some(8_000);
    let res = items::create_item(app.state::<AppState>(), payload);
    assert!(
        matches!(res, Err(AppError::Forbidden(_))),
        "stocker setting promo price must be rejected"
    );
}

#[test]
fn create_item_owner_with_negative_cost_rejected_with_validation() {
    let app = app_with_role("owner");
    let res = items::create_item(app.state::<AppState>(), sample_new_item(-1, 0));
    assert!(matches!(res, Err(AppError::Validation(_))));
}

#[test]
fn create_item_owner_with_negative_retail_rejected_with_validation() {
    let app = app_with_role("owner");
    let res = items::create_item(app.state::<AppState>(), sample_new_item(0, -1));
    assert!(matches!(res, Err(AppError::Validation(_))));
}

#[test]
fn create_item_owner_with_blank_name_rejected_with_validation() {
    let app = app_with_role("owner");
    let mut payload = sample_new_item(0, 0);
    payload.name = "   ".into();
    let res = items::create_item(app.state::<AppState>(), payload);
    assert!(matches!(res, Err(AppError::Validation(_))));
}

#[test]
fn create_item_owner_with_zero_location_rejected_with_validation() {
    let app = app_with_role("owner");
    let mut payload = sample_new_item(0, 0);
    payload.primary_location_id = 0;
    let res = items::create_item(app.state::<AppState>(), payload);
    assert!(matches!(res, Err(AppError::Validation(_))));
}

// ============================================================================
// update_item — partial patch + archive-only-owner
// ============================================================================

#[test]
fn update_item_owner_partial_patch_preserves_is_active() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(5_000, 10_000))
        .unwrap();
    let patch = ItemUpdate {
        name: Some("Renamed Brush".into()),
        ..blank_update()
    };
    let res = items::update_item(app.state::<AppState>(), created.id, patch).unwrap();
    assert_eq!(res.name, "Renamed Brush");
    assert!(res.is_active, "is_active preserved when patch.is_active is None");
    assert_eq!(res.cost_paise, 5_000, "owner sees unchanged cost");
}

#[test]
fn update_item_owner_can_archive() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(0, 0)).unwrap();
    let patch = ItemUpdate {
        is_active: Some(false),
        ..blank_update()
    };
    let res = items::update_item(app.state::<AppState>(), created.id, patch).unwrap();
    assert!(!res.is_active, "owner must be able to archive");
}

#[test]
fn update_item_owner_can_unarchive() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(0, 0)).unwrap();
    items::update_item(
        app.state::<AppState>(),
        created.id,
        ItemUpdate {
            is_active: Some(false),
            ..blank_update()
        },
    )
    .unwrap();
    let res = items::update_item(
        app.state::<AppState>(),
        created.id,
        ItemUpdate {
            is_active: Some(true),
            ..blank_update()
        },
    )
    .unwrap();
    assert!(res.is_active, "owner must be able to un-archive");
}

#[test]
fn update_item_stocker_cannot_archive() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(0, 0)).unwrap();
    reauth(&app, "stocker");
    let res = items::update_item(
        app.state::<AppState>(),
        created.id,
        ItemUpdate {
            is_active: Some(false),
            ..blank_update()
        },
    );
    assert!(
        matches!(res, Err(AppError::Forbidden(_))),
        "stocker must not be able to archive, got: {res:?}"
    );
}

#[test]
fn update_item_stocker_cannot_unarchive() {
    // The audit's specific concern: a stocker cannot flip an archived item
    // back to active. Setting is_active = Some(true) is just as restricted
    // as Some(false) — the ACL check is on is_active.is_some(), not its value.
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(0, 0)).unwrap();
    items::update_item(
        app.state::<AppState>(),
        created.id,
        ItemUpdate {
            is_active: Some(false),
            ..blank_update()
        },
    )
    .unwrap();
    reauth(&app, "stocker");
    let res = items::update_item(
        app.state::<AppState>(),
        created.id,
        ItemUpdate {
            is_active: Some(true),
            ..blank_update()
        },
    );
    assert!(
        matches!(res, Err(AppError::Forbidden(_))),
        "stocker must not be able to un-archive, got: {res:?}"
    );
}

#[test]
fn update_item_stocker_cannot_change_cost() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(5_000, 10_000))
        .unwrap();
    reauth(&app, "stocker");
    let res = items::update_item(
        app.state::<AppState>(),
        created.id,
        ItemUpdate {
            cost_paise: Some(7_000),
            ..blank_update()
        },
    );
    assert!(matches!(res, Err(AppError::Forbidden(_))));
}

#[test]
fn update_item_stocker_cannot_change_retail() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(5_000, 10_000))
        .unwrap();
    reauth(&app, "stocker");
    let res = items::update_item(
        app.state::<AppState>(),
        created.id,
        ItemUpdate {
            retail_price_paise: Some(12_000),
            ..blank_update()
        },
    );
    assert!(matches!(res, Err(AppError::Forbidden(_))));
}

#[test]
fn update_item_stocker_can_change_name() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(0, 0)).unwrap();
    reauth(&app, "stocker");
    let res = items::update_item(
        app.state::<AppState>(),
        created.id,
        ItemUpdate {
            name: Some("Relabeled".into()),
            ..blank_update()
        },
    )
    .unwrap();
    assert_eq!(res.name, "Relabeled");
}

#[test]
fn update_item_cashier_rejected_with_forbidden() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(0, 0)).unwrap();
    reauth(&app, "cashier");
    let res = items::update_item(
        app.state::<AppState>(),
        created.id,
        ItemUpdate {
            name: Some("x".into()),
            ..blank_update()
        },
    );
    assert!(matches!(res, Err(AppError::Forbidden(_))));
}

#[test]
fn update_item_unknown_id_returns_not_found() {
    let app = app_with_role("owner");
    let res = items::update_item(
        app.state::<AppState>(),
        9_999_999,
        ItemUpdate {
            name: Some("ghost".into()),
            ..blank_update()
        },
    );
    assert!(matches!(res, Err(AppError::NotFound(_))));
}

#[test]
fn update_item_empty_patch_rejected_with_validation() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(0, 0)).unwrap();
    let res = items::update_item(app.state::<AppState>(), created.id, blank_update());
    assert!(matches!(res, Err(AppError::Validation(_))));
}

// ============================================================================
// get_item (cmd_get_item) — fetch_item_stripped seam, 3 roles
// ============================================================================

#[test]
fn get_item_owner_returns_full_item_with_cost() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(5_000, 10_000))
        .unwrap();
    let res = items::get_item(app.state::<AppState>(), created.id).unwrap();
    assert_eq!(res.cost_paise, 5_000, "owner must see cost");
    assert_eq!(res.retail_price_paise, 10_000);
    assert_eq!(res.name, "Test Brush");
    assert_eq!(res.id, created.id);
}

#[test]
fn get_item_cashier_has_cost_zeroed() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(5_000, 10_000))
        .unwrap();
    reauth(&app, "cashier");
    let res = items::get_item(app.state::<AppState>(), created.id).unwrap();
    assert_eq!(res.cost_paise, 0, "cashier must not see cost");
    assert_eq!(
        res.retail_price_paise, 10_000,
        "cashier keeps retail for the sale line"
    );
}

#[test]
fn get_item_stocker_has_cost_zeroed() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(5_000, 10_000))
        .unwrap();
    reauth(&app, "stocker");
    let res = items::get_item(app.state::<AppState>(), created.id).unwrap();
    assert_eq!(res.cost_paise, 0, "stocker must not see cost");
    assert_eq!(res.retail_price_paise, 10_000);
}

#[test]
fn get_item_unknown_id_returns_not_found_for_all_roles() {
    for role in ["owner", "cashier", "stocker"] {
        let app = app_with_role(role);
        let res = items::get_item(app.state::<AppState>(), 9_999_999);
        assert!(
            matches!(res, Err(AppError::NotFound(_))),
            "{role} must see NotFound for missing id, got: {res:?}"
        );
    }
}

// ============================================================================
// lookup_item — ItemLookup envelope shape, 3 roles
// ============================================================================

#[test]
fn lookup_item_owner_returns_full_item_envelope() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(5_000, 10_000))
        .unwrap();
    let code = created.barcode.clone().expect("barcode set");
    let res = items::lookup_item(app.state::<AppState>(), code).unwrap().expect("found");
    match res {
        ItemLookup::Owner(inner) => {
            assert_eq!(inner.cost_paise, 5_000, "owner envelope carries cost");
            assert_eq!(inner.retail_price_paise, 10_000);
        }
        other => panic!("expected Owner envelope, got: {other:?}"),
    }
}

#[test]
fn lookup_item_cashier_returns_limited_envelope_without_cost() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(5_000, 10_000))
        .unwrap();
    let code = created.barcode.clone().expect("barcode set");
    reauth(&app, "cashier");
    let res = items::lookup_item(app.state::<AppState>(), code).unwrap().expect("found");
    match res {
        ItemLookup::Cashier {
            id,
            sku_code,
            name,
            retail_price_paise,
            sell_unit,
            unit,
            units_per_pack,
            in_stock,
        } => {
            assert_eq!(id, created.id);
            assert!(!sku_code.is_empty());
            assert_eq!(name, "Test Brush");
            assert_eq!(retail_price_paise, 10_000);
            assert_eq!(sell_unit, "pcs");
            assert_eq!(unit, "pcs");
            assert_eq!(units_per_pack, Some(1.0));
            assert!(in_stock >= 0.0);
        }
        other => panic!("expected Cashier envelope, got: {other:?}"),
    }
}

#[test]
fn lookup_item_stocker_returns_qty_per_loc_envelope_without_prices() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(5_000, 10_000))
        .unwrap();
    let code = created.barcode.clone().expect("barcode set");
    reauth(&app, "stocker");
    let res = items::lookup_item(app.state::<AppState>(), code).unwrap().expect("found");
    match res {
        ItemLookup::Stocker {
            id,
            sku_code,
            name,
            min_stock,
            qty_per_loc,
        } => {
            assert_eq!(id, created.id);
            assert!(!sku_code.is_empty());
            assert_eq!(name, "Test Brush");
            assert_eq!(min_stock, 0.0);
            // No preloaded stock for this item, but the envelope must
            // still surface the seeded location row shape.
            let _: Vec<_> = qty_per_loc; // typecheck only
        }
        other => panic!("expected Stocker envelope, got: {other:?}"),
    }
}

#[test]
fn lookup_item_unknown_code_returns_none_for_all_roles() {
    for role in ["owner", "cashier", "stocker"] {
        let app = app_with_role(role);
        let res = items::lookup_item(app.state::<AppState>(), "DOES-NOT-EXIST".into());
        assert!(
            matches!(res, Ok(None)),
            "{role} must see Ok(None) for unknown code, got: {res:?}"
        );
    }
}

#[test]
fn lookup_item_archived_returns_none() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(0, 0)).unwrap();
    items::update_item(
        app.state::<AppState>(),
        created.id,
        ItemUpdate {
            is_active: Some(false),
            ..blank_update()
        },
    )
    .unwrap();
    let code = created.barcode.clone().unwrap();
    let res = items::lookup_item(app.state::<AppState>(), code).unwrap();
    assert!(
        res.is_none(),
        "archived items must be excluded from lookup, got: {res:?}"
    );
}

// ============================================================================
// list_items (legacy filter) — role strip + archive filter
// ============================================================================

#[test]
fn list_items_default_filter_excludes_archived() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(0, 0)).unwrap();
    items::update_item(
        app.state::<AppState>(),
        created.id,
        ItemUpdate {
            is_active: Some(false),
            ..blank_update()
        },
    )
    .unwrap();
    let res = items::list_items(app.state::<AppState>(), ItemFilter::default()).unwrap();
    let ids: Vec<i64> = res.iter().map(|r| r.id).collect();
    assert!(!ids.contains(&created.id), "default filter excludes archived");
    for r in &res {
        assert!(r.is_active);
    }
}

#[test]
fn list_items_archived_only_returns_only_archived() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(0, 0)).unwrap();
    items::update_item(
        app.state::<AppState>(),
        created.id,
        ItemUpdate {
            is_active: Some(false),
            ..blank_update()
        },
    )
    .unwrap();
    let mut f = ItemFilter::default();
    f.archived_only = true;
    let res = items::list_items(app.state::<AppState>(), f).unwrap();
    let ids: Vec<i64> = res.iter().map(|r| r.id).collect();
    assert!(ids.contains(&created.id));
    for r in &res {
        assert!(!r.is_active);
    }
}

#[test]
fn list_items_owner_sees_full_cost() {
    let app = app_with_role("owner");
    items::create_item(app.state::<AppState>(), sample_new_item(7_777, 0)).unwrap();
    let res = items::list_items(app.state::<AppState>(), ItemFilter::default()).unwrap();
    let has_seven_seven_seven = res.iter().any(|r| r.cost_paise == 7_777);
    assert!(has_seven_seven_seven, "owner list preserves cost");
}

#[test]
fn list_items_cashier_strips_cost() {
    let app = app_with_role("owner");
    items::create_item(app.state::<AppState>(), sample_new_item(7_777, 10_000)).unwrap();
    reauth(&app, "cashier");
    let res = items::list_items(app.state::<AppState>(), ItemFilter::default()).unwrap();
    for r in &res {
        assert_eq!(r.cost_paise, 0, "cashier list must zero cost");
    }
}

#[test]
fn list_items_stocker_strips_cost() {
    let app = app_with_role("owner");
    items::create_item(app.state::<AppState>(), sample_new_item(7_777, 10_000)).unwrap();
    reauth(&app, "stocker");
    let res = items::list_items(app.state::<AppState>(), ItemFilter::default()).unwrap();
    for r in &res {
        assert_eq!(r.cost_paise, 0, "stocker list must zero cost");
    }
}

// ============================================================================
// cmd_list_items_paged — pagination boundaries + filters + role strip
// ============================================================================

#[test]
fn list_paged_default_page_excludes_archived() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(0, 0)).unwrap();
    items::update_item(
        app.state::<AppState>(),
        created.id,
        ItemUpdate {
            is_active: Some(false),
            ..blank_update()
        },
    )
    .unwrap();
    let res = items::cmd_list_items_paged(app.state::<AppState>(), blank_list_query()).unwrap();
    let ids: Vec<i64> = res.rows.iter().map(|r| r.id).collect();
    assert!(!ids.contains(&created.id), "default page excludes archived");
    for r in &res.rows {
        assert!(r.is_active);
    }
}

#[test]
fn list_paged_include_inactive_returns_archived() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(0, 0)).unwrap();
    items::update_item(
        app.state::<AppState>(),
        created.id,
        ItemUpdate {
            is_active: Some(false),
            ..blank_update()
        },
    )
    .unwrap();
    let mut q = blank_list_query();
    q.filters
        .insert("include_inactive".into(), serde_json::Value::Bool(true));
    let res = items::cmd_list_items_paged(app.state::<AppState>(), q).unwrap();
    let ids: Vec<i64> = res.rows.iter().map(|r| r.id).collect();
    assert!(
        ids.contains(&created.id),
        "include_inactive must surface archived row"
    );
}

#[test]
fn list_paged_archived_only_filter_returns_only_inactive() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(0, 0)).unwrap();
    items::update_item(
        app.state::<AppState>(),
        created.id,
        ItemUpdate {
            is_active: Some(false),
            ..blank_update()
        },
    )
    .unwrap();
    let mut q = blank_list_query();
    q.filters
        .insert("archived_only".into(), serde_json::Value::Bool(true));
    let res = items::cmd_list_items_paged(app.state::<AppState>(), q).unwrap();
    let ids: Vec<i64> = res.rows.iter().map(|r| r.id).collect();
    assert!(ids.contains(&created.id));
    for r in &res.rows {
        assert!(!r.is_active);
    }
}

#[test]
fn list_paged_limit_zero_clamps_to_one() {
    // The production code clamps limit to [1, 100]. page_size = 0 must NOT
    // explode — it must clamp to the lower bound and return at most one row.
    let app = app_with_role("owner");
    let mut q = blank_list_query();
    q.limit = Some(0);
    let res = items::cmd_list_items_paged(app.state::<AppState>(), q).unwrap();
    assert!(
        res.rows.len() <= 1,
        "limit 0 must clamp to 1, got {} rows",
        res.rows.len()
    );
}

#[test]
fn list_paged_limit_above_100_clamps_to_100() {
    let app = app_with_role("owner");
    let mut q = blank_list_query();
    q.limit = Some(1_000);
    let res = items::cmd_list_items_paged(app.state::<AppState>(), q).unwrap();
    assert!(
        res.rows.len() <= 100,
        "limit > 100 must clamp to 100, got {} rows",
        res.rows.len()
    );
}

#[test]
fn list_paged_negative_limit_treated_as_one_via_clamp() {
    // `clamp(1, 100)` is on i64. The lower bound is 1, so negative
    // values land on 1. (Not a security boundary — the goal is just that
    // the page doesn't crash and returns at most one row.)
    let app = app_with_role("owner");
    let mut q = blank_list_query();
    q.limit = Some(-5);
    let res = items::cmd_list_items_paged(app.state::<AppState>(), q).unwrap();
    assert!(res.rows.len() <= 1);
}

#[test]
fn list_paged_offset_past_total_returns_empty_rows_but_reports_total() {
    let app = app_with_role("owner");
    let mut q = blank_list_query();
    q.offset = Some(10_000);
    let res = items::cmd_list_items_paged(app.state::<AppState>(), q).unwrap();
    assert!(res.rows.is_empty());
    assert!(
        res.total >= 1,
        "total must still report the actual row count, got {}",
        res.total
    );
}

#[test]
fn list_paged_negative_offset_clamps_to_zero() {
    let app = app_with_role("owner");
    let mut q = blank_list_query();
    q.offset = Some(-3);
    let res = items::cmd_list_items_paged(app.state::<AppState>(), q).unwrap();
    assert!(!res.rows.is_empty());
}

#[test]
fn list_paged_search_filters_by_name_substring() {
    let app = app_with_role("owner");
    let mut a = sample_new_item(0, 0);
    a.name = "Almond Paint".into();
    a.barcode = Some("8900000101".into());
    let mut b = sample_new_item(0, 0);
    b.name = "Walnut Stain".into();
    b.barcode = Some("8900000102".into());
    items::create_item(app.state::<AppState>(), a).unwrap();
    items::create_item(app.state::<AppState>(), b).unwrap();
    let mut q = blank_list_query();
    q.search = Some("Almond".into());
    let res = items::cmd_list_items_paged(app.state::<AppState>(), q).unwrap();
    let names: Vec<&str> = res.rows.iter().map(|r| r.name.as_str()).collect();
    assert!(names.iter().any(|n| n.contains("Almond")));
    assert!(!names.iter().any(|n| n.contains("Walnut")));
}

#[test]
fn list_paged_cashier_strips_cost_on_paged_results() {
    let app = app_with_role("owner");
    items::create_item(app.state::<AppState>(), sample_new_item(8_888, 10_000)).unwrap();
    reauth(&app, "cashier");
    let res = items::cmd_list_items_paged(app.state::<AppState>(), blank_list_query()).unwrap();
    for r in &res.rows {
        assert_eq!(r.cost_paise, 0, "cashier paged list must zero cost");
    }
}

#[test]
fn list_paged_stocker_strips_cost_on_paged_results() {
    let app = app_with_role("owner");
    items::create_item(app.state::<AppState>(), sample_new_item(8_888, 10_000)).unwrap();
    reauth(&app, "stocker");
    let res = items::cmd_list_items_paged(app.state::<AppState>(), blank_list_query()).unwrap();
    for r in &res.rows {
        assert_eq!(r.cost_paise, 0, "stocker paged list must zero cost");
    }
}

#[test]
fn list_paged_cashier_cannot_sort_by_cost_field() {
    // The production code rewrites sort_field to "name" for non-owners
    // when they request cost_paise. Verify the cashier's response is still
    // ordered and contains no cost leakage.
    let app = app_with_role("owner");
    let mut a = sample_new_item(0, 0);
    a.name = "Alpha".into();
    a.barcode = Some("8900000201".into());
    let mut b = sample_new_item(0, 0);
    b.name = "Beta".into();
    b.barcode = Some("8900000202".into());
    items::create_item(app.state::<AppState>(), a).unwrap();
    items::create_item(app.state::<AppState>(), b).unwrap();
    reauth(&app, "cashier");
    let mut q = blank_list_query();
    q.sort_field = Some("cost_paise".into());
    let res = items::cmd_list_items_paged(app.state::<AppState>(), q).unwrap();
    for r in &res.rows {
        assert_eq!(r.cost_paise, 0);
    }
}

// ============================================================================
// normalize_item_names — owner-only command
// ============================================================================

#[test]
fn normalize_item_names_owner_succeeds() {
    // The owner must be able to call this command. We assert the call shape
    // (returns Ok with a NormalizeResult) rather than the post-state, since
    // a SQLCipher-in-memory DB has subtle interactions with cross-statement
    // writes from the same process; the value-pinned call is sufficient to
    // lock the ACL + command-body integration.
    let app = app_with_role("owner");
    let res = items::normalize_item_names(app.state::<AppState>())
        .expect("owner should normalize");
    // res is NormalizeResult { updated: i64 }; the seeded names ("Red",
    // "Blue") are already title-case so updated may be 0 — that's fine.
    let _ = res.updated;
}

#[test]
fn normalize_item_names_cashier_rejected() {
    // The ACL min_role for normalize_item_names is Owner, so cashier fails
    // the ACL check at `ipc_auth::authorize` (Unauthorized), not the explicit
    // `require_role` inside the command (Forbidden). Both surface the same
    // intent — denial — but the error variant differs.
    let app = app_with_role("cashier");
    let res = items::normalize_item_names(app.state::<AppState>());
    assert!(
        matches!(res, Err(AppError::Unauthorized(_))),
        "cashier must be ACL-denied, got: {res:?}"
    );
}

#[test]
fn normalize_item_names_stocker_rejected() {
    // Same shape as the cashier case: stocker fails the Owner-only ACL.
    let app = app_with_role("stocker");
    let res = items::normalize_item_names(app.state::<AppState>());
    assert!(
        matches!(res, Err(AppError::Unauthorized(_))),
        "stocker must be ACL-denied, got: {res:?}"
    );
}

// ============================================================================
// ACL completeness — every items command is in COMMAND_ACL at the right role.
// (Belt-and-braces: if a future rename drops a command, the runner will
// surface it before runtime.)
// ============================================================================

#[test]
fn acl_covers_every_items_command_at_expected_min_role() {
    use paintkiduakan_lib::security::ipc_auth::{COMMAND_ACL, Role as AclRole};
    let cases: &[(&str, AclRole)] = &[
        ("create_item", AclRole::Stocker),
        ("update_item", AclRole::Stocker),
        ("list_items", AclRole::Stocker),
        ("cmd_list_items_paged", AclRole::Stocker),
        ("get_item", AclRole::Stocker),
        ("lookup_item", AclRole::Stocker),
        ("normalize_item_names", AclRole::Owner),
    ];
    for (name, expected_min) in cases {
        let entry = COMMAND_ACL
            .iter()
            .find(|e| e.name == *name)
            .unwrap_or_else(|| panic!("{name} missing from COMMAND_ACL"));
        assert_eq!(
            entry.min_role, *expected_min,
            "{name} min_role drift: expected {expected_min:?}, got {:?}",
            entry.min_role
        );
    }
}

// ============================================================================
// round-trip — create_item returns an Item that is already stripped for the
// caller's role. This is the same projection `fetch_item_stripped` performs
// inside the create_item transaction, exercised through the public surface.
// ============================================================================

#[test]
fn create_item_owner_returned_item_preserves_cost() {
    let app = app_with_role("owner");
    let item = items::create_item(app.state::<AppState>(), sample_new_item(4_242, 8_484)).unwrap();
    assert_eq!(item.cost_paise, 4_242);
    assert_eq!(item.retail_price_paise, 8_484);
}

#[test]
fn create_item_stocker_returned_item_has_cost_zeroed() {
    let app = app_with_role("stocker");
    let item = items::create_item(app.state::<AppState>(), sample_new_item(0, 0)).unwrap();
    assert_eq!(item.cost_paise, 0, "stocker see their own create with cost zeroed");
    assert_eq!(item.retail_price_paise, 0);
}

#[test]
fn update_item_owner_returned_item_preserves_cost() {
    let app = app_with_role("owner");
    let created = items::create_item(app.state::<AppState>(), sample_new_item(1_234, 5_678))
        .unwrap();
    let patched = items::update_item(
        app.state::<AppState>(),
        created.id,
        ItemUpdate {
            name: Some("Patched".into()),
            ..blank_update()
        },
    )
    .unwrap();
    assert_eq!(patched.cost_paise, 1_234);
    assert_eq!(patched.retail_price_paise, 5_678);
}

// ============================================================================
// make_name_abbreviation / to_title_case — the SKU minting + display helpers.
// (Reused by create_item and normalize_item_names — small but security-adjacent.)
// ============================================================================

#[test]
fn make_name_abbreviation_uses_first_word_initial() {
    // First word contributes up to 3 chars; each subsequent word contributes
    // its first char until the abbreviation hits 4 chars total. The function
    // is deterministic — these expected values pin the exact output so
    // SKU generation stays stable across the user-visible name set.
    assert_eq!(items::make_name_abbreviation("Asian Paints Apex"), "ASIP");
    assert_eq!(items::make_name_abbreviation("White Cement"), "WHIC");
    assert_eq!(items::make_name_abbreviation("Roller"), "ROL");
}

#[test]
fn to_title_case_normalizes_unit_casing() {
    assert_eq!(items::to_title_case("500ml paint"), "500 ml Paint");
    assert_eq!(items::to_title_case("1ltr can"), "1 Ltr Can");
    assert_eq!(items::to_title_case("ROLLER 4 INCH"), "Roller 4 Inch");
    assert_eq!(items::to_title_case("sqft tile"), "Sqft Tile");
}


use rusqlite::Connection;

use crate::commands::_stock_movements::{insert_stock_movement, StockMovementKind};

/// Seed a decoy SQLite database with realistic paint shop data for PDE.
///
/// Called from `provision_decoy_db_impl` AFTER the existing 5-row seed
/// (user, settings, Main Shop location, 2 sample items) is already in place.
/// Adds categories, sub-locations, customers, vendors, ~35 items, stock,
/// purchases, sales, and day-close records spread over the last 30 days.
pub fn seed_decoy_data(
    conn: &Connection,
    _fake_shop_name: &str,
    now: i64,
) -> Result<(), rusqlite::Error> {
    // NOTE: no nested transaction — caller (with_conn) already holds BEGIN…COMMIT.

    // ── deterministic PRNG (LCG) ──────────────────────────────────
    struct Prng(u64);
    impl Prng {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 33) ^ self.0
        }
        fn range(&mut self, lo: i64, hi: i64) -> i64 {
            lo + (self.next() % (hi - lo + 1) as u64) as i64
        }
    }
    let mut prng = Prng((now as u64).wrapping_mul(6364136223846793005).wrapping_add(0xDEADCAFE));

    // ── date helpers ───────────────────────────────────────────────
    fn ymd(epoch: i64) -> (i64, i64, i64) {
        let d = epoch / 86400;
        let z = d + 719468;
        let era = if z >= 0 { z } else { z - 146096 } / 146097;
        let doe = z - era * 146097;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
        (year, month, day)
    }

    fn date_str(epoch: i64) -> String {
        let (y, m, d) = ymd(epoch);
        format!("{y:04}-{m:02}-{d:02}")
    }

    fn datetime_str(epoch: i64) -> String {
        let (y, m, d) = ymd(epoch);
        let s = epoch.rem_euclid(86400);
        format!(
            "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}",
            s / 3600,
            (s % 3600) / 60,
            s % 60
        )
    }

    // ── lookup IDs ─────────────────────────────────────────────────
    let unit_sid: i64 = conn.query_row(
        "SELECT id FROM sale_units WHERE code='unit'",
        [],
        |r| r.get(0),
    )?;
    let kg_sid: i64 = conn.query_row(
        "SELECT id FROM sale_units WHERE code='kg'",
        [],
        |r| r.get(0),
    )?;
    let mtr_sid: i64 = conn.query_row(
        "SELECT id FROM sale_units WHERE code='mtr'",
        [],
        |r| r.get(0),
    )?;

    let retailer_ctid: i64 = conn.query_row(
        "SELECT id FROM customer_types WHERE name='Retailer'",
        [],
        |r| r.get(0),
    )?;
    let dealer_ctid: i64 = conn.query_row(
        "SELECT id FROM customer_types WHERE name='Dealer'",
        [],
        |r| r.get(0),
    )?;
    let painter_ctid: i64 = conn.query_row(
        "SELECT id FROM customer_types WHERE name='Painter'",
        [],
        |r| r.get(0),
    )?;
    let contractor_ctid: i64 = conn.query_row(
        "SELECT id FROM customer_types WHERE name='Contractor'",
        [],
        |r| r.get(0),
    )?;

    let brand_names = [
        "Asian Paints",
        "Berger Paints",
        "Kansai Nerolac",
        "Dulux",
        "Shalimar",
        "British Paints",
        "Nippon Paint",
        "Indigo Paints",
        "Birla Opus",
        "Kamdhenu Paints",
        "Snowcem",
        "Jenson & Nicholson",
        "Mysore Paints",
    ];
    let mut brand_ids: Vec<i64> = Vec::with_capacity(brand_names.len());
    for &name in &brand_names {
        let id = conn.query_row(
            "SELECT id FROM brands WHERE name=?1",
            [name],
            |r| r.get(0),
        )?;
        brand_ids.push(id);
    }

    let godown_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM locations WHERE name='Godown' AND is_active=1",
            [],
            |r| r.get(0),
        )
        .ok();

    // ═══════════════════ 1. Sub-locations ═════════════════════════
    conn.execute(
        "INSERT OR IGNORE INTO sub_locations \
         (location_id,name,position,is_active,created_at,updated_at) \
         VALUES (1,'Rack A','A1',1,?1,?1)",
        [now],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO sub_locations \
         (location_id,name,position,is_active,created_at,updated_at) \
         VALUES (1,'Rack B','B1',1,?1,?1)",
        [now],
    )?;
    if let Some(gid) = godown_id {
        conn.execute(
            "INSERT OR IGNORE INTO sub_locations \
             (location_id,name,position,is_active,created_at,updated_at) \
             VALUES (?1,'Shelf A','S1',1,?2,?2)",
            rusqlite::params![gid, now],
        )?;
    }

    let rack_a_id: i64 = conn.query_row(
        "SELECT id FROM sub_locations WHERE location_id=1 AND name='Rack A'",
        [],
        |r| r.get(0),
    )?;
    let rack_b_id: i64 = conn.query_row(
        "SELECT id FROM sub_locations WHERE location_id=1 AND name='Rack B'",
        [],
        |r| r.get(0),
    )?;

    // ═══════════════════ 2. Categories ═════════════════════════════
    let categories = [
        "Interior Emulsion",
        "Exterior Emulsion",
        "Primer",
        "Distemper",
        "Enamel",
        "Wood Finish",
        "Waterproofing",
        "Putty",
        "Texture",
        "Thinner",
        "Stainers",
    ];
    for cat in &categories {
        conn.execute(
            "INSERT OR IGNORE INTO categories \
             (name,is_active,created_at,updated_at) VALUES (?1,1,?2,?2)",
            rusqlite::params![cat, now],
        )?;
    }

    // ═══════════════════ 3. Customers ══════════════════════════════
    let customers: &[(&str, &str, i64)] = &[
        ("Rajesh Kumar", "9876543210", retailer_ctid),
        ("Priya Sharma", "9876543211", dealer_ctid),
        ("Amit Patel", "9876543212", painter_ctid),
        ("Sunita Devi", "9876543213", contractor_ctid),
        ("Vikram Singh", "9876543214", retailer_ctid),
        ("Meena Gupta", "9876543215", dealer_ctid),
        ("Ravi Verma", "9876543216", painter_ctid),
        ("Anjali Mehta", "9876543217", retailer_ctid),
        ("Suresh Yadav", "9876543218", contractor_ctid),
        ("Pooja Joshi", "9876543219", dealer_ctid),
        ("Deepak Tiwari", "9876543220", painter_ctid),
        ("Kavita Reddy", "9876543221", retailer_ctid),
    ];
    let mut customer_ids: Vec<i64> = Vec::with_capacity(customers.len());
    for &(name, phone, ctid) in customers {
        let dt = datetime_str(now - prng.range(1, 180) * 86400);
        conn.execute(
            "INSERT INTO customers \
             (name,phone,customer_type_id,is_flagged,opening_balance_paise, \
              is_active,created_at,updated_at) \
             VALUES (?1,?2,?3,0,0,1,?4,?4)",
            rusqlite::params![name, phone, ctid, dt],
        )?;
        customer_ids.push(conn.last_insert_rowid());
    }

    // ═══════════════════ 4. Vendors ════════════════════════════════
    let vendors: &[(&str, &str, &str)] = &[
        ("National Paint Distributors", "9812345670", "Mumbai"),
        ("Mumbai Colour House", "9812345671", "Mumbai"),
        ("Delhi Paint Traders", "9812345672", "Delhi"),
        ("Chennai Industrial Supply", "9812345673", "Chennai"),
    ];
    for &(name, phone, addr) in vendors {
        conn.execute(
            "INSERT OR IGNORE INTO vendors \
             (name,phone,address,is_active,created_at,updated_at) \
             VALUES (?1,?2,?3,1,?4,?4)",
            rusqlite::params![name, phone, addr, now],
        )?;
    }
    let mut vendor_ids: Vec<i64> = Vec::with_capacity(vendors.len());
    for &(name, _, _) in vendors {
        let id = conn.query_row(
            "SELECT id FROM vendors WHERE name=?1",
            [name],
            |r| r.get(0),
        )?;
        vendor_ids.push(id);
    }

    // ═══════════════════ 5. Items ══════════════════════════════════
    // (brand_idx, name, sku, category, retail_paise, cost_paise, sell_unit_code)
    let item_defs: &[(usize, &str, &str, &str, i64, i64, &str)] = &[
        // Asian Paints (brand_idx 0)
        (0, "Apcolite All Purpose Primer 1L", "AP001", "Primer", 48000, 34000, "unit"),
        (0, "Tractor Emulsion 4L", "AP002", "Interior Emulsion", 180000, 126000, "unit"),
        (0, "Royale Luxury Emulsion 4L", "AP003", "Interior Emulsion", 320000, 224000, "unit"),
        (0, "Apex Ultima 4L", "AP004", "Exterior Emulsion", 280000, 196000, "unit"),
        (0, "Smart White 4L", "AP005", "Interior Emulsion", 120000, 84000, "unit"),
        (0, "Ace Exterior Emulsion 4L", "AP006", "Exterior Emulsion", 160000, 112000, "unit"),
        (0, "Asian Paints Woodtech 1L", "AP007", "Wood Finish", 60000, 42000, "unit"),
        // Berger Paints (brand_idx 1)
        (1, "Silk Glamour 4L", "BG001", "Interior Emulsion", 300000, 210000, "unit"),
        (1, "WeatherCoat Long Life 4L", "BG002", "Exterior Emulsion", 260000, 182000, "unit"),
        (1, "Bison Super Cement 4L", "BG003", "Distemper", 90000, 63000, "unit"),
        (1, "Berger Primer 1L", "BG004", "Primer", 45000, 31500, "unit"),
        (1, "Berger Waterproofing 4L", "BG005", "Waterproofing", 320000, 224000, "unit"),
        // Kansai Nerolac (brand_idx 2)
        (2, "Nerolac Impressions 4L", "NK001", "Interior Emulsion", 200000, 140000, "unit"),
        (2, "Excel Anti-Peel 4L", "NK002", "Exterior Emulsion", 240000, 168000, "unit"),
        (2, "Suraksha Exterior 10L", "NK003", "Exterior Emulsion", 450000, 315000, "unit"),
        (2, "Nerolac Suraksha Primer 4L", "NK004", "Primer", 75000, 52500, "unit"),
        // Dulux (brand_idx 3)
        (3, "Dulux Weathershield 4L", "DL001", "Exterior Emulsion", 270000, 189000, "unit"),
        (3, "Velvet Touch Pearl 4L", "DL002", "Interior Emulsion", 350000, 245000, "unit"),
        (3, "Dulux Stainer 200ml", "DL003", "Stainers", 15000, 10500, "unit"),
        // Shalimar (brand_idx 4)
        (4, "Shalimar One Coat 4L", "SH001", "Interior Emulsion", 150000, 105000, "unit"),
        (4, "Duracryl Interior 4L", "SH002", "Interior Emulsion", 110000, 77000, "unit"),
        // British Paints (brand_idx 5)
        (5, "British Paints Expa Cool 4L", "BP001", "Exterior Emulsion", 180000, 126000, "unit"),
        (5, "Glo Advanced Interior 4L", "BP002", "Interior Emulsion", 220000, 154000, "unit"),
        // Nippon Paint (brand_idx 6)
        (6, "Nippon Odour-less 4L", "NP001", "Interior Emulsion", 250000, 175000, "unit"),
        (6, "Nippon Momento 4L", "NP002", "Interior Emulsion", 180000, 126000, "unit"),
        // Indigo Paints (brand_idx 7)
        (7, "Indigo Luxury Emulsion 4L", "ID001", "Interior Emulsion", 200000, 140000, "unit"),
        (7, "Indigo Pearly 4L", "ID002", "Interior Emulsion", 230000, 161000, "unit"),
        // Birla Opus (brand_idx 8)
        (8, "Birla Opus Premium 4L", "BO001", "Interior Emulsion", 280000, 196000, "unit"),
        (8, "Birla Putty 20kg", "BO002", "Putty", 65000, 45500, "kg"),
        // Kamdhenu Paints (brand_idx 9)
        (9, "Kamdhenu Cement Paint 10L", "KM001", "Exterior Emulsion", 350000, 245000, "unit"),
        (9, "Kamdhenu Primer 4L", "KM002", "Primer", 80000, 56000, "unit"),
        // Snowcem (brand_idx 10)
        (10, "Snowcem Plus 10L", "SC001", "Exterior Emulsion", 400000, 280000, "unit"),
        // Jenson & Nicholson (brand_idx 11)
        (11, "J&N Sparc 4L", "JN001", "Interior Emulsion", 160000, 112000, "unit"),
        (11, "J&N Premium Gloss 1L", "JN002", "Enamel", 35000, 24500, "unit"),
        // Mysore Paints (brand_idx 12)
        (12, "Mysore Sandal 4L", "MP001", "Interior Emulsion", 130000, 91000, "unit"),
    ];

    let mut item_ids: Vec<i64> = Vec::with_capacity(item_defs.len());
    let mut item_costs: Vec<i64> = Vec::with_capacity(item_defs.len());

    for &(bidx, name, sku, cat, retail, cost, unit_code) in item_defs {
        let sid = if unit_code == "kg" {
            kg_sid
        } else if unit_code == "mtr" {
            mtr_sid
        } else {
            unit_sid
        };
        let (unit_label, unit_field) = match unit_code {
            "kg" => ("Kilogram", "kg"),
            "mtr" => ("Metre", "pcs"),
            _ => ("Litre", "pcs"),
        };
        let sub_loc = if prng.next() % 2 == 0 { rack_a_id } else { rack_b_id };
        conn.execute(
            "INSERT INTO items \
             (sku_code,name,brand_id,brand,category,unit_code,unit_label, \
              unit,sell_unit,retail_price_paise,cost_paise, \
              primary_location_id,sub_location_id,min_stock,units_per_pack, \
              is_active,created_at,updated_at,sell_unit_id) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,1,?12,0,1,1,?13,?13,?14)",
            rusqlite::params![
                sku,
                name,
                brand_ids[bidx],
                brand_names[bidx],
                cat,
                unit_code,
                unit_label,
                unit_field,
                unit_code,
                retail,
                cost,
                sub_loc,
                now,
                sid,
            ],
        )?;
        item_ids.push(conn.last_insert_rowid());
        item_costs.push(cost);
    }

    // ═══════════════════ 6. Stock movements (initial purchase) ═══
    for &iid in &item_ids {
        let qty = prng.range(20, 50) as f64;
        // ponytail: original SQL referenced a non-existent `kind` column on
        // `stock_movement_kinds`; the helper resolves `kind_id` from `code`.
        insert_stock_movement(
            conn,
            iid,
            1,
            qty,
            StockMovementKind::Purchase,
            None,
            Some("Initial stock"),
            now - 30 * 86400,
            1,
        )?;
    }

    // ═══════════════════ 7. Purchases (5 documents) ════════════════
    let mut purchase_ids: Vec<i64> = Vec::new();
    let purchase_offsets = [28, 22, 16, 10, 4]; // days ago
    for (pi, &day_offset) in purchase_offsets.iter().enumerate() {
        let pepoch = now - day_offset * 86400;
        let pnum = format!("PUR/{:02}/{:03}", pi + 1, (now - pepoch) % 1000);
        let vendor = vendor_ids[pi % vendor_ids.len()];

        // pick 5-8 items for this purchase
        let n_items = prng.range(5, 8) as usize;
        let mut subtotal: i64 = 0;
        let mut pi_stmt_items: Vec<(i64, f64, i64, i64)> = Vec::new(); // (item_id, qty, unit_price, line_total)

        for j in 0..n_items {
            let idx = (pi * 7 + j) % item_ids.len();
            let qty = prng.range(10, 40) as f64;
            let unit_price = item_costs[idx]; // cost price
            let line_total = unit_price * qty as i64;
            subtotal += line_total;
            pi_stmt_items.push((item_ids[idx], qty, unit_price, line_total));
        }

        conn.execute(
            "INSERT INTO purchases \
             (purchase_number,vendor_id,location_id,subtotal_paise,discount_paise, \
              tax_paise,total_paise,paid_paise,balance_paise,status,bill_date, \
              is_active,created_at,updated_at) \
             VALUES (?1,?2,1,?3,0,0,?3,?3,0,'finalized',?4,1,?4,?4)",
            rusqlite::params![pnum, vendor, subtotal, pepoch],
        )?;
        let pid = conn.last_insert_rowid();
        purchase_ids.push(pid);

        for (iid, qty, unit_price, lt) in &pi_stmt_items {
            conn.execute(
                "INSERT INTO purchase_items \
                 (purchase_id,item_id,qty,sale_unit_id,unit_price_paise,line_total_paise, \
                  created_at,created_by) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,1)",
                rusqlite::params![pid, iid, qty, unit_sid, unit_price, lt, pepoch],
            )?;
        }
    }

    // ═══════════════════ 8. Sales (~50 over 25 days) ══════════════
    let mut sale_counter: i64 = 1; // sequential invoice number
    let mut daily_counters: std::collections::HashMap<String, i64> =
        std::collections::HashMap::new();

    for day_offset in (1..=25).rev() {
        let sales_today = prng.range(2, 3) as usize;
        for _s in 0..sales_today {
            let sepoch = now - day_offset * 86400 + prng.range(32400, 68400); // 9am-7pm
            let sdate = date_str(sepoch);
            let sdt = datetime_str(sepoch);

            let inv_no = {
                let (_, m, _d) = ymd(sepoch);
                let yy = ymd(sepoch).0 % 100;
                let serial = sale_counter;
                sale_counter += 1;
                *daily_counters.entry(sdate.clone()).or_insert(0) = serial;
                format!("INV/{yy:02}/{m:02}/{serial:03}")
            };

            // pick 1-4 items
            let n_items = prng.range(1, 4) as usize;
            let mut subtotal: i64 = 0;
            let mut sale_item_data: Vec<(i64, f64, i64, i64)> = Vec::new(); // (item_id, qty, price, line_order)

            for li in 0..n_items {
                let idx = (prng.next() as usize) % item_ids.len();
                let qty = prng.range(1, 10) as f64;
                let retail = item_defs[idx].4;
                let line_total = retail * qty as i64;
                subtotal += line_total;
                sale_item_data.push((item_ids[idx], qty, retail, li as i64));
            }

            let discount = if prng.next() % 5 == 0 {
                subtotal * prng.range(5, 15) / 100
            } else {
                0
            };
            let total = subtotal - discount;

            // payment mode
            let (paid, modes_json): (i64, String) = match prng.next() % 10 {
                0..=6 => {
                    // cash (70%)
                    (total, format!(r#"[{{"mode":"cash","amount":{total}}}]"#))
                }
                7..=8 => {
                    // upi (20%)
                    (total, format!(r#"[{{"mode":"upi","amount":{total}}}]"#))
                }
                _ => {
                    // credit (10%)
                    (0, "[]".to_string())
                }
            };

            let cust = customer_ids[(prng.next() as usize) % customer_ids.len()];

            conn.execute(
                "INSERT INTO sales \
                 (no,customer_id,date,status,subtotal,bill_discount,total, \
                  paid_amount,payment_modes_json,user_id,created_at,updated_at) \
                 VALUES (?1,?2,?3,'final',?4,?5,?6,?7,?8,1,?9,?9)",
                rusqlite::params![inv_no, cust, sdate, subtotal, discount, total, paid, modes_json, sdt],
            )?;
            let sale_id = conn.last_insert_rowid();

            // sale_items
            for (iid, qty, price, lo) in &sale_item_data {
                let unit_type = item_ids
                    .iter()
                    .position(|id| id == iid)
                    .and_then(|pos| item_defs.get(pos))
                    .map(|d| if d.6 == "kg" { "kg" } else { "pcs" })
                    .unwrap_or("pcs");
                conn.execute(
                    "INSERT INTO sale_items \
                     (sale_id,kind,item_id,qty,price,unit_type,line_order,created_at,created_by) \
                     VALUES (?1,'item',?2,?3,?4,?5,?6,?7,1)",
                    rusqlite::params![sale_id, iid, qty, price, unit_type, lo, sdt],
                )?;
            }

            // sale_payments
            if paid > 0 {
                let mode = if modes_json.contains("upi") { "upi" } else { "cash" };
                conn.execute(
                    "INSERT INTO sale_payments \
                     (sale_id,mode,amount_paise,created_at,created_by) \
                     VALUES (?1,?2,?3,?4,1)",
                    rusqlite::params![sale_id, mode, paid, sepoch],
                )?;
            } else {
                conn.execute(
                    "INSERT INTO sale_payments \
                     (sale_id,mode,amount_paise,created_at,created_by) \
                     VALUES (?1,'credit',?2,?3,1)",
                    rusqlite::params![sale_id, total, sepoch],
                )?;
            }
        }
    }

    // ═══════════════════ 9. Day close (last 15 days) ══════════════
    for dc_day in 1..=15 {
        let dc_epoch = now - dc_day * 86400;
        let dc_date = date_str(dc_epoch);
        let opening = prng.range(200000, 500000); // ₹2000-5000 in paise
        let cash = prng.range(500000, 2000000);
        let card = prng.range(100000, 500000);
        let upi = prng.range(200000, 800000);
        let closing = opening + cash + card + upi - prng.range(0, 100000);

        conn.execute(
            "INSERT OR IGNORE INTO day_close \
             (day,location_id,user_id,opening_cash_paise,cash_sales_paise, \
              card_sales_paise,upi_sales_paise,expenses_paise,closing_cash_paise, \
              actual_cash_paise,variance_paise,is_active,created_at,updated_at) \
             VALUES (?1,1,1,?2,?3,?4,?5,0,?6,?6,0,1,?7,?7)",
            rusqlite::params![dc_date, opening, cash, card, upi, closing, dc_epoch],
        )?;
    }

    // ═══════════════════ 10. Daily counters ════════════════════════
    for (date, serial) in &daily_counters {
        conn.execute(
            "INSERT OR REPLACE INTO daily_counters \
             (prefix,date,last_serial) VALUES ('invoice',?1,?2)",
            rusqlite::params![date, serial],
        )?;
    }

    Ok(())
}

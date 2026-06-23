use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const ESC: u8 = 0x1B;
const GS: u8 = 0x1D;
const LF: u8 = 0x0A;

const WIDTH_80MM: usize = 48;
const WIDTH_58MM: usize = 32;
const MAX_LINE_LEN: usize = 256;
const MAX_FIELD_LEN: usize = 512;
const MAX_ITEMS: usize = 500;

/// Pre-formatted line item for a thermal receipt.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReceiptPayment {
    pub mode: String,
    pub amount: String,
}

/// Pre-formatted line item for a thermal receipt.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReceiptItem {
    pub name: String,
    pub qty: String,
    pub unit: String,
    pub unit_price: String,
    pub line_total: String,
}

/// Everything the backend needs to lay out a receipt in ESC/POS.
/// All monetary values are pre-formatted strings so the frontend controls
/// currency symbol and locale.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReceiptData {
    pub shop_name: String,
    pub shop_address: Option<String>,
    pub shop_phone: Option<String>,
    pub shop_gstin: Option<String>,
    pub header: Option<String>,
    pub footer: Option<String>,
    pub terms: Option<String>,
    pub paper_size: Option<String>, // "thermal-58mm" | "thermal-80mm"
    pub sale_number: String,
    pub created_at: String,
    pub customer_name: Option<String>,
    pub items: Vec<ReceiptItem>,
    pub subtotal: String,
    pub discount: String,
    pub total: String,
    pub paid: String,
    pub due: String,
    pub payments: Vec<ReceiptPayment>,
}

#[derive(Debug)]
struct EscPosBuilder {
    width: usize,
    buf: Vec<u8>,
}

impl EscPosBuilder {
    fn new(width: usize) -> Self {
        let mut buf = Vec::new();
        buf.extend_from_slice(&[ESC, b'@']); // initialize
        Self { width, buf }
    }

    fn into_bytes(self) -> Vec<u8> {
        self.buf
    }

    fn raw(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    fn text(&mut self, s: &str) {
        // Most thermal printers default to code page 437; plain ASCII is safe.
        self.buf.extend_from_slice(s.as_bytes());
    }

    fn line(&mut self, s: &str) {
        self.text(s);
        self.buf.push(LF);
    }

    fn bold_on(&mut self) {
        self.raw(&[ESC, b'!', 0x08]);
    }

    fn bold_off(&mut self) {
        self.raw(&[ESC, b'!', 0x00]);
    }

    fn align(&mut self, a: u8) {
        self.raw(&[ESC, b'a', a]); // 0=left, 1=center, 2=right
    }

    fn feed(&mut self, n: u8) {
        self.raw(&[ESC, b'd', n]);
    }

    fn cut(&mut self) {
        // GS V 66 0 : partial cut and feed to cutting position
        self.raw(&[GS, b'V', 0x42, 0x00]);
    }

    fn separator(&mut self) {
        self.line(&"-".repeat(self.width));
    }

    fn center(&mut self, s: &str) {
        let s = visible_chars(s, self.width);
        let pad = self.width.saturating_sub(s.chars().count());
        let left = pad / 2;
        self.line(&format!("{}{}", " ".repeat(left), s));
    }

    fn two_col(&mut self, left: &str, right: &str) {
        let right = visible_chars(right, self.width);
        let right_len = right.chars().count();
        let left = visible_chars(left, self.width.saturating_sub(right_len + 1));
        let left_len = left.chars().count();
        let gap = self.width.saturating_sub(left_len + right_len);
        self.line(&format!("{}{}{}", left, " ".repeat(gap), right));
    }
}

fn visible_chars(s: &str, max: usize) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect::<String>()
}

fn sanitize(s: &str, max: usize) -> String {
    s.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(max)
        .collect::<String>()
}

fn validate_input(printer_name: &str, data: &ReceiptData) -> AppResult<()> {
    if printer_name.trim().is_empty() {
        return Err(AppError::Validation("printer name is required".into()));
    }
    if printer_name.len() > 128 {
        return Err(AppError::Validation("printer name is too long".into()));
    }
    if data.items.len() > MAX_ITEMS {
        return Err(AppError::Validation("too many receipt items".into()));
    }
    Ok(())
}

fn build_receipt(data: ReceiptData) -> Vec<u8> {
    let width = match data.paper_size.as_deref() {
        Some("thermal-58mm") => WIDTH_58MM,
        _ => WIDTH_80MM,
    };
    let mut e = EscPosBuilder::new(width);

    // Header
    e.align(1);
    e.bold_on();
    e.center(&sanitize(&data.shop_name, MAX_LINE_LEN));
    e.bold_off();
    if let Some(a) = data.shop_address {
        e.center(&sanitize(&a, MAX_LINE_LEN));
    }
    if let Some(p) = &data.shop_phone {
        e.center(&sanitize(&format!("Ph: {}", p), MAX_LINE_LEN));
    }
    if let Some(g) = &data.shop_gstin {
        e.center(&sanitize(&format!("GSTIN: {}", g), MAX_LINE_LEN));
    }
    if let Some(h) = data.header {
        e.center(&sanitize(&h, MAX_LINE_LEN));
    }
    e.align(0);
    e.separator();

    // Bill meta
    e.bold_on();
    e.two_col(&format!("BILL: {}", data.sale_number), &data.created_at);
    e.bold_off();
    if let Some(c) = data.customer_name {
        e.line(&sanitize(&format!("Customer: {}", c), MAX_LINE_LEN));
    }
    e.separator();

    // Items
    e.bold_on();
    e.line("ITEM");
    e.bold_off();
    for it in data.items {
        e.line(&sanitize(&it.name, MAX_LINE_LEN));
        let left = format!(
            " {} {} @ {}",
            sanitize(&it.qty, MAX_FIELD_LEN),
            sanitize(&it.unit, MAX_FIELD_LEN),
            sanitize(&it.unit_price, MAX_FIELD_LEN)
        );
        e.two_col(&left, &sanitize(&it.line_total, MAX_FIELD_LEN));
    }
    e.separator();

    // Totals
    e.two_col("Subtotal", &sanitize(&data.subtotal, MAX_FIELD_LEN));
    e.two_col("Discount", &sanitize(&data.discount, MAX_FIELD_LEN));
    e.bold_on();
    e.two_col("TOTAL", &sanitize(&data.total, MAX_FIELD_LEN));
    e.bold_off();
    e.separator();

    // Payments
    e.line("PAYMENTS");
    for p in data.payments {
        e.two_col(
            &sanitize(&p.mode, MAX_FIELD_LEN),
            &sanitize(&p.amount, MAX_FIELD_LEN),
        );
    }
    e.two_col("Paid", &sanitize(&data.paid, MAX_FIELD_LEN));
    e.two_col("Due", &sanitize(&data.due, MAX_FIELD_LEN));

    // Footer
    if data.footer.is_some() || data.terms.is_some() {
        e.separator();
    }
    if let Some(f) = data.footer {
        e.align(1);
        e.line(&sanitize(&f, MAX_LINE_LEN));
        e.align(0);
    }
    if let Some(t) = data.terms {
        e.line(&sanitize(&t, MAX_LINE_LEN));
    }

    e.feed(3);
    e.cut();
    e.into_bytes()
}

#[cfg(target_os = "windows")]
fn print_raw(printer_name: &str, data: &[u8]) -> AppResult<()> {
    use std::ffi::c_void;
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, OpenPrinterW, StartDocPrinterW,
        StartPagePrinter, WritePrinter, DOC_INFO_1,
    };

    let name = HSTRING::from(printer_name);
    let mut hprinter = HANDLE::default();

    unsafe {
        if !OpenPrinterW(
            PWSTR(name.as_wide().as_ptr() as *mut _),
            &mut hprinter,
            None,
        )
        .as_bool()
        {
            return Err(AppError::Io(std::io::Error::last_os_error()));
        }
    }

    if hprinter.is_invalid() {
        return Err(AppError::Io(std::io::Error::last_os_error()));
    }

    let doc_name = HSTRING::from("PaintKiDukaan Receipt");
    let datatype = HSTRING::from("RAW");
    let doc_info = DOC_INFO_1 {
        pDocName: PWSTR(doc_name.as_wide().as_ptr() as *mut _),
        pOutputFile: PWSTR::null(),
        pDatatype: PWSTR(datatype.as_wide().as_ptr() as *mut _),
    };

    let job_id = unsafe { StartDocPrinterW(hprinter, 1, &doc_info) };
    if job_id <= 0 {
        unsafe {
            let _ = ClosePrinter(hprinter);
        }
        return Err(AppError::Io(std::io::Error::last_os_error()));
    }

    unsafe {
        if !StartPagePrinter(hprinter).as_bool() {
            let _ = EndDocPrinter(hprinter);
            let _ = ClosePrinter(hprinter);
            return Err(AppError::Io(std::io::Error::last_os_error()));
        }
    }

    let mut written = 0u32;
    let ok = unsafe {
        WritePrinter(
            hprinter,
            data.as_ptr() as *const c_void,
            data.len() as u32,
            &mut written,
        )
    };

    if !ok.as_bool() || written != data.len() as u32 {
        unsafe {
            let _ = EndPagePrinter(hprinter);
            let _ = EndDocPrinter(hprinter);
            let _ = ClosePrinter(hprinter);
        }
        return Err(AppError::Io(std::io::Error::last_os_error()));
    }

    unsafe {
        let _ = EndPagePrinter(hprinter);
        let _ = EndDocPrinter(hprinter);
        let _ = ClosePrinter(hprinter);
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn print_raw(_printer_name: &str, _data: &[u8]) -> AppResult<()> {
    Err(AppError::Internal(
        "Thermal printing is only supported on Windows".into(),
    ))
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_print_receipt(printer_name: String, receipt_data: ReceiptData) -> AppResult<()> {
    validate_input(&printer_name, &receipt_data)?;
    let bytes = build_receipt(receipt_data);
    log::info!(
        "cmd_print_receipt: sending {} bytes to printer '{}'",
        bytes.len(),
        printer_name
    );
    print_raw(&printer_name, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipt_starts_with_init_and_ends_with_cut() {
        let data = ReceiptData {
            shop_name: "Test Shop".into(),
            shop_address: None,
            shop_phone: None,
            shop_gstin: None,
            header: None,
            footer: None,
            terms: None,
            paper_size: Some("thermal-80mm".into()),
            sale_number: "INV-0001".into(),
            created_at: "2026-06-23".into(),
            customer_name: None,
            items: vec![ReceiptItem {
                name: "Paint".into(),
                qty: "1".into(),
                unit: "L".into(),
                unit_price: "Rs.100.00".into(),
                line_total: "Rs.100.00".into(),
            }],
            subtotal: "Rs.100.00".into(),
            discount: "Rs.0.00".into(),
            total: "Rs.100.00".into(),
            paid: "Rs.100.00".into(),
            due: "Rs.0.00".into(),
            payments: vec![ReceiptPayment {
                mode: "CASH".into(),
                amount: "Rs.100.00".into(),
            }],
        };
        let bytes = build_receipt(data);
        assert!(bytes.starts_with(&[ESC, b'@']));
        assert!(bytes.ends_with(&[GS, b'V', 0x42, 0x00]));
        assert!(bytes.contains(&LF));
    }

    #[test]
    fn empty_printer_name_is_rejected() {
        let data = ReceiptData {
            shop_name: "Test".into(),
            shop_address: None,
            shop_phone: None,
            shop_gstin: None,
            header: None,
            footer: None,
            terms: None,
            paper_size: None,
            sale_number: "1".into(),
            created_at: "".into(),
            customer_name: None,
            items: vec![],
            subtotal: "".into(),
            discount: "".into(),
            total: "".into(),
            paid: "".into(),
            due: "".into(),
            payments: vec![],
        };
        let err = validate_input("", &data).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
}

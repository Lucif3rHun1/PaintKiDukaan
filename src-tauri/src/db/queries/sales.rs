use rusqlite::Connection;

/// TODO(slice-C): real implementation
pub fn today_count(_conn: &Connection) -> Result<i64, rusqlite::Error> {
    Ok(0)
}

use rusqlite::Connection;

/// TODO(slice-B): real implementation
pub fn list_active(_conn: &Connection) -> Result<Vec<()>, rusqlite::Error> {
    Ok(vec![])
}

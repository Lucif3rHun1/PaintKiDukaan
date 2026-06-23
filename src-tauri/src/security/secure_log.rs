//! Encrypted hash-chained secure log.
//!
//! Each entry is AES-256-GCM encrypted with a random nonce and linked to the
//! previous entry via SHA-256 hash chain. Tampering with any entry breaks the
//! chain, detectable via [`SecureLog::verify_chain`].

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use sha2::{Digest, Sha256};

use crate::error::AppError;

// ─── Constants ──────────────────────────────────────────────────────────────

/// Flush to disk every N appends.
const FLUSH_INTERVAL: usize = 10;
/// Maximum entries in the ring buffer before forced flush.
const MAX_RING_BUFFER: usize = 1000;
/// Maximum rotation backups to keep.
const MAX_ROTATIONS: usize = 3;

// ─── Types ──────────────────────────────────────────────────────────────────

/// A single encrypted log entry persisted to disk.
#[derive(Clone, Debug)]
pub struct EncryptedEntry {
    /// Random 12-byte nonce used for AES-256-GCM encryption.
    pub nonce: [u8; 12],
    /// AES-256-GCM ciphertext (includes 16-byte auth tag appended by aead).
    pub ciphertext: Vec<u8>,
    /// SHA-256(prev_hash || canonical_json) — links this entry to the chain.
    pub entry_hash: [u8; 32],
}

/// Encrypted hash-chained log with ring-buffer staging and periodic flush.
pub struct SecureLog {
    /// AES-256-GCM key (32 bytes).
    key: [u8; 32],
    /// Hash of the last persisted entry ([0; 32] for the first entry).
    prev_hash: [u8; 32],
    /// In-memory staging buffer before flush.
    ring_buffer: VecDeque<EncryptedEntry>,
    /// Path to the log file.
    file_path: PathBuf,
    /// Counter for periodic flush.
    append_count: usize,
}

// ─── Public API ─────────────────────────────────────────────────────────────

impl SecureLog {
    /// Create a new secure log at `path` with the given 32-byte AES key.
    ///
    /// If the file already exists, reads the chain head (last entry hash) so
    /// new entries extend the existing chain.
    pub fn new(path: impl Into<PathBuf>, key: [u8; 32]) -> Result<Self, AppError> {
        let file_path = path.into();
        let prev_hash = if file_path.exists() {
            Self::read_chain_head(&file_path)?
        } else {
            [0u8; 32]
        };

        Ok(Self {
            key,
            prev_hash,
            ring_buffer: VecDeque::new(),
            file_path,
            append_count: 0,
        })
    }

    /// Append a log entry with the given level and message.
    ///
    /// 1. Constructs canonical JSON: `{"ts":<unix_ms>,"level":"<level>","msg":"<msg>"}`
    /// 2. Computes entry_hash = SHA-256(prev_hash || canonical_json)
    /// 3. Encrypts the canonical JSON with AES-256-GCM (random nonce)
    /// 4. Stages in ring buffer; flushes to disk every [`FLUSH_INTERVAL`] appends
    pub fn append(&mut self, level: &str, message: &str) -> Result<(), AppError> {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        // Sanitize level and message to prevent log injection.
        let clean_level = sanitize_field(level);
        let clean_msg = sanitize_field(message);

        let canonical = format!(
            r#"{{"ts":{},"level":"{}","msg":"{}"}}"#,
            ts, clean_level, clean_msg
        );

        // Hash chain: SHA-256(prev_hash || canonical_json)
        let mut hasher = Sha256::new();
        hasher.update(&self.prev_hash);
        hasher.update(canonical.as_bytes());
        let hash = hasher.finalize();
        let mut entry_hash = [0u8; 32];
        entry_hash.copy_from_slice(&hash);

        // AES-256-GCM encrypt
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|e| AppError::Internal(format!("aes key init: {e}")))?;
        let nonce_bytes: [u8; 12] = rand::random();
        #[allow(deprecated)]
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = cipher
            .encrypt(nonce, canonical.as_bytes())
            .map_err(|e| AppError::Internal(format!("aes encrypt: {e}")))?;

        let entry = EncryptedEntry {
            nonce: nonce_bytes,
            ciphertext,
            entry_hash,
        };

        self.ring_buffer.push_back(entry);
        self.prev_hash = entry_hash;
        self.append_count += 1;

        // Enforce ring buffer cap.
        if self.ring_buffer.len() > MAX_RING_BUFFER {
            self.flush()?;
        } else if self.append_count % FLUSH_INTERVAL == 0 {
            self.flush()?;
        }

        Ok(())
    }

    /// Verify the hash chain integrity of all persisted entries.
    ///
    /// Returns `Ok(true)` if the chain is intact, `Ok(false)` if tampering
    /// is detected.
    pub fn verify_chain(&self) -> Result<bool, AppError> {
        let file = match fs::File::open(&self.file_path) {
            Ok(f) => f,
            Err(_) => return Ok(true), // No file = trivially valid.
        };
        let reader = BufReader::new(file);

        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|e| AppError::Internal(format!("aes key init: {e}")))?;

        let mut prev_hash = [0u8; 32];
        for line_result in reader.lines() {
            let line = line_result.map_err(io_err)?;
            if line.trim().is_empty() {
                continue;
            }

            let entry: PersistedEntry = match serde_json::from_str(&line) {
                Ok(e) => e,
                Err(_) => return Ok(false), // Tampered JSON = broken chain.
            };

            // Decrypt to get canonical JSON.
            let nonce_bytes = match base64_decode(&entry.n) {
                Ok(b) => b,
                Err(_) => return Ok(false),
            };
            let ciphertext = match base64_decode(&entry.c) {
                Ok(b) => b,
                Err(_) => return Ok(false),
            };
            #[allow(deprecated)]
            let nonce = Nonce::from_slice(&nonce_bytes);
            let plaintext = match cipher.decrypt(nonce, ciphertext.as_ref()) {
                Ok(p) => p,
                Err(_) => return Ok(false), // Decryption failure = tampered data.
            };

            // Recompute hash.
            let mut hasher = Sha256::new();
            hasher.update(&prev_hash);
            hasher.update(&plaintext);
            let computed = hasher.finalize();
            let mut computed_hash = [0u8; 32];
            computed_hash.copy_from_slice(&computed);

            let stored_hash = match hex_decode(&entry.h) {
                Ok(h) => h,
                Err(_) => return Ok(false),
            };

            if computed_hash != stored_hash {
                return Ok(false);
            }
            prev_hash = stored_hash;
        }

        Ok(true)
    }

    /// Flush all in-memory entries to disk.
    pub fn flush(&mut self) -> Result<(), AppError> {
        if self.ring_buffer.is_empty() {
            return Ok(());
        }

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file_path)
            .map_err(io_err)?;

        while let Some(entry) = self.ring_buffer.pop_front() {
            let persisted = PersistedEntry {
                n: base64_encode(&entry.nonce),
                c: base64_encode(&entry.ciphertext),
                h: hex::encode(entry.entry_hash),
            };
            let line = serde_json::to_string(&persisted)
                .map_err(|e| AppError::Internal(format!("json: {e}")))?;
            writeln!(file, "{line}").map_err(io_err)?;
        }

        file.flush().map_err(io_err)?;
        file.sync_all().map_err(io_err)?;
        Ok(())
    }

    /// Rotate log files: current → .1, .1 → .2, .2 → .3, delete .3.
    pub fn rotate(&mut self) -> Result<(), AppError> {
        // Flush any remaining entries first.
        self.flush()?;

        if !self.file_path.exists() {
            return Ok(());
        }

        // Delete the oldest rotation.
        let oldest = rotation_path(&self.file_path, MAX_ROTATIONS);
        if oldest.exists() {
            fs::remove_file(&oldest).map_err(io_err)?;
        }

        // Shift each rotation: .(N-1) → .N
        for i in (1..MAX_ROTATIONS).rev() {
            let from = rotation_path(&self.file_path, i);
            let to = rotation_path(&self.file_path, i + 1);
            if from.exists() {
                fs::rename(&from, &to).map_err(io_err)?;
            }
        }

        // Current → .1
        let first = rotation_path(&self.file_path, 1);
        fs::rename(&self.file_path, &first).map_err(io_err)?;

        // Reset chain state for new file.
        self.prev_hash = [0u8; 32];
        self.append_count = 0;

        Ok(())
    }

    /// Securely scrub the log: flush, secure-delete file, zero key and state.
    pub fn scrub(&mut self) -> Result<(), AppError> {
        // Flush remaining entries so we secure-delete the full file.
        self.flush()?;

        // Secure delete the file.
        if self.file_path.exists() {
            super::anti_forensic::secure_delete(&self.file_path)?;
        }

        // Also scrub any rotation files.
        for i in 1..=MAX_ROTATIONS {
            let rp = rotation_path(&self.file_path, i);
            if rp.exists() {
                super::anti_forensic::secure_delete(&rp)?;
            }
        }

        // Zero sensitive fields.
        self.key.zeroize();
        self.prev_hash.zeroize();
        self.ring_buffer.clear();

        Ok(())
    }

    // ─── Internal helpers ───────────────────────────────────────────────────

    /// Read the last entry's hash from the persisted file to resume the chain.
    fn read_chain_head(path: &std::path::Path) -> Result<[u8; 32], AppError> {
        let file = fs::File::open(path).map_err(io_err)?;
        let reader = BufReader::new(file);
        let mut last_hash = [0u8; 32];

        for line_result in reader.lines() {
            let line = line_result.map_err(io_err)?;
            if line.trim().is_empty() {
                continue;
            }
            let entry: PersistedEntry = serde_json::from_str(&line)
                .map_err(|e| AppError::Internal(format!("json: {e}")))?;
            last_hash = hex_decode(&entry.h)?;
        }

        Ok(last_hash)
    }
}

// ─── Persisted format ───────────────────────────────────────────────────────

/// JSON-serializable entry for disk storage.
#[derive(serde::Serialize, serde::Deserialize)]
struct PersistedEntry {
    /// Base64-encoded nonce.
    n: String,
    /// Base64-encoded ciphertext.
    c: String,
    /// Hex-encoded entry hash.
    h: String,
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn io_err(e: std::io::Error) -> AppError {
    AppError::Internal(format!("io error: {e}"))
}

fn sanitize_field(s: &str) -> String {
    // Strip control characters (except tab/newline handled by JSON) and
    // backslash-escape quotes to prevent injection.
    s.chars()
        .filter(|c| !c.is_control() || *c == '\t')
        .map(|c| match c {
            '"' => "\\\"".to_string(),
            '\\' => "\\\\".to_string(),
            '\n' => "\\n".to_string(),
            '\r' => "\\r".to_string(),
            '\t' => "\\t".to_string(),
            other => other.to_string(),
        })
        .collect()
}

fn rotation_path(base: &std::path::Path, n: usize) -> PathBuf {
    let mut name = base.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{n}"));
    base.parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join(name)
}

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn base64_decode(s: &str) -> Result<Vec<u8>, AppError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| AppError::Internal(format!("base64: {e}")))
}

fn hex_decode(s: &str) -> Result<[u8; 32], AppError> {
    let bytes = hex::decode(s).map_err(|e| AppError::Internal(format!("hex: {e}")))?;
    if bytes.len() != 32 {
        return Err(AppError::Internal("hash length mismatch".into()));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(arr)
}

/// Zeroize trait extension for `[u8; 32]`.
trait Zeroize {
    fn zeroize(&mut self);
}

impl Zeroize for [u8; 32] {
    fn zeroize(&mut self) {
        // Use volatile write to prevent compiler from eliding the zeroing.
        for b in self.iter_mut() {
            unsafe {
                std::ptr::write_volatile(b, 0);
            }
        }
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> [u8; 32] {
        [0x42u8; 32]
    }

    #[test]
    fn append_and_verify() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.log");
        let mut log = SecureLog::new(&path, test_key()).unwrap();

        log.append("INFO", "hello world").unwrap();
        log.append("WARN", "something happened").unwrap();
        log.append("ERROR", "bad stuff").unwrap();
        log.flush().unwrap();

        assert!(path.exists());
        assert!(log.verify_chain().unwrap());
    }

    #[test]
    fn chain_break_detected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.log");
        let mut log = SecureLog::new(&path, test_key()).unwrap();

        log.append("INFO", "entry one").unwrap();
        log.append("INFO", "entry two").unwrap();
        log.flush().unwrap();

        // Tamper: corrupt a byte in the file.
        let mut content = fs::read_to_string(&path).unwrap();
        // Find the first 'A' in the base64 data and change it.
        if let Some(pos) = content.find('A') {
            let bytes = unsafe { content.as_bytes_mut() };
            bytes[pos] = b'Z';
        }
        fs::write(&path, &content).unwrap();

        // Verify with a fresh instance.
        let log2 = SecureLog::new(&path, test_key()).unwrap();
        assert!(!log2.verify_chain().unwrap());
    }

    #[test]
    fn rotate_keeps_last_3() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rotate.log");
        let mut log = SecureLog::new(&path, test_key()).unwrap();

        // Create 4 rotations.
        for i in 0..4 {
            log.append("INFO", &format!("rotation {i}")).unwrap();
            log.flush().unwrap();
            log.rotate().unwrap();
        }

        // Only .1, .2, .3 should exist; .4 should not (oldest was deleted).
        let base_name = "rotate.log";
        let parent = dir.path();
        assert!(parent.join(format!("{base_name}.1")).exists());
        assert!(parent.join(format!("{base_name}.2")).exists());
        assert!(parent.join(format!("{base_name}.3")).exists());
        assert!(!parent.join(format!("{base_name}.4")).exists());
    }

    #[test]
    fn scrub_zeroes_buffer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("scrub.log");
        let mut log = SecureLog::new(&path, test_key()).unwrap();

        log.append("INFO", "sensitive data").unwrap();
        log.scrub().unwrap();

        assert!(!path.exists());
        assert!(log.ring_buffer.is_empty());
        assert_eq!(log.key, [0u8; 32]);
        assert_eq!(log.prev_hash, [0u8; 32]);
    }

    #[test]
    fn encrypted_file_is_not_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("enc.log");
        let mut log = SecureLog::new(&path, test_key()).unwrap();

        log.append("INFO", "super secret message").unwrap();
        log.flush().unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert!(
            !content.contains("super secret message"),
            "plaintext should not appear in encrypted log"
        );
    }

    #[test]
    fn append_thousand_entries_stays_correct() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bulk.log");
        let mut log = SecureLog::new(&path, test_key()).unwrap();

        for i in 0..1000 {
            log.append("INFO", &format!("entry {i}")).unwrap();
        }
        log.flush().unwrap();

        assert!(log.verify_chain().unwrap());
    }

    #[test]
    fn verify_empty_chain() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.log");
        // Write an empty file.
        fs::write(&path, "").unwrap();

        let log = SecureLog::new(&path, test_key()).unwrap();
        assert!(log.verify_chain().unwrap());
    }

    #[test]
    fn new_log_resumes_chain_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("resume.log");

        // First session.
        {
            let mut log = SecureLog::new(&path, test_key()).unwrap();
            log.append("INFO", "session 1").unwrap();
            log.flush().unwrap();
        }

        // Second session — new instance reads chain head.
        {
            let mut log = SecureLog::new(&path, test_key()).unwrap();
            log.append("INFO", "session 2").unwrap();
            log.flush().unwrap();
            assert!(log.verify_chain().unwrap());
        }
    }
}

//! PKB1 envelope header serialization.
//!
//! The header is cleartext and provides the parameters required to derive the
//! encryption key and parse the encrypted body. It is also used as the
//! additional authenticated data (AAD) for every AES-256-GCM chunk.

use std::io::{Read, Write};

use crate::backup::{BackupError, BackupResult, PKB1_MAGIC, PKB1_VERSION};

/// Total size of a PKB1 header on disk, including the 4-byte magic.
pub const PKB1_HEADER_SIZE: usize = 64;

/// Cleartext header at the start of every `.pkb1` envelope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pkb1Header {
    /// Magic bytes (`b"PKB1"`).
    pub magic: [u8; 4],
    /// Envelope version.
    pub version: u16,
    /// Bit flags (reserved, always 0 in version 1).
    pub flags: u16,
    /// Backup creation timestamp (Unix milliseconds).
    pub created_at_unix_ms: i64,
    /// Length of the plaintext SQLCipher database in bytes.
    pub plaintext_db_len: u64,
    /// 16-byte random salt for Argon2id key derivation.
    pub salt: [u8; 16],
    /// 4-byte prefix used to build the 12-byte GCM nonce for each chunk.
    pub nonce_prefix: [u8; 4],
    /// Argon2id memory cost (KiB).
    pub argon2_m_cost_kib: u32,
    /// Argon2id time cost.
    pub argon2_t_cost: u32,
    /// Argon2id parallelism cost.
    pub argon2_p_cost: u32,
    /// Plaintext chunk size used for AEAD chunking.
    pub chunk_size: u32,
    /// Length of the JSON manifest in bytes.
    pub manifest_len: u32,
}

impl Pkb1Header {
    /// Serialize the header to its on-disk byte representation.
    pub fn to_bytes(&self) -> [u8; PKB1_HEADER_SIZE] {
        let mut buf = [0u8; PKB1_HEADER_SIZE];
        let mut off = 0usize;

        buf[off..off + 4].copy_from_slice(&self.magic);
        off += 4;
        buf[off..off + 2].copy_from_slice(&self.version.to_be_bytes());
        off += 2;
        buf[off..off + 2].copy_from_slice(&self.flags.to_be_bytes());
        off += 2;
        buf[off..off + 8].copy_from_slice(&self.created_at_unix_ms.to_be_bytes());
        off += 8;
        buf[off..off + 8].copy_from_slice(&self.plaintext_db_len.to_be_bytes());
        off += 8;
        buf[off..off + 16].copy_from_slice(&self.salt);
        off += 16;
        buf[off..off + 4].copy_from_slice(&self.nonce_prefix);
        off += 4;
        buf[off..off + 4].copy_from_slice(&self.argon2_m_cost_kib.to_be_bytes());
        off += 4;
        buf[off..off + 4].copy_from_slice(&self.argon2_t_cost.to_be_bytes());
        off += 4;
        buf[off..off + 4].copy_from_slice(&self.argon2_p_cost.to_be_bytes());
        off += 4;
        buf[off..off + 4].copy_from_slice(&self.chunk_size.to_be_bytes());
        off += 4;
        buf[off..off + 4].copy_from_slice(&self.manifest_len.to_be_bytes());

        buf
    }

    /// Write the header to a writer.
    pub fn write(&self, w: &mut impl Write) -> BackupResult<()> {
        w.write_all(&self.to_bytes())?;
        Ok(())
    }

    /// Read and validate a header from a reader.
    pub fn read(r: &mut impl Read) -> BackupResult<Self> {
        let mut buf = [0u8; PKB1_HEADER_SIZE];
        r.read_exact(&mut buf)?;

        let mut off = 0usize;

        let mut magic = [0u8; 4];
        magic.copy_from_slice(&buf[off..off + 4]);
        off += 4;
        if &magic != PKB1_MAGIC {
            return Err(BackupError::InvalidEnvelope("bad magic"));
        }

        let version = u16::from_be_bytes([buf[off], buf[off + 1]]);
        off += 2;
        if version != PKB1_VERSION {
            return Err(BackupError::InvalidEnvelope("unsupported version"));
        }

        let flags = u16::from_be_bytes([buf[off], buf[off + 1]]);
        off += 2;

        let created_at_unix_ms = i64::from_be_bytes([
            buf[off],
            buf[off + 1],
            buf[off + 2],
            buf[off + 3],
            buf[off + 4],
            buf[off + 5],
            buf[off + 6],
            buf[off + 7],
        ]);
        off += 8;

        let plaintext_db_len = u64::from_be_bytes([
            buf[off],
            buf[off + 1],
            buf[off + 2],
            buf[off + 3],
            buf[off + 4],
            buf[off + 5],
            buf[off + 6],
            buf[off + 7],
        ]);
        off += 8;

        let mut salt = [0u8; 16];
        salt.copy_from_slice(&buf[off..off + 16]);
        off += 16;

        let mut nonce_prefix = [0u8; 4];
        nonce_prefix.copy_from_slice(&buf[off..off + 4]);
        off += 4;

        let argon2_m_cost_kib =
            u32::from_be_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]]);
        off += 4;
        let argon2_t_cost =
            u32::from_be_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]]);
        off += 4;
        let argon2_p_cost =
            u32::from_be_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]]);
        off += 4;
        let chunk_size = u32::from_be_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]]);
        off += 4;
        let manifest_len = u32::from_be_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]]);

        if chunk_size == 0 {
            return Err(BackupError::InvalidEnvelope("chunk size must be non-zero"));
        }
        // Prevent crafted envelopes from causing OOM (Argon2 m_cost) or panics
        // (manifest_len > chunk_size causes slice out-of-bounds in chunked decrypt).
        const MAX_ARGON2_M_COST_KIB: u32 = 65536; // 64 MiB — generous ceiling
        if argon2_m_cost_kib > MAX_ARGON2_M_COST_KIB {
            return Err(BackupError::InvalidEnvelope("argon2 m_cost exceeds maximum"));
        }
        if argon2_t_cost == 0 || argon2_t_cost > 16 {
            return Err(BackupError::InvalidEnvelope("argon2 t_cost out of range"));
        }
        if argon2_p_cost == 0 || argon2_p_cost > 4 {
            return Err(BackupError::InvalidEnvelope("argon2 p_cost out of range"));
        }
        if manifest_len > chunk_size {
            return Err(BackupError::InvalidEnvelope(
                "manifest_len exceeds chunk_size",
            ));
        }

        Ok(Self {
            magic,
            version,
            flags,
            created_at_unix_ms,
            plaintext_db_len,
            salt,
            nonce_prefix,
            argon2_m_cost_kib,
            argon2_t_cost,
            argon2_p_cost,
            chunk_size,
            manifest_len,
        })
    }
}

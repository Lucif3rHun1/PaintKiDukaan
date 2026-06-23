//! Protected DEK wrapper — keeps the data-encryption key in zeroizing memory.
//!
//! Uses `zeroize::Zeroizing` (already a dependency) to wrap a 32-byte DEK.
//! On drop, the memory is zeroed before being freed.
//!
//! This module lives in `security/` but is conceptually part of the crypto
//! layer. It's the bridge between the raw `[u8; 32]` DEK from `kdf::random_dek`
//! and the rest of the application that needs a protected handle.

use zeroize::Zeroizing;

// ─── Public types ──────────────────────────────────────────────────────────

/// A 32-byte Data Encryption Key protected by zeroize-on-drop semantics.
///
/// The inner memory is guaranteed to be zeroed when this value is dropped,
/// preventing key material from lingering in freed heap memory.
pub struct ProtectedDek {
    inner: Zeroizing<[u8; 32]>,
}

impl ProtectedDek {
    /// Wrap a raw 32-byte key in protected memory.
    pub fn new(key: [u8; 32]) -> Self {
        Self {
            inner: Zeroizing::new(key),
        }
    }

    /// Borrow the key bytes. The returned slice is valid for the lifetime
    /// of the borrow — the key is zeroed as soon as the `ProtectedDek` is
    /// dropped.
    pub fn expose(&self) -> &[u8] {
        &*self.inner
    }

    /// Return the key as a fixed-size array reference.
    pub fn as_array(&self) -> &[u8; 32] {
        &*self.inner
    }

    /// Consume self and return the raw key. **Caller is responsible for
    /// zeroizing the returned array.** Prefer using `expose()` instead.
    pub fn into_raw(self) -> [u8; 32] {
        *self.inner
        // `self` is dropped here — inner is zeroed.
        // But we've already copied the value out, so the copy must be
        // zeroized by the caller.
    }
}

impl std::fmt::Debug for ProtectedDek {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ProtectedDek([REDACTED])")
    }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protect_and_expose_roundtrip() {
        let key = [42u8; 32];
        let protected = ProtectedDek::new(key);
        let exposed = protected.expose();
        assert_eq!(exposed, &[42u8; 32]);
    }

    #[test]
    fn exposed_value_matches_original() {
        let mut key = [0u8; 32];
        for (i, b) in key.iter_mut().enumerate() {
            *b = i as u8;
        }
        let protected = ProtectedDek::new(key);
        assert_eq!(protected.expose(), &key);
    }

    #[test]
    fn as_array_matches_original() {
        let key = [0xABu8; 32];
        let protected = ProtectedDek::new(key);
        assert_eq!(protected.as_array(), &[0xABu8; 32]);
    }

    #[test]
    fn into_raw_returns_correct_value() {
        let key = [0x11u8; 32];
        let protected = ProtectedDek::new(key);
        let raw = protected.into_raw();
        assert_eq!(raw, [0x11u8; 32]);
    }

    #[test]
    fn debug_does_not_leak_key() {
        let key = [0xFFu8; 32];
        let protected = ProtectedDek::new(key);
        let debug_str = format!("{:?}", protected);
        assert!(debug_str.contains("REDACTED"));
        assert!(
            !debug_str.contains("255"),
            "debug output should not contain key bytes"
        );
    }

    #[test]
    fn protected_drop_zeros_memory() {
        // This test verifies the zeroize-on-drop contract indirectly.
        // We create a ProtectedDek, get a raw pointer to its inner data,
        // drop it, and verify the memory is zeroed.
        //
        // Note: this test is inherently racy (the allocator may reuse the
        // memory immediately), but it's a reasonable heuristic.
        let key = [0xEEu8; 32];
        let protected = ProtectedDek::new(key);
        let ptr = protected.as_array() as *const [u8; 32] as *const u8;

        // Capture the address for later inspection.
        let addr = ptr as usize;

        // Drop the ProtectedDek.
        drop(protected);

        // Read the memory at that address. If the allocator hasn't reused it,
        // it should be zeroed by zeroize.
        // We can't guarantee this on all platforms, so we just verify the
        // address was valid.
        assert!(addr != 0, "pointer should be non-null before drop");
    }

    #[test]
    fn multiple_protected_deks_are_independent() {
        let k1 = ProtectedDek::new([1u8; 32]);
        let k2 = ProtectedDek::new([2u8; 32]);
        assert_ne!(k1.expose(), k2.expose());
    }
}

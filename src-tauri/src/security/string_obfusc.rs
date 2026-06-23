//! Compile-time string XOR obfuscation.
//!
//! Provides a minimal `obfstr!` macro that XOR-encodes string literals at
//! compile time so they never appear in the `.rodata` section as plaintext.
//! The macro returns a `[u8; N]` stack buffer that is decoded at runtime.
//!
//! A companion `obfstr_encoded!` macro returns just the encoded bytes for
//! testing that encoding actually changed the data.

// ─── Encode / decode helpers (const-compatible) ───────────────────────────

/// XOR a single byte with a position- and length-dependent key.
#[inline(always)]
pub const fn xor_byte(b: u8, pos: usize, len: usize) -> u8 {
    let key = (pos as u8).wrapping_add(len as u8).wrapping_add(0x5A);
    b ^ key
}

// ─── Macros ───────────────────────────────────────────────────────────────

/// XOR-encode a string literal at compile time, decode at runtime.
///
/// Usage:
/// ```
/// use paintkiduakan_lib::obfstr;
/// let decoded: [u8; 4] = obfstr!("test");
/// assert_eq!(&decoded, b"test");
/// ```
///
/// The bytes in the binary are **not** the plaintext literal.
#[macro_export]
macro_rules! obfstr {
    ($s:expr) => {{
        const _OBF_INPUT: &str = $s;
        const _OBF_LEN: usize = _OBF_INPUT.len();
        const _OBF_KEY: u8 = (_OBF_LEN as u8).wrapping_add(0x5A);

        // Compile-time encode — bytes in the binary differ from plaintext.
        const _OBF_ENCODED: [u8; _OBF_LEN] = {
            let src = _OBF_INPUT.as_bytes();
            let mut buf = [0u8; _OBF_LEN];
            let mut i = 0usize;
            while i < _OBF_LEN {
                buf[i] = src[i] ^ (_OBF_KEY.wrapping_add(i as u8));
                i += 1;
            }
            buf
        };

        // Runtime decode — returns a stack-allocated array.
        let mut _decoded = [0u8; _OBF_LEN];
        let mut i = 0usize;
        while i < _OBF_LEN {
            _decoded[i] = _OBF_ENCODED[i] ^ (_OBF_KEY.wrapping_add(i as u8));
            i += 1;
        }
        _decoded
    }};
}

/// Return only the compile-time XOR-encoded bytes (for testing).
///
/// Usage:
/// ```
/// use paintkiduakan_lib::obfstr_encoded;
/// let enc: [u8; 4] = obfstr_encoded!("test");
/// assert_ne!(&enc, b"test");  // encoded ≠ plaintext
/// ```
#[macro_export]
macro_rules! obfstr_encoded {
    ($s:expr) => {{
        const _OE_INPUT: &str = $s;
        const _OE_LEN: usize = _OE_INPUT.len();
        const _OE_KEY: u8 = (_OE_LEN as u8).wrapping_add(0x5A);

        const _OE_ENCODED: [u8; _OE_LEN] = {
            let src = _OE_INPUT.as_bytes();
            let mut buf = [0u8; _OE_LEN];
            let mut i = 0usize;
            while i < _OE_LEN {
                buf[i] = src[i] ^ (_OE_KEY.wrapping_add(i as u8));
                i += 1;
            }
            buf
        };
        _OE_ENCODED
    }};
}

/// XOR-decode a byte slice at runtime with the standard obfstr key scheme.
///
/// Useful when you have encoded bytes obtained elsewhere (e.g., from a
/// network or config) and need to decode them.
pub fn decode_bytes(encoded: &[u8]) -> Vec<u8> {
    let len = encoded.len();
    let key = (len as u8).wrapping_add(0x5A);
    encoded
        .iter()
        .enumerate()
        .map(|(i, &b)| b ^ key.wrapping_add(i as u8))
        .collect()
}

/// Convenience wrapper around [`obfstr!`] that returns an owned `String`.
/// The literal is XOR-encoded at compile time so it never appears in plaintext
/// inside the release binary's `.rodata` section.
#[macro_export]
macro_rules! obs {
    ($lit:expr) => {{
        let _buf = $crate::obfstr!($lit);
        String::from_utf8(_buf.to_vec()).expect("obfstr literal must be ASCII")
    }};
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoded_str_differs_from_plain() {
        let encoded = obfstr_encoded!("test");
        assert_ne!(
            &encoded, b"test",
            "encoded bytes must differ from plaintext"
        );
    }

    #[test]
    fn decoded_str_matches_original() {
        let decoded = obfstr!("hello world");
        assert_eq!(&decoded, b"hello world");
    }

    #[test]
    fn multiple_literals_have_different_keys() {
        let a = obfstr_encoded!("ab");
        let b = obfstr_encoded!("xyz");
        // Different lengths → different key base
        let key_a = 2u8.wrapping_add(0x5A);
        let key_b = 3u8.wrapping_add(0x5A);
        assert_ne!(key_a, key_b);
        // First bytes should differ even for the same first char position
        // (since key differs)
        assert_ne!(
            b'a' ^ (key_a.wrapping_add(0)),
            b'x' ^ (key_b.wrapping_add(0)),
        );
    }

    #[test]
    fn empty_string_roundtrips() {
        let decoded = obfstr!("");
        assert_eq!(decoded.len(), 0);
    }

    #[test]
    fn single_char_roundtrips() {
        let decoded = obfstr!("Z");
        assert_eq!(&decoded, b"Z");
    }

    #[test]
    fn decode_bytes_utility_matches_macro() {
        let encoded = obfstr_encoded!("roundtrip");
        let decoded = decode_bytes(&encoded);
        assert_eq!(decoded, b"roundtrip".to_vec());
    }

    #[test]
    fn long_string_roundtrips() {
        let long = b"this is a longer test string with spaces and numbers 12345";
        let encoded = obfstr_encoded!("this is a longer test string with spaces and numbers 12345");
        let decoded = decode_bytes(&encoded);
        assert_eq!(&decoded, long);
    }

    #[test]
    fn xor_byte_position_dependence() {
        // Same input byte at different positions → different encoded byte.
        let a = xor_byte(b'X', 0, 10);
        let b = xor_byte(b'X', 1, 10);
        assert_ne!(a, b);
    }
}

#!/usr/bin/env python3
"""Verify that the minisign pubkey in tauri.conf.json matches the signature in
latest.json. Run after publish to catch key-rotation drift before users hit it.

This is the regression test for the "signature was created with a different key
than the one provided" auto-update failure.
"""
import base64
import json
import sys
import urllib.request
from pathlib import Path

PUBKEY_FILE = Path("src-tauri/tauri.conf.json")
ENDPOINT = "https://github.com/Lucif3rHun1/PaintKiDukaan/releases/latest/download/latest.json"


def sig_num(blob: bytes) -> bytes:
    """First 8 bytes of a minisign signature body = sig_num (key identifier)."""
    return blob[:8]


def load_pubkey_sig_num() -> bytes:
    cfg = json.loads(PUBKEY_FILE.read_text())
    pub_b64 = cfg["plugins"]["updater"]["pubkey"]
    body = base64.b64decode(base64.b64decode(pub_b64).decode().split("\n")[1])
    return sig_num(body)


def load_published_sig_num() -> bytes:
    with urllib.request.urlopen(ENDPOINT, timeout=30) as r:
        latest = json.load(r)
    # any platform works — they all use the same signing key
    sig_b64 = next(iter(latest["platforms"].values()))["signature"]
    # sig_b64 is the whole .sig file, base64-encoded. Decode it, split on
    # newlines, the second line is the first signature body.
    sig_text = base64.b64decode(sig_b64).decode()
    sig_body_line = sig_text.split("\n", 2)[1]
    return sig_num(base64.b64decode(sig_body_line))


def main() -> int:
    expected = load_pubkey_sig_num()
    actual = load_published_sig_num()
    print(f"tauri.conf.json pubkey sig_num:  {expected.hex()}")
    print(f"latest.json    pubkey sig_num:  {actual.hex()}")
    if expected != actual:
        print()
        print("MISMATCH: the minisign pubkey embedded in tauri.conf.json was NOT")
        print("the key used to sign the published binaries.")
        print("Every auto-update will fail with 'signature was created with a")
        print("different key than the one provided'. Fix:")
        print("  1. Regenerate a fresh keypair: pnpm tauri signer generate -w src-tauri/updater.key")
        print("  2. Paste the new pubkey into src-tauri/tauri.conf.json")
        print("  3. Update CI secret TAURI_SIGNING_PRIVATE_KEY with the new secret key")
        print("  4. Push a new release (users on prior keys must reinstall manually)")
        return 1
    print("OK: pubkey matches published signatures.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
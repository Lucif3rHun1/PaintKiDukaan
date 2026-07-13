#!/usr/bin/env python3
"""Sign a file with Ed25519 and emit a base64 signature on stdout.

Used by .github/workflows/release.yml to sign self-update zip bundles before
upload. Private seed comes from $UPDATER_SIGNING_KEY (base64 of 32 bytes).

Usage: sign-ed25519.py <seed_b64> <file>
Outputs: base64-encoded 64-byte signature on stdout.
"""

import base64
import sys

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: sign-ed25519.py <seed_b64> <file>", file=sys.stderr)
        return 2

    seed_b64, file_path = sys.argv[1], sys.argv[2]
    seed = base64.b64decode(seed_b64)
    if len(seed) != 32:
        print(f"seed must be 32 bytes, got {len(seed)}", file=sys.stderr)
        return 1

    sk = Ed25519PrivateKey.from_private_bytes(seed)

    with open(file_path, "rb") as f:
        data = f.read()

    sig = sk.sign(data)
    print(base64.b64encode(sig).decode())
    return 0


if __name__ == "__main__":
    sys.exit(main())
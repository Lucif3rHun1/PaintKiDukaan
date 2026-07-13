#!/usr/bin/env python3
"""Sign a file with Ed25519 and emit a base64 signature on stdout.

Used by .github/workflows/release.yml to sign self-update zip bundles before
upload. Private seed comes from env var UPDATER_SIGNING_KEY (base64 of 32
bytes). Reading from env avoids leaking the seed via `ps aux` on Unix, which
would happen if it were passed on argv.

Usage: sign-ed25519.py <file>
Outputs: base64-encoded 64-byte signature on stdout.
"""

import base64
import os
import sys

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: sign-ed25519.py <file>", file=sys.stderr)
        return 2

    seed_b64 = os.environ.get("UPDATER_SIGNING_KEY", "")
    if not seed_b64:
        print("error: UPDATER_SIGNING_KEY env var is not set", file=sys.stderr)
        return 1

    seed = base64.b64decode(seed_b64)
    if len(seed) != 32:
        print(f"seed must be 32 bytes, got {len(seed)}", file=sys.stderr)
        return 1

    sk = Ed25519PrivateKey.from_private_bytes(seed)

    file_path = sys.argv[1]
    with open(file_path, "rb") as f:
        data = f.read()

    sig = sk.sign(data)
    print(base64.b64encode(sig).decode())
    return 0


if __name__ == "__main__":
    sys.exit(main())
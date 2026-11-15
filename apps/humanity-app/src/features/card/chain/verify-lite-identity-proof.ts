// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
import { UsernameUpgradeError } from "./username-upgrade-errors.ts";

/** `Resources.register_person` verifies exactly the alias bytes, not the
 * `<Bytes>` envelope the host's ordinary message signing adds. The host's
 * unwatermarked signing call omits that envelope; verifying here is what
 * proves it did, so a host that still wraps cannot broadcast a doomed claim. */
export async function verifyLiteIdentityProof(
  alias: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): Promise<void> {
  const { verify } = await import("@scure/sr25519");
  let valid = false;
  try {
    valid = verify(alias, signature, publicKey);
  } catch {
    // Malformed signatures are incompatible too; never submit them.
  }
  if (!valid) {
    throw new UsernameUpgradeError(
      "incompatible-proof",
      "This wallet's identity signature is incompatible with username claiming. A wallet update is needed.",
    );
  }
}

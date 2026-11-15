// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { ss58Encode } from "@parity/product-sdk/address";

import {
  formatHostError,
  fromHex,
  toHex,
  type TruApi,
} from "@humanity/shared/chain/host-api.ts";
import { UsernameUpgradeError } from "./username-upgrade-errors.ts";

/** Same prefix the upgrade preflight addresses both accounts with. */
const SS58_PREFIX = 42;
/** Safe copy; the caller re-classifies this as its own signing failure. */
const SIGNING_FAILURE_MESSAGE =
  "We couldn't sign your username upgrade proof. Try again shortly.";

/**
 * Sign the Resources alias as the lite username's on-chain owner: the raw 32
 * bytes, with no `<Bytes>` watermark, since `Resources.register_person`
 * verifies exactly the alias bytes.
 *
 * - The owner is product account `ownerDomain` index 0: `peopl.<tld>/0`, this
 *   app's own personhood account, which RFC-0028 makes the person's identity
 *   account. `peopl` signs as itself, so the product-account call needs no
 *   grant and no prompt.
 * - When the host answers `PermissionDenied` (a `dev.peopl.*` subname or a
 *   preview product whose own `/0` is not the owner, or a host before
 *   truapi-host 0.17) we fall back to the legacy-account call, which matches
 *   the signer by address and prompts. The host accepts the session identity
 *   account there, which RFC-0028 makes `peopl/0`.
 * - Both calls are deprecated host-side and go away once the runtime accepts
 *   a watermarked proof.
 *
 * No arbitrary account is reachable: the caller has checked `litePublicKey`
 * against the chain's username owner, and verifies the returned signature
 * against it before submitting.
 *
 * Security note. An unwatermarked signature over 32 bytes is as strong as a
 * transaction signature by that key: 32 bytes can be the hash of any
 * transaction's signing payload or implication. That is why hosts wrap raw
 * signing in `<Bytes>` and why these calls are deprecated. It is safe here
 * only because:
 * - this app builds the bytes itself, from the chain: the Resources alias
 *   (username upgrade) or the implication digest of a DotNS registration it
 *   encoded (claim-dotns-name.ts);
 * - the signer is the lite username's owner on chain, checked before the call;
 * - the signature is verified against that owner before anything is submitted.
 * Do not copy this for bytes that come from anywhere else (another product,
 * a URL, storage, user input). Once a host drops the deprecated calls, this
 * function fails with `signing` on it, so move both callers to watermarked
 * raw signing as soon as the runtime accepts a watermarked proof.
 *
 * @throws UsernameUpgradeError `signing` when the host refuses or fails.
 */
export async function signLiteIdentityProofUnwatermarked(
  truApi: TruApi,
  ownerDomain: string,
  litePublicKey: Uint8Array,
  alias: Uint8Array,
): Promise<Uint8Array> {
  const payload = { tag: "Bytes", value: { bytes: toHex(alias) } } as const;
  const fail = (error: unknown): never => {
    throw new UsernameUpgradeError("signing", SIGNING_FAILURE_MESSAGE, {
      cause: new Error(
        `Host could not sign the lite identity proof (${formatHostError(error)}).`,
      ),
    });
  };
  const product = await truApi.signing
    .signRawUnwatermarkedDeprecated({
      account: {
        dotNsIdentifier: ownerDomain,
        derivationIndex: { tag: "Index", value: 0 },
      },
      payload,
    })
    .match(
      ({ signature }) => signature,
      (error) =>
        error.tag === "Domain" && error.value.value.tag === "PermissionDenied"
          ? null
          : fail(error),
    );
  const signature =
    product ??
    (await truApi.signing
      .signRawUnwatermarkedDeprecatedWithLegacyAccount({
        signer: ss58Encode(litePublicKey, SS58_PREFIX),
        payload,
      })
      .match(({ signature }) => signature, fail));
  return fromHex(signature);
}

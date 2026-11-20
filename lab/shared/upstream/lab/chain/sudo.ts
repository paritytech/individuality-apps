// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// Sudo conventions of the People runtime, shared by the humanity and games
// integrations. Moved out of product-lab core in refactor step 3: the
// framework has no concept of Sudo; it takes a ReceiptValidator and an
// authority check from the integration.
import { AccountId } from "polkadot-api";
import { expectAuthority } from "@parity/product-lab";
import type { Receipt, ReceiptValidator, ReceiptVerdict } from "@parity/product-lab/chain";

const accountId = AccountId();

/** Public key hex of an SS58 address, so different prefixes compare equal. */
export function publicKeyHex(address: string): string {
  return Buffer.from(accountId.enc(address)).toString("hex");
}

interface SudoKeyApi {
  query: { Sudo: { Key: { getValue(options?: { at: string }): Promise<string | undefined> } } };
}

/**
 * `verifyAuthority` helper for Sudo-governed chains: accept only if the
 * signer's account is the chain's current `Sudo.Key` at the given block
 * (default finalized). Returns `true` or a reason naming both accounts.
 */
export async function verifySudoKey(
  api: SudoKeyApi | object,
  address: string,
  options: { at?: string; label?: string } = {},
): Promise<true | string> {
  const key = await (api as SudoKeyApi).query.Sudo.Key.getValue({ at: options.at ?? "finalized" });
  return expectAuthority({
    label: options.label ?? "Sudo.Key",
    expected: address,
    actual: key,
    normalise: publicKeyHex,
  });
}

/** Decides whether a failed inner dispatch is expected (for example a race another actor already won). */
export type AcceptInnerFailure = (error: unknown, receipt: Receipt) => Promise<boolean>;

/**
 * A `sudo` call dispatches even when its inner call fails; the result is only
 * in the `Sudo.Sudid` event. This validator fails such a receipt with "inner
 * dispatch failed" unless `acceptInnerFailure` accepts that failure.
 */
export class SudoDispatchValidator implements ReceiptValidator {
  constructor(private readonly acceptInnerFailure?: AcceptInnerFailure) {}

  async validate(receipt: Receipt): Promise<ReceiptVerdict> {
    for (const event of receipt.events) {
      if (event.type !== "Sudo" || event.value.type !== "Sudid") continue;
      const result = (event.value.value as { sudo_result: { success: boolean; value: unknown } }).sudo_result;
      if (!result.success && !(await this.acceptInnerFailure?.(result.value, receipt)))
        return { ok: false, reason: "inner dispatch failed" };
    }
    return { ok: true };
  }
}

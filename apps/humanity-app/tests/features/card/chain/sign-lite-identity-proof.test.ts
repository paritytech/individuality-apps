// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { ss58Encode } from "@parity/product-sdk/address";

import { signLiteIdentityProofUnwatermarked } from "@features/card/chain/sign-lite-identity-proof.ts";
import { UsernameUpgradeError } from "@features/card/chain/username-upgrade-errors.ts";
import type { TruApi } from "@humanity/shared/chain/host-api.ts";

const LITE_DOMAIN = "peopl.testnet";
const litePublicKey = new Uint8Array(32).fill(0x11);
const alias = new Uint8Array(32).fill(0xab);
const ALIAS_HEX = `0x${"ab".repeat(32)}`;
const PRODUCT_SIGNATURE = `0x${"01".repeat(64)}`;
const LEGACY_SIGNATURE = `0x${"02".repeat(64)}`;
const payload = { tag: "Bytes", value: { bytes: ALIAS_HEX } };

/** The slice of truAPI's `ResultAsync` the signer uses. */
const okAsync = (value: unknown) => ({
  match: async (ok: (v: unknown) => unknown) => ok(value),
});
const errAsync = (error: unknown) => ({
  match: async (_ok: unknown, err: (e: unknown) => unknown) => err(error),
});

function hostError(tag: "PermissionDenied" | "Rejected") {
  return { tag: "Domain", value: { tag: "V1", value: { tag } } };
}

function makeTruApi(product: () => unknown) {
  const signing = {
    signRawUnwatermarkedDeprecated: vi.fn(product),
    signRawUnwatermarkedDeprecatedWithLegacyAccount: vi.fn<(request: unknown) => unknown>(() =>
      okAsync({ signature: LEGACY_SIGNATURE }),
    ),
  };
  return { signing, truApi: { signing } as unknown as TruApi };
}

const sign = (truApi: TruApi) =>
  signLiteIdentityProofUnwatermarked(truApi, LITE_DOMAIN, litePublicKey, alias);

describe("signLiteIdentityProofUnwatermarked", () => {
  it("signs the raw alias as product account peopl.<tld>/0", async () => {
    const { signing, truApi } = makeTruApi(() =>
      okAsync({ signature: PRODUCT_SIGNATURE }),
    );

    const signature = await sign(truApi);

    expect(signature).toEqual(new Uint8Array(64).fill(0x01));
    expect(signing.signRawUnwatermarkedDeprecated).toHaveBeenCalledWith({
      account: {
        dotNsIdentifier: LITE_DOMAIN,
        derivationIndex: { tag: "Index", value: 0 },
      },
      payload,
    });
    expect(
      signing.signRawUnwatermarkedDeprecatedWithLegacyAccount,
    ).not.toHaveBeenCalled();
  });

  it("falls back to the legacy account when the host refuses the product account (dev/preview subname)", async () => {
    const { signing, truApi } = makeTruApi(() =>
      errAsync(hostError("PermissionDenied")),
    );

    const signature = await sign(truApi);

    expect(signature).toEqual(new Uint8Array(64).fill(0x02));
    expect(
      signing.signRawUnwatermarkedDeprecatedWithLegacyAccount,
    ).toHaveBeenCalledWith({
      signer: ss58Encode(litePublicKey, 42),
      payload,
    });
  });

  it("fails as a signing error on any other refusal, without falling back", async () => {
    const { signing, truApi } = makeTruApi(() =>
      errAsync(hostError("Rejected")),
    );

    const error = await sign(truApi).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UsernameUpgradeError);
    expect((error as UsernameUpgradeError).code).toBe("signing");
    expect(
      signing.signRawUnwatermarkedDeprecatedWithLegacyAccount,
    ).not.toHaveBeenCalled();
  });

  it("fails as a signing error when the legacy fallback fails", async () => {
    const { signing, truApi } = makeTruApi(() =>
      errAsync(hostError("PermissionDenied")),
    );
    signing.signRawUnwatermarkedDeprecatedWithLegacyAccount.mockReturnValue(
      errAsync(hostError("Rejected")),
    );

    await expect(sign(truApi)).rejects.toMatchObject({ code: "signing" });
  });
});

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** `withAuthorizeCall` turns the host's product-account signer into the
 *  unsigned General transaction an authorized call needs: the chain's own
 *  pipeline version, `VerifyMultiSignature` disabled so the host signs
 *  nothing, `RestrictOrigins` filled, and every other slot untouched. Checked
 *  against the People metadata the descriptors are generated from. */
import { readFileSync } from "node:fs";
import { toHex } from "polkadot-api/utils";
import { describe, expect, it, vi } from "vitest";

// PAPI's nonce and common-extension fillers need a live client; the slots
// this wrapper writes do not depend on them.
vi.mock("@polkadot-api/signers-common", () => ({
  withNonce: () => (create: unknown) => create,
  withCommonExtensions: (create: unknown) => create,
}));

import { withAuthorizeCall } from "@humanity/shared/chain/authorize-call-signer.ts";
import {
  readExtensionPipeline,
  type TxPayload,
} from "@humanity/shared/chain/extension-pipeline.ts";

const metadata = readFileSync(new URL("../../.papi/metadata/people.scale", import.meta.url));
const pipeline = readExtensionPipeline(metadata);

function fakeHostSigner() {
  const calls: { payload: TxPayload; mocked: boolean }[] = [];
  const create = async (payload: TxPayload, _opts: unknown, _bindings: unknown, mocked: boolean) => {
    calls.push({ payload, mocked });
    return "0xsigned";
  };
  const signer = Object.assign(create, {
    publicKey: new Uint8Array(32).fill(7),
    signBytes: vi.fn(),
  });
  return { signer, calls };
}

const payload = (extensions: TxPayload["extensions"] = []): TxPayload => ({
  callData: "0x3803",
  extensions,
  context: { metadata: toHex(metadata) },
});

const decode = (identifier: string, hex: string) =>
  pipeline.codec(pipeline.slot(identifier).type)[1](Uint8Array.from(Buffer.from(hex.slice(2), "hex")));

describe("withAuthorizeCall", () => {
  it("hands the host a v5 payload with VerifyMultiSignature disabled and RestrictOrigins off", async () => {
    const { signer, calls } = fakeHostSigner();
    const wrapped = withAuthorizeCall(signer as never) as unknown as typeof signer;

    await expect(wrapped(payload(), {}, {}, false)).resolves.toBe("0xsigned");

    const sent = calls[0]!;
    expect(sent.mocked).toBe(false);
    expect(sent.payload.txExtVersion).toBe(pipeline.version);
    expect(sent.payload.callData).toBe("0x3803");
    const byId = Object.fromEntries(sent.payload.extensions.map((e) => [e.id, e]));
    expect(decode("VerifyMultiSignature", byId.VerifyMultiSignature!.extra)).toEqual({
      type: "Disabled",
      value: undefined,
    });
    expect(decode("RestrictOrigins", byId.RestrictOrigins!.extra)).toBe(false);
  });

  it("keeps the slots PAPI filled and writes them in pipeline order", async () => {
    const { signer, calls } = fakeHostSigner();
    const wrapped = withAuthorizeCall(signer as never) as unknown as typeof signer;
    const spec = pipeline.extensions.find((slot) => slot.identifier === "CheckSpecVersion")!;

    await wrapped(payload([{ id: spec.identifier, extra: "0x", additionalSigned: "0x01020304" }]), {}, {}, false);

    const sent = calls[0]!.payload.extensions;
    expect(sent.find((e) => e.id === "CheckSpecVersion")).toEqual({
      id: "CheckSpecVersion",
      extra: "0x",
      additionalSigned: "0x01020304",
    });
    const order = sent.map((e) => pipeline.indexOf(e.id));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("passes a fee estimate straight through", async () => {
    const { signer, calls } = fakeHostSigner();
    const wrapped = withAuthorizeCall(signer as never) as unknown as typeof signer;
    const estimate = payload();

    await wrapped(estimate, {}, {}, true);

    expect(calls).toEqual([{ payload: estimate, mocked: true }]);
  });
});

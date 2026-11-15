// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RingLocation,
  RingVrfKeyHandle,
  TruApi,
} from "@humanity/shared/chain/host-api.ts";
import { PERSONHOOD_CONTEXT_INDEX } from "@humanity/shared/chain/individuality.ts";
import { createRingVrfProof } from "@humanity/shared/chain/ring-vrf-proof.ts";

const CONTEXT = `0x${"11".repeat(32)}` as const;
const ALIAS = `0x${"22".repeat(32)}` as const;
const PROOF = "0xc0ffee" as const;
const MESSAGE = new Uint8Array([0xde, 0xad]);
const PRODUCT_ID = "peopl.paseo";
const KEY_HANDLE = {
  dotNsIdentifier: PRODUCT_ID,
  derivationIndex: { tag: "Index", value: 1 },
} as unknown as RingVrfKeyHandle;
const RING: RingLocation = {
  chainId: `0x${"33".repeat(32)}`,
  junctions: [],
};

const createAccountProof = vi.fn();
const CLIENT = { account: { createAccountProof } } as unknown as TruApi;

function hostProof(context: string = CONTEXT) {
  const response = {
    proof: PROOF,
    contextualAlias: { context, alias: ALIAS },
    ringIndex: 3,
    ringRevision: 7,
  };
  return {
    match: (ok: (value: typeof response) => unknown) =>
      Promise.resolve(ok(response)),
  };
}

/** The host's `Result` error arm, which `createRingVrfProof` turns into a throw. */
function hostRefusal(error: unknown) {
  return {
    match: (_ok: (value: never) => unknown, fail: (cause: unknown) => unknown) =>
      Promise.resolve(fail(error)),
  };
}

function args() {
  return {
    client: CLIENT,
    keyHandle: KEY_HANDLE,
    productId: PRODUCT_ID,
    contextIndex: PERSONHOOD_CONTEXT_INDEX.score,
    expectedContext: CONTEXT,
    ringLocation: RING,
    message: MESSAGE,
    failureMessage: "Host could not create the proof",
    contextMismatchMessage: "Host returned a proof for a different context.",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createAccountProof.mockReturnValue(hostProof());
});

describe("createRingVrfProof", () => {
  it("asks the stable API for a product-namespaced context and decodes the answer", async () => {
    const result = await createRingVrfProof(args());

    expect(createAccountProof).toHaveBeenCalledWith({
      keyHandle: KEY_HANDLE,
      context: {
        productId: PRODUCT_ID,
        suffix: { tag: "Index", value: PERSONHOOD_CONTEXT_INDEX.score },
      },
      ringLocation: RING,
      message: "0xdead",
    });
    expect(result).toEqual({
      proof: new Uint8Array([0xc0, 0xff, 0xee]),
      contextualAlias: {
        context: new Uint8Array(32).fill(0x11),
        alias: new Uint8Array(32).fill(0x22),
      },
      ringIndex: 3,
      ringRevision: 7,
    });
  });

  it("rejects a proof minted for bytes the chain will not verify", async () => {
    createAccountProof.mockReturnValue(hostProof(`0x${"44".repeat(32)}`));

    await expect(createRingVrfProof(args())).rejects.toThrow(
      "Host returned a proof for a different context.",
    );
  });

  it("names the host's real refusal, not the CallError envelope around it", async () => {
    // How a ring-VRF refusal actually arrives: `Domain` is `CallError`'s
    // wrapper variant carrying the call's own versioned error as payload.
    createAccountProof.mockReturnValue(
      hostRefusal({ tag: "Domain", value: { tag: "V1", value: { tag: "NotMember" } } }),
    );

    await expect(createRingVrfProof(args())).rejects.toThrow(/NotMember/);
  });
});

describe("the app's proof surface", () => {
  it("no longer reaches for the host's development escape hatch", () => {
    const sourceRoots = ["../../src", "../../../../apps/humanity-app/src"].map((relative) =>
      fileURLToPath(new URL(relative, import.meta.url)),
    );
    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          if (readFileSync(path, "utf8").includes("development_createAccountProof")) {
            offenders.push(path);
          }
        }
      }
    };
    for (const srcRoot of sourceRoots) walk(srcRoot);

    expect(offenders).toEqual([]);
  });
});

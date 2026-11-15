// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { toHex } from "polkadot-api/utils";

import {
  encodeLink,
  registerNameProofMessage,
} from "@humanity/shared/chain/dotns-gateway/proof-message.ts";

// AccountId32 `0x11 × 32`, SS58 prefix 42.
const WHO = "5CT5jwBEAhveEjgiSCQbkaKcKcUyF3VJ8qNXM9rXsuQyn3Kd";

// Derived by hand from the SCALE rules the pallet's derive(Encode) applies to
// `(who, label.as_slice(), link)`, then blake2b-256 (cross-checked with
// Python's hashlib.blake2b):
//   who   = 11 × 32                     (AccountId32: raw bytes)
//   label = 0x2c "alicewonder"          (compact(11) = 11 << 2 = 0x2c, then bytes)
//   link  = 0x00 0x20 "alice.06"        (variant 0, compact(8) = 0x20, bytes)
const PREIMAGE_LITE =
  "0x1111111111111111111111111111111111111111111111111111111111111111" +
  "2c616c696365776f6e646572" +
  "0020616c6963652e3036";
const HASH_LITE =
  "0x3e9caeb5af7d0818a8b240592dc38a5f4708a847d553da05f06915e58630a11f";
//   link  = 0x01 + 65 × 0xab            (variant 1, fixed-size ChatKey, no length)
const HASH_NONE =
  "0x74629a83beb61d3cd99e6b21ca62cec0f2f7a3f34e750cf11b74069f8a131bf5";

describe("registerNameProofMessage", () => {
  it("encodes Link::LiteUsername as variant 0 with a compact-prefixed label", () => {
    expect(toHex(encodeLink({ tag: "LiteUsername", label: "alice.06" }))).toBe(
      "0x" + PREIMAGE_LITE.slice(-20),
    );
  });

  it("hashes (who, label, LiteUsername) like the pallet", () => {
    expect(
      toHex(
        registerNameProofMessage("5CT5jwBEAhveEjgiSCQbkaKcKcUyF3VJ8qNXM9rXsuQyn3Kd", "alicewonder", {
          tag: "LiteUsername",
          label: "alice.06",
        }),
      ),
    ).toBe(HASH_LITE);
  });

  it("hashes (who, label, None(chat key)) with a fixed-size key", () => {
    expect(
      toHex(
        registerNameProofMessage(WHO, "alicewonder", {
          tag: "None",
          chatKey: new Uint8Array(65).fill(0xab),
        }),
      ),
    ).toBe(HASH_NONE);
  });

  it("refuses a chat key of the wrong size and an empty label", () => {
    expect(() => encodeLink({ tag: "None", chatKey: new Uint8Array(64) })).toThrow(RangeError);
    expect(() => registerNameProofMessage(WHO, "", { tag: "LiteUsername", label: "a.01" })).toThrow(
      RangeError,
    );
  });
});

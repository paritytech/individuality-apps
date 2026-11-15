// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { decodeLink, stackId } from "@parity/trinity-stack";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkTarget,
  STACK_LINK_ENV,
  STACK_LINKS,
  stackCheckDisabled,
  stackLink,
  valuesFromDescriptor,
  type DescriptorSlice,
} from "../../scripts/trinity-stacks.mts";

/** A trimmed descriptor in the shape the stack reader returns; no network. */
const fixture = {
  tld: "testnet",
  services: [
    { kind: "ipfs-gateway", urls: ["https://ipfs.example.test/ipfs/"] },
    { kind: "web-gateway", urls: ["https://gateway.example.test/?network=fixturenet"] },
  ],
} as unknown as DescriptorSlice;

describe("valuesFromDescriptor", () => {
  it("reads the TLD and the web gateway host", () => {
    expect(valuesFromDescriptor(fixture)).toEqual({ tld: "testnet", gateway: "gateway.example.test" });
  });

  it("leaves the gateway undefined when the stack names none", () => {
    const bare = { tld: "paseo", services: [] } as unknown as DescriptorSlice;
    expect(valuesFromDescriptor(bare)).toEqual({ tld: "paseo", gateway: undefined });
  });
});

describe("STACK_LINKS", () => {
  it("holds a decodable, keyed default link for preview only", () => {
    expect(Object.keys(STACK_LINKS)).toEqual(["preview"]);
    for (const link of Object.values(STACK_LINKS)) {
      const pointer = decodeLink(link) as { key?: string; url?: string };
      expect(pointer.key).toMatch(/^0x[0-9a-f]{64}$/);
      expect(pointer.url).toMatch(/^https:\/\/.+\/\.well-known\/trinity-stack\.json$/);
    }
  });

  it("decodes to the expected stack id", () => {
    const id = String(stackId(decodeLink(STACK_LINKS["preview"] as string))).toLowerCase();
    expect(id).toContain("4d43362f03d5511632a210632d1fb7760b5a663580f12ffca34619f79357e239");
  });
});

describe("stackLink", () => {
  const override =
    "polkadotapp://stack?key=0x" + "ab".repeat(32) + "&url=https%3A%2F%2Fstack.example.test%2F.well-known%2Ftrinity-stack.json";

  it("names an override variable for each deploy environment", () => {
    expect(STACK_LINK_ENV).toEqual({
      preview: "HUMANITY_STACK_LINK_PREVIEW",
      "paseo-next-v2": "HUMANITY_STACK_LINK_PASEO_NEXT_V2",
    });
  });

  it("falls back to the default, or to nothing when there is none", () => {
    expect(stackLink("preview", {})).toBe(STACK_LINKS["preview"]);
    expect(stackLink("paseo-next-v2", {})).toBeUndefined();
    expect(stackLink("paseo-next-v2", { HUMANITY_STACK_LINK_PASEO_NEXT_V2: "  " })).toBeUndefined();
    expect(stackLink("unknown", { HUMANITY_STACK_LINK_PREVIEW: override })).toBeUndefined();
  });

  it("prefers the environment's override variable", () => {
    expect(stackLink("preview", { HUMANITY_STACK_LINK_PREVIEW: override })).toBe(override);
    expect(stackLink("paseo-next-v2", { HUMANITY_STACK_LINK_PASEO_NEXT_V2: ` ${override} ` })).toBe(override);
    const pointer = decodeLink(override) as { key?: string; url?: string };
    expect(pointer.url).toBe("https://stack.example.test/.well-known/trinity-stack.json");
  });
});

describe("checkTarget (setup's drift check)", () => {
  const target = { tld: "testnet", gateway: "gateway.example.test" };

  it("matches when the descriptor agrees", async () => {
    const read = async () => valuesFromDescriptor(fixture);
    expect(await checkTarget("preview", target, read)).toEqual({ status: "match" });
  });

  it("reports drift naming each stale value", async () => {
    const read = async () => ({ tld: "dot", gateway: "other.example.test" });
    expect(await checkTarget("preview", target, read)).toEqual({
      status: "drift",
      lines: [
        'tld: this script says "testnet", the descriptor says "dot"',
        'gateway: this script says "gateway.example.test", the descriptor says "other.example.test"',
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips, naming the override variable, when an environment has no link", async () => {
    vi.stubEnv("HUMANITY_STACK_LINK_PASEO_NEXT_V2", "");
    expect(await checkTarget("paseo-next-v2", { tld: "paseo", gateway: "paseo.li" })).toEqual({
      status: "skipped",
      note:
        'skipped the descriptor cross-check for "paseo-next-v2": No Trinity stack link is known for the ' +
        '"paseo-next-v2" environment; set HUMANITY_STACK_LINK_PASEO_NEXT_V2 to check against one.',
    });
  });

  it("skips with a note when the descriptor is unreachable", async () => {
    const read = async () => {
      throw new Error("descriptor unreachable");
    };
    expect(await checkTarget("preview", target, read)).toEqual({
      status: "skipped",
      note: 'skipped the descriptor cross-check for "preview": descriptor unreachable',
    });
  });
});

describe("stackCheckDisabled", () => {
  it("turns the check off only for 1 or true", () => {
    expect(["1", "true", "TRUE", " True "].map(stackCheckDisabled)).toEqual([true, true, true, true]);
    expect(["", "0", "false", "yes", undefined].map(stackCheckDisabled)).toEqual([false, false, false, false, false]);
  });
});

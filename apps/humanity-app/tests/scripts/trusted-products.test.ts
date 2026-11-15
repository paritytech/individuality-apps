// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";

/** Loads the deploy manifest fresh under the given grants variable. */
async function trustedProducts(raw: string | undefined): Promise<unknown> {
  vi.resetModules();
  vi.stubEnv("DEPLOY_DOMAIN", "example.paseo");
  if (raw === undefined) delete process.env["HUMANITY_TRUSTED_PRODUCTS"];
  else vi.stubEnv("HUMANITY_TRUSTED_PRODUCTS", raw);
  const config = await import("../../deploy/bulletin-deploy.config.ts");
  return config.default.trustedProducts;
}

describe("deploy manifest trustedProducts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("grants nothing unless the deployer names products", async () => {
    expect(await trustedProducts(undefined)).toEqual({});
    expect(await trustedProducts("")).toEqual({});
    expect(await trustedProducts("  ")).toEqual({});
  });

  it("reads the grants from HUMANITY_TRUSTED_PRODUCTS", async () => {
    expect(await trustedProducts('{"game":["context","storage"],"other":["context","context"]}')).toEqual({
      game: ["context", "storage"],
      other: ["context"],
    });
  });

  it("refuses a malformed value instead of granting something else", async () => {
    await expect(trustedProducts("not json")).rejects.toThrow(/not valid JSON/);
    await expect(trustedProducts('["game"]')).rejects.toThrow(/not a JSON object/);
    await expect(trustedProducts('{"game.paseo":["context"]}')).rejects.toThrow(/bare DotNS label/);
    await expect(trustedProducts('{"game":[]}')).rejects.toThrow(/non-empty array/);
    await expect(trustedProducts('{"game":["sign"]}')).rejects.toThrow(/unknown grant "sign"/);
  });
});

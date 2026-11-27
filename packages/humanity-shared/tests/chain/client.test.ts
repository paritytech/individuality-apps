// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFile } from "node:fs/promises";
import type { people } from "@polkadot-api/descriptors";
import { afterEach, expect, it, vi } from "vitest";
import { getPeopleClient } from "@humanity/shared/chain/client.ts";
import { NETWORKS, type NetworkKey } from "@humanity/shared/chain/networks.ts";

const mock = vi.hoisted(() => ({
  network: "paseo-next-v2" as NetworkKey,
  getTypedApi: vi.fn<(descriptor: Pick<typeof people, "genesis" | "getMetadata">) => void>(),
}));
vi.mock("@humanity/shared/config/env.ts", () => ({
  envConfig: {
    chain: {
      get network() {
        return mock.network;
      },
    },
  },
}));
vi.mock("@humanity/shared/chain/connection.ts", () => ({
  getOrCreateClient: async () => ({ getTypedApi: mock.getTypedApi }),
}));

afterEach(() => vi.clearAllMocks());

it.each([
  ["paseo-next-v2", "paseo.scale"],
  ["previewnet", "people.scale"],
] as const)(
  "uses the descriptor generated for %s",
  async (network, filename) => {
    mock.network = network;
    await getPeopleClient();
    expect(mock.getTypedApi).toHaveBeenCalledWith(
      expect.objectContaining({ genesis: NETWORKS[network].peopleChain.genesisHash }),
    );
    const [descriptor] = mock.getTypedApi.mock.calls[0]!;
    const metadata = new URL(`../../.papi/metadata/${filename}`, import.meta.url);
    expect(Buffer.from(await descriptor.getMetadata()).equals(await readFile(metadata))).toBe(true);
  },
);

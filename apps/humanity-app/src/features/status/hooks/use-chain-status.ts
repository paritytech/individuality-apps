// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";

import { CHAIN_READ_TIMEOUT_MS } from "@humanity/shared/chain/bounded-read.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";
import { getPeopleClient } from "@humanity/shared/chain/client.ts";
import { isInHost } from "@humanity/shared/chain/connection.ts";


export function useChainStatus() {
  return useQuery({
    queryKey: ["chain", "status"],
    refetchInterval: 12_000,
    queryFn: async () => {
      const { client, api, network, wsUrl } = await getPeopleClient();
      const [spec, finalized, gameIndex, game] = await withTimeout(
        Promise.all([
          client.getChainSpecData(),
          client.getFinalizedBlock(),
          api.query.Game.GameIndex.getValue(),
          // Plain StorageValue with no ValueQuery: empty between games.
          api.query.Game.Game.getValue(),
        ]),
        CHAIN_READ_TIMEOUT_MS,
        `no response from ${wsUrl} within ${CHAIN_READ_TIMEOUT_MS / 1000}s`,
      );
      return {
        chainName: spec.name,
        genesisHash: spec.genesisHash,
        wsUrl,
        networkDisplayName: network.displayName,
        inHost: isInHost(),
        finalizedNumber: finalized.number,
        gameIndex,
        game,
      };
    },
  });
}

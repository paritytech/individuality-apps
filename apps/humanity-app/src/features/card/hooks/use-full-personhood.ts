// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { readFullPersonhood } from "@humanity/shared/chain/full-personhood.ts";
import { runBoundedChainRead } from "@humanity/shared/chain/bounded-read.ts";
import { resolveNetwork } from "@humanity/shared/chain/networks.ts";
import { envConfig } from "@humanity/shared/config/env.ts";
import { productDomain } from "@humanity/shared/identity/product-domain.ts";

export function useFullPersonhood(
  identity: string | undefined,
  enabled: boolean,
) {
  const network = resolveNetwork(envConfig.chain.network);
  const domain = productDomain();
  return useQuery({
    queryKey: [
      "chain",
      "full-personhood",
      network.peopleChain.genesisHash,
      domain,
      identity,
    ],
    enabled: enabled && identity != null,
    retry: false,
    staleTime: 0,
    refetchInterval: 12_000,
    queryFn: ({ signal }) =>
      runBoundedChainRead(signal, (childSignal) =>
        readFullPersonhood(network, domain, childSignal),
      ),
  });
}

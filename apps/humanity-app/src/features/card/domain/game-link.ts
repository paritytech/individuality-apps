// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The way to the game. Games are sessions of DIM2, which is its own
 *  product, reached under its reserved product id on each network:
 *  `dim2.testnet` on previewnet, `dim2.paseo` on paseo-next-v2. The
 *  sign-up happens here (`use-register-for-game.ts`); playing happens
 *  there. */
import { navigateTo } from "@humanity/shared/chain/host-api.ts";
import { envConfig } from "@humanity/shared/config/env.ts";
import { dim2Url, resolveNetwork } from "@humanity/shared/chain/networks.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";

const logger = loggerFor("card", "game-link");

const DIM2_URL = dim2Url(resolveNetwork(envConfig.chain.network));

/** Hand the deep link to the host. `navigateTo` resolves a `Result` rather
 *  than throwing, so a host that declines is invisible unless it is logged:
 *  the caller still has nothing useful to say to the person, but a refused
 *  hand-off and a working one must not look identical from the outside. A
 *  host that rejects must not surface as an unhandled rejection either. */
export function openGame(): void {
  void navigateTo(DIM2_URL)
    .then((result) => {
      if (result.ok) {
        logger.info("handed the game off to {url}", { url: DIM2_URL });
        return;
      }
      logger.error("host declined the game hand-off to {url}: {reason}", {
        url: DIM2_URL,
        reason: JSON.stringify(result.error),
      });
    })
    .catch((error: unknown) => {
      logger.error("game hand-off to {url} threw: {error}", {
        url: DIM2_URL,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

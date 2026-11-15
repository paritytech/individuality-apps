// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";

import { sweepStrandedPrizes } from "@features/prize/chain/prize-coinage.ts";
import { runBoundedChainRead } from "@humanity/shared/chain/bounded-read.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";

const logger = loggerFor("prize", "stranded-sweep");

/**
 * Once per mount: recover any prize left on product account zero into the
 * coinage purse.
 *
 * The post-claim sweep is fire-and-forget, so a claim whose top-up never went
 * out — the app closed between inclusion and the sweep, or the host rejected
 * it — strands the prize on the account with nothing to retry it. This is that
 * retry, and it is deliberately a single pass at start-up rather than a timer:
 * the host watches the account for an hour once a top-up is accepted, so one
 * request per app run is enough to get the balance moving.
 *
 * Nothing is surfaced to the UI. Every outcome is a log line, including the
 * per-asset failures, which leave the prize exactly where it was for the next
 * run to pick up. An abort from unmount is not an error.
 */
export function useSweepStrandedPrizes(): void {
  useEffect(() => {
    const controller = new AbortController();
    void runBoundedChainRead(controller.signal, (signal) =>
      sweepStrandedPrizes(signal),
    )
      .then((sweep) => {
        if (sweep.status === "skipped") {
          logger.debug("no stranded prize sweep. reason={reason}", {
            reason: sweep.reason,
          });
          return;
        }
        for (const prize of sweep.sent) {
          logger.info(
            "stranded prize top-up accepted; host loads it once its balance lands. " +
              "amount={amount}",
            { amount: prize.amount.toString() },
          );
        }
        for (const { prize, error } of sweep.failed) {
          logger.error(
            "stranded prize top-up failed; prize remains on product account 0. " +
              "amount={amount} error={error}",
            { amount: prize.amount.toString(), error: String(error) },
          );
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        logger.error("stranded prize sweep failed. error={error}", {
          error: String(error),
        });
      });
    return () => {
      controller.abort();
    };
  }, []);
}

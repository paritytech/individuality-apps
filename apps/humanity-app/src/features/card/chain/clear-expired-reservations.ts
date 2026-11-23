// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Remove the expired reservations that stand between a person and the full
 * name they reserved (`domain/expired-reservations.ts` picks them), one
 * `Resources.remove_expired_username_reservation` per entry, in queue order.
 *
 * Nothing in the runtime clears an expired entry on its own, and
 * `register_person(Reservation)` only accepts the front of the queue, so
 * without this a person behind stale entries can never claim their name.
 * The call is permissionless and fee-free: it is
 * submitted as an unsigned General transaction (`withAuthorizeCall`) through
 * the product account's host signer, with no prompt and nothing signed.
 *
 * Only entries the runtime would accept and that have stood at least
 * `RESERVATION_FLOOR_SECS` are picked. The runtime re-checks each one when
 * the transaction is validated, so a stale read here costs a refused
 * transaction, never a wrong removal.
 *
 * The queue is read at the best block, and a removal that fails or cannot be
 * confirmed is checked against that queue before it stops the run: an entry
 * that is no longer there is done, whoever removed it. A run that starts over
 * after a reload therefore picks up where the last one got to instead of
 * resending removals the chain now refuses.
 */
import { Binary } from "polkadot-api";

import { expiredEntriesAhead } from "@features/card/domain/expired-reservations.ts";
import { recordMutation } from "@features/debug/debug-mutation-journal.ts";
import { withAuthorizeCall } from "@humanity/shared/chain/authorize-call-signer.ts";
import { getPeopleClient } from "@humanity/shared/chain/client.ts";
import { describeError } from "@humanity/shared/chain/error-detail.ts";
import { getAccountsProvider } from "@humanity/shared/chain/host-api.ts";
import { submissionDetail, watchTransactionSubmission } from "@humanity/shared/chain/transaction-submission.ts";
import { productDomain } from "@humanity/shared/identity/product-domain.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { runFlow, type FlowRun } from "@humanity/shared/telemetry/flow.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";

const logger = loggerFor("card", "reservation-cleanup");
const REMOVE_EXPIRED = "Resources.remove_expired_username_reservation";
const HOST_TIMEOUT_MS = 15_000;
const CHAIN_TIMEOUT_MS = 15_000;
/** Mortality era of each removal, in blocks. */
const REMOVAL_MORTALITY_PERIOD = 64;
const SIGNING_FAILURE_MESSAGE = "An expired reservation could not be removed.";
const FINALITY_FAILURE_MESSAGE = "An expired reservation removal did not confirm.";

export type ClearExpiredReservationsOutcome =
  /** Nothing ahead of the person has expired, or they are not in the queue. */
  | { readonly status: "nothing" }
  /** Every picked entry was removed. */
  | { readonly status: "cleared"; readonly removed: number }
  /** The attempt stopped; `removed` entries went before it did. */
  | { readonly status: "failed"; readonly removed: number; readonly detail: string };

export function clearExpiredReservations(
  name: string,
  claimant: string,
): Promise<ClearExpiredReservationsOutcome> {
  return runFlow("username.reservation-cleanup", (flow) => runCleanup(name, claimant, flow), {
    outcome: (outcome) => ({ kind: outcome.status, ok: outcome.status !== "failed" }),
  });
}

async function runCleanup(
  name: string,
  claimant: string,
  flow: FlowRun,
): Promise<ClearExpiredReservationsOutcome> {
  let removed = 0;
  try {
    flow.stage("read");
    const { api, client } = await withTimeout(getPeopleClient(), CHAIN_TIMEOUT_MS, "People did not respond in time.");
    const key = Binary.fromText(name);
    const readQueue = () =>
      withTimeout(
        api.query.Resources.UsernameReservationQueue.getValue(key, { at: "best" }),
        CHAIN_TIMEOUT_MS,
        "People did not respond in time.",
      );
    const stillQueued = async (account: string): Promise<boolean> =>
      (await readQueue())?.some((entry) => entry.account === account) === true;
    const [queue, duration, now] = await withTimeout(
      Promise.all([
        api.query.Resources.UsernameReservationQueue.getValue(key, { at: "best" }),
        api.query.Resources.UsernameReservationDuration.getValue(),
        api.query.Timestamp.Now.getValue(),
      ]),
      CHAIN_TIMEOUT_MS,
      "People did not respond in time.",
    );
    const accounts = expiredEntriesAhead(queue ?? [], claimant, now / 1000n, duration);
    flow.set({ "reservation.queue": queue?.length ?? 0, "reservation.expired_ahead": accounts.length });
    if (accounts.length === 0) return { status: "nothing" };
    logger.info("removing {count} expired reservations of {name} ahead of {claimant}", {
      count: accounts.length,
      name,
      claimant,
    });

    flow.stage("accounts");
    const provider = await withTimeout(getAccountsProvider(), HOST_TIMEOUT_MS, "The host did not respond in time.");
    if (provider == null) {
      logger.warning("expired reservation cleanup of {name} skipped: not running inside a host", { name });
      return { status: "failed", removed, detail: "not running inside a host" };
    }
    const productAccount = await withTimeout(
      provider.getProductAccount(productDomain(), 0).match(
        (value) => value,
        () => null,
      ),
      HOST_TIMEOUT_MS,
      "The host did not return the product account.",
    );
    if (productAccount == null) {
      logger.warning("expired reservation cleanup of {name} skipped: the host has no product account", { name });
      return { status: "failed", removed, detail: "the host has no product account to submit with" };
    }
    const signer = withAuthorizeCall(provider.getProductAccountSigner(productAccount));

    flow.stage("submit");
    for (const account of accounts) {
      const mortalityStart = await withTimeout(
        client.getFinalizedBlock(),
        CHAIN_TIMEOUT_MS,
        "People did not respond in time.",
      );
      const tx = api.tx.Resources.remove_expired_username_reservation({ username: key, account });
      let result;
      try {
        result = await watchTransactionSubmission(
          tx,
          signer,
          { at: mortalityStart.hash, mortality: { mortal: true, period: REMOVAL_MORTALITY_PERIOD } },
          {
            signingFailureMessage: SIGNING_FAILURE_MESSAGE,
            finalityFailureMessage: FINALITY_FAILURE_MESSAGE,
            settleOn: "bestBlock",
            onBroadcast: (txHash) => recordMutation(REMOVE_EXPIRED, "submitted", `${name} ${account} ${txHash}`),
          },
        );
      } catch (error) {
        if (await stillQueued(account)) throw error;
        result = null;
      }
      if (result == null || (result.status === "unknown" && !(await stillQueued(account)))) {
        removed += 1;
        recordMutation(REMOVE_EXPIRED, "finalized", `${name} ${account} already removed`);
        logger.info("expired reservation of {account} on {name} is already gone", { account, name });
        continue;
      }
      if (result.status === "unknown") {
        recordMutation(REMOVE_EXPIRED, "unknown", `${result.txHash} broadcast, unconfirmed`);
        logger.error("expired reservation removal of {account} from {name} unconfirmed, tx {txHash}: {detail}", {
          account,
          name,
          txHash: result.txHash,
          detail: result.detail,
        });
        return { status: "failed", removed, detail: `removal of ${account} unconfirmed (${result.txHash})` };
      }
      removed += 1;
      recordMutation(REMOVE_EXPIRED, "finalized", `${name} ${account} ${result.txHash}`);
    }
    logger.info("removed {removed} expired reservations of {name}", { removed, name });
    return { status: "cleared", removed };
  } catch (error) {
    const detail = describeError(error);
    recordMutation(REMOVE_EXPIRED, "failed", detail);
    logger.error("expired reservation cleanup of {name} stopped after {removed}: {detail}", {
      name,
      removed,
      detail,
      cause: submissionDetail(error),
    });
    return { status: "failed", removed, detail };
  }
}

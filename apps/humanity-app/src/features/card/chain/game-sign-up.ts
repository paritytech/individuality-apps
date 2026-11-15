// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The weekly game's sign-up, run from here on the flow Jollity's app runs
 * (`createSignUpFlow` of `@individuality/sign-up`). One tap, seen through
 * every gate until it lands or registration closes:
 *  - none over a sign-up Jollity has on its way (its record, which this home
 *    reads from Jollity's storage, comes in through `setRegistration`); this
 *    home writes the record of its own to its own storage, where Jollity
 *    reads it;
 *  - registration still open, and the player not registered already;
 *  - the seat: the SDK's route, the free seat's bind in the background, and
 *    the name link (`seat-name-link.ts`), which a sign-up never goes without;
 *  - the sign-up with its prize-draw entries and Jollity's draw rule
 *    (`signUpFlowChain`), retried on a backoff until it lands.
 *
 * The capabilities come from the host: the game account is `dim2.<tld>` at
 * `GAME_ACCOUNT_INDEX`, the same one the card reads and DIM2 signs at, and
 * the host signs as it under DIM2's `context` grant to this product (the root
 * `deploy/constants.ts`). The lite proof behind the bind is minted with this
 * product's own key. The flow keeps no words of a screen;
 * `use-register-for-game.ts` words it.
 */
import { paseo_individuality } from "@parity/product-sdk-descriptors/paseo-individuality";
import { createNameGate, type NameLinkResult } from "@individuality/name-link";
import { createSignUpFlow, type SignUpFlow } from "@individuality/sign-up";
import { signUpFlowChain } from "@individuality/sign-up/chain";

import { getPeopleClient } from "@humanity/shared/chain/client.ts";
import { describeError } from "@humanity/shared/chain/error-detail.ts";
import { getAccountsProvider } from "@humanity/shared/chain/host-api.ts";
import {
  hostGameRegistrationCapabilities,
  registrationRetryDelay,
} from "@humanity/shared/chain/individuality.ts";
import { CANDIDATE_PRODUCT_DOMAIN, GAME_ACCOUNT_INDEX } from "@humanity/shared/identity/game-account.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";

import { communicationIdentifier } from "./communication-key.ts";
import { ownGameRegistration } from "./game-registration-read.ts";
import { linkSeatName } from "./seat-name-link.ts";

const logger = loggerFor("card", "game-sign-up");

export interface GameSignUp {
  readonly flow: SignUpFlow;
  /** How the name link last ended, or null before it first did. */
  nameOutcome(): NameLinkResult | null;
}

/** The page's visibility, which the flow pauses its retries on. */
const page = {
  hidden: () => document.visibilityState === "hidden",
  watch: (onChange: (hidden: boolean) => void) => {
    const listener = () => onChange(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

/**
 * The sign-up of `seatAccount`, or null when this host cannot sign it up: no
 * host accounts, no capabilities, or a host that names another game account
 * than the one the card reads (the sign-up would register a seat the home
 * never shows).
 */
export async function createGameSignUp(seatAccount: string): Promise<GameSignUp | null> {
  const accounts = await getAccountsProvider();
  if (accounts == null) {
    logger.warning("no sign-up: no host accounts");
    return null;
  }
  const { client, network } = await getPeopleClient();
  const tld = network.dotnsSuffix;
  const capabilities = await hostGameRegistrationCapabilities({
    tld,
    accounts,
    accountIndex: GAME_ACCOUNT_INDEX,
  });
  if (!capabilities.ok) {
    logger.error("no sign-up: the host gave no capabilities: {detail}", {
      detail: describeError(capabilities.error),
    });
    return null;
  }
  const hostAccount = capabilities.value.account.address;
  if (hostAccount !== seatAccount) {
    logger.error("no sign-up: the host names {hostAccount} as the game account, the card reads {seatAccount}", {
      hostAccount,
      seatAccount,
    });
    return null;
  }

  let nameOutcome: NameLinkResult | null = null;
  const nameGate = createNameGate({
    link: linkSeatName,
    retryDelay: registrationRetryDelay,
    onOutcome: (outcome, failures, retryInMs) => {
      nameOutcome = outcome;
      if (retryInMs === null) logger.info("name {outcome}: Register may go", { outcome });
      else
        logger.warning("name link {outcome} ({failures} in a row), trying again in {seconds}s", {
          outcome: outcome ?? "timed out",
          failures,
          seconds: retryInMs / 1000,
        });
    },
  });

  const flow = createSignUpFlow({
    // Jollity's chain shape over this product's People client, typed by the
    // SDK's descriptors as Jollity's is.
    chain: signUpFlowChain({ client, api: client.getTypedApi(paseo_individuality) }, { tld }),
    player: seatAccount,
    capabilities: capabilities.value,
    communicationIdentifier,
    // The record of this home's sign-up, in this product's own storage, where
    // Jollity's chat and app read it as this home reads theirs.
    registrationRecord: {
      surface: "humanity",
      write: (record) =>
        ownGameRegistration.write(record).catch((error: unknown) => {
          logger.warning("the sign-up record could not be written: {detail}", { detail: describeError(error) });
        }),
    },
    nameGate,
    nowSeconds: () => Math.floor(Date.now() / 1000),
    page,
    log: (tag, message, data, level) => {
      const line = "{tag}: {message} {data}";
      const properties = { tag, message, data: data === undefined ? "" : JSON.stringify(data) };
      if (level === "error") logger.error(line, properties);
      else if (level === "warn") logger.warning(line, properties);
      else logger.info(line, properties);
    },
    warn: (message, error) => logger.warning("{message}: {detail}", { message, detail: describeError(error) }),
    describe: describeError,
    logFacts: { product: CANDIDATE_PRODUCT_DOMAIN, index: GAME_ACCOUNT_INDEX },
  });
  return { flow, nameOutcome: () => nameOutcome };
}

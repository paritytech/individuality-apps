// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Read behind the debug panel's manual `Score.register`: the configured
 *  game account and whether `Score` holds a participant under it — the
 *  account registration is signed by and the pallet reads. */
import { getPeopleClient } from "@humanity/shared/chain/client.ts";
import { describeError } from "@humanity/shared/chain/error-detail.ts";
import {
  individualityChain,
  readRegistrationEligibility,
} from "@humanity/shared/chain/individuality.ts";
import { resolveGameAccountAddress } from "@humanity/shared/identity/game-account.ts";

export interface GameAccountProbe {
  readonly address: string | null;
  /** One line on `Score.Participants[Account(address)]`. */
  readonly participant: string;
  readonly readyToRegister: boolean;
}

export async function probeGameAccount(): Promise<GameAccountProbe> {
  const address = await resolveGameAccountAddress();
  if (address == null) {
    return { address, participant: "host gave no account", readyToRegister: false };
  }
  const { api, client } = await getPeopleClient();
  const read = await readRegistrationEligibility(individualityChain(client, api), {
    registrant: { tag: "Account", accountAddress: address },
  });
  if (!read.ok) {
    return { address, participant: `read failed: ${describeError(read.error)}`, readyToRegister: false };
  }
  const { participant, personhoodThreshold, readyToRegister } = read.value;
  return {
    address,
    participant:
      participant == null
        ? "no Score participant"
        : `score ${participant.score}/${personhoodThreshold}, ` +
          `reachedPersonhood ${participant.reachedPersonhood}, ` +
          `recognition ${participant.recognition}`,
    readyToRegister,
  };
}

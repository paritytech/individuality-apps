// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { people } from "@polkadot-api/descriptors";
import type { PolkadotClient } from "polkadot-api";
import type { SnapshotAt } from "./finalized-snapshot.ts";

/** Check the live runtime against the descriptor that defines the optional constant. */
export async function usernameSigningContext(client: PolkadotClient, at?: SnapshotAt) {
  const { compat, constants } = await client.getTypedApi(people).getStaticApis(at);
  return compat.constants.Resources.SigningContext.isCompatible()
    ? constants.Resources.SigningContext
    : null;
}

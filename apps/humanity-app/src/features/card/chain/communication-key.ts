// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The communication key of this home's sign-ups (@individuality/shared-records,
 * communication-key.ts), kept in this product's own host storage: the key pair
 * of the game it signed up for, so the secret outlives the tap. A product can
 * read another's storage but never write it, so Jollity keeps the keys of its
 * sign-ups in its own storage, this home keeps its own here, and a reader
 * matches both against the identifier the chain holds.
 */
import { communicationKeyStore } from "@individuality/shared-records";
import { keptCommunicationIdentifier } from "@individuality/sign-up";

import { describeError } from "@humanity/shared/chain/error-detail.ts";
import { getHostLocalStorage } from "@humanity/shared/chain/host-api.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";

const logger = loggerFor("card", "communication-key");

/** The flow's `communicationIdentifier`: the game's kept key, or a fresh one kept first. */
export const communicationIdentifier = keptCommunicationIdentifier(
  communicationKeyStore(getHostLocalStorage),
  (message, error) => logger.warning("{message}: {detail}", { message, detail: describeError(error) }),
);

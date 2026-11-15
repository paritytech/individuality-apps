// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The People chain the sign-up reads and submits through: a papi client and
 * its typed API over the SDK descriptors at spec 3004000.
 *
 * Types only. Each surface connects its own client (through the host, or over
 * a chat worker's provider) and hands it in.
 */
import type { PolkadotClient, TypedApi } from "polkadot-api"
import type { paseo_individuality } from "@parity/product-sdk-descriptors/paseo-individuality"

export type PeopleApi = TypedApi<typeof paseo_individuality>

export interface PeopleClient {
  /** raw papi client — block subscriptions, `submitAndWatch`, `destroy()` */
  client: PolkadotClient
  /** typed API (`api.query.Game...`, `api.tx.Game...`) */
  api: PeopleApi
}

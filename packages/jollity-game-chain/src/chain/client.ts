// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Connects a PAPI client to the individuality People chain.
 *
 * The descriptors come from `@parity/product-sdk-descriptors`, pinned to spec
 * 3004000 in the same release as `@parity/product-sdk-individuality`, so the
 * typed API and the SDK reads over it cannot drift apart.
 *
 * Paseo and previewnet run the same runtime, code hash `0x69e7126f…`, and the
 * two descriptor sets carry the same checksums, so the paseo one serves both.
 */
import {
  createClient,
  type JsonRpcProvider,
  type PolkadotClient,
  type TypedApi,
} from "polkadot-api"
import { getWsProvider } from "polkadot-api/ws"
import { paseo_individuality } from "@parity/product-sdk-descriptors/paseo-individuality"

/** Public WS endpoint of the preview People chain (para 1502) */
export const PREVIEW_PEOPLE_WS = "wss://previewnet.substrate.dev/people"

export type PeopleApi = TypedApi<typeof paseo_individuality>

export interface PeopleClient {
  /** raw papi client — block subscriptions, `_request` for statement RPCs, `destroy()` */
  client: PolkadotClient
  /** typed API (`api.query.Game...`, `api.tx.Game...`) */
  api: PeopleApi
}

export type WsConnectionStatus = "connecting" | "connected" | "error" | "closed"

/**
 * Same as {@link createPeopleClient}, but over a caller-supplied provider —
 * e.g. a host-bridge provider when running inside a truapi container. Core
 * stays transport-agnostic; who supplies the provider decides where the
 * connection lives.
 */
export function createPeopleClientFromProvider(
  provider: JsonRpcProvider,
): PeopleClient {
  const client = createClient(provider)
  const api = client.getTypedApi(paseo_individuality)
  return { client, api }
}

/** Connects a People-chain client over a WebSocket (the preview chain by default), typed with the SDK's descriptors. */
export function createPeopleClient(
  wsUrl: string = PREVIEW_PEOPLE_WS,
  onStatusChange?: (status: WsConnectionStatus) => void,
): PeopleClient {
  const provider = getWsProvider(wsUrl, {
    onStatusChanged: (status) => {
      const name = (
        {
          CONNECTING: "connecting",
          CONNECTED: "connected",
          ERROR: "error",
          CLOSE: "closed",
        } as const
      )[status.type]
      onStatusChange?.(name ?? "closed")
    },
  })
  const client = createClient(provider)
  const api = client.getTypedApi(paseo_individuality)
  return { client, api }
}

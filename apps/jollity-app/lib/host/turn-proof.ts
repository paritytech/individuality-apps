// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Builds the personhood proof that buys TURN credentials.
 *
 * The proof itself is the shared `buildTurnProof` of @jollity/protocol, which
 * the chat calls too. This module finds the host, the People genesis and the
 * personhood keys for it (the SDK's `hostPersonhoodProver`), and logs what
 * came of it.
 *
 * This is the only module that asks the SDK for a proof, per architecture
 * rule 5. The mesh receives a plain body and never sees a key handle.
 */
import { blake2b } from "@noble/hashes/blake2.js"
import {
  buildTurnProof,
  localNetwork,
  freshnessMessage as sharedFreshnessMessage,
  type TurnProofCode,
  type TurnProofResult,
} from "@jollity/protocol"
import { devLog } from "../debug/log-store"
import { describeError } from "./error-detail"

export type { TurnProofBody, TurnProofCode, TurnProofResult } from "@jollity/protocol"

export const blake2b256 = (bytes: Uint8Array) => blake2b(bytes, { dkLen: 32 })

/** Logs a refusal and returns it as the result: the log line and the reason agree. */
const fail = (code: TurnProofCode, reason: string, detail?: Record<string, unknown>): { reason: string; code: TurnProofCode } => {
  devLog("turnproof", reason, detail, "error")
  return { reason, code }
}

/** Derives the message a proof covers, the one value both sides must agree on. */
export function freshnessMessage(timestamp: number): Uint8Array {
  return sharedFreshnessMessage(timestamp, blake2b256)
}

/**
 * Builds the request body, or says why this device cannot prove.
 *
 * No proof is an ordinary outcome rather than an error. There may be no host, no
 * registered key for the ring, or a host that refuses. A person with no ring
 * membership has no proof to give, and the mesh falls back to STUN.
 */
export async function turnProofBody(
  productId: string,
  /** the second to stamp the proof with: the issuer rejects one more than 60 s from ITS clock, so the caller passes corrected time (lib/webrtc/ice.ts), never the raw phone clock */
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<TurnProofResult> {
  try {
    const sdk = await import("@parity/product-sdk-host")
    if (!sdk.isInsideContainerSync()) return { reason: "not inside a host", code: "no-host" }
    const individuality = await import("@parity/product-sdk-individuality")

    const local = localNetwork()
    const discovery = local ? undefined : await sdk.getHostChainInfo(["People"] as never)
    const genesis = local?.genesis.people ?? (discovery?.chains as Record<string, string> | undefined)?.People
    if (!genesis) return fail("no-chain-info", "no People genesis from the host")

    const accounts = await sdk.getAccountsProvider()
    if (!accounts) return fail("no-accounts", "no accounts provider")
    const { hostPersonhoodProver } = await import("@parity/product-sdk-individuality/host")

    const result = await buildTurnProof(
      hostPersonhoodProver(accounts),
      {
        productId,
        genesis: genesis as `0x${string}`,
        timestamp,
        collectionId: individuality.ringCollectionId,
        hash: blake2b256,
        describe: describeError,
      },
    )
    if ("code" in result) return fail(result.code, result.reason, result.detail === undefined ? undefined : { detail: result.detail })
    devLog("turnproof", `proved in the ${result.ring} ring`, { ringIndex: result.body.ringIndex, ringRevision: result.body.ringRevision })
    return { body: result.body }
  } catch (error) {
    const detail = describeError(error)
    return fail("proof-threw", `proof unavailable: ${detail}`, { detail })
  }
}

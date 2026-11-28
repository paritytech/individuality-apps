// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * SETTLE A BOT'S dotNS USERNAME CLAIM (issue #697).
 *
 * A lite person's username is minted as a PENDING claim on the DotnsPopController (Asset Hub; the same address on
 * previewnet and paseo-next-v2). The host ignores a pending claim older than reservationDuration (7 days), so a bot
 * minted a week ago loses its username and breaks. `settlePendingClaims(user, limit)` is callable by anyone: it
 * deploys the user's label store and writes the claim for good. new-identity.mts calls it right after minting
 * (and `--settle <username>` re-runs it for older bots), so a new bot never reaches the lapse.
 *
 * COST per name: about 0.43 PAS storage deposit plus about 0.06 PAS fee, paid by a PUBLIC dev account (the Alice of
 * each network's dev seed), never by the bot. The submit is a Revive.call extrinsic.
 *
 * The pure parts (payer, storage key, address, calldata, dry-run reading) are exported and unit-tested; settleClaim is
 * the only function that touches a chain. It dry-runs first (a read-only ReviveApi_call): 0 settled means nothing is
 * pending, which is success and submits nothing.
 */
import { createClient, AccountId } from "polkadot-api"
import { getWsProvider } from "polkadot-api/ws"
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common"
import { getTxCreator } from "polkadot-api/tx-creator"
import { sr25519CreateDerive } from "@polkadot-labs/hdkd"
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers"
import { keccak_256 } from "@noble/hashes/sha3.js"
import { Blake2128, Twox128, decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings"
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders"
import { NETWORKS } from "../lib/host-slot.mjs"

type Network = keyof typeof NETWORKS

/** DotnsPopController: the same address on previewnet and paseo-next-v2. */
const CONTROLLER = "0xcc932348606cc1f3318cadec5a5cd2ca447f8a4b"
/** How many pending claims one call may settle (one bot holds one). */
export const SETTLE_LIMIT = 16n
const PAS = 1e10
const WEIGHT_LIMIT = { ref_time: 17_000_000_000n, proof_size: 1_200_000n }
const STORAGE_DEPOSIT_LIMIT = 10_000_000_000n

const enc = new TextEncoder()
export const hex = (b: Uint8Array): string => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
export const unhex = (h: string): Uint8Array => Uint8Array.from((h.replace(/^0x/, "").match(/../g) ?? []).map((x) => parseInt(x, 16)))
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
const word = (n: bigint): Uint8Array => {
  const w = new Uint8Array(32)
  let v = n
  for (let i = 31; i >= 0; i--) {
    w[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return w
}

/** The public dev account that pays, with the address it must derive to (a wrong seed is caught before any signing). */
export function settlePayer(network: Network): { derivation: string; expected: string } {
  return network === "previewnet"
    ? { derivation: "//Alice", expected: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" }
    : { derivation: "", expected: "5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV" }
}

/** Storage key of DotnsGateway.LiteLabelOwner[label]: the label is a SCALE string (one-byte compact length), hashed blake2_128_concat. */
export function labelOwnerKey(label: string): string {
  if (label.length > 63) throw new Error(`label "${label}" is too long for a one-byte compact length`)
  const encoded = cat(Uint8Array.of(label.length << 2), enc.encode(label))
  return hex(cat(Twox128(enc.encode("DotnsGateway")), Twox128(enc.encode("LiteLabelOwner")), Blake2128(encoded), encoded))
}

/** The user's H160: the last 20 bytes of keccak256 of the 32-byte account that ends the LiteLabelOwner value. */
export function h160FromOwner(storageValue: string): Uint8Array {
  return keccak_256(unhex(storageValue).slice(-32)).slice(12)
}

/** settlePendingClaims(address,uint256) calldata: selector, the H160 left-padded to a word, the limit. */
export function settleCalldata(h160: Uint8Array): Uint8Array {
  const selector = keccak_256(enc.encode("settlePendingClaims(address,uint256)")).slice(0, 4)
  return cat(selector, new Uint8Array(12), h160, word(SETTLE_LIMIT))
}

interface DryRunResult {
  success: boolean
  value: unknown
}
const show = (value: unknown): string => JSON.stringify(value, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof Uint8Array ? hex(x) : x)).slice(0, 200)

/** How many claims the dry-run would settle: the first return word. A failure or a revert (flags bit 0) throws. */
export function settledByDryRun(result: DryRunResult): number {
  const value = result.value as { flags: number; data: Uint8Array }
  if (!result.success || value.flags & 1) throw new Error(`settlePendingClaims dry-run failed: ${show(result)}`)
  return Number(BigInt(hex(value.data.slice(0, 32))))
}

/** The one unsafe-API path this module submits, typed as far as it is used. */
interface ReviveTxApi {
  tx: { Revive: { call(args: object): { createAndSubmit(signer: CommonSignerTxCreator): Promise<{ ok: boolean; txHash: string; block: { number: number }; dispatchError?: unknown; events: { value?: { type?: string } }[] }> } } }
}

export interface SettleOutcome {
  /** claims the call settles (dry-run) or settled (submitted); 0 = nothing was pending */
  settled: number
  /** the storage deposit the dry-run reports, in PAS */
  depositPas: number
  /** set only when a transaction was submitted */
  txHash?: string
}

/** Settle `username`'s pending claim on `network`'s Asset Hub. `submit: false` stops after the read-only dry-run. */
export async function settleClaim(network: Network, username: string, { submit }: { submit: boolean }): Promise<SettleOutcome> {
  const { derivation, expected } = settlePayer(network)
  const keypair = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)))(derivation)
  const payer = AccountId().dec(keypair.publicKey)
  if (payer !== expected) throw new Error(`settle payer ${payer} is not the expected ${expected}`)
  const client = createClient(getWsProvider(NETWORKS[network].assetHubWs))
  try {
    const request = (method: string, params: unknown[]) => client._request(method, params) as Promise<string | null>
    const ownerValue = await request("state_getStorage", [labelOwnerKey(username)])
    if (!ownerValue) throw new Error(`${username} has no LiteLabelOwner on ${network}: not a lite username of this network`)
    const data = settleCalldata(h160FromOwner(ownerValue))

    // the runtime call's codec comes from the chain's own metadata (v16)
    const metadata = (await request("state_call", ["Metadata_metadata_at_version", "0x10000000"])) as string
    const reviveCall = getDynamicBuilder(getLookupFn(unifyMetadata(decAnyMetadata("0x" + metadata.slice(metadata.indexOf("6d657461")))))).buildRuntimeCall("ReviveApi", "call")
    // ReviveApi_call(origin, dest, value, gas_limit None, storage_deposit_limit None, input)
    const compactLength = (data.length << 2) | 1
    const params = cat(keypair.publicKey, unhex(CONTROLLER), new Uint8Array(16), Uint8Array.of(0, 0), Uint8Array.of(compactLength & 0xff, compactLength >> 8), data)
    const dry = reviveCall.value.dec((await request("state_call", ["ReviveApi_call", hex(params)])) as string) as { result: DryRunResult; storage_deposit: { type: "Charge" | "Refund"; value: bigint } }
    const settled = settledByDryRun(dry.result)
    // StorageDeposit is Charge or Refund; a refund is money back, so it reads negative.
    const depositPas = (dry.storage_deposit.type === "Refund" ? -1 : 1) * Number(dry.storage_deposit.value) / PAS
    if (settled === 0 || !submit) return { settled, depositPas }

    const api = client.getUnsafeApi() as unknown as ReviveTxApi
    const tx = api.tx.Revive.call({ dest: CONTROLLER, value: 0n, weight_limit: WEIGHT_LIMIT, storage_deposit_limit: STORAGE_DEPOSIT_LIMIT, data })
    const r = await tx.createAndSubmit(getTxCreator(keypair.publicKey, "Sr25519", keypair.sign))
    const failed = r.events.filter((e) => ["BatchInterrupted", "ExtrinsicFailed"].includes(e.value?.type ?? ""))
    if (!r.ok || failed.length) throw new Error(`settlePendingClaims for ${username} failed in block #${r.block.number}: ${r.dispatchError ? show(r.dispatchError) : "ExtrinsicFailed"}`)
    return { settled, depositPas, txHash: r.txHash }
  } finally {
    client.destroy()
  }
}

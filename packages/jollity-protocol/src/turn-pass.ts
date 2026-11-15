// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The TURN pass the app and the chat share: the personhood proof that buys
 * it, its redemption at the issuer, and its record in host storage.
 *
 * Products use `/issue-with-proof` on the issuer, described in
 * device-uniqueness-backend `crates/turn/src/http.rs`. It takes a ring-VRF
 * proof instead of a token, so the proof is the authorization. Both sides
 * derive the proved message rather than exchanging it:
 * `blake2b256("dub/turn-credential/v1" ++ timestamp_be_u64)`, accepted inside
 * a clock skew of 60 s. There is deliberately no nonce. Ring-VRF proofs are
 * deterministic, so one person and one second yield one fixed value.
 *
 * Either side may fetch a pass and both read it from `turnPassKey`, so the
 * chat can have one ready before the app opens. It lives in the protocol
 * because the worker bundle takes only what QuickJS runs.
 * The personhood keys, the hash, the ring collection ids and the fetch are
 * injected, and the SDK is imported for its types alone.
 */
import type { PersonhoodProver, PersonhoodRing } from "@parity/product-sdk-individuality"

/**
 * The storage key of the pass of one player, which the app and the chat both read and write.
 *
 * The account keeps the relay secret of one player from another on a shared phone.
 */
export const turnPassKey = (product: string, account: Uint8Array, issuers: readonly string[]): string =>
  `jollity.turn.v1:${product}:${hex(account).slice(2)}:${issuers.join(",")}`

/** Seconds before its expiry that a pass is let go, as the native `EXPIRY_BUFFER_SECONDS`. */
export const TURN_EXPIRY_BUFFER_S = 5

/** The answer of the issuer to a proof, per `proof_routes.rs`. */
export interface TurnCredentials {
  servers: string[]
  username: string
  password: string
  ttl: number
}

/** One relay of a pass, in the shape of `RTCIceServer`. */
export interface TurnServer {
  urls: string | string[]
  username?: string
  credential?: string
}

/**
 * Relay credentials kept in storage.
 *
 * The expiry is a wall clock stamp, because it outlives the page and the
 * worker that wrote it. It already takes off the buffer the pass is let go by.
 */
export interface TurnPass {
  turn: TurnServer[]
  expiresAtWallMs: number
}

/** What `/issue-with-proof` expects, per `proof_routes.rs`. */
export interface TurnProofBody {
  productId: string
  collection: string
  proof: string
  ringIndex: number
  ringRevision: number
  timestamp: number
}

/**
 * Which step stopped the proof.
 *
 * Each names a different thing to fix. `no-ring-key` is a host that
 * registered no personhood ring key. `grant-missing` is the host refusing the
 * key of `peopl.<tld>` because its `trustedProducts` grant does not name this
 * product. `proof-refused` is any other refusal of the host to prove, with its
 * text in the reason. `no-host`, `no-chain-info` and `no-accounts` on a hosted
 * origin point at a client too old for the call.
 */
export type TurnProofCode =
  | "no-host"
  | "no-chain-info"
  | "no-accounts"
  | "key-list-failed"
  | "no-ring-key"
  | "proof-refused"
  | "proof-threw"
  | "grant-missing"

/** The personhood ring a proof was made in. */
export type TurnProofRing = "people-lite" | "people"

/**
 * A proof, or why there is none, in words an operator can act on.
 *
 * A refusal keeps the words of the host in `reason`, and `detail` holds them
 * alone for a log line.
 */
export type TurnProofResult =
  | { body: TurnProofBody; ring?: TurnProofRing }
  | { reason: string; code: TurnProofCode; detail?: string }

/** What a proof needs besides the personhood keys. */
export interface TurnProofInputs {
  productId: string
  genesis: `0x${string}`
  /** The second the proof is stamped with, on a clock the issuer agrees with. */
  timestamp: number
  collectionId: (name: TurnProofRing) => Uint8Array
  hash: (bytes: Uint8Array) => Uint8Array
  describe?: (error: unknown) => string
}

/** Why the issuer gave no pass, one value per thing that needs a different fix. */
export type TurnIssueCause =
  | "timestamp-window"
  | "bad-request"
  | "proof-rejected"
  | "no-route"
  | "redemption-limit"
  | "no-ring-roots"
  | "server-error"

/** A redemption that gave no pass. */
export interface TurnRedeemRefusal {
  cause: TurnIssueCause | "timeout"
  status?: number
  reason: string
}

export type TurnRedeemResult = { credentials: TurnCredentials } | TurnRedeemRefusal

/** The slice of an HTTP answer a redemption reads. */
export interface TurnIssuerAnswer {
  status: number
  json(): Promise<unknown>
  text?(): Promise<string>
}

export type TurnFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<TurnIssuerAnswer>

export const TURN_ISSUE_PATH = "/api/v1/turn/issue-with-proof"

/** Domain separator, byte for byte with the issuer in `proof/message.rs`. */
const LABEL = "dub/turn-credential/v1"

const TIMESTAMP_WINDOW = /timestamp.*(window|outside|skew)/i
const REDEEM_TIMEOUT_MS = 5_000
const REASON_READ_MS = 1_000
const REASON_MAX_CHARS = 1_000
const NO_REASON = "no reason given"

export const hex = (bytes: Uint8Array): `0x${string}` => `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`

/** Derives the message a proof covers, the one value both sides must agree on. */
export function freshnessMessage(timestamp: number, hash: (bytes: Uint8Array) => Uint8Array): Uint8Array {
  const label = new TextEncoder().encode(LABEL)
  const stamp = new Uint8Array(8)
  new DataView(stamp.buffer).setBigUint64(0, BigInt(timestamp), false)
  const message = new Uint8Array(label.length + stamp.length)
  message.set(label)
  message.set(stamp, label.length)
  return hash(message)
}

/** Names a refusal to prove, `grant-missing` when the host says the grant does not allow this product. */
export const proofRefusalCode = (detail: string): TurnProofCode => (/NotAllowlisted/.test(detail) ? "grant-missing" : "proof-refused")

/** A prover that did not prove: the host's refusal (the words both provers
 *  give it), or a call that threw before the host answered. */
const proveFailureCode = (error: unknown, detail: string): TurnProofCode =>
  error instanceof Error && /the host refused/.test(error.message) ? proofRefusalCode(detail) : "proof-threw"

/**
 * Builds the request body, or says why these keys cannot prove.
 *
 * The key is the one `peopl.<tld>` owns, since a host stores a key only under
 * the product that registered it. Both collections are tried, because a full
 * person need not hold a lite membership. `prover` is the SDK's
 * `PersonhoodProver` (`hostPersonhoodProver` of its `/host` entry, or the
 * chat's own over the same host calls): it finds the key under whichever
 * shape the host holds the ring in.
 */
export async function buildTurnProof(prover: PersonhoodProver, inputs: TurnProofInputs): Promise<TurnProofResult> {
  const describe = inputs.describe ?? String
  try {
    const owner = `peopl.${inputs.productId.split(".").slice(1).join(".")}`
    const rings: TurnProofRing[] = ["people-lite", "people"]
    for (const name of rings) {
      const collection = hex(inputs.collectionId(name))
      const ring: PersonhoodRing = {
        owner,
        key: name === "people-lite" ? "lite" : "full",
        ring: { chainId: inputs.genesis, junctions: [{ tag: "CollectionId", value: collection }] },
      }
      let held: boolean
      try {
        held = await prover.holds(ring)
      } catch (error) {
        const detail = describe(error)
        return { code: "key-list-failed", reason: `could not look up the ${owner} keys: ${detail}`, detail }
      }
      if (!held) continue
      let proof: Awaited<ReturnType<PersonhoodProver["prove"]>>
      try {
        proof = await prover.prove(
          ring,
          { productId: inputs.productId, suffix: { tag: "Index", value: 0 } },
          freshnessMessage(inputs.timestamp, inputs.hash),
        )
      } catch (error) {
        const detail = describe(error)
        const code = proveFailureCode(error, detail)
        return { code, reason: code === "proof-threw" ? `proof unavailable: ${detail}` : `refused (${name}): ${detail}`, detail }
      }
      return {
        body: {
          productId: inputs.productId,
          collection,
          proof: hex(proof.proof),
          ringIndex: proof.ringIndex,
          ringRevision: proof.ringRevision,
          timestamp: inputs.timestamp,
        },
        ring: name,
      }
    }
    return { code: "no-ring-key", reason: `no ${owner} key for either personhood ring` }
  } catch (error) {
    const detail = describe(error)
    return { code: "proof-threw", reason: `proof unavailable: ${detail}`, detail }
  }
}

/** Names a refusal of the issuer by its status, and a 400 by whether its reason names the timestamp window. */
export function turnIssueCause(status: number, reason: string | undefined): TurnIssueCause {
  if (status === 400) return TIMESTAMP_WINDOW.test(reason ?? "") ? "timestamp-window" : "bad-request"
  if (status === 403) return "proof-rejected"
  if (status === 404) return "no-route"
  if (status === 429) return "redemption-limit"
  if (status === 503) return "no-ring-roots"
  return status >= 500 ? "server-error" : "bad-request"
}

/** True for an answer of the issuer that holds credentials. */
export function isTurnCredentials(value: unknown): value is TurnCredentials {
  if (!value || typeof value !== "object") return false
  const answer = value as Record<string, unknown>
  return (
    Array.isArray(answer.servers) &&
    answer.servers.every((server) => typeof server === "string") &&
    typeof answer.username === "string" &&
    typeof answer.password === "string" &&
    typeof answer.ttl === "number"
  )
}

/** True for a pass read back from storage, whoever wrote it. */
export function isTurnPass(value: unknown): value is TurnPass {
  if (!value || typeof value !== "object") return false
  const pass = value as Partial<TurnPass>
  return (
    Array.isArray(pass.turn) &&
    pass.turn.every(
      (server: unknown) =>
        server !== null &&
        typeof server === "object" &&
        (typeof (server as TurnServer).urls === "string" || Array.isArray((server as TurnServer).urls)),
    ) &&
    typeof pass.expiresAtWallMs === "number" &&
    Number.isFinite(pass.expiresAtWallMs)
  )
}

/** The pass for credentials the issuer just gave, stamped from the wall clock of the device. */
export function turnPassFor(credentials: TurnCredentials, nowWallMs: number): TurnPass {
  return {
    turn: credentials.servers.map((urls) => ({ urls, username: credentials.username, credential: credentials.password })),
    expiresAtWallMs: nowWallMs + Math.max(0, credentials.ttl - TURN_EXPIRY_BUFFER_S) * 1000,
  }
}

/** Milliseconds a pass still has before it is let go, below zero once it has been. */
export function turnPassLeftMs(pass: TurnPass, nowWallMs: number): number {
  return pass.expiresAtWallMs - nowWallMs
}

const TIMED_OUT = Symbol("timed-out")

function deadline<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/** The reason of a refusal, raw: the `error` of a JSON body, else the text. Never throws and never waits long. */
async function refusalReason(answer: TurnIssuerAnswer): Promise<string | undefined> {
  try {
    if (!answer.text) return undefined
    const read = await deadline(answer.text(), REASON_READ_MS)
    const text = read === TIMED_OUT ? undefined : read.slice(0, REASON_MAX_CHARS)
    if (!text) return undefined
    try {
      const error = (JSON.parse(text) as { error?: unknown } | null)?.error
      return typeof error === "string" ? error : text
    } catch {
      return text
    }
  } catch {
    return undefined
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Posts a proof to the issuer once and reads its answer.
 *
 * It never throws and never waits past `timeoutMs` for the answer or its
 * body. The caller decides on retries.
 */
export async function redeemTurnProof(
  fetch: TurnFetch,
  base: string,
  body: TurnProofBody,
  timeoutMs: number = REDEEM_TIMEOUT_MS,
): Promise<TurnRedeemResult> {
  try {
    const answer = await deadline(
      fetch(`${base}${TURN_ISSUE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      timeoutMs,
    )
    if (answer === TIMED_OUT) return { cause: "timeout", reason: `no answer in ${timeoutMs}ms` }
    const { status } = answer
    if (status !== 200 && status !== 201) {
      const reason = await refusalReason(answer)
      return { cause: turnIssueCause(status, reason), status, reason: reason ?? NO_REASON }
    }
    const data = await deadline(answer.json(), timeoutMs)
    if (data === TIMED_OUT) return { cause: "timeout", status, reason: `no body in ${timeoutMs}ms` }
    if (!isTurnCredentials(data)) return { cause: "server-error", status, reason: "unexpected response shape" }
    return { credentials: data }
  } catch (error) {
    return { cause: "server-error", reason: messageOf(error) }
  }
}

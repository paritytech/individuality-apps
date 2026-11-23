// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The communication key of this product's sign-ups (@individuality/shared-records,
 * communication-key.ts), kept in this product's host storage before the
 * sign-up goes out. It is derived from the host's entropy and the game as the
 * chat derives it (`COMMUNICATION_ENTROPY_CONTEXT`), so the app and the chat
 * send the same key for a game and a race between them cannot leave a secret
 * nobody kept. A host that gives no entropy, or a sign-up with no game read
 * yet, gets a random key, kept the same way. Humanity keeps the keys of its own
 * sign-ups in its own storage; a reader matches both against the chain.
 *
 * In the game the key's secret is what the signalling is sealed with
 * (`signallingSecret`): the one of the kept keys, or of the key the entropy
 * derives for the game, whose public half is the identifier on chain.
 */
import {
  communicationKeyStore,
  matchCommunicationKey,
  toHex,
  type CommunicationKey,
} from "@individuality/shared-records"
import {
  communicationKeyFrom,
  communicationKeyRecord,
  freshCommunicationKey,
  keptCommunicationIdentifier,
  soundCommunicationKey,
  type CommunicationKeyPair,
} from "@individuality/sign-up"
import { COMMUNICATION_ENTROPY_CONTEXT, type GameEngine } from "@jollity/protocol"
import { devLog } from "../debug/log-store"
import { withTimeout } from "../with-timeout"
import { describeError, HostReadRefused } from "./error-detail"
import { humanityStorage } from "./game-registration"
import { hostStorage } from "./storage"

const warn = (message: string, error: unknown) => devLog("signup", message, { detail: describeError(error) }, "warn")

/** each read of the signalling-secret lookup gives up after this: a host read
 *  can hang (game-registration.ts bounds the same reads), and the four reads
 *  in a row (the identifier on chain, the kept keys, the game, the entropy)
 *  stay inside the transport's 15 s lookup timeout, the SDK's import aside */
const READ_TIMEOUT_MS = 3_500

/** How one read of a kept key went. */
export type KeyRead = "answered" | "refused" | "failed" | "no-answer"

/** Why this player's own key was (not) found, decided in this order: no
 *  identifier on chain (and no read hung), a match, Humanity's read refused,
 *  a read that gave no answer or failed, and else no kept key matches. A refusal wins
 *  over no match because it is why nothing could match. */
export type OwnKeyCause = "found" | "no-identifier" | "read-refused" | "no-answer" | "no-match"

/** Which candidate matched: this product's kept key, Humanity's, or the one
 *  the host's entropy derives for the game. */
export type OwnKeySource = "jollity" | "humanity" | "derived"

export interface OwnKeyLookup {
  secret: Uint8Array | null
  cause: OwnKeyCause
  source?: OwnKeySource
  /** how the reads of the kept keys went; absent when they were not made (no identifier, or a key already found) */
  reads?: { own: KeyRead; humanity: KeyRead }
  /** the host's words for Humanity's refusal, when it refused */
  refusal?: string
}

/** one signalling-secret lookup: whether any of its reads gave no answer, and
 *  how the reads of the kept keys went */
type Lookup = { hung: boolean; reads: { own: KeyRead; humanity: KeyRead }; refusal?: string }

/** The read's answer as `{ value }`, or null once READ_TIMEOUT_MS have passed:
 *  logged as a read that gave no answer, and marked on the lookup. A rejection
 *  passes. */
async function answerOf<T>(lookup: Lookup, what: string, read: PromiseLike<T>): Promise<{ value: T } | null> {
  const answer = await withTimeout(Promise.resolve(read).then((value) => ({ value })), READ_TIMEOUT_MS)
  if (answer) return answer
  lookup.hung = true
  devLog("signup", `${what} gave no answer in ${READ_TIMEOUT_MS} ms`, undefined, "warn")
  return null
}

/** The read's answer, or null once READ_TIMEOUT_MS have passed (see `answerOf`). */
async function bounded<T>(lookup: Lookup, what: string, read: PromiseLike<T>): Promise<T | null> {
  return (await answerOf(lookup, what, read))?.value ?? null
}

/** The key the host's entropy derives for the game, or null when it gives
 *  none (or, within a `lookup`, no answer in time). */
async function entropyKey(gameIndex: number, lookup?: Lookup): Promise<CommunicationKeyPair | null> {
  try {
    const { deriveEntropy } = await import("@parity/product-sdk-host")
    const asked = deriveEntropy(COMMUNICATION_ENTROPY_CONTEXT)
    const entropy = lookup ? await bounded(lookup, "the host's entropy", asked) : await asked
    if (!entropy) return null
    if (entropy.ok) return communicationKeyFrom(entropy.value, gameIndex)
    warn("the host gave no entropy for the communication key", entropy.error)
  } catch (error) {
    // the call itself failed: no answer, not a key that is missing
    if (lookup) lookup.hung = true
    warn("the host gave no entropy for the communication key", error)
  }
  return null
}

async function makeKey(gameIndex: number | undefined) {
  return (gameIndex === undefined ? null : await entropyKey(gameIndex)) ?? freshCommunicationKey()
}

const ownKeys = communicationKeyStore(() => hostStorage())
const humanityKeys = communicationKeyStore(humanityStorage)

/** The flow's `communicationIdentifier`: the game's kept key, or one made and kept first. */
export const communicationIdentifier = keptCommunicationIdentifier(ownKeys, warn, makeKey)

/** One kept key, or null; how the read went is marked on the lookup. */
async function read(lookup: Lookup, which: "own" | "humanity", what: string, keys: Promise<CommunicationKey | null>) {
  try {
    const answer = await answerOf(lookup, `${what} communication key`, keys)
    lookup.reads[which] = answer ? "answered" : "no-answer"
    return answer?.value ?? null
  } catch (error) {
    if (error instanceof HostReadRefused) {
      lookup.reads[which] = "refused"
      lookup.refusal = error.reason
    } else lookup.reads[which] = "failed"
    warn(`${what} communication key could not be read`, error)
    return null
  }
}

/** identifier → its secret and where it came from, once found. Only a found
 *  one is kept: a lookup still running is not, so one that hangs (a host read
 *  that never answers) is not handed to the transport's next try, which would
 *  hang with it */
const secrets = new Map<string, { secret: Uint8Array; source: OwnKeySource }>()

/**
 * The secret this player's signalling is sealed with: of this product's kept
 * key, Humanity's and the one the entropy derives for the current game, the
 * one whose public half is the player's identifier on chain. Null when the
 * player has none on chain or no key matches it (a sign-up whose key was never
 * kept): then the transport links with nobody rather than in the clear. Kept
 * once found per identifier; a miss, or a lookup the transport gave up on, is
 * looked up afresh on its next try.
 */
export async function signallingSecret(player: string, engine: Pick<GameEngine, "communicationIdentifier" | "game">) {
  return (await lookUpSignallingSecret(player, engine)).secret
}

/** `signallingSecret`, with why it was or was not found (`OwnKeyCause`). */
export async function lookUpSignallingSecret(
  player: string,
  engine: Pick<GameEngine, "communicationIdentifier" | "game">,
): Promise<OwnKeyLookup> {
  const lookup: Lookup = { hung: false, reads: { own: "no-answer", humanity: "no-answer" } }
  const onChain = await bounded(lookup, "the communication identifier on chain", engine.communicationIdentifier(player))
  if (!onChain) {
    if (lookup.hung) return { secret: null, cause: "no-answer" }
    devLog("signup", "no communication identifier on chain for this player", undefined, "warn")
    return { secret: null, cause: "no-identifier" }
  }
  const id = toHex(onChain)
  const known = secrets.get(id)
  if (known) return { secret: known.secret, cause: "found", source: known.source }
  const found = await findSecret(onChain, engine, lookup)
  const reads = { ...lookup.reads }
  const refusal = lookup.refusal === undefined ? {} : { refusal: lookup.refusal }
  if (found) {
    secrets.set(id, found)
    return { secret: found.secret, cause: "found", source: found.source, reads, ...refusal }
  }
  // a read that failed says no more than one that hung: only a refusal, or
  // every read answered, is a definite miss
  const failed = reads.own === "failed" || reads.humanity === "failed"
  const cause: OwnKeyCause = reads.humanity === "refused" ? "read-refused" : lookup.hung || failed ? "no-answer" : "no-match"
  return { secret: null, cause, reads, ...refusal }
}

async function findSecret(
  onChain: Uint8Array,
  engine: Pick<GameEngine, "game">,
  lookup: Lookup,
): Promise<{ secret: Uint8Array; source: OwnKeySource } | null> {
  // every candidate is checked, not just the first whose public half matches:
  // a kept record is only as sound as the storage it came from, and a corrupt
  // one must not hide a sound one behind it
  const sound = (key: CommunicationKey | null) => {
    const match = key ? matchCommunicationKey([key], onChain) : null
    return match ? soundCommunicationKey(match) : null
  }
  const [own, humanity] = await Promise.all([
    read(lookup, "own", "this product's", ownKeys.read()),
    read(lookup, "humanity", "Humanity's", humanityKeys.read()),
  ])
  for (const [key, source] of [[own, "jollity"], [humanity, "humanity"]] as const) {
    const pair = sound(key)
    if (pair) return { secret: pair.secret, source }
  }
  const gameIndex = (
    await bounded(lookup, "the game read", engine.game()).catch(() => {
      lookup.hung = true // a game read that failed gave no answer
      return null
    })
  )?.index
  const derived = gameIndex === undefined ? null : await entropyKey(gameIndex, lookup)
  const pair = derived ? sound(communicationKeyRecord(gameIndex!, derived)) : null
  if (pair) return { secret: pair.secret, source: "derived" }
  // a read that gave no answer is a hang, not a key that is missing
  if (lookup.hung) devLog("signup", "no key found for the communication identifier: a host read gave no answer", undefined, "warn")
  else warn("no kept key matches the communication identifier on chain", toHex(onChain))
  return null
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The communication key a sign-up registers: a P-256 key pair whose public
 * half, 65 bytes in the raw (SEC1 uncompressed) form the chain stores, is how
 * co-players reach the player, and whose secret the surface keeps
 * (@individuality/shared-records, communication-key.ts) so it can read them.
 *
 * Two ways to make one. A surface with storage makes a random key once per game
 * and keeps it before sending it (`keptCommunicationIdentifier`), so every retry
 * of that game sends the same identifier and the kept secret is the one that
 * lands. The
 * chat's QuickJS has no WebCrypto, so it derives one from the host's entropy
 * and the game (`communicationKeyFrom`), which a retry in the same game
 * derives again.
 */
import {
  COMMUNICATION_KEY_VERSION,
  fromHex,
  toHex,
  type CommunicationKey,
  type CommunicationKeyStore,
} from "@individuality/shared-records"
import { p256 } from "@noble/curves/nist.js"
import { sha256 } from "@noble/hashes/sha2.js"

export interface CommunicationKeyPair {
  /** The raw public key the chain stores. */
  publicKey: Uint8Array
  /** The 32-byte secret. */
  secret: Uint8Array
}

/** A random key pair. */
export function freshCommunicationKey(): CommunicationKeyPair {
  const secret = p256.utils.randomSecretKey()
  return { secret, publicKey: p256.getPublicKey(secret, false) }
}

/** The key pair derived from `entropy` and the game, the same for every sign-up of one game. */
export function communicationKeyFrom(entropy: Uint8Array, gameIndex: number): CommunicationKeyPair {
  const game = [gameIndex & 0xff, (gameIndex >>> 8) & 0xff, (gameIndex >>> 16) & 0xff, (gameIndex >>> 24) & 0xff]
  for (let counter = 0; ; counter++) {
    const secret = sha256(new Uint8Array([...entropy, ...game, counter & 0xff]))
    if (p256.utils.isValidSecretKey(secret)) return { secret, publicKey: p256.getPublicKey(secret, false) }
  }
}

/** The record a store keeps of `pair` for `gameIndex` (null: no game read yet). */
export function communicationKeyRecord(gameIndex: number | null, pair: CommunicationKeyPair, at = Date.now()): CommunicationKey {
  return { version: COMMUNICATION_KEY_VERSION, gameIndex, publicKey: toHex(pair.publicKey), secret: toHex(pair.secret), at }
}

/** The kept key of `gameIndex` when its secret is the one behind its public half, else null. */
export function reusableCommunicationKey(
  kept: CommunicationKey | null,
  gameIndex: number | undefined,
): CommunicationKeyPair | null {
  if (kept == null || gameIndex === undefined || kept.gameIndex !== gameIndex) return null
  return soundCommunicationKey(kept)
}

/** The kept key as a pair when its secret is the one behind its public half,
 *  else null: a record is only as sound as the storage it was read from. */
export function soundCommunicationKey(kept: CommunicationKey): CommunicationKeyPair | null {
  try {
    const publicKey = fromHex(kept.publicKey)
    const secret = fromHex(kept.secret)
    const derived = p256.getPublicKey(secret, false)
    return derived.length === publicKey.length && derived.every((byte, i) => byte === publicKey[i])
      ? { publicKey, secret }
      : null
  } catch {
    return null
  }
}

/**
 * The flow's `communicationIdentifier` over the product's own key store: the
 * kept key of the game when there is a sound one, else a fresh one, kept
 * BEFORE it is handed to the sign-up. A key that could not be kept is never
 * sent: the write's rejection fails the attempt's route read, and the flow
 * goes again (a sign-up that landed with a lost secret could never read its
 * co-players). A read that fails only costs reuse: a fresh key is made and kept.
 * No game read yet (`undefined`): a key kept with no game. `make` makes the key
 * of a game: random by default; a product whose surfaces can all reach the
 * host's entropy derives it (`communicationKeyFrom`), so they agree on it.
 */
export function keptCommunicationIdentifier(
  store: CommunicationKeyStore,
  warn: (message: string, error: unknown) => void,
  make: (gameIndex: number | undefined) => Promise<CommunicationKeyPair> | CommunicationKeyPair = freshCommunicationKey,
): (gameIndex: number | undefined) => Promise<Uint8Array> {
  return async (gameIndex) => {
    try {
      const kept = reusableCommunicationKey(await store.read(), gameIndex)
      if (kept) return kept.publicKey
    } catch (error) {
      warn("the kept communication key could not be read", error)
    }
    const pair = await make(gameIndex)
    await store.write(communicationKeyRecord(gameIndex ?? null, pair))
    return pair.publicKey
  }
}

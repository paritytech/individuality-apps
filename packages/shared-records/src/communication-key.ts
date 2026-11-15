// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The communication key of a sign-up: the P-256 key pair whose public half a
 * sign-up registers as the player's communication identifier, and whose
 * secret a surface keeps so it can later read what co-players send it.
 *
 * Every product that signs the shared game account up keeps its own key in its
 * OWN host storage under `COMMUNICATION_KEY_KEY`: a product can read another's
 * storage through a `trustedProducts` storage grant, but never write it. So
 * the key of a game may sit in Jollity's storage or in Humanity's, whichever
 * signed up last, and a reader reads both and keeps the one whose public half
 * the chain holds (`matchCommunicationKey`). The chain is the authority: the
 * match is on the public key alone, so a key filed under the wrong game
 * (the slot moved between the read and the broadcast) is still found.
 *
 * One key per game per product: a retry of the same game sends the same key
 * again, so whichever attempt lands, its secret is the one kept. A surface
 * keeps its key before the key goes out, and a sign-up whose key could not be
 * kept does not go out.
 *
 * The record is JSON under the key, hex as `0x…`, with a `version` so a later
 * shape can tell this one apart.
 */
import type { JSONStorage } from "./game-registration-store"

/** The host storage key of the record, a `CommunicationKey`. */
export const COMMUNICATION_KEY_KEY = "individuality.communication-key"

/** The record's shape version. */
export const COMMUNICATION_KEY_VERSION = 1

export type CommunicationKey = {
  version: typeof COMMUNICATION_KEY_VERSION
  /** The game it was made for; null when the sign-up had read no game yet. */
  gameIndex: number | null
  /** The raw (65-byte SEC1 uncompressed) public key, as the chain stores it. */
  publicKey: string
  /** The 32-byte P-256 secret. */
  secret: string
  /** When it was made, in wall-clock milliseconds. */
  at: number
}

const HEX = /^0x[0-9a-f]*$/i

/** The record if it is well formed, else null. */
export function parseCommunicationKey(stored: unknown): CommunicationKey | null {
  if (typeof stored !== "object" || stored === null) return null
  const { version, gameIndex, publicKey, secret, at } = stored as Record<string, unknown>
  if (version !== COMMUNICATION_KEY_VERSION) return null
  if (gameIndex !== null && (typeof gameIndex !== "number" || !Number.isInteger(gameIndex))) return null
  if (typeof publicKey !== "string" || !HEX.test(publicKey) || publicKey.length !== 2 + 65 * 2) return null
  if (typeof secret !== "string" || !HEX.test(secret) || secret.length !== 2 + 32 * 2) return null
  if (typeof at !== "number") return null
  return { version, gameIndex, publicKey: publicKey.toLowerCase(), secret: secret.toLowerCase(), at }
}

/** `bytes` as `0x…` lowercase hex. */
export function toHex(bytes: Uint8Array): string {
  let out = "0x"
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

/** `0x…` hex as bytes. */
export function fromHex(hex: string): Uint8Array {
  const digits = hex.replace(/^0x/i, "")
  const bytes = new Uint8Array(digits.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/**
 * Of the keys the products keep, the one whose public half is the identifier
 * the chain holds for the player; null when none is. A kept key the chain does
 * not hold belongs to a sign-up that did not land.
 */
export function matchCommunicationKey(
  keys: readonly (CommunicationKey | null)[],
  onChain: Uint8Array | string,
): CommunicationKey | null {
  const wanted = (typeof onChain === "string" ? onChain : toHex(onChain)).toLowerCase()
  return keys.find((key) => key != null && key.publicKey === wanted) ?? null
}

export interface CommunicationKeyStore {
  /** The kept key, or null: none, malformed, or no storage. Rejects when the storage does. */
  read(): Promise<CommunicationKey | null>
  /** Keeps `key` in place of the last. Rejects when there is no storage to keep it in, or the write fails. */
  write(key: CommunicationKey): Promise<void>
}

/** A store over whatever `open` hands back: null when the product has no storage right now. */
export function communicationKeyStore(open: () => Promise<JSONStorage | null>): CommunicationKeyStore {
  return {
    async read() {
      const storage = await open()
      return storage ? parseCommunicationKey(await storage.readJSON(COMMUNICATION_KEY_KEY)) : null
    },
    async write(key) {
      const storage = await open()
      if (!storage?.writeJSON) throw new Error("no storage to keep the communication key in")
      await storage.writeJSON(COMMUNICATION_KEY_KEY, key)
    },
  }
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The store of the game registration record: the one place that knows the
 * key, parses and ages what is under it, and writes one record after the
 * other. Each product opens one over its own host storage (read and write)
 * and one over truapi's cross-product read of the other product's storage
 * (read only), and reads both.
 */
import { GAME_REGISTRATION_KEY, liveGameRegistration, parseGameRegistration, type GameRegistration } from "./game-registration"

/** What a store needs of a storage handle: JSON under a key. `writeJSON` is absent for a reader. */
export interface JSONStorage {
  readJSON(key: string): Promise<unknown>
  writeJSON?(key: string, value: unknown): Promise<void>
}

export interface GameRegistrationStore {
  /**
   * The live record, or null: none, cleared, malformed, past its lifetime at
   * `now`, or no storage to read. Rejects when the storage does.
   */
  read(now?: number): Promise<GameRegistration | null>
  /**
   * The record whatever its age, or null: none, cleared, malformed, or no
   * storage to read. Only for asking which surface made a game's sign-up;
   * never for whether a sign-up is still on its way. Rejects when the storage
   * does.
   */
  readAny(): Promise<GameRegistration | null>
  /**
   * Writes the record, or clears it with null. Writes go one after the other,
   * so a slow write of the tap never lands after the end, and a write that
   * failed never holds the next. A storage that cannot write drops it.
   * Resolves once the write is done; rejects when the storage does.
   */
  write(record: GameRegistration | null): Promise<void>
}

/** A store over whatever `open` hands back: null when the product has no storage right now. */
export function gameRegistrationStore(open: () => Promise<JSONStorage | null>): GameRegistrationStore {
  let writing: Promise<void> = Promise.resolve()
  return {
    async read(now = Date.now()) {
      const storage = await open()
      return storage ? liveGameRegistration(await storage.readJSON(GAME_REGISTRATION_KEY), now) : null
    },
    async readAny() {
      const storage = await open()
      return storage ? parseGameRegistration(await storage.readJSON(GAME_REGISTRATION_KEY)) : null
    },
    write(record) {
      const next = writing.then(async () => {
        const storage = await open()
        await storage?.writeJSON?.(GAME_REGISTRATION_KEY, record)
      })
      writing = next.catch(() => undefined)
      return next
    },
  }
}

/**
 * The JSON under a key of another product's storage, from the hex truapi
 * answers a cross-product `localStorage.read` with: the UTF-8 of what that
 * product's `writeJSON` stored.
 */
export function decodeStoredJSON(hex: string): unknown {
  const digits = hex.replace(/^0x/i, "")
  const bytes = new Uint8Array(digits.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16)
  return JSON.parse(new TextDecoder().decode(bytes))
}

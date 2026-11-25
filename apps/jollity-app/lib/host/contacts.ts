// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE PLAYER'S CONTACTS, BY NAME: the dotNS usernames of their chat contacts
 * (`alice`, or a device name such as `alice.07`), which the host gives the
 * game product alone, with no prompt (TrUAPI `contacts.usernames`). The prize
 * draw marks the entrants among them as the player's friends.
 *
 * Read once a page: a list that came is kept, a read that failed is asked
 * again next time. Empty outside a host, from a host that lists none
 * (`Unsupported`), while nobody is signed in, after TIMEOUT_MS, or on any
 * failure. Never throws.
 */
import { devLog } from "../debug/log-store"
import { withTimeout } from "../with-timeout"
import { describeError } from "./error-detail"

const TIMEOUT_MS = 5_000

let listed: Promise<readonly string[]> | null = null

export function contactUsernames(): Promise<readonly string[]> {
  listed ??= readContactUsernames().then((usernames) => {
    if (!usernames) listed = null
    return usernames ?? []
  })
  return listed
}

/** the list, or null for a read worth asking again */
async function readContactUsernames(): Promise<readonly string[] | null> {
  const ask = async (): Promise<readonly string[] | null> => {
    const sdk = await import("@parity/product-sdk-host")
    const truApi = await sdk.getTruApi()
    if (!truApi) return []
    return (await truApi.contacts.usernames({})).match(
      ({ usernames }) => [...new Set(usernames.map((name) => name.trim()).filter((name) => name !== ""))],
      (error) => {
        devLog("contacts", "the host lists no contacts", { detail: sdk.formatHostError(error) })
        return null
      },
    )
  }
  try {
    return await withTimeout(ask(), TIMEOUT_MS)
  } catch (error) {
    devLog("contacts", "the contacts read failed", { detail: describeError(error) }, "warn")
    return null
  }
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The player's username for the worker's telemetry (#826).
 *
 * The app writes the name it learns into host storage (PLAYER_NAME_KEY), and
 * the worker reads it from there. A player who never opened the app since the
 * name was shared has nothing stored, so the worker asks the host for it, and
 * the host answers only when the player already gave this product the right to
 * know it. The worker never prompts for it: a refusal or a host without the
 * call leaves the telemetry with the id alone.
 */
import type { PolkadotClient } from "polkadot-api"
import { fullUsernameSet, usernameOwner } from "@individuality/name-link"
import { PLAYER_NAME_KEY } from "@jollity/protocol"
import type { WorkerHost } from "./host"
import { within } from "./state"
import { setChatUsername } from "./telemetry"

/** Sets the telemetry's username when one is known, and returns it. Never throws. */
export async function learnUsername(host: WorkerHost): Promise<string | null> {
  try {
    const stored = await within(host.storage.readJSON<unknown>(PLAYER_NAME_KEY)).catch(() => null)
    let name = typeof stored === "string" && stored.trim() ? stored.trim() : null
    if (!name && host.accounts.userName) name = (await within(host.accounts.userName()).catch(() => null))?.trim() || null
    if (name) setChatUsername(name)
    return name
  } catch {
    return null
  }
}

// The poll asks again until the full username is set, and the host would be
// asked for the name on every one of those polls when storage holds none.
const knownNames = new WeakMap<WorkerHost, string>()

/**
 * Whether the player has set a full username on the People chain, or null
 * when that cannot be told: no name known yet, a chain that does not answer,
 * a read that throws. A name nobody owns reads as not set. Never throws.
 */
export async function readNameSet(host: WorkerHost, people: () => Promise<{ client: PolkadotClient } | null>): Promise<boolean | null> {
  try {
    const name = knownNames.get(host) ?? (await learnUsername(host))
    if (!name) return null
    knownNames.set(host, name)
    const client = (await within(people()))?.client
    if (!client) return null
    const root = await within(usernameOwner(client, name))
    return root ? await within(fullUsernameSet(client, root)) : false
  } catch {
    return null
  }
}

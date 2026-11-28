// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// WHO PLAYS, derived from the environment instead of a literal list, as pure
// functions (vitest pins them). The username is read back from the host at
// pairing (oracle.mts `pairedAs`), so none lives in code.
//
//   CI     E2E_SLOT=<n> with E2E_PLAYER_MNEMONIC: a matrix runner is handed
//          ONE identity selected by the workflow from the aggregate pool (or
//          a legacy E2E_ID_<USERNAME>) and never sees the others
//   desk   no mnemonic: every .truapi-host/e2e-<n> directory present
//          (E2E_SLOT=<n> narrows it to that one). The desk may boot several
//          slots in one process; that is a convenience, CI never does.

import { addMasks } from "./mask"

export interface PlayerSpec {
  n: number
  /** the BIP39 phrase (CI mode) or "" (desk: the slot's stored session) */
  mnemonic: string
}
export interface Derived {
  mode: "ci" | "desk"
  players: PlayerSpec[]
}

type Env = Record<string, string | undefined>

/** The env a child may see: no player secret and no host signer, unless the
 *  caller adds its own slot's (boot.mts childEnv). */
export function stripSecrets(env: Env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v
  delete out.E2E_PLAYER_MNEMONIC
  delete out.HOST_CLI_SIGNER_MNEMONIC
  for (const key of Object.keys(out)) if (/^E2E_GROUP_MNEMONIC_[1-3]$/.test(key)) delete out[key]
  return out
}

/** `deskSlots`: the n of every e2e-<n> directory under the desk state dir. */
export function derivePlayers(env: Env, deskSlots: readonly number[]): Derived {
  const read = (k: string) => env[k]?.trim() ?? ""
  const slotRaw = read("E2E_SLOT")
  let slot: number | null = null
  if (slotRaw) {
    slot = Number(slotRaw)
    if (!Number.isInteger(slot) || slot < 1) throw new Error(`E2E_SLOT=${slotRaw} is not a slot number (1, 2, …)`)
  }
  const mnemonic = read("E2E_PLAYER_MNEMONIC")
  // masked the moment it is read: a value picked out of a pool secret is not a whole secret GitHub already masks
  addMasks([mnemonic], env)

  if (mnemonic) {
    if (slot === null) throw new Error("E2E_PLAYER_MNEMONIC needs E2E_SLOT=<n> (the bot's index: ports, out dir, artifact name)")
    return { mode: "ci", players: [{ n: slot, mnemonic }] }
  }
  if (env.CI) throw new Error("CI is set but E2E_PLAYER_MNEMONIC is not: the secret is missing or not passed to this step")
  if (slot !== null) {
    if (!deskSlots.includes(slot)) throw new Error(`E2E_SLOT=${slot}: no mnemonic and no desk slot e2e-${slot} under E2E_DESK_STATE`)
    return { mode: "desk", players: [{ n: slot, mnemonic: "" }] }
  }
  if (!deskSlots.length) throw new Error("no E2E_PLAYER_MNEMONIC and no .truapi-host/e2e-<n> desk slot under E2E_DESK_STATE")
  return { mode: "desk", players: [...deskSlots].sort((a, b) => a - b).map((n) => ({ n, mnemonic: "" })) }
}

/** The three ports a slot uses, from one base so concurrent single-slot
 *  processes on a desk stay apart (E2E_BASE_PORT per process): host at base,
 *  app at base+100, oracle at base+200, each plus the slot's position. With no
 *  base the hosts probe upward from 9955 / 3000 and the oracle sits at 9975. */
export function portPlan(base: number, i: number): { hostStart: number; appStart: number; oracle: number } {
  return base ? { hostStart: base + i, appStart: base + 100 + i, oracle: base + 200 + i } : { hostStart: 9955, appStart: 3000, oracle: 9975 + i }
}

// THE IDENTITY POOL. An identity is a NAMED lite person (its username, e.g.
// jollityeea.09), not a number. The pool is the public repo variable
// E2E_IDENTITIES = JSON {username: account}; mnemonics live in the network's
// ONE aggregate secret, E2E_POOL[_PREVIEWNET]. A legacy E2E_ID_<USERNAME>
// secret still wins during migration. A profile (profiles.json) names the
// identity it plays as, and timing.ts botMatrix hands the runner only that
// person's mnemonic. new-identity.mts adds a person to the pool.

/** A lite username: letters, a dot, digits (jollityeea.09). */
export const USERNAME_RE = /^[a-z][a-z0-9]*\.[0-9]+$/

/** jollityeea.09 -> JOLLITYEEA_69: the secret's name minus its E2E_ID_ prefix. */
export function secretSuffix(username: string): string {
  if (!USERNAME_RE.test(username)) throw new Error(`"${username}" is not a lite username (letters, a dot, digits: jollityeea.09)`)
  return username.toUpperCase().replace(/[^A-Z0-9]/g, "_")
}
/** The repo secret holding the identity's mnemonic. */
export const identitySecretName = (username: string): string => `E2E_ID_${secretSuffix(username)}`

/** The repo variable holding `network`'s pool: identities are per chain, and the usernames differ (paseo's jollityeea.NN,
 *  previewnet's jollitypv.NN). The workflow hands the chosen one to the scripts as E2E_IDENTITIES. */
export const poolVariable = (network: string): string => (network === "paseo-next-v2" ? "E2E_IDENTITIES" : "E2E_IDENTITIES_PREVIEWNET")

/** E2E_IDENTITIES: JSON {username: account}. Empty or missing is an error here (a run needs the pool). */
export function parseIdentities(raw: string | undefined): Record<string, string> {
  const text = (raw ?? "").trim()
  if (!text) throw new Error("E2E_IDENTITIES is empty: set the repo variable to the pool as JSON {username: account} (new-identity.mts keeps it)")
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error("E2E_IDENTITIES is not valid JSON ({username: account})")
  }
  if (!json || typeof json !== "object" || Array.isArray(json) || !Object.keys(json).length) throw new Error("E2E_IDENTITIES must be a non-empty JSON object {username: account}")
  const out: Record<string, string> = {}
  for (const [user, account] of Object.entries(json)) {
    secretSuffix(user)
    if (typeof account !== "string" || !account.trim()) throw new Error(`E2E_IDENTITIES: the account of ${user} must be a non-empty string`)
    out[user] = account
  }
  const suffixes = Object.keys(out).map(secretSuffix)
  if (new Set(suffixes).size !== suffixes.length) throw new Error("E2E_IDENTITIES: two usernames map to the same secret name")
  return out
}

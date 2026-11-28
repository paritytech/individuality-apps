// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// THE FRESH POOL: lite persons nobody has played as yet, for the profiles that need a person whose seat is still
// UNBOUND (check-seat-preparing: "preparing your seat" only reads on a person the chain holds no binding for, and
// the long-lived bots of the regular pool are all bound). A fresh person is single-use: the app binds it the first
// time it plays, and from then on it is an ordinary bound person.
//
//   pool     the repo variable E2E_FRESH_IDENTITIES_PREVIEWNET (E2E_FRESH_IDENTITIES on paseo-next-v2), JSON
//            {username: game account}, the same shape as the regular pool. The mnemonics are NOT one secret each (the
//            repo caps secrets at 100 and a consumable pool would eat them): ALL of them live in ONE JSON secret,
//            E2E_FRESH_POOL_PREVIEWNET (E2E_FRESH_POOL), {username: mnemonic}, so the count never grows. The play
//            job reads the drawn person's mnemonic from it (a person with an E2E_ID_<USER> secret of its own, minted
//            before this, still wins). Topped up and pruned OUT OF BAND with `new-identity.mts --fresh` /
//            `--fresh --prune-spent` (they need the faucet-funded host the desk already has; CI never mints).
//            A secret cannot be read back, so the desk REBUILDS it whole from the persons' local slots
//            (.truapi-host/<username>), see rebuildFreshPool.
//   consume  there is no counter to keep. The probe asks the chain which pool accounts are still unbound
//            (PeopleLite.AccountToAlias at finalized, read-only) and a run takes the first one. A run that
//            played binds its person, so the next probe skips it: the chain IS the ledger, and a lost write
//            can neither re-offer a spent person nor lock out a fresh one.
//   race     two probes drawing from the same pool could pick the same person. Ordinary live runs and
//            complete-suite waves share one non-replacing per-network execution lane. An ordinary PreviewNet
//            run rechecks for an active complete suite after acquiring that lane, before allocation.
import { parseIdentities } from "./players"

/** Rechecked inside an admitted serial live or reserved suite lane before the allocator draws a person. */
export function reserveFresh(fresh: readonly string[], reserve: number): void {
  if (!Number.isSafeInteger(reserve) || reserve < 1) throw new Error("fresh reserve must be a positive integer")
  if (new Set(fresh).size <= reserve) throw new Error("missing (pool): fresh-person reserve exhausted; no person consumed")
}

/** The repo variable holding `network`'s fresh pool (beside poolVariable's regular pool). */
export const freshPoolVariable = (network: string): string => (network === "paseo-next-v2" ? "E2E_FRESH_IDENTITIES" : "E2E_FRESH_IDENTITIES_PREVIEWNET")

/** The ONE repo secret holding every fresh mnemonic of `network`, JSON {username: mnemonic}. */
export const freshPoolSecret = (network: string): string => (network === "paseo-next-v2" ? "E2E_FRESH_POOL" : "E2E_FRESH_POOL_PREVIEWNET")

/** The profile names a bots input LISTS, exactly: the entries of a JSON list (a name, or {profile}). A preset, a count
 *  or text that is no list names none. Never a substring test: "check-seat-preparing-2" is not "check-seat-preparing". */
export function listedProfiles(raw: string | undefined): string[] {
  let json: unknown
  try {
    json = JSON.parse((raw ?? "").trim())
  } catch {
    return []
  }
  if (!Array.isArray(json)) return []
  return json.flatMap((e: unknown) => {
    if (typeof e === "string") return [e]
    const profile = (e as { profile?: unknown } | null)?.profile
    return typeof profile === "string" ? [profile] : []
  })
}

export interface FreshRebuild {
  /** {username: game account}: the pool variable to write */
  variable: Record<string, string>
  /** {username: mnemonic}: the pool secret to write */
  secret: Record<string, string>
  /** the usernames pruned as spent */
  dropped: string[]
}

/** The desk's rebuild of the fresh pool after a top-up or a prune: the variable minus the spent persons, plus `add`,
 *  and the secret holding exactly the mnemonics of the persons that remain. `mnemonicOf` reads a person's local slot.
 *  A person with no local slot is an error (the secret would silently lose it) unless it is spent (dropped) or still
 *  plays from its own legacy E2E_ID_ secret (`legacy`: kept in the variable, left out of the JSON secret). The error
 *  names the person only, never a mnemonic. */
export function rebuildFreshPool(o: {
  variable: Record<string, string>
  mnemonicOf: (username: string) => string | undefined
  spent: ReadonlySet<string>
  legacy: ReadonlySet<string>
  add?: { username: string; account: string; mnemonic: string }
}): FreshRebuild {
  const variable: Record<string, string> = {}
  const secret: Record<string, string> = {}
  const dropped: string[] = []
  const lost: string[] = []
  for (const [username, account] of Object.entries(o.variable)) {
    if (o.spent.has(username) && username !== o.add?.username) {
      dropped.push(username)
      continue
    }
    variable[username] = account
    if (o.legacy.has(username)) continue
    const mnemonic = o.mnemonicOf(username)
    if (mnemonic) secret[username] = mnemonic
    else lost.push(username)
  }
  if (lost.length) throw new Error(`no local slot (.truapi-host/<username>) holds the mnemonic of ${lost.join(", ")}: rebuilding the fresh secret would lose ${lost.length === 1 ? "it" : "them"}. Run on the desk that minted ${lost.length === 1 ? "it" : "them"}, or prune ${lost.length === 1 ? "it" : "them"} first if spent`)
  if (o.add) {
    if (variable[o.add.username] && variable[o.add.username] !== o.add.account) throw new Error(`the fresh pool already lists ${o.add.username} with a different account`)
    variable[o.add.username] = o.add.account
    secret[o.add.username] = o.add.mnemonic
  }
  return { variable, secret, dropped }
}

/** {username: game account}. Unlike the regular pool an unset or empty variable is just an empty pool: most runs need none. */
export function parseFreshPool(raw: string | undefined): Record<string, string> {
  const text = (raw ?? "").trim()
  if (!text || text === "{}") return {}
  return parseIdentities(text)
}

/** The usernames of `pool` the chain holds no binding for, in pool order. `isBound(account)` is one read of
 *  PeopleLite.AccountToAlias; a FAILED read throws (never counted as unbound). A person who is also in the regular
 *  pool is a long-lived bot, never fresh. */
export async function unboundFresh(pool: Record<string, string>, regular: Record<string, string>, isBound: (account: string) => Promise<boolean>): Promise<string[]> {
  const candidates = Object.entries(pool).filter(([username]) => !(username in regular))
  const bound = await Promise.all(candidates.map(([, account]) => isBound(account)))
  return candidates.filter((_, i) => !bound[i]).map(([username]) => username)
}

/** The fresh persons this run's matrix drew, {username: account}: the probe hands it to the gather job, which can no
 *  longer find them by asking the chain (the run binds them, so they read as spent) and must still resolve each bot's
 *  username and account. */
export function drawnFresh(bots: readonly { profile: string; identity: string }[], pool: Record<string, string>, fresh: (profile: string) => boolean): Record<string, string> {
  return Object.fromEntries(bots.filter((b) => fresh(b.profile)).map((b) => [b.identity, pool[b.identity]]))
}

/** Which spent persons' own legacy E2E_ID_ secrets may be deleted. FAIL CLOSED: when the regular pool could not be read
 *  (`regular` null: the read failed, was empty or was not JSON) nothing is deleted. A person the regular pool or any
 *  profile names (`protectedUsers`) is never deleted, and only a person that actually has such a secret (`legacy`). */
export function deletableLegacy(dropped: readonly string[], legacy: ReadonlySet<string>, regular: Record<string, string> | null, protectedUsers: ReadonlySet<string>): string[] {
  if (regular === null) return []
  return dropped.filter((u) => legacy.has(u) && !(u in regular) && !protectedUsers.has(u))
}

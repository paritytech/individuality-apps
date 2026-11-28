// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// THE REGULAR POOL: long-lived bot identities. Their public username -> game
// account map remains in E2E_IDENTITIES[_PREVIEWNET]. Every mnemonic lives in
// ONE per-network JSON secret instead of one E2E_ID_<USER> secret per person:
//
//   paseo-next-v2  E2E_POOL
//   previewnet     E2E_POOL_PREVIEWNET
//
// The workflow still prefers a legacy E2E_ID_<USER> secret while migration is
// in progress. The desk cannot read repository secrets, so it rebuilds the JSON
// secret from retained .truapi-host/<username> slots. A pool entry with no local
// slot is safe only while its legacy secret still exists.

/** The ONE repo secret holding every regular mnemonic of `network`, JSON {username: mnemonic}. */
export const regularPoolSecret = (network: string): string => (network === "paseo-next-v2" ? "E2E_POOL" : "E2E_POOL_PREVIEWNET")

export interface GhReadResult {
  ok: boolean
  out: string
}

/** Interpret `gh variable get` without confusing a transient/API failure with an absent pool. */
export function poolFromVariableRead(variableName: string, result: GhReadResult): Record<string, string> {
  if (!result.ok) {
    const escapedName = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (new RegExp(`(?:^|\\n)variable ${escapedName} was not found(?:$|\\n)`, "i").test(result.out.trim())) return {}
    throw new Error(`gh variable get ${variableName} failed: ${result.out || "no diagnostic output"}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(result.out)
  } catch {
    throw new Error(`${variableName} is not valid JSON; fix the variable by hand first`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== "string" || !value)) {
    throw new Error(`${variableName} must be a JSON object with non-empty string values`)
  }
  return parsed as Record<string, string>
}

/** An aggregate secret with no matching public map cannot be reconstructed from GitHub. Stop before any write. */
export function assertRegularPoolState(variableName: string, variable: Record<string, string>, aggregateSecret: string, secretNames: ReadonlySet<string>): void {
  if (!Object.keys(variable).length && secretNames.has(aggregateSecret)) {
    throw new Error(`${variableName} is missing or empty while ${aggregateSecret} already exists; refusing to overwrite an inconsistent regular pool`)
  }
}

export interface RegularRebuild {
  /** {username: game account}: the public pool variable to write */
  variable: Record<string, string>
  /** {username: mnemonic}: the aggregate secret to write */
  secret: Record<string, string>
  /** legacy E2E_ID_ secrets now covered by the aggregate and safe to retire after a live proof */
  migratedLegacy: string[]
  /** pool identities that remain on a legacy secret because this desk has no retained signer */
  legacyOnly: string[]
}

/** Rebuild the aggregate regular secret from the desk's retained signers.
 *
 * Existing identities with a local slot go into the aggregate even when they
 * still have a legacy secret. Existing identities without a local slot remain
 * valid only when their legacy secret exists. This makes mixed migration safe:
 * neither the public pool nor a working legacy path is silently discarded.
 */
export function rebuildRegularPool(o: {
  variable: Record<string, string>
  mnemonicOf: (username: string) => string | undefined
  legacy: ReadonlySet<string>
  add?: { username: string; account: string; mnemonic: string }
}): RegularRebuild {
  const variable: Record<string, string> = {}
  const secret: Record<string, string> = {}
  const migratedLegacy: string[] = []
  const legacyOnly: string[] = []
  const lost: string[] = []

  for (const [username, account] of Object.entries(o.variable)) {
    variable[username] = account
    const mnemonic = o.mnemonicOf(username)
    if (mnemonic) {
      secret[username] = mnemonic
      if (o.legacy.has(username)) migratedLegacy.push(username)
    } else if (o.legacy.has(username)) {
      legacyOnly.push(username)
    } else {
      lost.push(username)
    }
  }

  if (lost.length) {
    throw new Error(`no local slot (.truapi-host/<username>) or legacy E2E_ID_ secret holds ${lost.join(", ")}: rebuilding the regular pool would make ${lost.length === 1 ? "it" : "them"} unbootable`)
  }

  if (o.add) {
    if (variable[o.add.username] && variable[o.add.username] !== o.add.account) throw new Error(`the regular pool already lists ${o.add.username} with a different account`)
    variable[o.add.username] = o.add.account
    secret[o.add.username] = o.add.mnemonic
  }

  return { variable, secret, migratedLegacy, legacyOnly }
}

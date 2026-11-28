// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The public-content sweep over the live bots' tree: nothing private may sit in
// it. It fails on
//   - real players: a username or account (SS58 or its hex public key) from a
//     private username map, unless it is one of the bots' own identities
//     (profiles.json, persona-bootstrap.json) or another account of the same
//     bot base (`<base>.<NN>`). The map is never in the repository: it comes
//     from a path given to the CLI, and without it this check is skipped;
//   - private repository and tooling names and the private telemetry project
//     ids, known here only by hash (long terms, so the hash does not give them
//     away); short private terms (machines, people) come from a private terms
//     file given to the CLI, like the username map;
//   - home paths, private IPv4 addresses, board message ids and Sentry DSNs.
// A hit is printed as file:line, its category and a short hash (or the bot
// handle it was taken for), never the value. public-sweep.mts is the CLI.
import { createHash } from "node:crypto"

export interface Hit { file: string; line: number; category: string; tag: string }
export interface Allowlist { names: Set<string>; bases: Set<string> }
export interface UserMap { names: Map<string, string>; accounts: Map<string, string> }

export const sha = (text: string): string => createHash("sha256").update(text).digest("hex")
const short = (text: string): string => sha(text).slice(0, 10)

/** sha256 prefixes (24 hex) of long lowercase private terms: repository and tooling names, project ids. */
const PRIVATE_TERMS = new Map<string, string>([
  ["32c2d57a5b3fd3d38dbf9d4b", "private repository"],
  ["18022a2bc4b210a1de2f7479", "private repository"],
  ["0a80f0be9295e3f8a99d0898", "private tooling"],
  ["43fa5fa3338c6966ea71bed7", "private tooling"],
  ["e1f4292464eaa221108c4600", "private tooling"],
  ["5b6dae8343d692b6280d89b5", "telemetry project id"],
  ["45144d9111b022b5bbdf4ece", "telemetry project id"],
])

/** A private terms file: {"terms": [{"term": "...", "category": "private host"}, ...]}, matched case-insensitively per token run. */
export function buildPrivateTerms(file: unknown): Map<string, string> {
  const terms = new Map<string, string>()
  for (const entry of (file as { terms?: { term?: unknown; category?: unknown }[] } | null)?.terms ?? []) {
    if (typeof entry.term === "string" && entry.term.trim()) terms.set(entry.term.trim().toLowerCase(), typeof entry.category === "string" ? entry.category : "private term")
  }
  return terms
}

/** Generic shapes, safe to spell out. */
const PATTERNS: { category: string; re: RegExp }[] = [
  { category: "home path", re: /(?:\/home\/[a-z_][a-z0-9_-]*|\/Users\/[A-Za-z][A-Za-z0-9._-]*|~\/GitHub\b)/g },
  { category: "private address", re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g },
  { category: "board message id", re: /\bM-20\d{2}[01]\d[0-3]\d[-T]?[0-9A-Za-z]*-[0-9A-Za-z]+\b/g },
  { category: "sentry dsn", re: /\bhttps?:\/\/[0-9a-f]{16,}@[a-z0-9.-]*ingest[a-z0-9.-]*/gi },
  { category: "sentry org id", re: /\bo\d{5,}\.ingest\./g },
]

const TOKEN = /[\p{L}\p{N}]+(?:[-_.][\p{L}\p{N}]+)*/gu
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

/** Every contiguous run of a token's parts, with its separators: `a-b.c` -> a, b, c, a-b, b.c, a-b.c. */
export function subRuns(token: string): string[] {
  const parts = token.split(/([-_.])/)
  const words = parts.filter((_, i) => i % 2 === 0)
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    let run = words[i]!
    out.push(run)
    for (let j = i + 1; j < words.length && j - i < 8; j++) {
      run += parts[2 * j - 1]! + words[j]!
      out.push(run)
    }
  }
  return out
}

/** The 32-byte public key of an SS58 address as lowercase hex, or null when it is not one. */
export function ss58PublicKey(address: string): string | null {
  let n = 0n
  for (const ch of address) {
    const v = BASE58.indexOf(ch)
    if (v < 0) return null
    n = n * 58n + BigInt(v)
  }
  let hex = n.toString(16)
  if (hex.length % 2) hex = "0" + hex
  const bytes = hex.length / 2
  // one- or two-byte prefix, 32-byte key, 2-byte checksum
  if (bytes === 35) return hex.slice(2, 66)
  if (bytes === 36) return hex.slice(4, 68)
  return null
}

/** The bots' own identities: exact handles, and the bases a bot account is minted under. */
export function buildAllowlist(profiles: unknown, personas: unknown): Allowlist {
  const names = new Set<string>()
  const bases = new Set<string>()
  const list = (profiles as { profiles?: { identity?: unknown }[] } | null)?.profiles ?? []
  for (const profile of list) {
    const identity = profile.identity
    const values = typeof identity === "string" ? [identity] : identity && typeof identity === "object" ? Object.values(identity) : []
    for (const value of values) {
      if (typeof value !== "string") continue
      names.add(value.toLowerCase())
      bases.add(value.toLowerCase().replace(/\.[0-9]+$/, ""))
    }
  }
  for (const persona of (personas as { personas?: { base?: unknown }[] } | null)?.personas ?? []) {
    if (typeof persona.base === "string") bases.add(persona.base.toLowerCase())
  }
  return { names, bases }
}

export const isBotHandle = (name: string, allow: Allowlist): boolean => {
  const lower = name.toLowerCase()
  return allow.names.has(lower) || allow.bases.has(lower.replace(/\.[0-9\p{Nd}]+$/u, ""))
}

/** The username map {address: username} as lookups; hex public keys are matched too. */
export function buildUserMap(map: Record<string, string>): UserMap {
  const names = new Map<string, string>()
  const accounts = new Map<string, string>()
  for (const [address, username] of Object.entries(map)) {
    names.set(username.toLowerCase(), username)
    accounts.set(address, username)
    const key = ss58PublicKey(address)
    if (key) accounts.set(key, username)
  }
  return { names, accounts }
}

/** Scan one file's text. `users` is optional (the private map); without it only the other checks run. */
export function scanText(file: string, text: string, allow: Allowlist, users?: UserMap, privateTerms?: Map<string, string>): Hit[] {
  const hits: Hit[] = []
  const lines = text.split("\n")
  lines.forEach((content, index) => {
    const line = index + 1
    for (const { category, re } of PATTERNS) {
      for (const match of content.matchAll(re)) hits.push({ file, line, category, tag: short(match[0]) })
    }
    for (const match of content.matchAll(TOKEN)) {
      const token = match[0]
      for (const run of subRuns(token)) {
        const lower = run.toLowerCase()
        const term = PRIVATE_TERMS.get(sha(lower).slice(0, 24))
        if (term) hits.push({ file, line, category: term, tag: short(lower) })
        const named = privateTerms?.get(lower)
        if (named) hits.push({ file, line, category: named, tag: short(lower) })
        if (!users) continue
        const username = users.names.get(lower)
        if (username !== undefined) {
          if (!isBotHandle(username, allow)) hits.push({ file, line, category: "player username", tag: short(lower) })
        }
      }
      if (users) {
        const bare = token.replace(/^0x/i, "")
        const account = users.accounts.get(token) ?? users.accounts.get(bare.toLowerCase())
        if (account !== undefined && !isBotHandle(account, allow)) hits.push({ file, line, category: "player account", tag: short(token) })
      }
    }
  })
  // one report per place and finding
  const seen = new Set<string>()
  return hits.filter((hit) => {
    const key = `${hit.file}:${hit.line}:${hit.category}:${hit.tag}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

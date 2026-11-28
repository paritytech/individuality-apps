// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// OTHER PLAYERS STAY OUT OF PUBLIC RUN LOGS AND ARTIFACTS. A live game puts the
// bots next to people; their accounts and usernames reach the bots through the
// chain roster, the page and the app's own logs. In a public repository every
// run log and artifact is world-readable, so:
//   - each non-bot account or username is registered with `::add-mask::` the
//     moment the run knows it (an account's 8-character short form too, the way
//     the reports print it), so no later log line shows it;
//   - every file the run uploads has each one replaced by a stable invented
//     label, `player-<8 hex>` (redact-players.mts, before each upload).
// The bots' own names and accounts (profiles.json, persona bases, the pool
// variables, the run's bot accounts) stay readable: the reports are about them.
import { createHash } from "node:crypto"

type Env = Record<string, string | undefined>
type Write = (line: string) => void

const toStdout: Write = (line) => {
  process.stdout.write(line)
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
/** An SS58 address with a valid checksum (prefix of one or two bytes, a 32-byte key). */
export function isSs58(text: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{46,48}$/.test(text)) return false
  let n = 0n
  for (const ch of text) n = n * 58n + BigInt(B58.indexOf(ch))
  let hex = n.toString(16)
  if (hex.length % 2) hex = "0" + hex
  const bytes = Buffer.from(hex, "hex")
  for (const prefix of [1, 2]) {
    if (bytes.length !== prefix + 34) continue
    const body = bytes.subarray(0, prefix + 32)
    const sum = createHash("blake2b512").update(Buffer.concat([Buffer.from("SS58PRE"), body])).digest().subarray(0, 2)
    if (sum.equals(bytes.subarray(prefix + 32))) return true
  }
  return false
}

/** A lite username: lowercase letters, a dot, two or three digits (botbase.07). */
export const LITE_USERNAME = /\b[a-z][a-z0-9]{2,}\.[0-9]{2,3}\b/g
const SS58_RUN = /\b[1-9A-HJ-NP-Za-km-z]{46,48}\b/g
/** The short form the reports print: an account's first 8 characters. */
export const SHORT = 8

export const playerLabel = (value: string): string => `player-${createHash("sha256").update(value).digest("hex").slice(0, 8)}`

export interface BotSet { names: Set<string>; bases: Set<string>; accounts: Set<string> }

const parseJson = (raw: string | undefined): unknown => {
  try {
    return JSON.parse(raw?.trim() || "null")
  } catch {
    return null
  }
}

/** The bots: profile identities and persona bases, plus whatever the run's env names (the pools {username: account},
 *  the run's bot accounts, this runner's expected user). */
export function botSet(profiles: unknown, personas: unknown, env: Env = process.env): BotSet {
  const names = new Set<string>()
  const bases = new Set<string>()
  const accounts = new Set<string>()
  const addName = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return
    names.add(value.trim().toLowerCase())
    bases.add(value.trim().toLowerCase().replace(/\.[0-9]+$/, ""))
  }
  for (const profile of (profiles as { profiles?: { identity?: unknown }[] } | null)?.profiles ?? []) {
    const identity = profile.identity
    if (typeof identity === "string") addName(identity)
    else if (identity && typeof identity === "object") Object.values(identity).forEach(addName)
  }
  for (const persona of (personas as { personas?: { base?: unknown }[] } | null)?.personas ?? []) {
    if (typeof persona.base === "string") bases.add(persona.base.toLowerCase())
  }
  for (const key of ["E2E_IDENTITIES", "E2E_FRESH_IDENTITIES", "E2E_IDENTITIES_PREVIEWNET", "E2E_FRESH_IDENTITIES_PREVIEWNET"]) {
    const pool = parseJson(env[key])
    if (!pool || typeof pool !== "object" || Array.isArray(pool)) continue
    for (const [username, account] of Object.entries(pool)) {
      addName(username)
      if (typeof account === "string") accounts.add(account)
    }
  }
  const runBots = parseJson(env.E2E_RUN_BOT_ACCOUNTS)
  if (Array.isArray(runBots)) for (const account of runBots) if (typeof account === "string") accounts.add(account)
  addName(env.E2E_EXPECTED_USER)
  return { names, bases, accounts }
}

export const isBotName = (name: string, bots: BotSet): boolean => {
  const lower = name.toLowerCase()
  return bots.names.has(lower) || bots.bases.has(lower.replace(/\.[0-9]+$/, ""))
}

/** The other players a run has seen: masked as they arrive, replaced in what it writes. */
export class PlayerPrivacy {
  /** value (account, its short form, or username) -> label */
  private readonly labels = new Map<string, string>()

  constructor(private readonly bots: BotSet, private readonly env: Env = process.env, private readonly write: Write = toStdout) {}

  /** Learn one account or username. A bot's is ignored; another player's is masked now and labelled from here on. */
  see(value: string | null | undefined): void {
    const v = value?.trim()
    if (!v || this.labels.has(v)) return
    if (isSs58(v)) {
      if (this.bots.accounts.has(v)) return
      const label = playerLabel(v)
      this.labels.set(v, label)
      const short = v.slice(0, SHORT)
      if (!this.labels.has(short)) this.labels.set(short, label)
      this.mask(v, short)
      return
    }
    if (isBotName(v, this.bots)) return
    this.labels.set(v, playerLabel(v.toLowerCase()))
    this.mask(v)
  }

  /** Learn every account and lite username in a text (a log line, a JSON file). */
  seeIn(text: string): void {
    for (const match of text.matchAll(SS58_RUN)) if (isSs58(match[0])) this.see(match[0])
    for (const match of text.matchAll(LITE_USERNAME)) this.see(match[0])
  }

  /** The text with every other player replaced by their label (longest values first, so a full account wins over its short form). */
  redact(text: string): string {
    if (!this.labels.size) return text
    const values = [...this.labels.keys()].sort((a, b) => b.length - a.length)
    // whole tokens only: a short form inside a longer account, CID or hash is not that player
    const pattern = new RegExp(`(?<![A-Za-z0-9])(?:${values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z0-9])`, "g")
    return text.replace(pattern, (found) => this.labels.get(found) ?? found)
  }

  get seen(): number {
    return new Set(this.labels.values()).size
  }

  private mask(...values: string[]): void {
    if (this.env.GITHUB_ACTIONS !== "true") return
    for (const value of values) this.write(`::add-mask::${value}\n`)
  }
}

/** Learn other players from everything this process prints, before it is printed, so the line goes out masked. */
export function guardConsole(privacy: PlayerPrivacy, target: Pick<Console, "log" | "info" | "warn" | "error"> = console): void {
  for (const method of ["log", "info", "warn", "error"] as const) {
    const original = target[method].bind(target)
    target[method] = (...args: unknown[]) => {
      privacy.seeIn(args.map((arg) => (typeof arg === "string" ? arg : (() => {
        try {
          return JSON.stringify(arg) ?? String(arg)
        } catch {
          return String(arg)
        }
      })())).join(" "))
      original(...args)
    }
  }
}

/** The run's privacy guard, from this repository's bot lists and the run's env. */
export function runPrivacy(profiles: unknown, personas: unknown, env: Env = process.env): PlayerPrivacy {
  return new PlayerPrivacy(botSet(profiles, personas, env), env)
}

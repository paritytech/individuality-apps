// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What an exported debug log says about itself, in its meta block and in its
 * filename.
 *
 * The filename is `jollity-logs-<date>-g<game>-<who>-v<version>.json`. The who
 * is the permissioned username, else the start of the address, else `anon`. A
 * part the export does not know is left out, and every part keeps to
 * characters any filesystem takes.
 */
import type { TelemetryEntry } from "./telemetry"

export interface LogExportFacts {
  exportedAt: Date
  gameIndex: number | null
  username: string | null
  address: string | null
  version: string
}

const ADDRESS_CHARS = 8
const VERSION_CHARS = 8
const PART_CHARS = 32

function safePart(text: string, limit = PART_CHARS): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .slice(0, limit)
    .replace(/^[-.]+|[-.]+$/g, "")
}

export function logFilename(facts: LogExportFacts): string {
  const who = (facts.username && safePart(facts.username)) || facts.address?.slice(0, ADDRESS_CHARS) || "anon"
  const version = safePart(facts.version, VERSION_CHARS)
  const parts = [
    "jollity-logs",
    facts.exportedAt.toISOString().slice(0, 10),
    facts.gameIndex === null ? null : `g${facts.gameIndex}`,
    who,
    version ? `v${version}` : null,
  ]
  return `${parts.filter((part) => part !== null).join("-")}.json`
}

/**
 * The newest game the player was registered in, else the newest game the log
 * saw at all.
 *
 * It reads the `status` lines that `watchStatus` in lib/game-source.ts writes,
 * over every stored session, so an export made after a reload still names the
 * game. Preferring a registered game keeps the name on the game just played
 * once the next one opens for sign-up.
 */
export function gameIndexOf(entries: readonly TelemetryEntry[]): number | null {
  let newestSeen: number | null = null
  for (let i = entries.length - 1; i >= 0; i--) {
    const { tag, data } = entries[i]
    if (tag !== "status" || typeof data !== "object" || data === null) continue
    const { game, registered } = data as { game?: unknown; registered?: unknown }
    if (typeof game !== "number") continue
    if (registered === true) return game
    newestSeen ??= game
  }
  return newestSeen
}

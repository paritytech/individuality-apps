// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// THE STORE'S OWN WORD ON A SUBMIT, read off the wire. The app signals through the statement store via the host
// (product-sdk -> truapi-host -> the People node), and the node's refusal comes back to the page as the host's reply on
// the page's websocket: `statement-store submit failed: statement_submit not accepted: {"reason":"channelPriorityTooLow",
// "status":"rejected"}` (host-rust-core runtime/statement_store.rs + statement_store_rpc.rs), a SCALE string, so its
// bytes are plain UTF-8 inside the binary frame.
//
// WHY THE WIRE AND NOT THE APP'S TELEMETRY. A refusal the transport recovers from (one re-stamp for alreadyExpired, one
// lift above the held expiry for channelPriorityTooLow, statementTransport.ts) is told only as an anonymous `retry`
// (the rtc.signal_problems counter, no reason) and never reaches the devLog; only a submit that fails twice is logged.
// So "no priority rejection happened after the reload" can only be proven where the reason is still attached: the
// host's reply. This is a harness-side tap (Playwright's websocket events), independent of what the app reports.
//
// Pure scanning is vitest-pinned (store-wire.test.ts); WireTap attaches to a page.
//
// A channelPriorityTooLow is NOT always the saved floor failing. The transport keeps two submits in flight, so two
// frames for one channel (the glare rebuild's offer and answer to one peer, sent in the same millisecond) can land in
// the wrong order: the node refuses the older one, naming the newer one's expiry, and the transport drops the older as
// superseded (statementTransport.ts; game 199 bot 16 refused one 77 s after its reload, bot 4 three with no reload).
// The refusal names the expiry its channel holds (`min_expiry`), and the reload act reads the floor the old page saved
// (lib/store-clock.ts). Both are packed expiries on one scale, so no clock is converted: a holder AT OR BELOW the saved
// floor is one the restored floor should have cleared (the restore failed); one above it is the page's own newer frame,
// or a statement still in flight at the reload, which no saved floor can know and the one-shot lift re-stamps over.
import type { Page, WebSocket } from "@playwright/test"

/** The node reasons a statement submit can be refused with (polkadot-sdk sc-statement-store; the app's own handling in
 *  packages/jollity-statement-core names the first two). Only these are counted: a free-text match could hit statement data. */
export const STORE_REASONS = ["alreadyExpired", "channelPriorityTooLow", "accountFull", "noAllowance", "badProof", "dataTooLarge"] as const

/** A reason as a whole word: the node's JSON (`{"reason":"alreadyExpired",...}`) whatever the host or SDK wraps it in
 *  (truapi-host says `statement_submit not accepted: ...`, game 192 bot 9; the wording around it is not relied on). The
 *  names are specific enough that statement data (the app's rtc frames) never carries them. */
const REASON_RE = new RegExp(`(?<![A-Za-z])(${STORE_REASONS.join("|")})(?![A-Za-z])`, "g")

/** The refusal reasons one frame carries (each once), from a text or binary payload. */
export function reasonsIn(payload: string | Buffer | Uint8Array): string[] {
  const text = typeof payload === "string" ? payload : Buffer.from(payload).toString("latin1")
  return [...new Set([...text.matchAll(REASON_RE)].map((m) => m[1]))]
}

export interface WireRejection {
  reason: string
  /** ISO time the frame arrived */
  at: string
  /** channelPriorityTooLow: the packed expiry (decimal u64) of the statement the channel holds, when named */
  heldExpiry?: string
}

/** The holder a channelPriorityTooLow names (`min_expiry`, or spec-v2 `minExpiry`), from the raw text of the refusal's
 *  own JSON object: a packed expiry is past 2^53. Null when the frame names none. */
export function heldExpiryIn(payload: string | Buffer | Uint8Array): bigint | null {
  const text = typeof payload === "string" ? payload : Buffer.from(payload).toString("latin1")
  const obj = /\{[^{}]*"reason"\s*:\s*"channelPriorityTooLow"[^{}]*\}/.exec(text)
  const held = obj && /"min_?[eE]xpiry"\s*:\s*(\d+)/.exec(obj[0])
  return held ? BigInt(held[1]) : null
}

/** What the tap saw for one slot: every refusal with its time, and how many host frames it read (so "none refused" is
 *  told apart from "nothing was read"). */
export interface WireEvidence {
  rejections: WireRejection[]
  frames: number
  sockets: number
  /** each reload of the page: when, and the expiry floor the old page saved for the new one (decimal; null = none) */
  reloads?: { at: string; floor: string | null }[]
}
export const emptyWire = (): WireEvidence => ({ rejections: [], frames: 0, sockets: 0, reloads: [] })

/** Refusals of `reason` at or after `since` (ISO; null = the whole run). */
export const rejectionsOf = (w: WireEvidence, reason: string, since: string | null = null): WireRejection[] =>
  w.rejections.filter((r) => r.reason === reason && (since === null || r.at >= since))

/** The channelPriorityTooLow refusals at or after `since`, split by their holder against the latest reload before each.
 *  STALE: the holder is at or below the floor the old page saved, or the refusal names none, or nothing was saved: the
 *  restored floor did not lift the new page above the old page's statements. SUPERSEDED: above the saved floor, so the
 *  page's own newer frame (or one in flight at the reload): the store kept the right one. Before any reload, a holder
 *  can only be the page's own. */
export function priorityRefusals(w: WireEvidence, since: string | null = null): { stale: WireRejection[]; superseded: WireRejection[] } {
  const stale: WireRejection[] = []
  const superseded: WireRejection[] = []
  for (const r of rejectionsOf(w, "channelPriorityTooLow", since)) {
    const reload = (w.reloads ?? []).filter((x) => x.at <= r.at).sort((a, b) => (a.at < b.at ? -1 : 1)).at(-1)
    const own = r.heldExpiry !== undefined && (!reload || (reload.floor !== null && BigInt(r.heldExpiry) > BigInt(reload.floor)))
    ;(own ? superseded : stale).push(r)
  }
  return { stale, superseded }
}

/** One line for a log or a check's detail. */
export function wireSummary(w: WireEvidence): string {
  const by = new Map<string, number>()
  for (const r of w.rejections) by.set(r.reason, (by.get(r.reason) ?? 0) + 1)
  const parts = [...by].map(([r, n]) => `${r} x${n}`)
  return `${w.frames} host frame(s) on ${w.sockets} socket(s), ${parts.length ? `refusals: ${parts.join(", ")}` : "no store refusal"}`
}

/** Taps every websocket a page opens (a reload or a navigation keeps the same Page, so the tap survives it; a relaunch's
 *  new page needs its own attach). Frames from the host are scanned; the evidence accumulates across pages. */
export class WireTap {
  readonly evidence: WireEvidence = emptyWire()
  constructor(private readonly onRejection?: (r: WireRejection) => void) {}
  /** a reload act: when, and the floor the old page saved (null = none) */
  reloaded(at: string, floor: bigint | null): void {
    ;(this.evidence.reloads ??= []).push({ at, floor: floor === null ? null : floor.toString() })
  }
  attach(page: Page): void {
    page.on("websocket", (ws: WebSocket) => {
      this.evidence.sockets++
      ws.on("framereceived", (f) => {
        this.evidence.frames++
        for (const reason of reasonsIn(f.payload)) {
          const held = reason === "channelPriorityTooLow" ? heldExpiryIn(f.payload) : null
          const r: WireRejection = { reason, at: new Date().toISOString(), ...(held !== null ? { heldExpiry: held.toString() } : {}) }
          this.evidence.rejections.push(r)
          this.onRejection?.(r)
        }
      })
    })
  }
}

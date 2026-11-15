// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE SIGNALLING ROUND TRIP: the time from an offer being sent to its answer
 * coming back, from the end that offered. One per peer connection; the two
 * routes an offer takes are told apart (rtc-events.ts SignalRttEvent.via),
 * because only the statement store's is signalling health.
 *
 * ONE CLOCK: both ends of the subtraction are this device's monotonic
 * `performance.now()` (the caller's), never `Date.now()`. The wall clock can be
 * off by a minute or more on a phone and can step mid-game when the OS
 * corrects it, which put 135 s on a 2 s round trip (#319). The answerer's side
 * is not timed here: nothing of the other device's time ever enters.
 *
 * WAS THE PEER THERE? An offer to a peer whose app is not running just waits
 * in the store, so its "round trip" includes the peer's absence (74 s and
 * 69 s have been seen to a player who answered 0.3 s after coming back, #370). The
 * caller says at `sent` whether the peer was PRESENT: the mesh has heard a
 * statement from it (a presence heartbeat or any signal, Conn.lastSignalAt)
 * within PRESENT_WINDOW_MS before the offer was posted. The event carries that
 * as `peerPresent`; for an offer to an absent peer it also carries
 * `fromSeenMs`, answer time counted from the peer's first frame AFTER the offer
 * (`seen`), so we still learn how fast a late peer answers. When the answer is
 * itself the first frame there is no such time. A lane (channel) offer rides an
 * open data channel, so its peer is present by construction.
 */
import type { SignalRttEvent } from "./rtc-events"

export class OfferClock {
  private sentAt: number | null = null // null = no offer waiting for an answer
  private via: SignalRttEvent["via"] = "statement"
  private peerPresent = true
  private firstSeenAt: number | null = null // first frame from an absent peer since the offer

  /** our offer has gone out */
  sent(via: SignalRttEvent["via"], now: number, peerPresent = true): void {
    this.sentAt = now
    this.via = via
    this.peerPresent = peerPresent
    this.firstSeenAt = null
  }

  /** a frame (presence, signal, answer) arrived from the peer */
  seen(now: number): void {
    if (this.sentAt !== null && !this.peerPresent && this.firstSeenAt === null) this.firstSeenAt = now
  }

  /** an answer was applied: how long the offer it answers was out, once; null for an answer to no offer of ours */
  answered(now: number): SignalRttEvent | null {
    if (this.sentAt === null) return null
    const ms = now - this.sentAt
    this.sentAt = null
    const event: SignalRttEvent = { ms, via: this.via, peerPresent: this.peerPresent }
    if (this.firstSeenAt !== null && this.firstSeenAt < now) event.fromSeenMs = now - this.firstSeenAt
    return event
  }
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { devLog } from "../debug/log-store"
import { describeError } from "../host/error-detail"
import type { PeerActorEvent, PeerActorStep } from "./peer-actor"
import type { PeerCompletion } from "./peer-runner"

type Outcome = PeerCompletion["outcome"]

export interface PeerActorSummaryData {
  /** Commands the runner executed, by kind. */
  commands: Record<string, number>
  /** Accepted completions by the site that ran the command ("none" when it stamped none). */
  completions: Record<string, Record<Outcome, number>>
  /** Commands the room-closed teardown ran, by kind (not in commands). */
  teardown: Record<string, number>
  /** Commands still pending when the line was written: their later completions and errors are not counted. */
  inFlightAtClose: number
  /** Facts the reducer ignored, by reason (stale-connection, closed, stale-room, held, ...). */
  ignored: Record<string, number>
  /** Times an actor was started on a connection (a first meeting or a return). */
  actorStarts: number
  /** Times the actor accepted a catch-up to a connection Mesh made without it (a dropped one shows under ignored). */
  replacedExternally: number
  /** Effects that threw or rejected, and the first one's message. */
  errors: number
  firstError?: string
}

/** The per-game summary of what the peer actor did while it drove the mesh. Counts only, so any game, a scripted test run included, shows the actor's
 *  health. Mesh feeds it from the runner's hooks and writes it once, when the
 *  room closes. */
export class PeerActorSummary {
  private data: PeerActorSummaryData = { commands: {}, teardown: {}, inFlightAtClose: 0, completions: {}, ignored: {}, actorStarts: 0, replacedExternally: 0, errors: 0 }
  private written = false
  private closing = false

  /** The room is closing: later commands are teardown, not the game. */
  close(): void {
    this.closing = true
  }

  command(kind: string): void {
    const bucket = this.closing ? this.data.teardown : this.data.commands
    bucket[kind] = (bucket[kind] ?? 0) + 1
  }

  /** The reducer accepted this event. */
  accepted(event: PeerActorEvent): void {
    if (event.type === "connection-replaced-externally") this.data.replacedExternally++
  }

  completion(completion: PeerCompletion): void {
    const site = completion.site ?? "none"
    const row = (this.data.completions[site] ??= { resolved: 0, rejected: 0, stale: 0 })
    row[completion.outcome]++
  }

  ignored(reason: NonNullable<PeerActorStep["ignored"]>): void {
    this.data.ignored[reason] = (this.data.ignored[reason] ?? 0) + 1
  }

  started(): void {
    this.data.actorStarts++
  }

  error(error: unknown): void {
    this.data.errors++
    this.data.firstError ??= describeError(error)
  }

  snapshot(): PeerActorSummaryData {
    return structuredClone(this.data)
  }

  /** Once per room, for every room the runner drove, zeros when idle. A flag-on game without this line is a missing log. */
  write(inFlight: number): void {
    if (this.written) return
    this.written = true
    this.data.inFlightAtClose = inFlight
    devLog("peer-actor", "peer actor authority summary", this.snapshot())
  }
}

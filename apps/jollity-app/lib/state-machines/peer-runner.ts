// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The peer actor's effect runner for one room: the only place a peer reducer
 * step meets the browser.
 *
 * It keeps the reducer/runner transaction contract: a reducer step and the
 * commands it issues behave as one transaction, with the guarantees
 * below:
 *
 * - Every peer's events go through one room FIFO with a synchronous drain, so
 *   a callback that dispatches from inside an effect, for this peer or another,
 *   waits until the current step's whole command program has run.
 * - One step's commands execute back to back, in order, exactly once. The
 *   reducer has already counted all of them as issued, so a command whose
 *   effect throws does not stop the rest.
 * - An effect that returns a promise is awaited outside the drain, and its
 *   result is reduced in that continuation as the command's own
 *   `command-completed`, stamped with the epochs the command was issued under.
 *   A result that outlives its connection meets the reducer's stale-connection
 *   guard, and a call that never settles holds nothing else up.
 * - An effect that throws, or whose promise rejects, completes as `rejected`.
 * - An effect may instead return (or resolve to) a `PeerCommandResult`: its
 *   outcome, `stale` for a bail after an await that had no effect, and the
 *   facts Mesh stamps at its call site (the site, the error's class, the
 *   round, the time it heard the peer). A synchronous result completes at
 *   once, after the rest of the step's program.
 *
 * The runner holds no browser objects itself. `execute` is the bridge to them,
 * and the caller stamps browser facts onto the events it dispatches.
 */
import { stepPeerActor, type PeerActorCommand, type PeerActorEvent, type PeerActorState, type PeerActorStep } from "./peer-actor"

type CommandCompleted = Extract<PeerActorEvent, { type: "command-completed" }>

export type PeerCommandOutcome = CommandCompleted["outcome"]

/** A command's outcome with what Mesh stamps at the site that ran it. */
export type PeerCommandResult = { outcome: PeerCommandOutcome } & Partial<Pick<CommandCompleted, "site" | "reason" | "roundGeneration" | "at" | "offer" | "haveLocalOffer" | "displaced">>

/** Runs one command for one peer against the browser. A promise means the
 *  command is awaited; a result returned at once completes it at once. */
export type PeerCommandEffect = (peer: string, command: PeerActorCommand) => void | PeerCommandResult | Promise<PeerCommandOutcome | PeerCommandResult | void>

export type PeerCompletion = Omit<Extract<PeerActorEvent, { type: "command-completed" }>, "type">

export interface PeerRunnerHooks {
  /** The clock a completion is stamped with: the actor times
   *  what the completion moves by it. Without one, completions carry none. */
  clock?: () => number
  /** Each event the reducer accepted (not ignored), after its commands ran. */
  onAccepted?: (peer: string, event: PeerActorEvent) => void
  /** Each completion the reducer accepted. */
  onCompletion?: (peer: string, completion: PeerCompletion) => void
  /** Each event the reducer ignored, with the reason. */
  onIgnored?: (peer: string, reason: NonNullable<PeerActorStep["ignored"]>, event: PeerActorEvent) => void
  /** An effect threw or rejected, or a reducer step or hook threw. The drain carries on. */
  onError?: (peer: string, error: unknown) => void
}

export class PeerRoomRunner {
  private readonly peers = new Map<string, { state: PeerActorState; run: number }>()
  private readonly queue: { peer: string; event: PeerActorEvent; run: number | undefined }[] = []
  private draining = false
  private runs = 0

  constructor(
    private readonly execute: PeerCommandEffect,
    private readonly hooks: PeerRunnerHooks = {},
  ) {}

  /** Starts (or restarts) a peer's actor from `initial`. Results still in flight from an earlier start are dropped. */
  add(peer: string, initial: PeerActorState): void {
    this.peers.set(peer, { state: initial, run: ++this.runs })
  }

  remove(peer: string): void {
    this.peers.delete(peer)
  }

  state(peer: string): PeerActorState | undefined {
    return this.peers.get(peer)?.state
  }

  dispatch(peer: string, event: PeerActorEvent): void {
    this.enqueue(peer, event)
  }

  /** `run`, when given, ties the event to one start of the peer's actor: it is dropped if the actor restarted. */
  private enqueue(peer: string, event: PeerActorEvent, run?: number): void {
    this.queue.push({ peer, event, run })
    if (this.draining) return
    this.draining = true
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        try {
          this.reduce(next.peer, next.event, next.run)
        } catch (error) {
          this.report(next.peer, error)
        }
      }
    } finally {
      this.draining = false
    }
  }

  private reduce(peer: string, event: PeerActorEvent, run: number | undefined): void {
    const entry = this.peers.get(peer)
    if (!entry || (run !== undefined && run !== entry.run)) return
    const result = stepPeerActor(entry.state, event)
    entry.state = result.state
    // The new state already counts every command of the program as issued, so
    // all of them run, and each failure is reported on its own.
    for (const command of result.commands) this.run(peer, entry.run, command, event.roomEpoch)
    if (result.ignored) this.hooks.onIgnored?.(peer, result.ignored, event)
    else {
      this.hooks.onAccepted?.(peer, event)
    }
    if (!result.ignored && event.type === "command-completed") {
      const { commandEpoch, commandKind, roomEpoch, connectionEpoch } = event
      this.hooks.onCompletion?.(peer, { commandEpoch, commandKind, roomEpoch, connectionEpoch, ...stamped(event) })
    }
  }

  private run(peer: string, run: number, command: PeerActorCommand, roomEpoch: number): void {
    const complete = (result: PeerCommandResult) => this.enqueue(peer, {
      ...result,
      ...(this.hooks.clock ? { now: this.hooks.clock() } : {}),
      type: "command-completed",
      commandEpoch: command.commandEpoch,
      commandKind: command.kind,
      roomEpoch,
      connectionEpoch: command.connectionEpoch,
    }, run)
    const fail = (error: unknown) => {
      this.report(peer, error)
      complete({ outcome: "rejected" })
    }
    let effect: ReturnType<PeerCommandEffect>
    try {
      effect = this.execute(peer, command)
    } catch (error) {
      fail(error)
      return
    }
    if (isResult(effect)) {
      complete(stamped(effect))
      return
    }
    if (typeof (effect as Promise<unknown> | undefined)?.then !== "function") return
    ;(effect as Promise<PeerCommandOutcome | PeerCommandResult | void>).then(
      (value) => complete(isResult(value) ? stamped(value) : { outcome: value === "rejected" || value === "stale" ? value : "resolved" }),
      fail,
    )
  }

  private report(peer: string, error: unknown): void {
    try {
      this.hooks.onError?.(peer, error)
    } catch {
      // The error hook itself failed. The drain carries on regardless.
    }
  }
}

const OUTCOMES: ReadonlySet<unknown> = new Set<PeerCommandOutcome>(["resolved", "rejected", "stale"])

function isResult(value: unknown): value is PeerCommandResult {
  return typeof value === "object" && value !== null && OUTCOMES.has((value as { outcome?: unknown }).outcome)
}

/** Only the result's own fields: an effect's object never adds others to the event. */
function stamped({ outcome, site, reason, roundGeneration, at, offer, haveLocalOffer, displaced }: PeerCommandResult): PeerCommandResult {
  return {
    outcome,
    ...(site === undefined ? {} : { site }),
    ...(reason === undefined ? {} : { reason }),
    ...(roundGeneration === undefined ? {} : { roundGeneration }),
    ...(at === undefined ? {} : { at }),
    ...(offer === undefined ? {} : { offer }),
    ...(haveLocalOffer === undefined ? {} : { haveLocalOffer }),
    ...(displaced === undefined ? {} : { displaced }),
  }
}

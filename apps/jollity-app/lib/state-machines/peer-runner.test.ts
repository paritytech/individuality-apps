// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { createPeerActorState, type PeerActorCommand, type PeerActorEvent, type PeerActorState } from "./peer-actor"
import { PeerRoomRunner, type PeerCommandEffect, type PeerCommandOutcome, type PeerCommandResult, type PeerCompletion } from "./peer-runner"

const initial = (overrides: Partial<PeerActorState> = {}): PeerActorState => {
  const state = createPeerActorState({ game: 1, roomEpoch: 1, peer: "peer" })
  return { ...state, ...overrides, scope: { ...state.scope, ...overrides.scope }, budgets: { ...state.budgets, ...overrides.budgets } }
}

const at = <Event extends Omit<PeerActorEvent, "roomEpoch" | "connectionEpoch">>(value: Event, connectionEpoch = 1): PeerActorEvent =>
  ({ ...value, roomEpoch: 1, connectionEpoch }) as PeerActorEvent

const connected = () => initial({ link: "connected", laneOpen: true })

/** A browser call the test settles by hand. */
function deferred() {
  let settle!: (outcome: PeerCommandOutcome | void) => void
  const promise = new Promise<PeerCommandOutcome | void>((resolve) => { settle = resolve })
  return { promise, settle }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function room(execute: PeerCommandEffect) {
  const completions: PeerCompletion[] = []
  const ignored: string[] = []
  const runner = new PeerRoomRunner(execute, {
    onCompletion: (_peer, completion) => completions.push(completion),
    onIgnored: (_peer, reason) => ignored.push(reason),
  })
  runner.add("a", connected())
  return { runner, completions, ignored }
}

describe("peer room runner", () => {
  it("runs one step's command program in order, exactly once, before a re-entrant event reduces", () => {
    const log: string[] = []
    const { runner } = room((_peer, command) => {
      log.push(command.kind)
      if (command.kind === "rollback") runner.dispatch("a", at({ type: "network-changed" }))
    })

    runner.dispatch("a", at({ type: "codec-guard-rtx" }))

    expect(log).toEqual(["rollback", "send-offer", "restart-ice"])
  })

  it("holds another peer's re-entrant event until the current program has run", () => {
    const log: string[] = []
    const { runner } = room((peer, command) => {
      log.push(`${peer}:${command.kind}`)
      if (peer === "a" && command.kind === "rollback") runner.dispatch("b", at({ type: "network-changed" }))
    })
    runner.add("b", connected())

    runner.dispatch("a", at({ type: "codec-guard-rtx" }))

    expect(log).toEqual(["a:rollback", "a:send-offer", "b:restart-ice"])
  })

  it("reduces an awaited result in its continuation as the command's completion, with its issue epochs", async () => {
    const call = deferred()
    const { runner, completions } = room((_peer, command) => command.kind === "send-offer" ? call.promise : undefined)

    runner.dispatch("a", at({ type: "codec-guard-rtx" }))
    const sent = runner.state("a")!.commandEpoch
    call.settle("resolved")
    await flush()

    expect(runner.state("a")!.openCommands).toEqual({ rollback: 1 })
    expect(completions).toEqual([{ commandEpoch: sent, commandKind: "send-offer", outcome: "resolved", roomEpoch: 1, connectionEpoch: 1 }])
  })

  it("drops a result that returns after its connection was replaced", async () => {
    const call = deferred()
    const { runner, ignored } = room((_peer, command) => command.kind === "send-offer" ? call.promise : undefined)

    runner.dispatch("a", at({ type: "codec-guard-rtx" }))
    runner.dispatch("a", at({ type: "glare-observed", remoteCarriesVideo: true, lane: true }))
    const replaced = runner.state("a")
    call.settle("rejected")
    await flush()

    expect(replaced!.connectionEpoch).toBe(2)
    expect(runner.state("a")).toEqual(replaced)
    expect(ignored).toEqual(["stale-connection"])
  })

  // An unstamped rejection (the runner's own, before the 3c bridge stamps the
  // site) is logged, as legacy logs a rejection outside its named sites: it
  // closes the command and leaves the connection alone. These tests check that
  // a rejection lands, so they read the closed command.
  it("does not let a call that never settles hold up the next connection's rejection", async () => {
    const offers = [deferred(), deferred()]
    let sent = 0
    const { runner } = room((_peer, command: PeerActorCommand) => command.kind === "send-offer" ? offers[sent++]!.promise : undefined)

    runner.dispatch("a", at({ type: "codec-guard-rtx" }))
    runner.dispatch("a", at({ type: "glare-observed", remoteCarriesVideo: true, lane: true }))
    runner.dispatch("a", at({ type: "channel-observed", state: "open" }, 2))
    runner.dispatch("a", at({ type: "codec-guard-rtx" }, 2))
    offers[1]!.settle("rejected")
    await flush()

    expect(runner.state("a")).toMatchObject({ connectionEpoch: 2, link: "connecting", openCommands: {} })
  })

  it("leaves the connection alone when a media command is rejected", async () => {
    const call = deferred()
    const { runner } = room((_peer, command) => command.kind === "replace-video-track" ? call.promise : undefined)

    runner.dispatch("a", at({ type: "standby-changed", standby: true }))
    call.settle("rejected")
    await flush()

    expect(runner.state("a")!.link).toBe("connected")
  })

  it("closes a rejected negotiation command and, unstamped, leaves the connection alone", async () => {
    const call = deferred()
    const { runner } = room((_peer, command) => command.kind === "send-offer" ? call.promise : undefined)

    runner.dispatch("a", at({ type: "codec-guard-rtx" }))
    call.settle("rejected")
    await flush()

    expect(runner.state("a")).toMatchObject({ link: "connected", openCommands: { rollback: expect.any(Number) } })
    expect(runner.state("a")!.openCommands["send-offer"]).toBeUndefined()
  })

  it("counts a call that resolves without a value as resolved", async () => {
    const call = deferred()
    const { runner, completions } = room((_peer, command) => command.kind === "send-offer" ? call.promise : undefined)

    runner.dispatch("a", at({ type: "codec-guard-rtx" }))
    call.settle()
    await flush()

    expect(completions).toEqual([expect.objectContaining({ commandKind: "send-offer", outcome: "resolved" })])
  })

  it("lands an effect that throws as a rejected completion", () => {
    const { runner, completions } = room((_peer, command) => {
      if (command.kind === "send-offer") throw new Error("createOffer refused")
    })

    runner.dispatch("a", at({ type: "codec-guard-rtx" }))

    expect(completions).toEqual([expect.objectContaining({ commandKind: "send-offer", outcome: "rejected" })])
    expect(runner.state("a")!.openCommands["send-offer"]).toBeUndefined()
  })

  it("lands a rejected promise as a rejected completion", async () => {
    const { runner, completions } = room((_peer, command) =>
      command.kind === "send-offer" ? Promise.reject(new Error("setLocalDescription refused")) : undefined)

    runner.dispatch("a", at({ type: "codec-guard-rtx" }))
    await flush()

    expect(completions).toEqual([expect.objectContaining({ commandKind: "send-offer", outcome: "rejected" })])
  })

  it("runs the rest of a program when one command's effect throws, and reports the error", () => {
    const log: string[] = []
    const errors: unknown[] = []
    const thrown = new Error("rollback refused")
    const runner = new PeerRoomRunner((_peer, command) => {
      log.push(command.kind)
      if (command.kind === "rollback") throw thrown
    }, { onError: (_peer, error) => errors.push(error) })
    runner.add("a", connected())

    runner.dispatch("a", at({ type: "codec-guard-rtx" }))

    expect(log).toEqual(["rollback", "send-offer"])
    expect(errors).toEqual([thrown])
    expect(runner.state("a")!.openCommands).toEqual({ "send-offer": expect.any(Number) })
  })

  it("treats an effect that returns a non-promise value as synchronous", () => {
    const log: string[] = []
    const { runner, completions } = room(((_peer: string, command: PeerActorCommand) => {
      log.push(command.kind)
      return log.length
    }) as unknown as PeerCommandEffect)

    runner.dispatch("a", at({ type: "codec-guard-rtx" }))

    expect(log).toEqual(["rollback", "send-offer"])
    expect(completions).toEqual([])
  })

  it.each([null, "resolved", 1])("does not inspect a non-result synchronous effect value (%j)", (value) => {
    const { runner, completions } = room((() => value) as unknown as PeerCommandEffect)

    expect(() => runner.dispatch("a", at({ type: "codec-guard-rtx" }))).not.toThrow()
    expect(completions).toEqual([])
  })

  it("preserves a rejected result's site and reason on the actor completion", () => {
    const { runner, completions } = room((_peer, command) => command.kind === "send-offer"
      ? { outcome: "rejected", site: "lane", reason: "hard-sdp" }
      : undefined)

    runner.dispatch("a", at({ type: "codec-guard-rtx" }))

    expect(completions).toEqual([
      expect.objectContaining({
        commandKind: "send-offer",
        outcome: "rejected",
        site: "lane",
        reason: "hard-sdp",
      }),
    ])
  })

  it("reports a rejected effect's error", async () => {
    const errors: unknown[] = []
    const refused = new Error("setLocalDescription refused")
    const runner = new PeerRoomRunner((_peer, command) => command.kind === "send-offer" ? Promise.reject(refused) : undefined, {
      onError: (_peer, error) => errors.push(error),
    })
    runner.add("a", connected())

    runner.dispatch("a", at({ type: "codec-guard-rtx" }))
    await flush()

    expect(errors).toEqual([refused])
  })

  it("drops results that come back after the peer's actor was restarted", async () => {
    const call = deferred()
    const { runner, completions } = room((_peer, command) => command.kind === "send-offer" ? call.promise : undefined)

    runner.dispatch("a", at({ type: "codec-guard-rtx" }))
    const old = runner.state("a")!.openCommands["send-offer"]!
    // The fresh actor happens to hold an open offer with the same epoch, so only the restart fence stops the old result.
    const restarted = { ...connected(), commandEpoch: old, openCommands: { "send-offer": old } }
    runner.add("a", restarted)
    call.settle("rejected")
    await flush()

    expect(runner.state("a")).toEqual(restarted)
    expect(completions).toEqual([])
  })

  it("forgets a removed peer", () => {
    const log: string[] = []
    const { runner } = room((peer, command) => { log.push(`${peer}:${command.kind}`) })

    runner.remove("a")
    runner.dispatch("a", at({ type: "codec-guard-rtx" }))

    expect(runner.state("a")).toBeUndefined()
    expect(log).toEqual([])
  })

  it("runs a step's commands and keeps draining when a hook throws", () => {
    const log: string[] = []
    const errors: unknown[] = []
    const runner = new PeerRoomRunner((peer, command) => { log.push(`${peer}:${command.kind}`) }, {
      onIgnored: () => { throw new Error("telemetry broke") },
      onError: (_peer, error) => errors.push(error),
    })
    runner.add("a", connected())

    runner.dispatch("a", at({ type: "network-changed" }, 0))
    runner.dispatch("a", at({ type: "codec-guard-rtx" }))

    expect(errors).toHaveLength(1)
    expect(log).toEqual(["a:rollback", "a:send-offer"])
  })

  it("lands an older negotiation command's rejection after a newer command completed", async () => {
    const offer = deferred()
    const track = deferred()
    const { runner } = room((_peer, command) => {
      if (command.kind === "send-offer") return offer.promise
      if (command.kind === "replace-video-track") return track.promise
      return undefined
    })

    runner.dispatch("a", at({ type: "codec-guard-rtx" }))
    runner.dispatch("a", at({ type: "standby-changed", standby: true }))
    track.settle("resolved")
    await flush()
    offer.settle("rejected")
    await flush()

    expect(runner.state("a")!.openCommands["send-offer"]).toBeUndefined()
  })
  describe("stamped results (Step 4.3 stage 3c: Mesh is the runner)", () => {
    it("lands a synchronous result at once, after the rest of the program, with the site and class Mesh stamped", () => {
      const log: string[] = []
      const { runner, completions } = room((_peer, command) => {
        log.push(command.kind)
        if (command.kind === "restart-ice") return { outcome: "rejected", site: "network-change" } satisfies PeerCommandResult
        return undefined
      })

      runner.dispatch("a", at({ type: "network-changed" }))

      const restart = completions[0]!
      expect(restart).toMatchObject({ commandKind: "restart-ice", outcome: "rejected", site: "network-change" })
      // legacy's networkChanged falls through to a rebuild: the actor replaced the connection
      expect(log).toEqual(["restart-ice", "replace-connection"])
      expect(runner.state("a")!.connectionEpoch).toBe(2)
    })

    it("carries an awaited result's stamp into the completion the reducer reads", async () => {
      const { runner, completions } = room((_peer, command) => command.kind === "send-offer"
        ? Promise.resolve({ outcome: "rejected", site: "lane", reason: "hard-sdp", roundGeneration: 0 } satisfies PeerCommandResult)
        : undefined)

      runner.dispatch("a", at({ type: "codec-guard-rtx" }))
      await flush()

      expect(completions.find(({ commandKind }) => commandKind === "send-offer")).toMatchObject({ outcome: "rejected", site: "lane", reason: "hard-sdp", roundGeneration: 0 })
      // the round's immediate rebuild, as laneNegotiationFailed spends it
      expect(runner.state("a")!.connectionEpoch).toBe(2)
      expect(runner.state("a")!.budgets.negotiationImmediate).toBe(1)
    })

    it("passes a stale bail through as stale, never as resolved", async () => {
      const { runner, completions } = room((_peer, command) => command.kind === "send-offer" ? Promise.resolve("stale" as const) : undefined)

      runner.dispatch("a", at({ type: "codec-guard-rtx" }))
      await flush()

      expect(completions.find(({ commandKind }) => commandKind === "send-offer")).toMatchObject({ outcome: "stale" })
    })

    it("lands a stale result with its stamp", () => {
      const { runner, completions } = room((_peer, command) => command.kind === "send-offer" ? { outcome: "stale", site: "lane" } satisfies PeerCommandResult : undefined)

      runner.dispatch("a", at({ type: "codec-guard-rtx" }))

      expect(completions.find(({ commandKind }) => commandKind === "send-offer")).toMatchObject({ outcome: "stale", site: "lane" })
    })

    it("stamps the time Mesh heard the peer on the completion", async () => {
      const { runner, completions } = room((_peer, command) => command.kind === "send-offer"
        ? Promise.resolve({ outcome: "resolved", at: 42 } satisfies PeerCommandResult)
        : undefined)

      runner.dispatch("a", at({ type: "codec-guard-rtx" }))
      await flush()

      expect(completions.find(({ commandKind }) => commandKind === "send-offer")).toMatchObject({ outcome: "resolved", at: 42 })
    })
  })

  // design B, B1: every completion carries Mesh's clock, so the attempt a
  // completion makes is timed (#1458)
  it("stamps each completion with its clock, synchronous and awaited, and the stamped offer", async () => {
    let clock = 5_000
    const events: PeerActorEvent[] = []
    const call = deferred()
    const runner = new PeerRoomRunner((_peer, command) => {
      if (command.kind === "send-offer") return { outcome: "resolved", offer: "sent-statement" as const }
      if (command.kind === "restart-ice") return call.promise
    }, { clock: () => clock })
    runner.add("a", initial({ link: "connecting", laneOpen: true }))
    const reduce = (runner as unknown as { reduce(peer: string, event: PeerActorEvent, run?: number): void }).reduce.bind(runner)
    ;(runner as unknown as { reduce: typeof reduce }).reduce = (peer, event, run) => { events.push(event); reduce(peer, event, run) }
    runner.dispatch("a", at({ type: "local-offer-requested", lane: false, now: 4_000 }))
    expect(events.at(-1)).toMatchObject({ type: "command-completed", commandKind: "send-offer", now: 5_000, offer: "sent-statement" })
    expect(runner.state("a")!.offerSentAt).toBe(5_000)
    clock = 7_000
    runner.dispatch("a", at({ type: "network-changed", now: 6_000 }))
    call.settle("rejected")
    await flush()
    expect(events.at(-1)).toMatchObject({ type: "command-completed", commandKind: "restart-ice", now: 7_000 })
  })

  it("stamps no clock without one (a runner built before design B)", () => {
    const events: PeerActorEvent[] = []
    const runner = new PeerRoomRunner(() => ({ outcome: "resolved" }))
    runner.add("a", initial({ link: "connecting" }))
    const reduce = (runner as unknown as { reduce(peer: string, event: PeerActorEvent, run?: number): void }).reduce.bind(runner)
    ;(runner as unknown as { reduce: typeof reduce }).reduce = (peer, event, run) => { events.push(event); reduce(peer, event, run) }
    runner.dispatch("a", at({ type: "local-offer-requested", lane: false }))
    expect(events.at(-1)).not.toHaveProperty("now")
  })
})

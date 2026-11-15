// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The confirm pipeline's own proofs. #1562 itself is mesh-confirm.test.ts.
 *
 * The planted mutant is applied by swapping stepPeerActor under both the
 * abstract room (room/model.ts) and real Mesh's runner (peer-runner.ts), which
 * import the same module: `planted.step` on means both run the mutant.
 * With it on for the room only, the room's model is wrong and Mesh runs the
 * real actor: the refuted case of the design. Over the after-reload anchor the
 * pipeline names it a translator defect, since on Mesh that anchor still has
 * the pre-reload offer of a in flight and in the room it does not.
 */
// quiescence first: it traps the real timers before anything else loads
import "../mesh/quiescence"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PeerActorEvent, PeerActorState, stepPeerActor as Step } from "../../state-machines/peer-actor"

const planted = vi.hoisted(() => ({ step: null as null | ((state: PeerActorState, event: PeerActorEvent) => ReturnType<typeof Step>) }))
vi.mock("../../state-machines/peer-actor", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../state-machines/peer-actor")>()
  let inside = 0
  return {
    ...real,
    stepPeerActor: (state: PeerActorState, event: PeerActorEvent) => {
      // the mutation itself calls stepPeerActor: that call is the real one
      if (!planted.step || inside > 0) return real.stepPeerActor(state, event)
      inside += 1
      try {
        return planted.step(state, event)
      } finally {
        inside -= 1
      }
    },
  }
})

import { stepPeerActor } from "../../state-machines/peer-actor"
import { ACTOR_MUTATIONS } from "../actor/mutations"
import { shape } from "../actor/shape"
import type { RoomFinding } from "./bfs"
import { roomAnchor } from "./checks"
import { cause, confirmPlan, phonesOf, planConfirmation, planKey, projectLabel, type ConfirmPlan } from "./to-mesh"

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "findings", "1562.json"), "utf8")) as { phones: number; finding: RoomFinding }

/** Two RP10 findings of the 3-phone network-all d9 run (#1583 item l), past roomAnchor(3, "network-all", 1):
 *  D17's valid stale lane offer while a newer remote-offer SRD is queued, and a rejected restart choice. */
const NETWORK_D17 = ["choice:2:resolved", "choice:2:resolved", "h:1>0:local-offer-requested", "h:0>1:local-offer-requested", "h:0>1:complete:send-offer:lane:resolved", "lane:0>1:deliver", "h:1>0:complete:send-offer:lane:stale:lane", "advance-jb:2"]
const NETWORK_C10 = ["choice:2:resolved", "choice:2:resolved", "h:0>1:local-offer-requested", "h:1>0:local-offer-requested", "h:1>0:complete:send-offer:lane:resolved", "lane:1>0:deliver", "h:0>1:stats:peer-cannot-see-us", "choice:0:rejected"]
const networkAll = (labels: readonly string[], stuck: string): RoomFinding => ({ property: "RP10", detail: `the fair continuation did not bring every pair to steady (not steady: ${stuck})`, labels: [...roomAnchor(3, "network-all", 1).labels, ...labels] })

describe("the cause of a refutation", () => {
  it("is a model defect when Mesh accepted the room prefix of each side", () => {
    const attributed = cause({ a: ["heard", "offer"], b: ["observed"] }, { a: ["heard", "offer"], b: ["observed"] })
    expect(attributed.word).toBe("model defect")
    expect(attributed.prefix).toEqual({ matched: true, room: 3, mesh: 3 })
  })

  it("is still a model defect when Mesh accepted more shapes between the room shapes", () => {
    const attributed = cause({ a: ["heard", "offer"], b: ["observed"] }, { a: ["heard", "stale", "offer", "stale"], b: ["stale", "observed"] })
    expect(attributed.word).toBe("model defect")
    expect(attributed.prefix).toEqual({ matched: true, room: 3, mesh: 6 })
  })

  it("names b, the first room shape on b Mesh never accepted in order and its index, when a matches", () => {
    const attributed = cause({ a: ["heard"], b: ["heard", "observed", "refused"] }, { a: ["heard"], b: ["observed", "heard", "refused"] })
    expect(attributed.word).toBe("translator defect")
    expect(attributed.prefix).toEqual({ matched: false, side: "b", missing: "observed", room: 4, mesh: 4 })
    expect(attributed.detail).toBe("but b never accepted observed before the last fault (room event 2 of 3)")
  })

  it("checks a before b", () => {
    const attributed = cause({ a: ["offer"], b: ["observed"] }, { a: [], b: [] })
    expect(attributed.prefix).toMatchObject({ matched: false, side: "a", missing: "offer" })
  })

  it("needs one Mesh shape per room shape", () => {
    expect(cause({ a: ["x", "x"], b: [] }, { a: ["x"], b: [] }).prefix).toMatchObject({ matched: false, side: "a", missing: "x" })
  })

  it("says so when the room accepted nothing before the last fault", () => {
    const attributed = cause({ a: [], b: [] }, { a: ["x"], b: [] })
    expect(attributed.word).toBe("model defect")
    expect(attributed.detail).toBe("and the room accepted nothing before the last fault")
  })

  it("keys two plans apart that differ only in their room prefix, so each gets its own cause", () => {
    const plan: ConfirmPlan = { property: "RP10", pair: [0, 1], anchor: "steady", faults: [], abstractLabels: 1, prefix: { a: ["heard"], b: [] } }
    expect(planKey({ ...plan, prefix: { a: ["heard", "offer"], b: [] } })).not.toBe(planKey(plan))
  })
})

describe("projection", () => {
  it("reads the phones a label names and renames a pair's to 0 and 1", () => {
    expect(phonesOf("h:2>1:local-offer-requested")).toEqual([2, 1])
    expect(phonesOf("advance-jb:2")).toEqual([2])
    expect(phonesOf("ice:0-2:up")).toEqual([0, 2])
    expect(projectLabel("h:2>1:complete:send-offer:statement:resolved", [1, 2])).toBe("h:1>0:complete:send-offer:statement:resolved")
    expect(projectLabel("hello:1@2", [1, 2])).toBe("hello:0@1")
    expect(projectLabel("advance-jb:2", [1, 2])).toBe("advance-jb:1")
    expect(projectLabel("tick:0", [1, 2])).toBeNull()
    expect(projectLabel("w:0>2:deliver", [1, 2])).toBeNull()
  })
})

afterEach(() => {
  planted.step = null
})

/** a probe of actor/mutations.ts, scoped to its witness's event type as actor.test.ts scopes it */
function plant(mutation: string, type: PeerActorEvent["type"]): void {
  const probe = ACTOR_MUTATIONS.find((candidate) => candidate.mutation === mutation)
  if (!probe) throw new Error(`no mutation ${mutation}`)
  const before = planted.step
  planted.step = (state, event) => (event.type === type ? probe.mutate(state, event) : before ? before(state, event) : stepPeerActor(state, event))
}

/** B3b's everConnected gate on connectBy, planted in the room and under
 *  Mesh's runner: B4 heals #1562's archived finding by connectBy, so the
 *  pipeline's own proofs below replay it on the actor as it was. */
const plantB3bGate = () => plant("keep the everConnected gate on connectBy (#1562)", "clock")


/** a 2-phone reload-run finding: steady-2, phone 1's reload, then `tail` */
function reloadFinding(tail: string[]): RoomFinding {
  const anchor = roomAnchor(2, "reload", 1)
  return { property: "RP10", detail: "not steady: 0-1)", labels: [...anchor.labels, ...tail] }
}

describe("verdicts before Mesh", () => {
  it("projects #1562's three-phone finding onto pair 0-1, from the after-reload anchor, with one sld refusal", () => {
    // B4 retires the finding (mesh-confirm.test.ts); on B3b's gate it still projects
    expect(planConfirmation(fixture.finding, fixture.phones)).toMatchObject({ verdict: "abstract-3" })
    plantB3bGate()
    const plan = planConfirmation(fixture.finding, fixture.phones) as ConfirmPlan
    expect(plan).toMatchObject({ property: "RP10", pair: [0, 1], anchor: "after-reload" })
    expect(plan.faults.map((fault) => [fault.abstract, fault.name, fault.before])).toEqual([
      ["h:0>1:complete:send-offer:statement:rejected:statement-offer-sent:hard-sdp", "pc:a/*:sld:reject:OperationError", JSON.stringify({ type: "local-offer-requested", lane: false })],
    ])
  })

  it("abstract-3: the same finding read as pair 0-2's needs the third phone (the reload was phone 1's)", () => {
    const finding = { ...fixture.finding, detail: fixture.finding.detail.replace("not steady: 0-1", "not steady: 0-2") }
    expect(planConfirmation(finding, 3)).toMatchObject({ verdict: "abstract-3" })
  })

  it("names a codec guard in the witness not confirmable, before it replays anything", () => {
    // the guard is a choice of an RTX-unsafe phone (model.ts codecGuard), not a fault: no skeleton carries it
    const finding: RoomFinding = { property: "RP10", detail: "not steady: 0-1)", labels: ["hello:0@1", "h:0>1:codec-guard-rtx", "ph:0:reload"] }
    expect(planConfirmation(finding, 2)).toEqual({ verdict: "not-confirmable", why: "h:0>1:codec-guard-rtx: the codec guard has no mesh-pair counterpart in the confirm pipeline" })
  })

  it("keeps a crossed remote-offer stale trace, while rejecting its three-phone-only RP10 projection", () => {
    const verdict = planConfirmation(networkAll(NETWORK_D17, "0-1"), 3)
    expect(verdict).toMatchObject({ verdict: "abstract-3" })
    expect((verdict as { why: string }).why).toMatch(/needs the third phone/)
  })

  it("not-confirmable: a network-all witness with a rejected restart choice (design S1 proof 3)", () => {
    const verdict = planConfirmation(networkAll(NETWORK_C10, "0-1"), 3)
    expect(verdict).toMatchObject({ verdict: "not-confirmable" })
    expect((verdict as { why: string }).why).toMatch(/^choice:0:rejected: mesh-pair has no restartIce rejection/)
  })

  it("unconfirmed: a property with no mesh judge yet", () => {
    expect(planConfirmation({ ...fixture.finding, property: "RP3" }, 3)).toMatchObject({ verdict: "unconfirmed" })
  })
})

/** A rejected hard-SDP statement offer wedges the actor, so later recovery facts cannot heal it. */
function plantTerminalHardSdpRebuild(): void {
  const wedged = new WeakSet<PeerActorState>()
  planted.step = (state, event) => {
    if (wedged.has(state)) return { state, commands: [] }
    const result = stepPeerActor(state, event)
    if (event.type === "command-completed" && event.commandKind === "send-offer" && event.outcome === "rejected" && event.reason === "hard-sdp") wedged.add(result.state)
    return result
  }
}

describe("the control's moment", () => {
  it("needs the recorded accepted-event shape, not only the counterpart enabled: an impossible shape is never the moment", async () => {
    plantB3bGate()
    const plan = planConfirmation(fixture.finding, fixture.phones) as ConfirmPlan
    const impossible: ConfirmPlan = { ...plan, faults: plan.faults.map((fault) => ({ ...fault, before: JSON.stringify({ type: "no-such-event" }) })) }
    const confirmation = await confirmPlan(impossible)
    expect(confirmation.control?.momentSeen).toBe(false)
    expect(confirmation.verdict).not.toBe("confirmed:mesh-pair")
  }, 120_000)
})

describe("the pattern's self-test: planted actor mutants (design 2.3)", () => {
  it("rejects a premature forming-link drop before asking Mesh to confirm it", () => {
    const lostRejoinOffer = ["hello:1@0", "h:0>1:local-offer-requested", "h:0>1:complete:send-offer:statement:resolved", "w:0>1:drop"]
    plant("exclude timeout-away from supervision", "clock")
    const verdict = planConfirmation(reloadFinding(lostRejoinOffer), 2)
    expect(verdict).toMatchObject({ verdict: "unconfirmed" })
    expect((verdict as { why: string }).why).toMatch(/w:0>1:drop is not enabled/)
  })

  // phone 0 hears phone 1's new session, then its replacement connection's statement offer is refused
  // (hard-sdp, one fault). B4's connectBy heals the clean actor; the terminal mutant ignores it.
  const rejoinThenRefused = ["hello:1@0", "h:0>1:local-offer-requested", "h:0>1:complete:send-offer:statement:rejected:statement-offer-sent:hard-sdp"]

  it("a terminal hard-SDP mutant stays caught under Mesh's runner while clean Mesh recovers", async () => {
    expect(planConfirmation(reloadFinding(rejoinThenRefused), 2)).toMatchObject({ verdict: "unconfirmed" })
    plantTerminalHardSdpRebuild()
    const plan = planConfirmation(reloadFinding(rejoinThenRefused), 2) as ConfirmPlan
    expect(plan, JSON.stringify(plan)).toMatchObject({ anchor: "after-reload" })
    // count, on Mesh alone, the steps where the mutant decides otherwise than the real actor: it must act under Mesh's runner, not only in the room
    let steps = 0
    const mutant = planted.step!
    planted.step = (state, event) => {
      const mutated = mutant(state, event)
      const real = stepPeerActor(state, event)
      if (JSON.stringify(mutated.commands) !== JSON.stringify(real.commands) || JSON.stringify(mutated.state) !== JSON.stringify(real.state)) steps += 1
      return mutated
    }
    const confirmation = await confirmPlan(plan)
    expect(confirmation.verdict, confirmation.why).toBe("confirmed:mesh-pair")
    expect(confirmation.faults).toEqual([{ abstract: "h:0>1:complete:send-offer:statement:rejected:statement-offer-sent:hard-sdp", mesh: "pc:a/2:sld:reject:OperationError" }])
    expect(confirmation.control).toMatchObject({ steady: true, momentSeen: true })
    expect(steps, "the mutant decides otherwise than the real actor on some step under Mesh's runner").toBeGreaterThan(0)

    planted.step = null
    const clean = await confirmPlan(plan)
    expect(clean.verdict, clean.why).toBe("refuted")
    expect(clean.why).toContain("Mesh recovers")
  }, 120_000)

  // b's PC refuses a's rejoin offer as a virgin PC (one fault): the room recovers, and so does Mesh
  const virginRefusal = ["hello:1@0", "h:0>1:local-offer-requested", "h:0>1:complete:send-offer:statement:resolved", "w:0>1:deliver", "h:1>0:complete:set-remote-description:statement-offer:rejected:statement-offer-received:virgin-pc"]

  it("plans the room prefix of each side from the anchor to the edge before the last fault", () => {
    plant("exclude timeout-away from supervision", "clock")
    const plan = planConfirmation(reloadFinding(virginRefusal), 2) as ConfirmPlan
    const heard = shape({ type: "peer-heard" } as PeerActorEvent)
    expect(plan.prefix).toEqual({
      a: [
        shape({ type: "peer-session-changed", localOffer: true, negotiated: true } as PeerActorEvent),
        heard,
        shape({ type: "local-offer-requested", lane: false } as PeerActorEvent),
        shape({ type: "command-completed", commandKind: "send-offer", outcome: "resolved" } as PeerActorEvent),
      ],
      b: [heard, heard, shape({ type: "description-observed", lane: false, description: "offer", departedSession: false } as PeerActorEvent)],
    })
  })

  it("REFUTED: a room-only mutant over the after-reload anchor is a translator defect, since the Mesh anchor still carries the pre-reload offer of a", async () => {
    expect(planConfirmation(reloadFinding(virginRefusal), 2)).toMatchObject({ verdict: "unconfirmed" })
    plant("exclude timeout-away from supervision", "clock")
    const plan = planConfirmation(reloadFinding(virginRefusal), 2) as ConfirmPlan
    expect(plan.faults.map((fault) => fault.name)).toEqual(["pc:b/*:srd:reject:OperationError"])
    // Mesh runs the real actor: the room's model is the wrong one
    planted.step = null
    const confirmation = await confirmPlan(plan)
    expect(confirmation.verdict, confirmation.why).toBe("refuted")
    expect(confirmation.why).toMatch(/^refuted \(translator defect\)/)
    const sessionChanged = shape({ type: "peer-session-changed", localOffer: true, negotiated: true } as PeerActorEvent)
    expect(confirmation.prefix).toEqual({ matched: false, side: "a", missing: sessionChanged, room: 7, mesh: 4 })
    expect(confirmation.faults![0]!.mesh).toMatch(/^pc:b\/\d+:srd:reject:OperationError$/)
  }, 120_000)

  it("does not send the crossed remote-offer trace to Mesh when its RP10 result needs the third phone", () => {
    expect(planConfirmation(networkAll(NETWORK_D17, "0-1"), 3)).toMatchObject({ verdict: "abstract-3" })
  })
})

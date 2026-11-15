// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What Mesh does with each actor command (executePeerCommand in mesh.ts),
 * as the world sees it. A command whose effect returns nothing
 * never completes (peer-runner.ts:140); one that returns a result at once
 * completes in the same drain, after the rest of its program; one that
 * returns a promise completes later, as an alphabet choice.
 */
import type { PeerActorCommand, PeerActorEvent } from "../../state-machines/peer-actor"
import { freshBook, freshFacts, mayOffer, stamp, type ActorWorld, type PendingCommand } from "./world"

/** RESTART_SITES (mesh.ts:838): the site a restart-ice completion carries. */
export const RESTART_SITES: Readonly<Record<string, "supervisor-recovery" | "media-stall" | "peer-no-video" | "network-change">> = {
  "soft-disconnect": "supervisor-recovery",
  "media-stall": "media-stall",
  "peer-no-video": "peer-no-video",
  "network-change": "network-change",
}

/** A completion the runner enqueues for a result: the command's own epochs,
 *  the issuing room, and the runner's clock (Mesh's). */
export function completion(world: ActorWorld, command: Pick<PendingCommand, "kind" | "commandEpoch" | "connectionEpoch">, result: { outcome: "resolved" | "rejected" | "stale"; site?: string; reason?: string; roundGeneration?: number; at?: number; offer?: "sent-statement" | "set-lane" }): PeerActorEvent {
  return {
    ...result,
    now: world.now,
    type: "command-completed",
    commandEpoch: command.commandEpoch,
    commandKind: command.kind,
    roomEpoch: world.actor.scope.roomEpoch,
    connectionEpoch: command.connectionEpoch,
  } as PeerActorEvent
}

const queueEvent = (world: ActorWorld, event: PeerActorEvent): void => {
  world.queue.push({ type: "event", event })
}
const settleNow = (world: ActorWorld, command: PeerActorCommand, result: Parameters<typeof completion>[2]): void => queueEvent(world, completion(world, command, result))

/** offerOnStatement (mesh.ts:1505-1517): offers when Mesh may, is not already
 *  offering and the connection is stable; the actor's send-offer makes it. */
export function offerOnStatement(world: ActorWorld): PeerActorEvent | null {
  const offering = world.pending.some((entry) => entry.kind === "send-offer" && entry.connectionEpoch === world.meshConnectionEpoch)
  if (!mayOffer(world) || offering || world.mesh.signaling !== "stable") return null
  world.mesh.negotiationNeeded = false
  return { type: "local-offer-requested", lane: world.facts.laneOpen, ...stamp(world) }
}

/** rebuildPeer → addPeer (mesh.ts:3578-3617, 1603-1680): a fresh connection
 *  at the command's epoch; presence, the away mark, the down clock and the
 *  history carry over. heardOnFresh (4594) on a rejoin or stranded rebuild,
 *  and yieldedAt on a yield (4935). The initiate side creates its channel
 *  when it may offer (createOfferChannel, 3338), which needs negotiation. */
export function rebuild(world: ActorWorld, epoch: number, initiate: boolean, cause: string): void {
  const old = world.facts
  const channel = initiate && mayOffer(world)
  world.meshConnectionEpoch = epoch
  world.facts = freshFacts({ lastSignalAt: old.lastSignalAt, firstHeardAt: old.firstHeardAt, everConnected: old.everConnected, downAt: old.downAt, away: old.away }, channel)
  // the round's link proofs and no-video rebuild is Mesh's per-peer map (roundLinkProofs)
  world.facts.sawVideoThisRound = old.sawVideoThisRound
  // the held descriptions, answers, refused offer and superseded offer are
  // Mesh's per-peer maps: they outlive the connection (dropPeer clears them)
  const { statementInbound, laneInbound, statementAnswering, laneAnswering, refusedEpoch, superseded, cameraLive, leave } = world.mesh
  world.mesh = { ...freshBook(channel, { cameraLive, leave }), statementInbound, laneInbound, statementAnswering, laneAnswering, refusedEpoch, superseded }
  world.nextReadSequence = 1
  const rejoin = cause === "description-session-rejoin" || cause === "signalling-session-rejoin" || cause === "offer-refused-rejoin"
  const stranded = cause === "stranded-yield-unanswered" || cause === "stranded-offer-refused"
  if (rejoin || stranded) {
    world.facts.lastSignalAt = world.now
  }
  if (cause === "answer-timeout-yield") world.facts.yieldedAt = world.now
}

/** markBack (mesh.ts:1963-1977): the peer is shown back. */
function markBack(world: ActorWorld): void {
  if (world.facts.away === null) return
  world.facts.away = null
  if (world.facts.downAt) world.facts.downAt = world.now
}

/** Run one command against the world. `world.actor` is already the step's
 *  new state, as in the runner (the reducer counted every command issued). */
export function applyCommand(world: ActorWorld, command: PeerActorCommand): void {
  if (command.kind === "replace-connection") {
    if (world.meshConnectionEpoch !== command.connectionEpoch - 1) {
      // replaceForActor (4819-4824): not the connection the command was issued
      // after: Mesh tells the actor which one it holds, then completes stale
      // with Mesh's own last attempt on the connection it holds (4823), which
      // mirrors the actor's: the world keeps no second copy
      queueEvent(world, { type: "connection-replaced-externally", ...stamp(world) })
      settleNow(world, command, { outcome: "stale" })
      return
    }
    rebuild(world, command.connectionEpoch, command.initiate, command.cause)
    return
  }
  // executePeerCommand's epoch guard (4690)
  if (command.connectionEpoch !== world.meshConnectionEpoch) {
    settleNow(world, command, { outcome: "stale" })
    return
  }
  const pend = (extra: Partial<PendingCommand>): void => void world.pending.push({ kind: command.kind, commandEpoch: command.commandEpoch, connectionEpoch: command.connectionEpoch, ...extra })
  switch (command.kind) {
    case "restart-ice":
      // restartForActor (4769-4812) returns at once: resolved, or rejected
      // when restartIce throws. The world offers both (a choice).
      world.queue.push({ type: "choice", command: { kind: command.kind, commandEpoch: command.commandEpoch, connectionEpoch: command.connectionEpoch, cause: command.cause } })
      return
    case "set-remote-description": {
      if (command.lane) {
        // applyRemoteForActor (4943-4950); lastRecvDescAt is set before the await (2710, 2779)
        if (world.mesh.laneInbound === null) return settleNow(world, command, { outcome: "stale", site: "lane" })
        world.facts.lastRecvDescAt = world.now
        // the held description is read, not taken: a later frame replaces it
        return pend({ lane: true, description: world.mesh.laneInbound, roundGeneration: world.actor.roundGeneration })
      }
      const refused = world.mesh.refusedEpoch
      world.mesh.refusedEpoch = null
      if (refused !== null && refused + 1 === world.meshConnectionEpoch) return pend({ lane: false, description: "retry" })
      if (world.mesh.statementInbound === null) return settleNow(world, command, { outcome: "stale" })
      world.facts.lastRecvDescAt = world.now
      return pend({ lane: false, description: world.mesh.statementInbound })
    }
    case "send-answer":
      if (command.lane) {
        if (!world.mesh.laneAnswering) return settleNow(world, command, { outcome: "stale", site: "lane" })
        world.mesh.laneAnswering = false
        return pend({ lane: true, roundGeneration: world.actor.roundGeneration })
      }
      if (!world.mesh.statementAnswering) return settleNow(world, command, { outcome: "stale", site: "statement-answer" })
      world.mesh.statementAnswering = false
      return pend({ lane: false })
    case "send-offer":
      // makeStatementOffer / offerOnLane / the codec guard's offer: awaited
      return pend({ lane: command.lane, roundGeneration: world.actor.roundGeneration, cause: command.lane && world.mesh.codecGuard ? "codec-guard" : undefined })
    case "rollback":
      if (command.cause === "glare") return settleNow(world, command, { outcome: "resolved" })
      if (command.cause === "codec-guard") {
        if (!world.mesh.codecGuard) return settleNow(world, command, { outcome: "stale", site: "lane" })
        return pend({ cause: "codec-guard", roundGeneration: world.actor.roundGeneration })
      }
      if (!world.mesh.superseded) return settleNow(world, command, { outcome: "stale", site: "lane" })
      world.mesh.superseded = false
      return pend({ cause: "superseded", roundGeneration: world.actor.roundGeneration })
    case "create-channel": {
      // Mesh grants the leave, creates its channel and offers at once (4713-4718)
      if (!world.facts.hasChannel) world.facts.hasChannel = true
      const offer = offerOnStatement(world)
      if (offer) queueEvent(world, offer)
      return
    }
    case "mark-away":
      // setAway "timeout" (1933-1958): a change is told to the actor
      if (world.facts.away !== "timeout") {
        queueEvent(world, { type: "peer-away", away: "timeout", ...stamp(world) })
        world.facts.away = "timeout"
      }
      return
    case "mark-back":
      return markBack(world)
    case "sweep":
      if (world.facts.away === "timeout") markBack(world)
      return
    case "close-connection":
    case "yield-responder":
    case "ignore-offer":
    case "replace-video-track":
    case "request-keyframe":
    case "configure-ice":
      return
  }
}

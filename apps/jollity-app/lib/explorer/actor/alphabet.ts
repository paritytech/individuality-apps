// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The facts the world can deliver to the actor, as Mesh delivers them with
 * the actor driving. Each entry builds one fact from
 * the world, or null when Mesh could not send it in that world. Line numbers
 * refer to mesh.ts as it was when this was written and drift as it changes;
 * the named functions are the reliable pointer.
 *
 * Faithfulness beats coverage: an event Mesh cannot send never gets built,
 * because the candidates report (candidates.ts) reads every unreached branch as a simplification
 * candidate. Two flags say how sure each entry is:
 * - `uncertain`: Mesh can send it, but the world gates it on a coarser
 *   condition than Mesh's (a timer or a remote fact the world does not
 *   model). The reason is listed.
 * - `excluded`: Mesh never sends it with the actor driving. The entry is kept
 *   so every event type is accounted for, and builds nothing.
 * `fault: true` spends one unit of the fault budget.
 */
import type { PeerActorEvent } from "../../state-machines/peer-actor"
import { completion, offerOnStatement, rebuild, RESTART_SITES } from "./effects"
import { SAT } from "./canon"
import { cloneWorld, nextDeadline, quietUntil, setSignaling, stamp, superviseHead, type ActorWorld, type PendingCommand, type PendingDescription } from "./world"

export type AlphabetEvent = {
  key: string
  build(world: ActorWorld): { event: PeerActorEvent; world: ActorWorld } | null
  fault?: true
  uncertain?: string
  excluded?: string
}

/** Mesh's clock on every fact (stampAttemptClock). */
function stamped(world: ActorWorld, event: PeerActorEvent): PeerActorEvent {
  return event.now === undefined ? ({ ...event, now: world.now } as PeerActorEvent) : event
}

type Options = Pick<AlphabetEvent, "fault" | "uncertain" | "excluded">

/** A fact from outside the actor's own commands: enabled only between drains
 *  (no follow-up or synchronous result waits) and while the peer is kept. */
function fact(key: string, make: (next: ActorWorld) => PeerActorEvent | null, options: Options = {}): AlphabetEvent {
  return {
    key,
    ...options,
    build(world) {
      if (options.excluded || world.queue.length > 0 || world.actor.link === "closed") return null
      const next = cloneWorld(world)
      const event = make(next)
      return event ? { event: stamped(next, event), world: next } : null
    },
  }
}

const hidden = (world: ActorWorld) => world.actor.hidden
const connected = (world: ActorWorld) => world.facts.browserConnectionState === "connected"
const negotiated = (world: ActorWorld) => world.facts.localDescription || world.facts.remoteDescription
/** conn.makingOffer: an offer of ours on this connection is under way */
const offering = (world: ActorWorld) => world.pending.some((entry) => entry.kind === "send-offer" && entry.connectionEpoch === world.meshConnectionEpoch)
const laneOfferPending = (world: ActorWorld) => world.pending.some((entry) => entry.kind === "send-offer" && entry.lane && entry.connectionEpoch === world.meshConnectionEpoch)

/** onRtc's own steps before the actor hears a statement description
 *  (mesh.ts:2936-2965): the peer is heard, its away mark is cleared (a fact
 *  of its own, ahead of the description), and the description is held. */
function statementDescription(world: ActorWorld, kind: "offer" | "answer", held: boolean): PeerActorEvent {
  world.facts.lastSignalAt = world.now
  if (world.facts.firstHeardAt === null) world.facts.firstHeardAt = world.now
  world.mesh.statementInbound = kind
  const collision = !held && kind === "offer" && (offering(world) || world.mesh.signaling !== "stable")
  // a collision on the impolite side (the initiator, conn.polite = myId > peerId) is statement glare
  const event: PeerActorEvent = collision && world.actor.initiator
    ? { type: "glare-observed", remoteCarriesVideo: false, polite: false, lane: false, ...stamp(world) }
    : { type: "description-observed", departedSession: false, lane: false, description: kind, ...(held ? { newRemoteSession: { at: world.now } } : {}), ...stamp(world) }
  // onSignal tells the actor the peer was heard (observeHeard) first;
  // setAway(null) before the description: the peer-away fact goes next
  if (world.facts.away !== null) world.queue.push({ type: "event", event: { type: "peer-away", away: "back", ...stamp(world) } })
  world.queue.push({ type: "event", event: stamped(world, event) })
  return { type: "peer-heard", at: world.now, ...stamp(world) }
}

/** onLane (mesh.ts:2634-2658): the frame is held, then the actor hears it. */
function laneDescription(world: ActorWorld, kind: "offer" | "answer"): PeerActorEvent {
  world.mesh.laneInbound = kind
  if (kind === "answer") return { type: "description-observed", lane: true, description: "answer", ...stamp(world) }
  // an offer that lands while this side's lane-answer SRD is pending is not glare (mesh.ts 2342, laneRemoteAnswerPending, #1696)
  const answerPending = world.pending.some((entry) => entry.kind === "set-remote-description" && entry.lane === true && entry.description === "answer")
  const collision = offering(world) || (world.mesh.signaling === "have-local-offer" && !answerPending)
  return collision
    ? { type: "glare-observed", remoteCarriesVideo: world.mesh.laneMedia, polite: !world.actor.initiator, lane: true, ...stamp(world) }
    : { type: "description-observed", lane: true, description: "offer", ...stamp(world) }
}

/** watchMedia's read of a connected, present, active link (mesh.ts:3696-3735).
 *  It stamps our camera (localVideoLive) and recoveryDue = localVideoLive &&
 *  healDue (3719). The heal window (healDue: the keyframe hold and the heal
 *  backoff) is not modelled: it is open unless the read says `healHeld`. */
function framesRead(world: ActorWorld, frames: number, extra: { noVideoDeadline?: boolean; peerCannotSeeUs?: boolean; peerSeesUs?: boolean; healHeld?: boolean; packetsMoving?: boolean } = {}): PeerActorEvent | null {
  if (hidden(world) || !connected(world) || world.facts.away !== null || world.actor.standby) return null
  if (frames > 2) return null
  const readSequence = world.nextReadSequence
  world.nextReadSequence += 1
  const seen = world.facts.framesSeen
  // advanced(): new frames, or a lower positive count (a counter reset)
  if (frames > seen || (frames > 0 && frames < seen)) {
    world.facts.framesSeen = frames
    world.facts.sawVideoThisRound = true
  }
  return {
    type: "stats-observed",
    readSequence,
    framesDecoded: frames,
    browserConnectionState: "connected",
    noVideoDeadline: extra.noVideoDeadline ?? false,
    stallAfter: world.actor.initiator ? 2 : 6,
    recoveryDue: world.mesh.cameraLive && !extra.healHeld,
    peerCannotSeeUs: (extra.peerCannotSeeUs ?? false) && world.mesh.cameraLive && !extra.healHeld,
    // #1523: the peer's view says it decodes our video again (mesh.ts's fresh-view read)
    peerSeesUs: extra.peerSeesUs ?? false,
    cameraLive: world.mesh.cameraLive,
    haveLocalOffer: world.mesh.signaling === "have-local-offer",
    // #1917: whether the inbound packets rose since the sweep before, and the heal window without the camera gate
    packetsMoving: extra.packetsMoving ?? false,
    healDue: !extra.healHeld,
    // mesh.ts's FRAMES_STALL_SWEEPS (the explorer does not import Mesh), as stallAfter's 2 and 6 above
    frozenAskAfter: 2,
    ...stamp(world),
  }
}

const FACTS: readonly AlphabetEvent[] = [
  // ── presence ──
  fact("peer-heard", (w) => {
    // markSeen (mesh.ts:4022-4036): heard, and back after a 20 s silence
    const event: PeerActorEvent = { type: "peer-heard", at: w.now, ...stamp(w) }
    if (w.facts.away !== null && w.facts.lastSignalAt !== null && w.now - w.facts.lastSignalAt > 20_000) {
      w.queue.push({ type: "event", event: { type: "peer-away", away: "back", ...stamp(w) } })
    }
    w.facts.lastSignalAt = w.now
    if (w.facts.firstHeardAt === null) w.facts.firstHeardAt = w.now
    return event
  }),
  fact("peer-away:said", (w) => {
    // the peer's own away frame, on the open channel (setAway "said")
    if (!w.facts.laneOpen || w.facts.away === "said") return null
    w.facts.away = "said"
    return { type: "peer-away", away: "said", ...stamp(w) }
  }),
  fact("peer-away:back", (w) => {
    if (!w.facts.laneOpen || w.facts.away === null) return null
    return { type: "peer-away", away: "back", ...stamp(w) }
  }, { uncertain: "the peer's back frame on the open channel: the world lets any away mark be cleared this way, not only its own said" }),

  // ── the link (onconnectionstatechange, 1780-1830; oniceconnectionstatechange, 1740-1746) ──
  fact("connection-observed:connected", (w) => {
    if (connected(w) || !w.facts.localDescription || !w.facts.remoteDescription) return null
    w.facts.browserConnectionState = "connected"
    if (!w.facts.upAt) w.facts.upAt = w.now
    w.facts.everConnected = true
    w.facts.disconnectedAt = 0
    w.facts.downAt = 0
    const event: PeerActorEvent = { type: "connection-observed", state: "connected", ...stamp(w) }
    // setAway(null), "the ONE place a returning link clears away" (1810)
    if (w.facts.away !== null) w.queue.push({ type: "event", event: { type: "peer-away", away: "back", ...stamp(w) } })
    return event
  }),
  fact("connection-observed:connected-again", (w) => {
    if (!connected(w)) return null
    return { type: "connection-observed", state: "connected", ...stamp(w) }
  }, { uncertain: "the ICE handler's second report of a connected link (iceConnectionState completed); the world lets it arrive any time the link is connected" }),
  fact("connection-observed:disconnected", (w) => {
    if (!connected(w)) return null
    w.facts.browserConnectionState = "disconnected"
    w.facts.upAt = 0
    if (!w.facts.disconnectedAt) w.facts.disconnectedAt = w.now
    if (!w.facts.downAt && w.facts.everConnected) w.facts.downAt = w.now
    return { type: "connection-observed", state: "disconnected", ...stamp(w) }
  }, { fault: true }),
  fact("connection-observed:failed", (w) => {
    const state = w.facts.browserConnectionState
    if (state === "failed" || (state === "new" && !(w.facts.localDescription && w.facts.remoteDescription))) return null
    w.facts.browserConnectionState = "failed"
    w.facts.upAt = 0
    if (!w.facts.downAt && w.facts.everConnected) w.facts.downAt = w.now
    return { type: "connection-observed", state: "failed", ...stamp(w) }
  }, { fault: true }),
  fact("local-description:set", (w) => {
    // #1951: our offer's or answer's setLocalDescription, before its gather:
    // Mesh's onsignalingstatechange tells the actor, whatever the command's
    // completion is later
    const entry = w.pending.find((pending) => (pending.kind === "send-offer" || pending.kind === "send-answer") && pending.connectionEpoch === w.meshConnectionEpoch && !pending.localSet)
    if (!entry) return null
    entry.localSet = true
    return { type: "local-description-set", ...stamp(w) }
  }, { uncertain: "the world moves the connection's signalling at the offer's or answer's completion, where Mesh's setLocalDescription moves it before the gather; a description refused there is told all the same" }),
  fact("gathering:stalled", (w) => {
    // #1951: this connection's gathering stopped on host candidates
    // before it connected: no srflx or relay candidate, never complete. The
    // actor times it (gatherStallBy) and keeps the round's one early rebuild
    // (gatherStallRebuilds); a fresh connection gathers afresh (freshFacts).
    // The sweep that reads it: none while the page is hidden (3370)
    const state = w.facts.browserConnectionState
    if (hidden(w) || w.facts.srflxOrRelaySeen !== true || (state !== "new" && state !== "connecting")) return null
    w.facts.srflxOrRelaySeen = false
    w.facts.gatheringComplete = false
    return superviseHead(w)
  }, { fault: true }),
  fact("channel-observed:open", (w) => {
    // the offerer's channel opens once DTLS is up; the answerer adopts it (ondatachannel)
    if (!connected(w) || w.facts.laneOpen) return null
    w.facts.hasChannel = true
    w.facts.laneOpen = true
    // addLocalTracks: both sides' tracks need negotiation, which mayOffer gates
    w.mesh.negotiationNeeded = true
    return { type: "channel-observed", state: "open", ...stamp(w) }
  }, { uncertain: "the answerer's channel is the offerer's (ondatachannel); the world assumes the offerer made one whenever the link connects" }),
  fact("channel-observed:closed", (w) => {
    if (!w.facts.laneOpen) return null
    w.facts.laneOpen = false
    return { type: "channel-observed", state: "closed", ...stamp(w) }
  }, { fault: true }),

  // ── statement descriptions (onRtc, 2920-2985) ──
  fact("description:statement-offer", (w) => (w.actor.initiator ? null : statementDescription(w, "offer", false))),
  fact("description:statement-offer:from-answerer", (w) => (w.actor.initiator ? statementDescription(w, "offer", false) : null), {
    uncertain: "the remote answerer offers only with its leave to offer, which the world does not model",
  }),
  fact("description:statement-answer", (w) => (w.mesh.localOfferWire === "statement" ? statementDescription(w, "answer", false) : null)),
  fact("description:statement-offer:new-session", (w) => (negotiated(w) && !connected(w) ? statementDescription(w, "offer", true) : null), {
    uncertain: "a description from another remote connection (a rebuild or a reload of the peer's); the world allows it whenever this link negotiated and is not connected",
  }),
  fact("description:statement-answer:new-session", (w) => (negotiated(w) && !connected(w) && w.mesh.localOfferWire === "statement" ? statementDescription(w, "answer", true) : null), {
    uncertain: "a fresh remote connection answering our offer from the store; as the new-session offer",
  }),
  fact("description:departed", (w) => {
    // a late frame from a session the peer left: told, never applied (2955, 2979)
    if (!negotiated(w)) return null
    return { type: "description-observed", departedSession: true, lane: false, description: "offer", ...stamp(w) }
  }, { uncertain: "needs a session the peer left; the world allows it once this link negotiated" }),
  fact("peer-session-changed", (w) => {
    // onPeerSession (3067-3082): the peer reloaded
    const negotiatedNow = negotiated(w)
    return { type: "peer-session-changed", at: w.now, localOffer: w.mesh.localType === "offer", negotiated: negotiatedNow, ...stamp(w) }
  }, { fault: true }),

  // ── lane descriptions (onLane, 2620-2660) ──
  fact("description:lane-offer", (w) => (w.facts.laneOpen && !w.actor.initiator ? laneDescription(w, "offer") : null)),
  fact("description:lane-offer:from-answerer", (w) => (w.facts.laneOpen && w.actor.initiator ? laneDescription(w, "offer") : null), {
    uncertain: "the remote answerer renegotiates the lane only with its leave to offer (a recovery), which the world does not model",
  }),
  fact("description:lane-answer", (w) => (w.facts.laneOpen && w.mesh.localOfferWire === "lane" ? laneDescription(w, "answer") : null)),

  // ── our own offers ──
  fact("local-offer-requested", (w) => (w.mesh.negotiationNeeded ? offerOnStatement(w) : null), {
    uncertain: "onnegotiationneeded is taken as due after a channel, an open lane's tracks or an ICE restart, and held until the connection is stable",
  }),
  fact("local-offer-superseded:held", (w) => {
    if (!laneOfferPending(w) || w.mesh.superseded || w.mesh.signaling !== "have-local-offer") return null
    w.mesh.superseded = true
    return { type: "local-offer-superseded", haveLocalOffer: true, ...stamp(w) }
  }, { uncertain: "no current mesh path supersedes a local offer; kept so the model still covers the actor's command" }),
  fact("local-offer-superseded:left", (w) => {
    if (!laneOfferPending(w) || w.mesh.signaling === "have-local-offer") return null
    return { type: "local-offer-superseded", haveLocalOffer: false, ...stamp(w) }
  }, { uncertain: "as local-offer-superseded:held" }),
  fact("codec-guard-rtx", (w) => {
    if (!laneOfferPending(w) || w.mesh.codecGuard) return null
    w.mesh.codecGuard = true
    // offerOnLane ends the statement offer's answer wait once its offer is set, before the guard
    w.facts.offerSentAt = null
    return { type: "codec-guard-rtx", ...stamp(w) }
  }, { uncertain: "the codec guard runs only on engines that are not RTX-safe (codecGuardNeeded, 2442)" }),

  // ── media (watchMedia, 3664-3735) ──
  fact("stats:advance", (w) => framesRead(w, w.facts.framesSeen + 1), { uncertain: "frames are read at any time: watchMedia's 4 s cadence is not modelled" }),
  fact("stats:same", (w) => framesRead(w, w.facts.framesSeen)),
  fact("stats:frozen", (w) => framesRead(w, w.facts.framesSeen, { packetsMoving: true }), {
    uncertain: "#1917: whether the peer's packets still arrive while its frames stay flat is not modelled: any flat read may find them rising (a frozen decoder) or flat (a broken transport, stats:same)",
  }),
  fact("stats:reset", (w) => (w.facts.framesSeen === 2 ? framesRead(w, 1) : null)),
  fact("stats:no-inbound", (w) => framesRead(w, -1)),
  fact("stats:no-video-deadline", (w) => (w.facts.framesSeen === 0 && w.facts.laneOpen ? framesRead(w, 0, { noVideoDeadline: true }) : null), {
    uncertain: "the connected-without-video deadline (channelOpenAt + CONNECTED_WITHOUT_VIDEO_MS) is not modelled: once the lane is open with no frames it may be due",
  }),
  fact("stats:heal-held", (w) => framesRead(w, w.facts.framesSeen, { healHeld: true }), {
    uncertain: "the heal window (healHoldUntil, lastMediaHealAt + MEDIA_HEAL_BACKOFF_MS) is not modelled: any read may find it closed",
  }),
  fact("stats:camera-down", (w) => {
    // our camera's track ended (lib/camera's recovery reopens it): the next read stamps it
    if (!w.mesh.cameraLive) return null
    w.mesh.cameraLive = false
    return framesRead(w, w.facts.framesSeen)
  }, { uncertain: "when our camera's track ends or comes back is not modelled: the change is seen on the next driven read" }),
  fact("stats:camera-up", (w) => {
    if (w.mesh.cameraLive) return null
    w.mesh.cameraLive = true
    return framesRead(w, w.facts.framesSeen)
  }, { uncertain: "as stats:camera-down; the camera may come up after the actor started (mesh.ts:3730-3734)" }),
  fact("stats:peer-cannot-see-us", (w) => (w.actor.initiator && w.mesh.cameraLive ? framesRead(w, w.facts.framesSeen, { peerCannotSeeUs: true }) : null), {
    uncertain: "the peer's report of what it sees (peerCannotSeeUs) is not modelled: the initiator may read it on any sweep",
  }),
  fact("stats:peer-sees-us", (w) => framesRead(w, w.facts.framesSeen, { peerSeesUs: true }), {
    uncertain: "#1523: the peer's view saying it decodes our video again refills the unseen budget; any connected sweep may carry it",
  }),
  fact("stats:probe", (w) => {
    // probeFrames (4256-4275): a look outside the sweep, after the link came up;
    // not held back while the page is hidden, and told only when frames advanced
    if (!connected(w) || w.facts.framesSeen >= 2) return null
    const frames = w.facts.framesSeen + 1
    const readSequence = w.nextReadSequence
    w.nextReadSequence += 1
    w.facts.framesSeen = frames
    w.facts.sawVideoThisRound = true
    return { type: "stats-observed", readSequence, framesDecoded: frames, browserConnectionState: "connected", ...stamp(w) }
  }, { uncertain: "probeFrames runs PROBE_AFTER_UP_MS after the link comes up and for seats that are not live; the world lets it run whenever the link is connected" }),
  fact("stats:held", (w) => {
    // the sweep Mesh skips, told so the stall counts restart together (3672-3690)
    if (hidden(w) || (connected(w) && w.facts.away === null && !w.actor.standby)) return null
    return {
      type: "stats-observed",
      readSequence: w.nextReadSequence - 1,
      framesDecoded: w.facts.framesSeen,
      browserConnectionState: w.facts.browserConnectionState,
      ...stamp(w),
    }
  }),

  // ── this phone (setSelfAway 1983-2015, page-away.ts) ──
  fact("visibility:hide", (w) => (hidden(w) ? null : { type: "visibility-changed", hidden: true, ...stamp(w) })),
  fact("visibility:show", (w) => {
    if (!hidden(w)) return null
    w.now += 8000
    return { type: "visibility-changed", hidden: false, hiddenForMs: 8000, ...stamp(w) }
  }),
  fact("visibility:show-long", (w) => {
    if (!hidden(w)) return null
    w.now += 8001
    // the kick: the actors' sweeps, then supervise once (sweepAfterKick)
    w.queue.push({ type: "sweep" })
    return { type: "visibility-changed", hidden: false, hiddenForMs: 8001, ...stamp(w) }
  }),
  fact("visibility:kick-unmarked", (w) => {
    // a mesh never told it was away still sweeps after a long absence (1986-1996)
    if (hidden(w)) return null
    w.now += 8001
    w.queue.push({ type: "sweep" })
    return { type: "visibility-changed", hidden: false, hiddenForMs: 8001, keyframe: false, ...stamp(w) }
  }),
  fact("standby:on", (w) => (w.actor.standby ? null : { type: "standby-changed", standby: true, ...stamp(w) })),
  fact("standby:off", (w) => (w.actor.standby ? { type: "standby-changed", standby: false, ...stamp(w) } : null)),
  fact("network-changed", (w) => ({ type: "network-changed", ...stamp(w) }), { fault: true }),
  fact("ice-policy-changed", (w) => ({ type: "ice-policy-changed", ...stamp(w) })),
  fact("round-changed", (w) => {
    // setRound (1577-1585); two rounds a game, so generations up to 2
    if (w.actor.roundGeneration >= 2) return null
    w.facts.sawVideoThisRound = false
    return { type: "round-changed", roundGeneration: w.actor.roundGeneration + 1, ...stamp(w) }
  }),
  fact("peer-removed", (w) => ({ type: "peer-removed", ...stamp(w) })),
  fact("room-closed", (w) => ({ type: "room-closed", ...stamp(w) })),
  fact("connection-replaced-externally", (w) => {
    // rebuildAll (3642-3648, the manual Reconnect) skips a connected link
    if (connected(w)) return null
    rebuild(w, w.meshConnectionEpoch + 1, true, "manual-rebuild-all")
    return { type: "connection-replaced-externally", ...stamp(w) }
  }, { fault: true, uncertain: "Mesh's own rebuild leaves its answererMayOffer as it was (the world's mesh.leave), as on in-model paths" }),

  // ── the one clock ──
  fact("supervisor-tick", (w) => {
    // supervise() every SUPERVISE_MS, skipped while the page is hidden (3370)
    if (hidden(w) || w.mesh.tickedAt === w.now) return null
    return superviseHead(w)
  }, { uncertain: "a sweep at the current instant stands for the next one landing before any comparison flips" }),
  fact("advance:just-before", (w) => {
    // the last instant before the next flip: a sweep there decides as before
    // it, which is what pins every threshold to the millisecond
    if (hidden(w)) return null
    const next = nextDeadline(w)
    if (next === null || next - 1 <= w.now) return null
    w.now = next - 1
    return superviseHead(w)
  }),
  fact("advance", (w) => {
    if (hidden(w)) return null
    // the next flip; past the last one, the quiet until every distance saturates
    const next = nextDeadline(w) ?? quietUntil(w, SAT)
    if (next === null) return null
    w.now = next
    return superviseHead(w)
  }),
]

// ── completions ──

type Outcome = { outcome: "resolved" | "rejected" | "stale"; site?: string; reason?: string; haveLocalOffer?: boolean; displaced?: true }

interface Family {
  /** the key's middle part */
  name: string
  matches(entry: PendingCommand): boolean
  /** each outcome Mesh can return for it, with what it does to the world */
  outcomes: { result: Outcome; uncertain?: string; when?: (world: ActorWorld) => boolean; apply?: (world: ActorWorld, entry: PendingCommand) => void }[]
}

const isStatement = (description: PendingDescription) => (entry: PendingCommand) => entry.kind === "set-remote-description" && !entry.lane && entry.description === description
const hard = (site: string): Outcome[] => [{ outcome: "rejected", site, reason: "hard-sdp" }, { outcome: "rejected", site, reason: "other" }]

const FAMILIES: Family[] = [
  {
    name: "set-remote-description:statement-offer",
    matches: isStatement("offer"),
    outcomes: [
      { result: { outcome: "resolved" }, apply: (w) => { setSignaling(w, "have-remote-offer"); w.facts.remoteDescription = true; w.mesh.statementAnswering = true } },
      // applyStatementOffer (4975-4985): the refusal's class
      { result: { outcome: "rejected", site: "statement-offer-received", reason: "virgin-pc" }, when: (w) => !w.facts.remoteDescription, uncertain: "strandedEligible is read as: the connection took no remote description" },
      { result: { outcome: "rejected", site: "statement-offer-received", reason: "other" } },
      { result: { outcome: "rejected", site: "statement-offer-received", reason: "invalid-access" }, when: (w) => w.facts.remoteDescription, apply: (w) => { w.mesh.refusedEpoch = w.meshConnectionEpoch } },
    ],
  },
  {
    name: "set-remote-description:statement-retry",
    matches: isStatement("retry"),
    outcomes: [
      { result: { outcome: "resolved" }, apply: (w) => { setSignaling(w, "have-remote-offer"); w.facts.remoteDescription = true; w.mesh.statementAnswering = true } },
      ...hard("statement-offer-retried").map((result) => ({ result })),
    ],
  },
  {
    name: "set-remote-description:statement-answer",
    matches: isStatement("answer"),
    outcomes: [
      { result: { outcome: "resolved" }, apply: (w) => { setSignaling(w, "stable"); w.facts.remoteDescription = true } },
      // applyStatementAnswer stamps whether our offer still holds the connection (#1605)
      ...hard("statement-answer").map((result) => ({ result: { ...result, haveLocalOffer: true }, when: (w: ActorWorld) => w.mesh.signaling === "have-local-offer" })),
      ...hard("statement-answer").map((result) => ({ result: { ...result, haveLocalOffer: false }, when: (w: ActorWorld) => w.mesh.signaling !== "have-local-offer" })),
    ],
  },
  {
    name: "set-remote-description:lane-offer",
    matches: (entry) => entry.kind === "set-remote-description" && entry.lane === true && entry.description === "offer",
    outcomes: [
      { result: { outcome: "resolved" }, apply: (w) => { setSignaling(w, "have-remote-offer"); w.mesh.laneAnswering = true; w.mesh.laneMedia = true } },
      ...hard("lane").map((result) => ({ result })),
    ],
  },
  {
    name: "set-remote-description:lane-answer",
    matches: (entry) => entry.kind === "set-remote-description" && entry.lane === true && entry.description === "answer",
    outcomes: [
      { result: { outcome: "resolved" }, apply: (w) => { setSignaling(w, "stable"); w.mesh.laneMedia = true } },
      ...hard("lane").map((result) => ({ result })),
    ],
  },
  {
    name: "send-answer:statement",
    matches: (entry) => entry.kind === "send-answer" && !entry.lane,
    outcomes: [
      { result: { outcome: "resolved" }, apply: (w) => { setSignaling(w, "stable"); w.facts.localDescription = true; w.mesh.localType = "answer" } },
      ...hard("statement-answer").map((result) => ({ result })),
      { result: { outcome: "stale", site: "statement-answer" }, uncertain: "sendStatementAnswer's stale: the PC moved on, or a newer offer was applied, during the gather" },
      { result: { outcome: "stale", site: "statement-answer", displaced: true }, uncertain: "sendStatementAnswer's displaced: our own offer took the answer's place during the gather (#1606)" },
    ],
  },
  {
    name: "send-answer:lane",
    matches: (entry) => entry.kind === "send-answer" && entry.lane === true,
    outcomes: [
      { result: { outcome: "resolved" }, apply: (w) => { setSignaling(w, "stable"); w.mesh.localType = "answer" } },
      ...hard("lane").map((result) => ({ result })),
      { result: { outcome: "stale", site: "lane" }, uncertain: "answerLane's !sent: the lane closed or the connection moved on during the answer" },
    ],
  },
  {
    name: "send-offer:statement",
    matches: (entry) => entry.kind === "send-offer" && !entry.lane,
    outcomes: [
      { result: { outcome: "resolved" }, apply: (w) => { setSignaling(w, "have-local-offer"); w.mesh.localOfferWire = "statement"; w.facts.localDescription = true; w.mesh.localType = "offer"; w.facts.offerSentAt = w.now } },
      ...hard("statement-offer-sent").map((result) => ({ result })),
      { result: { outcome: "stale" }, uncertain: "makeStatementOffer's bail after the gather: a remote offer was rolled in meanwhile (1552-1555)" },
    ],
  },
  {
    name: "send-offer:lane",
    matches: (entry) => entry.kind === "send-offer" && entry.lane === true,
    outcomes: [
      // offerOnLane clears the statement offer's answer wait once its offer is
      // set; the codec guard's stripped offer (guardOfferForActor) does not
      { result: { outcome: "resolved" }, apply: (w, entry) => { setSignaling(w, "have-local-offer"); w.mesh.localOfferWire = "lane"; w.mesh.localType = "offer"; if (entry.cause !== "codec-guard") w.facts.offerSentAt = null; if (entry.cause === "codec-guard") w.mesh.codecGuard = false } },
      ...hard("lane").map((result) => ({ result })),
      { result: { outcome: "stale", site: "lane" }, apply: (w, entry) => { if (entry.cause !== "codec-guard") w.facts.offerSentAt = null }, uncertain: "offerOnLane's bails: the connection or the codec guard moved on during the offer (2537-2563)" },
    ],
  },
  {
    name: "rollback",
    matches: (entry) => entry.kind === "rollback",
    outcomes: [
      { result: { outcome: "resolved" }, apply: (w) => setSignaling(w, "stable") },
      ...hard("lane").map((result) => ({ result })),
    ],
  },
]

/** The pending command a completion entry finishes: the oldest of its family
 *  on the connection Mesh holds. One connection's SDP operations settle in
 *  order (the browser's operations chain), so the oldest settles first. */
function oldest(world: ActorWorld, family: Family): number {
  return world.pending.findIndex((entry) => entry.connectionEpoch === world.meshConnectionEpoch && family.matches(entry))
}

function completionEntry(family: Family, option: Family["outcomes"][number]): AlphabetEvent {
  const { result } = option
  // displaced is its own entry: sharing the plain stale key, the room (which looks entries up by
  // key, last wins) could take only one of the two (#1797)
  const key = ["complete", family.name, result.outcome, result.site, result.reason, result.displaced ? "displaced" : undefined].filter(Boolean).join(":")
  return {
    key,
    ...(result.outcome === "rejected" ? { fault: true as const } : {}),
    ...(option.uncertain ? { uncertain: option.uncertain } : {}),
    build(world) {
      if (world.queue.length > 0 || world.actor.link === "closed") return null
      const index = oldest(world, family)
      if (index < 0 || (option.when && !option.when(world))) return null
      const next = cloneWorld(world)
      const [entry] = next.pending.splice(index, 1)
      const signaling = next.mesh.signaling
      option.apply?.(next, entry!)
      const stampedResult = {
        ...result,
        ...(result.site === "lane" && result.outcome === "rejected" ? { roundGeneration: entry!.roundGeneration } : {}),
        ...(result.reason && result.site === "statement-offer-received" ? { at: next.now } : {}),
        // what Mesh stamps on its offer's result: the statement offer went out,
        // or the lane offer was set (every lane bail comes after setLocalDescription)
        ...(family.name === "send-offer:statement" && result.outcome === "resolved" ? { offer: "sent-statement" as const } : {}),
        ...(family.name === "send-offer:lane" && result.outcome !== "rejected" && entry!.cause !== "codec-guard" ? { offer: "set-lane" as const } : {}),
      }
      const done = completion(next, entry!, stampedResult)
      // #1951: Mesh's onsignalingstatechange tells the actor our local
      // description on every signalling change that has one, as the
      // operation resolves, before its completion. Our own offer or answer
      // set it before the gather (unless local-description:set told it
      // already), and a stale bail came after; an applied remote description
      // or a rollback moves the signalling with ours still in
      const local = entry!.kind === "send-offer" || entry!.kind === "send-answer"
      const told = local
        ? result.outcome !== "rejected" && !entry!.localSet
        : result.outcome === "resolved" && next.mesh.signaling !== signaling && next.facts.localDescription
      if (!told) return { event: done, world: next }
      next.queue.push({ type: "event", event: done })
      return { event: { type: "local-description-set", ...stamp(next) }, world: next }
    },
  }
}

/** A command issued on a connection Mesh has since replaced: its promise
 *  still settles, on the closed connection, as a rejection the actor's
 *  stale-connection guard drops. Not a fault: it follows the replace. */
const overtaken: AlphabetEvent = {
  key: "complete:overtaken",
  build(world) {
    if (world.queue.length > 0 || world.actor.link === "closed") return null
    const index = world.pending.findIndex((entry) => entry.connectionEpoch !== world.meshConnectionEpoch)
    if (index < 0) return null
    const next = cloneWorld(world)
    const [entry] = next.pending.splice(index, 1)
    const site = entry!.lane || entry!.kind === "rollback" ? "lane" : entry!.kind === "send-offer" ? "statement-offer-sent" : entry!.kind === "send-answer" ? "statement-answer" : entry!.description === "retry" ? "statement-offer-retried" : entry!.description === "offer" ? "statement-offer-received" : "statement-answer"
    return { event: completion(next, entry!, { outcome: "rejected", site, reason: "hard-sdp", ...(site === "lane" ? { roundGeneration: entry!.roundGeneration } : {}) }), world: next }
  },
}

/** restart-ice returns at once (restartForActor, 4769-4812): the drain's
 *  head is the choice, and nothing else happens until it is taken. */
function restartChoice(outcome: "resolved" | "rejected"): AlphabetEvent {
  return {
    key: `complete:restart-ice:${outcome}`,
    ...(outcome === "rejected" ? { fault: true as const, uncertain: "restartIce throws (an old engine without it, or a closed connection)" } : {}),
    build(world) {
      const head = world.queue[0]
      if (head?.type !== "choice" || head.command.kind !== "restart-ice") return null
      const next = cloneWorld(world)
      next.queue.shift()
      const site = RESTART_SITES[head.command.cause ?? ""]
      // restartIce: onnegotiationneeded, a fresh-ICE offer over the lane
      if (outcome === "resolved") next.mesh.negotiationNeeded = true
      return { event: completion(next, head.command, { outcome, ...(site ? { site } : {}) }), world: next }
    },
  }
}

export const ALPHABET: readonly AlphabetEvent[] = [
  ...FACTS,
  ...FAMILIES.flatMap((family) => family.outcomes.map((option) => completionEntry(family, option))),
  overtaken,
  restartChoice("resolved"),
  restartChoice("rejected"),
]

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Independent executable model of the peer actor's contract.
 *
 * It is written from Mesh's recovery ordering (the supervisor sweep, the
 * media watch, the return from the background and the SDP/glare handlers)
 * and the actor's recovery rules. It intentionally imports neither peer-actor nor its
 * reducer/types. Its strings are contract vocabulary, so an actor change
 * cannot silently update the model through a shared implementation helper.
 */

export interface ModelPeerState {
  roomEpoch: number
  roundGeneration: number
  connectionEpoch: number
  commandEpoch: number
  /** command kind -> the epoch of its latest issued, not yet completed command */
  open: Record<string, number>
  /** the link: connecting, connected, link-down, yielded or closed,
   *  moved only by the browser's word, a replace, the yield and the close */
  link: string
  away: string
  hidden: boolean
  standby: boolean
  initiator: boolean
  cameraLive: boolean
  laneOpen: boolean
  /** the wire of the peer's offer the open set-remote-description applies, or null */
  remoteOffer: string | null
  /** that offer is the one an old connection refused (refusedAndRebuilt) */
  rejoinAnswer: boolean
  lastSignalAt: number | null
  /** when recovery was last attempted on this peer, by Mesh's clock (null: never) */
  lastAttemptAt: number | null
  /** The times the supervisor's rules read, each written as Mesh writes its
   *  own, by the clock on the fact (null: never). The
   *  connection's, which a new connection starts without: */
  upAt: number | null
  connectingSince: number | null
  disconnectedAt: number | null
  lastRecvDescAt: number | null
  offerSentAt: number | null
  yieldedAt: number | null
  /** the peer's, which a new connection keeps: */
  downAt: number | null
  everConnected: boolean
  firstHeardAt: number | null
  framesSeen: number
  stallSamples: number
  framesReadSequence: number
  budgets: Record<string, number>
}
export interface ModelPeerEvent {
  type: string
  roomEpoch: number
  connectionEpoch: number
  [key: string]: unknown
}

export interface ModelPeerStep {
  state: ModelPeerState
  commands: string[]
  ignored?: string
}

export function createModelPeerState(overrides: Partial<ModelPeerState> = {}): ModelPeerState {
  return {
    roomEpoch: 1,
    roundGeneration: 0,
    connectionEpoch: 1,
    commandEpoch: 0,
    open: {},
    link: "connecting",
    away: "here",
    hidden: false,
    standby: false,
    initiator: true,
    cameraLive: true,
    laneOpen: false,
    remoteOffer: null,
    rejoinAnswer: false,
    lastSignalAt: null,
    lastAttemptAt: null,
    upAt: null,
    connectingSince: null,
    disconnectedAt: null,
    lastRecvDescAt: null,
    offerSentAt: null,
    yieldedAt: null,
    downAt: null,
    everConnected: false,
    firstHeardAt: null,
    framesSeen: 0,
    stallSamples: 0,
    framesReadSequence: 0,
    ...overrides,
    budgets: { failCount: 0, stallHeals: 0, unseenHeals: 0, noVideoRebuilds: 0, negotiationImmediate: 0, negotiationUnseen: 0, glareRebuilds: 0, ...overrides.budgets },
  }
}

/** The outcome of a rejected command, by the site that ran it (Mesh's catch
 * blocks). Anything not listed is only logged. */
type RejectionOutcome = "rebuild-offer" | "hard-sdp-rebuild" | "stranded" | "rejoin"
function rejectionOutcome(kind: string, site: unknown, reason: unknown): RejectionOutcome | "log" {
  // the supervisor's recovery and a network change rebuild when restartIce
  // throws; the media-stall and unseen heals catch it and log.
  if (kind === "restart-ice") return site === "supervisor-recovery" || site === "network-change" ? "rebuild-offer" : "log"
  // Every lane SDP await (offer, answer, the codec guard's rollback and
  // replacement offer, the superseded offer's rollback) lands in
  // laneNegotiationFailed: hard errors rebuild.
  if (site === "lane" && (kind === "send-offer" || kind === "send-answer" || kind === "set-remote-description" || kind === "rollback")) return reason === "hard-sdp" ? "hard-sdp-rebuild" : "log"
  // a remote offer: a PC with no description and no channel is re-initiated,
  // InvalidAccessError rebuilds and applies the offer again, the rest is
  // rethrown to onRtc, which logs it.
  if (site === "statement-offer-received" && kind === "set-remote-description") return reason === "virgin-pc" ? "stranded" : reason === "invalid-access" ? "rejoin" : "log"
  return "log"
}

/** Mesh.supervise for one peer at one sweep, written from its rules (Mesh
 * sends none from the background): a connected link only for a channel that never opened
 * (once a round, said-away or not, after the backoff); else a link that was up
 * and stays down past 8 s marks the peer away (#229), said-away peers are left
 * alone, only peers heard in the last 45 s or dropped in the last 30 s are
 * chased (#245), a yield unanswered 30 s re-initiates unless a channel exists
 * (#1163), then due links (failed; disconnected past 4 s; never connected and
 * due) and, failing those, an unanswered statement offer (#1020) are acted on
 * after the backoff, 3 s doubling per failure up to 20 s. */
function supervisorRule(clock: Record<string, unknown>, peer: ModelPeerState): { away: boolean; act: string } {
  const initiator = peer.initiator
  const now = clock.now as number
  // the browser's reads at the sweep; every time is the peer's own, as the facts wrote it
  const tick = clock.snapshot as Record<string, unknown>
  const at = (key: "lastSignalAt" | "firstHeardAt" | "lastRecvDescAt" | "offerSentAt" | "yieldedAt" | "connectingSince"): number | null => peer[key]
  const ago = (key: "lastSignalAt" | "lastRecvDescAt" | "offerSentAt"): number => { const value = at(key); return value === null ? Number.POSITIVE_INFINITY : now - value }
  const quiet = { away: false, act: "none" }
  // The failures, the last attempt and the round's no-video rebuild are this
  // peer's own: the tick's copies of them are Mesh's, and are not read.
  const failures = peer.budgets.failCount!
  const backoffMs = Math.min(20_000, 3_000 * Math.pow(2, failures))
  const attemptAllowed = (peer.lastAttemptAt === null ? Number.POSITIVE_INFINITY : now - peer.lastAttemptAt) >= backoffMs
  const upAt = peer.upAt, downAt = peer.downAt, disconnectedAt = peer.disconnectedAt
  if (tick.browserConnectionState === "connected") {
    const stalled = upAt !== null && now - upAt >= 23_000 && !tick.laneOpen && tick.framesSeen === 0 && !tick.sawVideoThisRound
    return stalled && peer.budgets.noVideoRebuilds === 0 && attemptAllowed ? { away: false, act: "channel-never-opened" } : quiet
  }
  const away = tick.away === null && peer.everConnected && downAt !== null && now - downAt > 8_000
  const result = (act: string) => ({ away, act })
  if (tick.away === "said") return result("none")
  const heard = ago("lastSignalAt") < 45_000
  const droppedRecently = downAt !== null && now - downAt < 30_000
  if (!heard && !droppedRecently) return result("none")
  const yieldedAt = at("yieldedAt")
  if (yieldedAt !== null && !tick.localDescription && !tick.remoteDescription && now - yieldedAt >= 30_000) return result(tick.hasChannel ? "none" : "stranded")
  let connectByDue = false
  const firstHeardAt = at("firstHeardAt")
  const connectingSince = at("connectingSince")
  if (peer.link === "connecting" && firstHeardAt !== null && connectingSince !== null && now >= Math.max(firstHeardAt, connectingSince) + 18_000 && ago("lastRecvDescAt") >= 15_000) {
    const theyDescribed = at("lastRecvDescAt") !== null
    connectByDue = initiator ? theyDescribed || ago("offerSentAt") >= 30_000 : !theyDescribed
  }
  const connection = tick.browserConnectionState
  const due = connection === "failed" || (connection === "disconnected" && disconnectedAt !== null && now - disconnectedAt > 4_000) || connectByDue
  const offerSentAt = at("offerSentAt")
  const unanswered = !due && peer.everConnected && !tick.laneOpen && Boolean(tick.haveLocalOffer) && offerSentAt !== null && now - offerSentAt >= 30_000
  if (!attemptAllowed || (!due && !unanswered)) return result("none")
  if (unanswered) return result("yield")
  const restart = connection === "disconnected" && Boolean(tick.canRestartIce) && Boolean(tick.laneOpen) && failures < 1
  return result(restart ? "restart-ice" : "rebuild")
}

export function stepModelPeer(previous: ModelPeerState, event: ModelPeerEvent): ModelPeerStep {
  if (previous.link === "closed") return { state: previous, commands: [], ignored: "closed" }
  if (event.roomEpoch !== previous.roomEpoch) return { state: previous, commands: [], ignored: "stale-room" }
  if (event.type === "connection-replaced-externally") {
    // Mesh names the connection it holds; the peer's own is old news, any other is adopted
    if (event.connectionEpoch === previous.connectionEpoch) return { state: previous, commands: [], ignored: "stale-connection" }
  } else if (event.connectionEpoch !== previous.connectionEpoch && event.type !== "round-changed" && event.type !== "room-closed") {
    return { state: previous, commands: [], ignored: "stale-connection" }
  }
  const state: ModelPeerState = { ...previous, budgets: { ...previous.budgets }, open: { ...previous.open } }
  const commands: string[] = []
  const emit = (command: string) => {
    state.commandEpoch += 1
    state.open[command.split(":")[0]!] = state.commandEpoch
    commands.push(`${command}@${state.commandEpoch}:${state.connectionEpoch}`)
  }
  // Mesh's clock when it stamped this fact. An attempt is timed by it; a
  // completion the runner reports carries none, and leaves the last attempt
  // as it was.
  const now = typeof event.now === "number" ? event.now : null
  const attempted = () => { if (now !== null) state.lastAttemptAt = now }
  // The peer is back (setAway(null), kick): its failures and its last attempt
  // were counted against a phone that was not there, and both are dropped.
  const forgive = () => { state.budgets.failCount = 0; state.lastAttemptAt = null }
  // Mesh's markBack: a peer shown away is shown here again; it is forgiven,
  // and a link that is still down starts its 8 s to "away" over from now.
  const shownBack = () => {
    if (state.away === "here") return
    state.away = "here"; forgive()
    if (state.downAt !== null && now !== null) state.downAt = now
  }
  // a new connection starts without this connection's times
  const freshConnectionTimes = () => {
    state.upAt = null; state.connectingSince = now; state.disconnectedAt = null
    state.lastRecvDescAt = null; state.offerSentAt = null; state.yieldedAt = null
  }
  // applying a description of the peer's times it on the connection
  const described = () => { if (now !== null) state.lastRecvDescAt = now }
  const replace = (cause: string, initiate: boolean, grant = false) => {
    // rebuildPeer times every fresh connection as an attempt
    attempted()
    state.open = {}
    state.remoteOffer = null; state.rejoinAnswer = false
    state.connectionEpoch += 1
    emit(`replace-connection:${cause}:${initiate ? "offer" : "answer"}${grant ? ":leave" : ""}`)
    freshConnectionTimes()
    state.link = "connecting"
    state.laneOpen = false
    state.framesSeen = 0
    state.stallSamples = 0
    state.framesReadSequence = 0
    state.budgets.stallHeals = 0
  }
  const rejoin = (cause: string, initiate: boolean, at: number, grant = false) => {
    shownBack(); state.lastSignalAt = at
    replace(cause, initiate, grant)
  }

  switch (event.type) {
    case "peer-heard": {
      const at = event.at as number
      const gap = state.lastSignalAt === null ? 0 : at - state.lastSignalAt
      if (gap > 20_000 && state.away !== "here") shownBack()
      state.lastSignalAt = at
      if (state.firstHeardAt === null) state.firstHeardAt = at
      break
    }
    case "peer-away":
      if (event.away === "back") { forgive(); shownBack(); emit("mark-back") } else state.away = event.away as string
      break
    case "description-observed": {
      if (event.departedSession) return { state: previous, commands: [], ignored: "departed-session" }
      const session = event.newRemoteSession as { at: number } | undefined
      if (session && !event.lane && event.description !== undefined) {
        const answer = event.description === "answer"
        rejoin("description-session-rejoin", answer, session.at)
        if (answer) break
        described(); emit("set-remote-description:statement")
        state.remoteOffer = "statement"; state.rejoinAnswer = false
        break
      }
      if (!event.lane) shownBack()
      // A remote lane offer is the other side renegotiating, possibly a stall
      // heal of its own: the answerer's count starts over so the two sides do
      // not both restart. A remote answer leaves the count alone.
      if (event.lane && event.description === "offer") state.stallSamples = 0
      described(); emit(`set-remote-description:${event.lane ? "lane" : "statement"}`)
      // an offer is answered once applied; an answer, or no type, is not
      state.remoteOffer = event.description === "offer" ? (event.lane ? "lane" : "statement") : null
      state.rejoinAnswer = false
      break
    }
    case "peer-session-changed":
      // a connection that negotiated nothing holds nothing of the old
      // session: onPeerSession leaves it, and the peer, as they are
      if (event.negotiated === false) return { state: previous, commands: [] }
      // onPeerSession: our offer went to the peer's old session, so the
      // answerer offers anew on the rebuilt connection. Either side rebuilds
      // as an offerer; whether it makes a channel is the leave to offer.
      // the replace grants the leave this fact decides, and only that one
      rejoin("signalling-session-rejoin", true, event.at as number, event.localOffer === true && !state.initiator)
      break
    case "connection-observed":
      if (event.state === "connected") {
        // the link is up, and was up: no grace, no drop; a peer marked away
        // is back too, and with it the last attempt is dropped (setAway(null))
        state.everConnected = true
        if (state.upAt === null && now !== null) state.upAt = now
        state.disconnectedAt = null; state.downAt = null
        shownBack()
        state.link = "connected"
        state.budgets.failCount = 0
      } else if (event.state === "connecting" || event.state === "new") {
        // checking again: the grace starts over when it next drops; the link
        // and the up time are left as they were
        if (state.disconnectedAt === null) return { state: previous, commands: [] }
        state.disconnectedAt = null
      } else {
        state.upAt = null
        if (now !== null && event.state === "disconnected" && state.disconnectedAt === null) state.disconnectedAt = now
        if (now !== null && state.everConnected && state.downAt === null) state.downAt = now
        state.link = "link-down"
      }
      break
    case "channel-observed": state.laneOpen = event.state === "open"; break
    case "local-offer-requested":
      // our own offer leaves the stall count alone: offerOnLane does not touch it
      emit(`send-offer:${event.lane ? "lane" : "statement"}`); break
    case "clock": {
      // nothing is attempted in the background
      if (state.hidden) return { state: previous, commands: [], ignored: "held" }
      const rule = supervisorRule(event, state)
      // a sweep with nothing to do is idle, and changes nothing
      if (!rule.away && rule.act === "none") return { state: previous, commands: [], ignored: "idle" }
      if (rule.away) { state.away = "timeout"; emit("mark-away") }
      // recovery: one more failure, then an ICE restart or a rebuild
      const recover = (cause: string, restart: boolean) => {
        state.budgets.failCount += 1
        attempted()
        if (restart) emit(`restart-ice:${cause}`); else replace(cause, true)
      }
      if (rule.act === "channel-never-opened") { state.budgets.noVideoRebuilds = 1; recover("channel-never-opened", false) }
      else if (rule.act === "stranded") { replace("stranded-yield-unanswered", false); if (now !== null) state.lastSignalAt = now; emit("create-channel") }
      else if (rule.act === "yield") {
        state.budgets.failCount += 1
        emit("yield-responder"); replace("answer-timeout-yield", false); state.link = "yielded"
        if (now !== null) state.yieldedAt = now
      }
      else if (rule.act === "restart-ice") recover("soft-disconnect", true)
      else if (rule.act === "rebuild") {
        const browser = (event.snapshot as Record<string, unknown>).browserConnectionState
        recover(browser === "failed" ? "failed" : browser === "disconnected" ? "soft-disconnect" : "connect-by-deadline", false)
      }
      break
    }
    case "glare-observed":
      // statement glare: the peer is back; lane glare: the stall count restarts
      if (event.lane === false) shownBack(); else state.stallSamples = 0
      if (event.lane === false || event.polite === false) emit("ignore-offer")
      else if (event.remoteCarriesVideo && state.budgets.glareRebuilds === 0) { state.budgets.glareRebuilds = 1; state.budgets.failCount += 1; replace("lane-glare-video", true) }
      else { emit("rollback:glare"); described(); emit("set-remote-description:lane"); state.remoteOffer = "lane"; state.rejoinAnswer = false }
      break
    case "codec-guard-rtx": state.offerSentAt = null; emit("rollback:codec-guard"); emit("send-offer:lane"); break
    case "local-offer-superseded":
      // offerOnLane: the rollback runs only while our offer is still set
      if (!event.haveLocalOffer) return { state: previous, commands: [] }
      emit("rollback:superseded")
      break
    case "stats-observed": {
      // our own camera, when the sweep stamps it: it may come up after the start
      if (typeof event.cameraLive === "boolean") state.cameraLive = event.cameraLive
      if (state.hidden || state.away !== "here" || state.standby || event.browserConnectionState !== "connected") {
        if (state.stallSamples === 0 && state.cameraLive === previous.cameraLive) return { state: previous, commands: [], ignored: "held" }
        state.stallSamples = 0
        return { state, commands: [], ignored: "held" }
      }
      const read = event.readSequence as number
      if (read < state.framesReadSequence) return { state: previous, commands: [], ignored: "stale-command" }
      const frames = event.framesDecoded as number
      if (event.noVideoDeadline && frames <= 0) {
        // one rebuild a round, and a second for a link our own unanswered
        // offer still holds (#1607); a spent rebuild is skipped and the sweep
        // goes on to the heals
        const allowed = event.haveLocalOffer === true ? 2 : 1
        if (state.budgets.noVideoRebuilds < allowed) {
          // through recovery: a failure
          state.budgets.noVideoRebuilds += 1; state.budgets.failCount += 1; replace("connected-no-video", true); break
        }
      }
      // no inbound video stat yet: neither heal runs, the read is still taken
      if (frames < 0) { state.framesReadSequence = read; break }
      const progress = frames > state.framesSeen || (frames > 0 && frames < state.framesSeen)
      if (progress) state.stallSamples = 0
      else if (state.framesSeen > 0) state.stallSamples += 1
      const stalled = Boolean(event.recoveryDue && event.stallAfter && state.stallSamples >= (event.stallAfter as number))
      if (stalled) {
        state.framesReadSequence = read; state.stallSamples = 0; state.budgets.stallHeals += 1
        if (state.budgets.stallHeals <= 2) emit("restart-ice:media-stall")
        else { state.budgets.failCount += 1; replace("media-stall", true) }
        break
      }
      if (progress) {
        state.framesSeen = frames; state.budgets.stallHeals = 0
      }
      state.framesReadSequence = read
      if (event.peerCannotSeeUs && state.initiator && state.cameraLive) {
        if (state.budgets.negotiationImmediate > 0 && state.budgets.negotiationUnseen === 0) { state.budgets.negotiationUnseen = 1; replace("peer-no-video-hard-sdp", true) }
        else if (state.budgets.unseenHeals < 2) { state.budgets.unseenHeals += 1; state.stallSamples = 0; emit("restart-ice:peer-no-video") }
      }
      break
    }
    case "visibility-changed":
      state.hidden = Boolean(event.hidden)
      if (state.hidden) { state.stallSamples = 0 }
      // a page never marked away asks for no keyframe, and only sweeps
      // (a timed-out peer shown back with its face, or its placeholder before any frame)
      else { if (event.keyframe !== false) emit("request-keyframe"); if ((event.hiddenForMs as number | undefined ?? 0) > 8_000) { if (state.away === "timeout") shownBack(); forgive(); emit("sweep") } }
      break
    case "standby-changed":
      state.standby = Boolean(event.standby)
      // setStandby restarts the stall count on promotion; the heals a stall
      // had are left as they are
      if (!state.standby) state.stallSamples = 0
      emit(`replace-video-track:${state.standby ? "none" : "camera"}`)
      break
    case "network-changed":
      // already on the new network, or connected on an inferred change: untouched
      if (event.onNewNetwork || (event.inferred && event.browserConnectionState === "connected")) return { state: previous, commands: [], ignored: "idle" }
      // networkChanged times the attempt on every link, restart or rebuild
      attempted()
      if (state.laneOpen) emit("restart-ice:network-change"); else replace("network-change", true)
      break
    case "ice-policy-changed": emit("configure-ice"); break
    case "round-changed":
      if ((event.roundGeneration as number) <= state.roundGeneration) return { state: previous, commands: [], ignored: "stale-command" }
      state.roundGeneration = event.roundGeneration as number
      state.budgets.noVideoRebuilds = 0; state.budgets.negotiationImmediate = 0; state.budgets.negotiationUnseen = 0; state.budgets.glareRebuilds = 0
      break
    case "command-completed": {
      const epoch = event.commandEpoch as number
      const kind = event.commandKind as string
      if (state.open[kind] !== epoch) return { state: previous, commands: [], ignored: "stale-command" }
      delete state.open[kind]
      // makeStatementOffer starts the answer wait as the offer goes out; offerOnLane ends it once its offer is set
      if (event.offer === "sent-statement" && now !== null) state.offerSentAt = now
      if (event.offer === "set-lane") state.offerSentAt = null
      if (kind === "set-remote-description") {
        // the statement and lane paths answer an applied offer
        const wire = state.remoteOffer; const rejoin = state.rejoinAnswer
        state.remoteOffer = null; state.rejoinAnswer = false
        if (wire !== null && event.outcome === "resolved") { state.rejoinAnswer = rejoin; emit(`send-answer:${wire}`); break }
      }
      if (kind === "send-answer") {
        // refusedAndRebuilt: after the sent answer, our channel and our offer
        const rejoin = state.rejoinAnswer
        state.rejoinAnswer = false
        if (rejoin && event.outcome === "resolved") { emit("create-channel"); break }
        // #1606: an answer our own offer displaced leaves the peer's offer
        // unanswered. Only the polite side (the answerer) acts, since the
        // impolite peer ignores its offer: a fresh responder applies the
        // peer's offer again (a retry, so no new description time).
        if (event.outcome === "stale" && event.displaced === true && !state.initiator) {
          replace("answer-displaced-rejoin", false); emit("set-remote-description:statement")
          state.remoteOffer = "statement"
          break
        }
      }
      if (event.outcome !== "rejected") break
      // #1605: the peer's answer refused while our offer still holds the
      // connection: rebuild as offerer now, once a round (the immediate
      // hard-SDP budget); a refusal on a connection past our offer is logged
      if (kind === "set-remote-description" && event.site === "statement-answer") {
        if (event.haveLocalOffer === true && state.budgets.negotiationImmediate === 0) {
          state.budgets.negotiationImmediate = 1
          replace("answer-refused", true)
        }
        break
      }
      const outcome = rejectionOutcome(kind, event.site, event.reason)
      if (outcome === "rebuild-offer") replace(`${event.site as string}-restart-failed`, true)
      else if (outcome === "hard-sdp-rebuild") {
        // a rejection from an earlier round, or a spent budget, is only logged
        const sameRound = event.roundGeneration === undefined || event.roundGeneration === state.roundGeneration
        if (sameRound && state.budgets.negotiationImmediate === 0) {
          state.budgets.negotiationImmediate = 1
          replace("hard-sdp-immediate", true)
        }
      } else if (outcome === "stranded") { replace("stranded-offer-refused", false); if (now !== null) state.lastSignalAt = now; emit("create-channel") }
      else if (outcome === "rejoin") {
        // a rejoin rebuild brings the peer back and stamps when it was heard;
        // the re-applied offer's answer is followed by our channel and offer
        // (a retried offer is not a new description: no time)
        shownBack()
        if (typeof event.at === "number") state.lastSignalAt = event.at
        replace("offer-refused-rejoin", false); emit("set-remote-description:statement")
        state.remoteOffer = "statement"; state.rejoinAnswer = true
      }
      break
    }
    case "connection-replaced-externally":
      // Mesh's own rebuildPeer (an ICE-policy change, a test fault seam, the
      // departed-session initiate): no command, since Mesh already rebuilt.
      // The connection's facts start over at Mesh's epoch, the peer's
      // failures and the round's rebuilds stay, the stall heals do not.
      attempted()
      state.open = {}
      state.remoteOffer = null
      state.rejoinAnswer = false
      state.connectionEpoch = event.connectionEpoch
      state.link = "connecting"
      freshConnectionTimes()
      state.laneOpen = false
      state.framesSeen = 0
      state.stallSamples = 0
      state.framesReadSequence = 0
      state.budgets.stallHeals = 0
      break
    case "peer-removed":
      // removePeer: a genuine leave forgets the failures, the last attempt, the
      // unseen heals and the peer's presence (a rejoin is a new conn, heard
      // afresh); the round's budgets stay
      forgive(); state.budgets.unseenHeals = 0
      state.away = "here"; state.lastSignalAt = null
      state.downAt = null; state.everConnected = false; state.firstHeardAt = null
    // falls through
    case "room-closed": emit("close-connection"); state.link = "closed"; break
  }
  return { state, commands }
}

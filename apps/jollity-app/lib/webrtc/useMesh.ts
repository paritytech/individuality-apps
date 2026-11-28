// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The game's WebRTC mesh as a hook: local camera in, peer streams out,
 * verdict gestures both ways over each peer's data channel, self-healing
 * connections in between (mesh.ts), with signalling over WHATEVER
 * CreateTransport the game source provides — in a host container that is
 * statement-core's statementTransport over the People-chain statement store;
 * without one the mesh stays dark and the tiles keep their placeholders. It
 * also feeds the game trace, the health snapshot and the debug log.
 *
 * ICE servers are Google STUN plus TURN credentials from
 * /api/v1/turn/issue-with-proof, fetched in ice.ts.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  NOT_STALLED,
  classifyLadder,
  iceRecoveryEpisode,
  dedupeKey,
  deriveGroupId,
  shouldEmit,
  stallTransition,
  isRtcPayload,
  type CreateTransport,
  type LadderVerdict,
  type PeerHealthSnapshot,
  type SignalTransport,
  type SignalStats,
  type StallState,
} from "@jollity/statement-core"
import { Mesh, monoNow, type AwayReason, type MeshLink, type PeerReport } from "./mesh"
import { phoneStruggles, seatState, seatTransitionMessage, settleSeat, streak, type LinkWindow, type SeatState, type ShownSeat, type Streak } from "./seat-state"
import { relayPairEvidenceSignature, rtcRates, type RtcSample } from "./rtc-stats"
import { decodeGesture, encodeGesture, type GestureTag } from "./gesture"
import { decodeClockFrame, encodeClockPing, handleClockFrame, type MeshClock } from "./clock-frame"
import { PEER_PING_MS } from "../clock-sync"
import { cameraState, holdCamera, subscribeCamera, waitForCamera } from "../camera"
import {
  fetchIceServers,
  lastIceOutcome,
  lateIceServers,
  observeTurnServers,
  retryIceServers,
  setTurnPlayerAccount,
} from "./ice"
import { devLog } from "../debug/log-store"
import { advanceAwakeClock, noteInvariant, recoveryHoldExpired, type AwakeClock } from "../invariants"
import { watchPageAway } from "./page-away"
import { pageHidden } from "../telemetry/util"
import { observeCameraOutbound } from "../camera-diagnostics"
import { setHealthSnapshot } from "../health/snapshot"
import { deviceNowMs } from "../device-clock"
import { meshOpened, observeMesh, observeRtcReport, peerAway, peerBack, peersBack, recordMeshEvent, setRtcStandby, stallChanged } from "../journeys/game-trace"
import { createSpsTap, noteSessionTap, sessionSpsTap, sessionTapTag, spsTapEngine, untappedEvent, type SpsTap, type SpsTapEngine } from "./sps-tap"
import { setSpsTapTag } from "../telemetry"
import { effectsHealthSnapshot } from "../telemetry/smoothness"
import { watchPageActivity, watchPageHidden } from "../page-lifecycle"
import { SendAdaptationDriver } from "./send-adaptation-driver"
import { SEND_ADAPTATION_OBSERVE_MS } from "./send-adaptation-classifier"
import { retryableNetworkChange, watchNetwork } from "../journeys/net-changes"
import { NoUsableNetworkPathGate } from "./path-health"
import { captureReplayObservation } from "../telemetry/replay-capture"
import { ReplayReceiverObserver } from "../telemetry/replay-receiver"
import { RtcpClockObserver } from "./rtcp-clock"
import { parseUserAgent } from "../telemetry/device"
import { readHostTelemetryContext } from "../telemetry/host-context"
import { observeLegacyDecision } from "./legacy-decision-capture"

export interface UseMeshOptions {
  /** stable room id, one per game (`g<index>`). "" disables the mesh. */
  roomKey: string
  selfId: string
  /** the co-players of the round being played (or about to be): video both ways */
  peers: string[]
  /** co-players of a LATER round of the game, linked ahead with video held back
   *  both ways until their round (Mesh.setStandby). Absent = none */
  standby?: string[]
  /** relay only when the network check found this phone's UDP blocked
   *  (path-mode.ts). Absent = every path */
  icePolicy?: RTCIceTransportPolicy
  /** relay only: the transports a relay answered on in that check
   *  (PathProbe.relayProtocols), the only TURN servers the links keep */
  relayProtocols?: readonly string[]
  /** the signalling channel — absent = mesh disabled */
  createTransport?: CreateTransport
  /** your own account as the 32 bytes the gesture body carries. Absent = no
   *  gesture leaves this device. */
  selfAccountId?: Uint8Array
  /** the 0-based round being played, for the pair id on the trace. Not a
   *  dependency: a round change does not rebuild the room; later values go to
   *  Mesh.setRound and the upload adaptation. */
  round?: number | null
  /** Authoritative game boundary. Every new game starts at Full. */
  gameIndex: number | null
  /** Global game turn used only to retain clock-independent receiver proof. */
  gameTurn: number | null
  /** the game clock, for the peer clock check. Read through a ref, never a dependency.
   *  Absent = clock frames are dropped. */
  clock?: MeshClock
}

/** One link as the waiting room reads it: up or not, over which path, and
 *  whether the peer was ever heard from. */
export interface LinkSummary {
  id: string
  conn: RTCPeerConnectionState
  /** relay when either end of the selected pair is a TURN relay */
  path: "direct" | "relay" | "unknown"
  rttMs?: number
  /** a later round's co-player: linked, video held back */
  standby: boolean
  /** the peer put an SDP/ICE endpoint on the statement store, for this link
   *  or one that came up before it was rebuilt */
  endpoint: boolean
}

/** One gesture a peer sent you, as it arrived. */
interface MeshGesture {
  /** who sent it — their mesh id, which is their account */
  peerId: string
  tag: GestureTag
  /** the round the SENDER was in */
  round: number
  /** the game turn THIS phone was in when the frame arrived, null outside a
   *  round. The frame does not carry the sender turn, so acceptance is filed
   *  per turn under this stamp, and a stamp from before the sender round
   *  counts on the first turn of that round (`acceptKey`). */
  turn: number | null
}

export interface MeshView {
  /** your own camera (mirrored by the tile) */
  localStream: MediaStream | null
  /** live peer streams by peer id */
  streams: Map<string, MediaStream>
  /** connection state by peer id */
  states: Map<string, RTCPeerConnectionState>
  /** every gesture received on this mesh, oldest first. An `Unaccept` after an
   *  `Accept` undoes it, so the ORDER is the meaning — a reader folds the list,
   *  it does not count it. */
  gestures: MeshGesture[]
  /** tell one peer your verdict on them. Sends nothing without an account to
   *  name in the body, and the mesh queues the frame while the channel is
   *  still opening. */
  sendGesture: (peerId: string, tag: GestureTag, round: number) => void
  /** peers that left (#229): the phone said it was going, or its link stayed
   *  down and nothing answered. Display only: nothing here reaches a vote. */
  away: Set<string>
  /** peers whose phone explicitly said it was leaving. Unlike timeout-away,
   *  these peers are not evidence that this browser itself is isolated. */
  saidAway: Set<string>
  /** Monotonic count of peers moving from away to back in this room. Away
   *  additions do not move it: only a real return starts a recovery grace. */
  peerReturnEpoch: number
  /** peers with LIVE evidence on the signalling channel — their presence
   *  statement (hello) or any signal from them reached us. "Who is here",
   *  before any WebRTC link closes. */
  present: Set<string>
  /** the signalling transport's own counters (statement-store health) */
  stats: () => SignalStats | undefined
  /** per-peer link state — `gaveEndpoint` says whether they ever published an
   *  SDP/ICE endpoint, which `states` cannot tell you and the health ladder
   *  needs to separate "nobody signalled" from "nobody could be reached". */
  health: () => Map<string, PeerHealthSnapshot>
  /** which layer is broken, if any. Null before the first reading. */
  verdict: LadderVerdict | null
  /** Completed gathering found only local/private candidates and no peer link. */
  noUsablePath: boolean
  /** what each co-player's tile shows (seat-state.ts), settled; a new map
   *  only when a shown state changes. Empty before the mesh opens. */
  seats: ReadonlyMap<string, SeatState>
  /** every link of the game's session, standby ones too, for the waiting
   *  room; a new array only when what it shows changes */
  links: readonly LinkSummary[]
}

/** one link's last report window: is their video flowing, and badly (weak
 *  signal), and how long our encoder was held back by the CPU */
function linkWindow(prev: RtcSample | undefined, cur: RtcSample): LinkWindow {
  const rates = rtcRates(prev, cur)
  const seconds = prev && prev.at !== undefined && cur.at !== undefined ? (cur.at - prev.at) / 1000 : 0
  const cpuLimitedS = rates.limited.cpu ?? 0
  // a phone that paused its camera is not a bad link
  if (rates.pausedS) return { video: false, weak: false, cpuLimitedS, seconds }
  const weak = (rates.inFps !== undefined && rates.inFps < 8) || (rates.lossPct ?? 0) > 10 || (rates.rttMs ?? 0) > 700 || (rates.freezeMs ?? 0) > 1000
  return { video: rates.inFps !== undefined || weak, weak, cpuLimitedS, seconds }
}

/** The waiting room's reading of the links: every link the mesh holds, a
 *  later round's on standby, with its round trip from the last report window.
 *  A link reads up once its path is known, a moment after it connects, so its
 *  dot and Network never show direct on the way to relay. */
function linkSummaries(links: ReadonlyMap<string, MeshLink>, rtts: ReadonlyMap<string, number>, active: ReadonlySet<string>): LinkSummary[] {
  return [...links].map(([id, link]) => ({
    id,
    conn: link.conn === "connected" && link.path === "unknown" ? "connecting" : link.conn,
    path: link.path,
    rttMs: rtts.get(id),
    standby: !active.has(id),
    endpoint: link.endpoint,
  }))
}

/** a relay key's transports back as the list the mesh takes ("" = none said) */
function relayTransports(key: string): string[] {
  return key ? key.split(",") : []
}

/** the ladder's blame that is OUR side: while it holds, no tile blames a peer */
const OUR_SIDE = new Set(["internet", "own-key", "turn-credentials", "store-write", "store-read", "ice", "media"])

export function useMesh({ roomKey, selfId, peers, standby, createTransport, selfAccountId, round, gameIndex, gameTurn, clock, icePolicy, relayProtocols }: UseMeshOptions): MeshView {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [streams, setStreams] = useState<Map<string, MediaStream>>(() => new Map())
  const [states, setStates] = useState<Map<string, RTCPeerConnectionState>>(() => new Map())
  const [away, setAway] = useState<Set<string>>(() => new Set())
  const awayReasonRef = useRef<Map<string, AwayReason>>(new Map())
  const [saidAway, setSaidAway] = useState<Set<string>>(() => new Set())
  const [peerReturnEpoch, setPeerReturnEpoch] = useState(0)
  const [gestures, setGestures] = useState<MeshGesture[]>([])
  const [present, setPresent] = useState<Set<string>>(() => new Set())
  // A network transition repairs every LINK in place (Mesh.networkChanged),
  // never the room: the transport stays, so it still knows the offers it has
  // delivered and a replayed old one cannot bind a fresh connection (#1020).
  // Cleanup itself cannot tell why React invalidated the room effect: the next
  // desired room says whether it went inactive, moved to another game, or unmounted.
  const desiredRoomRef = useRef(roomKey)
  // Layout setup precedes passive cleanup, so the outgoing room effect sees
  // the next desired room without mutating a ref during render.
  useLayoutEffect(() => {
    desiredRoomRef.current = roomKey
  }, [roomKey])
  const meshLifecycleGenerationRef = useRef(0)
  const localAddressesRef = useRef(new Map<string, string>())
  const transportRef = useRef<SignalTransport | undefined>(undefined)
  // TWO clocks, deliberately. `roomOpenAt` spans the whole mesh lifecycle;
  // `signalStartedAt` begins only when the transport exists and signalling can
  // actually start trying. The async chain between them — the camera prompt,
  // then fetchIceServers with its own timeout and retries — can itself outrun
  // the health grace window, so judging the signalling channel on the room
  // clock reads a healthy slow start as a dead signer.
  const roomOpenAtRef = useRef<number | null>(null)
  const signalStartedAtRef = useRef<number | null>(null)
  // health-loop state: the latest per-peer WebRTC rows, the stall clock, the
  // dedupe window, and the two "has this changed?" guards that keep a 1s poll
  // from re-rendering the game and flooding the log.
  const [verdict, setVerdict] = useState<LadderVerdict | null>(null)
  const [noUsablePath, setNoUsablePath] = useState(false)
  // the seat states: each co-player's shown state, the links flowing badly,
  // and the last quality sample per link the rates are taken against
  const [seats, setSeats] = useState<ReadonlyMap<string, SeatState>>(() => new Map())
  const [links, setLinks] = useState<readonly LinkSummary[]>([])
  const linksShapeRef = useRef("")
  // each link's last round trip, from the report window: Quality's bars
  const rttRef = useRef<ReadonlyMap<string, number>>(new Map())
  // the links as the waiting room's dots read them: from the mesh the moment
  // a link moves (Mesh onLinkChange), never a stats poll; set only on a change
  const publishLinks = useCallback((mesh: Mesh | null, active: readonly string[]) => {
    const summary = mesh ? linkSummaries(mesh.links(), rttRef.current, new Set(active)) : []
    const shape = summary.map((l) => `${l.id}:${l.conn}:${l.path}:${l.standby ? 1 : 0}:${l.endpoint ? 1 : 0}:${Math.round((l.rttMs ?? 0) / 50)}`).join("|")
    if (shape === linksShapeRef.current) return
    linksShapeRef.current = shape
    setLinks(summary)
  }, [])
  const shownRef = useRef<Map<string, ShownSeat>>(new Map())
  const weakRef = useRef<Set<string>>(new Set())
  // a link reads weak only after two bad report windows in a row, and good
  // again after two good ones: one bad window is a hiccup, not a weak signal
  const weakStreakRef = useRef<Map<string, Streak>>(new Map())
  const qualityRef = useRef<Map<string, RtcSample>>(new Map())
  // this phone cannot keep up with the video: null until a window carried any
  const struggleRef = useRef<Streak | null>(null)
  const reportRef = useRef<PeerReport[]>([])
  const stallRef = useRef<StallState>(NOT_STALLED)
  const seenRef = useRef<Map<string, number>>(new Map())
  const shapeRef = useRef("")
  // what the game trace last saw of the peers: who is present, and each one's state
  const traceShapeRef = useRef("")
  const blameRef = useRef("")
  const iceRecoveryLogRef = useRef<{
    startedAt: number
    holdLogged: boolean
    expiryLogged: boolean
  } | null>(null)
  // the recovery episode's age in time the page was actually awake: a phone
  // backgrounded or offline for a minute must not age its own hold
  const recoveryAwakeRef = useRef<AwakeClock | undefined>(undefined)
  const recoveryEpisodeRef = useRef<number | null>(null)
  // the join journey reads who is present and how many relays the room has
  const presentRef = useRef<Set<string>>(new Set())
  const turnServersRef = useRef(0)
  const markPresent = (id: string) => {
    presentRef.current.add(id)
    setPresent((current) => (current.has(id) ? current : new Set(current).add(id)))
  }
  const peersRef = useRef(peers)
  const standbyRef = useRef(standby ?? [])
  const icePolicyRef = useRef<RTCIceTransportPolicy>(icePolicy ?? "all")
  // the transports matter on relay only: a direct probe's must not rebuild a link
  const relayKey = icePolicy === "relay" ? (relayProtocols ?? []).join(",") : ""
  const relayKeyRef = useRef(relayKey)
  /** everyone this phone links to: the round's group and the later rounds' */
  const inRoster = (id: string) => peersRef.current.includes(id) || standbyRef.current.includes(id)
  const roster = () => [...peersRef.current, ...standbyRef.current]
  const roundRef = useRef(round ?? null)
  const replayGameIndexRef = useRef(gameIndex)
  // The mesh lives inside the effect, and a sender reaches it from a render.
  // The account rides a ref too, so arriving late does not rebuild the mesh.
  const meshRef = useRef<Mesh>(null)
  const [adaptation] = useState(
    () => new SendAdaptationDriver({
      nowMs: () => performance.now(),
      hidden: pageHidden,
      effectsHealth: effectsHealthSnapshot,
      networkType: () => (typeof navigator === "undefined" ? undefined : (navigator as Navigator & { connection?: { type?: string; effectiveType?: string } }).connection?.type),
    }),
  )
  const accountRef = useRef(selfAccountId)
  const clockRef = useRef(clock)
  const gameTurnRef = useRef(gameTurn)

  // Bind durable relay credentials as soon as the game source has the public
  // playing account. This starts the host-storage read ahead of the room-open
  // effect and prevents one person's relay secret crossing to another player.
  useEffect(() => setTurnPlayerAccount(selfAccountId), [selfAccountId])
  useEffect(() => {
    adaptation.setGameTurn(gameTurn)
  }, [adaptation, gameTurn])
  useEffect(() => {
    if (gameIndex !== null) adaptation.startGame(gameIndex)
  }, [adaptation, gameIndex])
  useEffect(() => watchPageHidden(() => adaptation.visibilityChanged(true), () => adaptation.visibilityChanged(false)), [adaptation])
  useEffect(() => () => adaptation.close(), [adaptation])
  // THE CAMERA IS THE APP'S, not the room's (lib/camera). A round change is a
  // new room, and closing the camera to open it again a moment later fails on
  // Android, where the camera is handed back asynchronously. So the mesh holds
  // it for as long as it can signal at all, and each room only reads it.
  useEffect(() => {
    if (!selfId || !createTransport) return
    return holdCamera("mesh")
  }, [selfId, createTransport])
  // A REOPENED CAMERA (lib/camera's recovery) is a new stream: swap its track
  // into every connection in place, so the others get your face back without
  // a renegotiation, and your tile follows.
  useEffect(
    () =>
      subscribeCamera(() => {
        const camera = cameraState()
        const mesh = meshRef.current
        if (camera.kind !== "live" || !mesh) return
        setLocalStream(camera.stream)
        void mesh.setLocalStream(camera.stream)
      }),
    [],
  )
  useEffect(() => {
    peersRef.current = peers
    standbyRef.current = standby ?? []
    setRtcStandby(standbyRef.current)
    accountRef.current = selfAccountId
    clockRef.current = clock
    gameTurnRef.current = gameTurn
    const nextRound = round ?? null
    roundRef.current = nextRound
    replayGameIndexRef.current = gameIndex
    adaptation.startRound(nextRound)
    meshRef.current?.setRound(nextRound)
  })

  // THE PHONE LEAVING: hidden or pagehide tells every peer "away" (page-away.ts)
  useEffect(() => watchPageAway(() => meshRef.current), [])

  // The shared watcher covers online/offline everywhere and
  // navigator.connection changes where Chromium exposes them. The journey
  // owns the durable telemetry; this listener owns the immediate repair.
  useEffect(() => {
    if (!roomKey || !selfId || !createTransport) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = watchNetwork((change) => {
      if (!retryableNetworkChange(change)) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        devLog("rtc", `[jollity-rtc] network ${change.event}: repairing every link`, change.attrs, "warn")
        // The next gathering is the baseline for this newly announced network;
        // its new address must not trigger a second repair for the same switch.
        localAddressesRef.current.clear()
        repairNetworkRef.current()
      }, 750)
    })
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      stop()
    }
  }, [roomKey, selfId, createTransport])

  // a new network: every link restarts or rebuilds in place, on fresh relay
  // credentials when the old ones were bound to the old path (ice.ts).
  // `addresses`: inferred from a link's new local address, not announced
  // (Mesh.networkChanged leaves the links already on it alone, #1608)
  const repairNetworkRef = useRef((addresses?: string) => {
    const mesh = meshRef.current
    if (!mesh) return
    mesh.networkChanged(addresses)
    void retryIceServers().then((servers) => {
      if (meshRef.current === mesh && servers.length > 1) mesh.setIceServers(servers, true)
    })
  })

  // THE ROSTER, applied to the live room: the round's group goes active, a
  // later round's waits on standby, and anyone with no round left with us is
  // closed and dropped from what the tiles read. A player in both rounds keeps
  // the very same connection.
  const rosterKey = `${peers.join(",")}|${(standby ?? []).join(",")}`
  useEffect(() => {
    // the wire listens to the roster alone (#1959): a co-player named after
    // the room opened is heard from here on (one gone changes nothing there)
    transportRef.current?.setPeers?.(roster())
    const mesh = meshRef.current
    if (!mesh) return
    const removed = mesh.setPeers(peersRef.current, standbyRef.current)
    publishLinks(mesh, peersRef.current) // who is on standby moved with the roster
    if (removed.length === 0) return
    devLog("rtc", "roster: no round left with", { peers: removed })
    const drop = <T,>(current: Map<string, T>) => {
      if (!removed.some((id) => current.has(id))) return current
      const next = new Map(current)
      for (const id of removed) next.delete(id)
      return next
    }
    setStreams(drop)
    setStates(drop)
    setPresent((current) => {
      if (!removed.some((id) => current.has(id))) return current
      const next = new Set(current)
      for (const id of removed) next.delete(id)
      return next
    })
    for (const id of removed) presentRef.current.delete(id)
  }, [rosterKey, publishLinks])

  // relay only, or every path: from the next gathering, so the links not yet up start over
  useEffect(() => {
    const policy = icePolicy ?? "all"
    if (icePolicyRef.current === policy && relayKeyRef.current === relayKey) return
    icePolicyRef.current = policy
    relayKeyRef.current = relayKey
    const mesh = meshRef.current
    if (!mesh) return
    mesh.setIcePolicy(policy, relayTransports(relayKey))
    mesh.rebuildAll()
  }, [icePolicy, relayKey])

  const sendGesture = useCallback((peerId: string, tag: GestureTag, round: number) => {
    const account = accountRef.current
    if (!account) return
    const bytes = encodeGesture({ tag, roundIndex: round, acceptorAccountId: account })
    if (!bytes) return // not a 32-byte account: the frame would be undecodable
    meshRef.current?.send(peerId, bytes)
  }, [])

  useEffect(() => {
    if (!roomKey || !selfId || !createTransport) return
    const roomPeers = [...peersRef.current]
    const lifecycleGeneration = ++meshLifecycleGenerationRef.current
    observeLegacyDecision({
      kind: "setup",
      at: performance.now(),
      event: "room-open-requested",
      scope: { room: roomKey, round: roundRef.current, generation: lifecycleGeneration },
      decision: "start-setup",
      landingState: "waiting-camera-and-ice",
      setup: { phase: "requested" },
    })
    devLog("rtc", "mesh opening", { room: roomKey, round: roundRef.current, generation: lifecycleGeneration, self: selfId, peers: roomPeers })
    let mesh: Mesh | undefined
    let stopTurnServers: (() => void) | undefined
    let transport: SignalTransport | undefined
    let cancelled = false
    const abort = new AbortController()
    roomOpenAtRef.current = performance.now()
    // THE SPS TAP (#629), for a sampled session: started now, so its worker
    // has answered long before the first track arrives (sps-tap.ts)
    const tapping = sessionSpsTap()
    const engine: SpsTapEngine | null = tapping === "on" ? spsTapEngine() : null
    // "pending" until a link is really tapped (sps-tap.ts nextTapTag)
    setSpsTapTag(tapping === "on" && engine ? sessionTapTag() : tapping === "on" ? "unsupported" : tapping)
    const noteTap = (what: "attached" | "failed") => {
      const next = noteSessionTap(what)
      if (next) setSpsTapTag(next)
    }
    const spsTap: SpsTap | null = engine
      ? createSpsTap({ engine, onResult: (peerId, event) => recordMeshEvent(peerId, { kind: "sps", ...event }), onWorkerFailed: () => noteTap("failed") })
      : null
    if (engine && !spsTap) noteTap("failed")
    const tapVideo = engine
      ? (peerId: string, receiver: RTCRtpReceiver) => {
          const outcome = spsTap ? spsTap.attach(peerId, receiver) : "no-worker"
          if (outcome === "attached") return noteTap("attached")
          noteTap("failed")
          recordMeshEvent(peerId, { kind: "sps", ...untappedEvent(engine, outcome) })
        }
      : undefined

    void (async () => {
      // ICE servers (Google STUN + TURN creds from
      // /api/v1/turn/issue-with-proof, see ice.ts), fetched IN PARALLEL with the camera
      // prompt so they cost no extra time on the path to the first offer
      const icePromise = fetchIceServers(abort.signal)
      // the camera outlives the room: a room torn down meanwhile leaves it
      // open for the next one. NO CAMERA, NO ROOM: a camera that cannot be
      // opened holds the room here until a retry gets it (lib/camera), and
      // the game screen tells the player why.
      const local = await waitForCamera(abort.signal)
      if (cancelled || !local) return
      observeLegacyDecision({
        kind: "setup",
        at: performance.now(),
        event: "camera-ready",
        scope: { room: roomKey, round: roundRef.current, generation: lifecycleGeneration },
        decision: "continue-setup",
        landingState: "waiting-ice",
        setup: { phase: "camera-ready" },
      })
      setLocalStream(local)

      const iceServers = await icePromise
      if (cancelled) return // cleanup already stopped the local tracks
      observeLegacyDecision({
        kind: "setup",
        at: performance.now(),
        event: "ice-ready",
        scope: { room: roomKey, round: roundRef.current, generation: lifecycleGeneration },
        decision: "open-room",
        landingState: "opening-transport",
        setup: { phase: "ice-ready" },
      })
      devLog("rtc", "mesh open", { room: roomKey, self: selfId, peers: peersRef.current, iceServers: iceServers.length })
      turnServersRef.current = Math.max(0, iceServers.length - 1)
      meshOpened(selfId, roundRef.current)

      transport = createTransport({
        base: "",
        room: roomKey,
        id: selfId,
        name: selfId,
        // LISTEN TO THE ROSTER (#1959): every co-player of every round still
        // to come, fixed by the shuffle before the pre-game countdown. The wire hears their
        // statements alone, never the whole game's
        peers: roster(),
        handlers: {
          onPeerJoined: (id: string, _name: string, seen?: boolean) => {
            if (!seen) return
            if (!inRoster(id)) return // a co-player of a round that is over
            markPresent(id)
            mesh?.addPeer(id)
            // a hello is the player still here: the supervisor heals their link while they are heard
            mesh?.markSeen(id)
          },
          onPeerLeft: () => {},
          // a peer's view of the room, off its hello (link-view.ts): arrives while the link is down
          onView: (from: string, view: string) => mesh?.onPeerView(from, view),
          // the peer reloaded (a new signalling session, #214): its old link is dead
          onPeerSession: (from: string) => mesh?.onPeerSession(from),
          onSignal: (from: string, data: unknown) => {
            if (!isRtcPayload(data) || !inRoster(from)) return
            markPresent(from)
            mesh?.markSeen(from)
            void mesh?.onRtc(from, data)
          },
        },
      })
      transportRef.current = transport
      // the grace clock starts HERE — when signalling can begin trying — not
      // when the room opened. See the two-clock note above.
      signalStartedAtRef.current = performance.now()

      mesh = new Mesh(
        selfId,
        local,
        { iceServers, iceTransportPolicy: icePolicyRef.current },
        (to, data) => transport?.send(to, data),
        (peerId, stream) => setStreams((current) => new Map(current).set(peerId, stream)),
        (peerId, state) => {
          setStates((current) => new Map(current).set(peerId, state))
          // a connected link needs little more of the store: the heartbeat
          // stops re-announcing our description to it, and slows the hello
          // once every link is up (statementTransport, rule 6)
          transport?.setLinked?.(peerId, state === "connected")
        },
        (peerId, bytes) => {
          const clockFrame = decodeClockFrame(bytes)
          if (clockFrame) {
            if (clockRef.current) {
              handleClockFrame(clockFrame, peerId, deviceNowMs(), clockRef.current, (reply) => mesh?.send(peerId, reply), (rttMs) =>
                devLog("clock", "peer clock reply dropped", { peer: peerId, rttMs: Math.round(rttMs) }))
            }
            return
          }
          const gesture = decodeGesture(bytes)
          // A peer can send anything, and the same channel carries the native
          // clients' media-state traffic, which this app does not speak. A
          // frame we cannot read is normal, so it is dropped quietly.
          if (!gesture) return
          setGestures((current) => [...current, { peerId, tag: gesture.tag, round: gesture.roundIndex, turn: gameTurnRef.current }])
        },
        {
          // the link's steps, gathering, heals and round trips go to the trace alone (lib/webrtc/rtc-events.ts)
          onRtcEvent: recordMeshEvent,
          initialVideoRung: adaptation.targetRung(),
          onVideoRungResult: (result) => adaptation.videoRungResult(result, mesh),
          onActiveVideoSendersChanged: (count) => void adaptation.activeSendersChanged(count),
          // the waiting room's dots: a link added, heard from, up, down, moved or gone
          onLinkChange: () => {
            if (mesh && meshRef.current === mesh) publishLinks(mesh, peersRef.current)
          },
          onLocalAddresses: (peerId, addresses) => {
            const fingerprint = addresses.join("|")
            const previous = localAddressesRef.current.get(peerId)
            localAddressesRef.current.set(peerId, fingerprint)
            if (!previous || previous === fingerprint) return
            devLog("rtc", "local address changed: repairing the links not on it", {
              peer: peerId,
              before: previous,
              after: fingerprint,
            }, "warn")
            localAddressesRef.current.clear()
            localAddressesRef.current.set(peerId, fingerprint)
            repairNetworkRef.current(fingerprint)
          },
          relayProtocols: relayTransports(relayKeyRef.current),
          decisionRoom: roomKey,
          decisionRoomEpoch: lifecycleGeneration,
          ...(tapVideo ? { tapVideo } : {}),
          // who sees whom (link-view.ts): the room in one order on every phone, and ours on the hello
          members: [...peersRef.current, selfId],
          onOwnView: (row) => transport?.setView?.(row),
          // The full away set drives the tile; explicit-said-away is also
          // exposed because only that reason removes a peer from the local
          // isolation verdict. A timeout-away peer is still expected here.
          onAway: (peerId, reason) => {
            if (reason) peerAway(peerId, reason)
            else peerBack(peerId)
            const previous = awayReasonRef.current.get(peerId)
            if (previous === reason || (!previous && !reason)) return
            const reasons = new Map(awayReasonRef.current)
            if (reason) reasons.set(peerId, reason)
            else reasons.delete(peerId)
            awayReasonRef.current = reasons
            setAway(new Set(reasons.keys()))
            setSaidAway(new Set([...reasons].filter(([, value]) => value === "said").map(([id]) => id)))
            const wasAway = Boolean(previous)
            if (wasAway && !reason) setPeerReturnEpoch((current) => current + 1)
          },
        },
      )
      mesh.setRound(roundRef.current)
      adaptation.attachMesh(mesh)
      meshRef.current = mesh
      // opened on STUN only (the TURN fetch outlived its 8 s): take the relays
      // when they land, so the links that need one can still get it
      if (turnServersRef.current === 0) {
        const opened = mesh
        const installTurnServers = (servers: RTCIceServer[]) => {
          if (
            cancelled ||
            meshRef.current !== opened ||
            turnServersRef.current > 0 ||
            servers.length <= 1
          )
            return
          turnServersRef.current = servers.length - 1
          opened.setIceServers(servers)
          stopTurnServers?.()
          stopTurnServers = undefined
        }
        stopTurnServers = observeTurnServers(installTurnServers)
        void lateIceServers(abort.signal).then((servers) => {
          if (servers) installTurnServers(servers)
        })
      }
      if (pageHidden()) mesh.setSelfAway(true) // the room opened while we were in the background
      // the camera may have been reopened while ICE was being fetched
      const camera = cameraState()
      if (camera.kind === "live" && camera.stream !== local) {
        setLocalStream(camera.stream)
        void mesh.setLocalStream(camera.stream)
      }
      // the roster: the group with video, a later round's on standby (setPeers links them all)
      mesh.setPeers(peersRef.current, standbyRef.current)
      observeLegacyDecision({
        kind: "setup",
        at: performance.now(),
        event: "room-opened",
        scope: { room: roomKey, round: roundRef.current, generation: lifecycleGeneration },
        decision: "setup-complete",
        landingState: "open",
        setup: { phase: "open" },
      })
    })()

    // THE PEER CLOCK CHECK: while a check window is open, ping each peer with an open channel.
    // A ping queued on a closed channel would come back with a false round trip.
    const clockPing = setInterval(() => {
      if (!mesh || !clockRef.current?.wants()) return
      const ping = encodeClockPing(deviceNowMs())
      for (const [peerId, facts] of mesh.seats()) {
        if (facts.conn === "connected" && facts.channelOpenAt > 0) {
          observeLegacyDecision({
            kind: "clock-ping",
            at: performance.now(),
            event: "peer-clock-ping",
            scope: { room: roomKey, peer: peerId, round: roundRef.current, generation: lifecycleGeneration },
            decision: "send",
            landingState: "window-open",
            clockPing: { eligible: true, windowOpen: true },
          })
          mesh.send(peerId, ping)
        }
      }
    }, PEER_PING_MS)

    return () => {
      const desiredRoom = desiredRoomRef.current
      const cause = desiredRoom === roomKey ? "unmount" : desiredRoom ? "room-change" : "inactive"
      observeLegacyDecision({
        kind: "setup",
        at: performance.now(),
        event: "room-closed",
        scope: { room: roomKey, round: roundRef.current, generation: lifecycleGeneration },
        decision: "close-room",
        landingState: "closed",
        setup: { phase: "closed", cause },
      })
      devLog("rtc", "mesh closing", { room: roomKey, generation: lifecycleGeneration, cause, self: selfId, peers: roomPeers })
      cancelled = true
      abort.abort()
      clearInterval(clockPing)
      transport?.close()
      if (mesh) adaptation.detachMesh(mesh)
      stopTurnServers?.()
      mesh?.close()
      spsTap?.close() // after the mesh: its connections no longer feed the worker
      meshRef.current = null
      transportRef.current = undefined
      roomOpenAtRef.current = null
      signalStartedAtRef.current = null
      setPresent(new Set())
      presentRef.current = new Set()
      setStreams(new Map())
      setStates(new Map())
      setNoUsablePath(false)
      setAway(new Set())
      setSaidAway(new Set())
      awayReasonRef.current = new Map()
      setPeerReturnEpoch(0)
      peersBack() // a closed room ends its away spans
      // A room is one game. Its gestures are filed by the sender's round, and
      // belong to nothing after it.
      setGestures([])
    }
  }, [roomKey, selfId, createTransport, adaptation, publishLinks])

  // ── connection health ──────────────────────────────────────────────────
  // Which layer is broken, recomputed every second from facts the mesh already
  // produces. `report()` awaits getStats, so it refreshes on a slower tick
  // behind an overlap guard and the verdict reads its latest snapshot.
  //
  // A poll loop that logged every tick would bury the export it exists to
  // fill, so a line is written ONLY when the blame changes — entry, exit, or
  // one cause replacing another.
  useEffect(() => {
    if (!roomKey || !selfId || !createTransport) return
    let stop = false
    let reporting = false
    let noUsablePathGate = new NoUsableNetworkPathGate()
    let pathGateMesh: Mesh | null = null
    let receiverCapture: ReplayReceiverObserver | undefined
    let rtcpClockCapture: RtcpClockObserver | undefined
    const stopReceiverActivity = watchPageActivity((hidden, suspended) => {
      if (hidden || suspended) receiverCapture?.reset()
    })
    const pairEvidence = new Map<string, { signature: string; loggedAt: number }>()

    const refresh = async () => {
      const mesh = meshRef.current
      if (reporting || !mesh) return
      if (mesh !== pathGateMesh) {
        pathGateMesh = mesh
        noUsablePathGate = new NoUsableNetworkPathGate()
        pairEvidence.clear()
        receiverCapture = new ReplayReceiverObserver(
          { roomKey, selfId, meshGeneration: meshLifecycleGenerationRef.current },
          (payload) => captureReplayObservation("receiver-quality", payload),
        )
        rtcpClockCapture?.flush()
        let browserBuild = "other/unknown"
        let hostBuild = "unknown"
        try {
          const browser = parseUserAgent(typeof navigator === "undefined" ? "" : navigator.userAgent, typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints)
          const host = readHostTelemetryContext()
          browserBuild = `${browser.engine}/${browser.engineVersion || "unknown"}`
          hostBuild = host?.appBuild ?? host?.appVersion ?? "unknown"
        } catch { /* build context is diagnostic too; unknown is still evidence */ }
        rtcpClockCapture = new RtcpClockObserver(
          {
            roomKey,
            groupId: deriveGroupId([...peersRef.current, selfId]),
            selfId,
            meshGeneration: meshLifecycleGenerationRef.current,
            browserBuild,
            hostBuild,
          },
          (payload) => captureReplayObservation("rtcp-clock-offset", payload),
        )
      }
      reporting = true
      try {
        const replayRoundAtRequest = roundRef.current
        const replayGameAtRequest = replayGameIndexRef.current
        const replayPollStartedMs = monoNow()
        const rows = await mesh.report()
        if (stop) return
        // A replaced mesh can finish an old report. Only its current instance
        // feeds replay, and capture never awaits or changes the media path.
        if (meshRef.current === mesh && replayGameIndexRef.current === replayGameAtRequest) {
          try {
            const completedMonotonicMs = monoNow()
            receiverCapture?.observe(rows, completedMonotonicMs, pageHidden(), replayGameAtRequest, roundRef.current, {
              startedMonotonicMs: replayPollStartedMs, completedMonotonicMs,
              roundAtRequest: replayRoundAtRequest, roundAtCompletion: roundRef.current,
            })
            rtcpClockCapture?.observe(rows, replayGameAtRequest, replayRoundAtRequest)
          } catch { /* telemetry must never interrupt the existing health loop */ }
        }
        // everything below reads the round's group alone: a standby link holds
        // its video back on purpose, so it is no blame, no seat and no coverage.
        // The waiting room reads them all.
        const activePeers = new Set(peersRef.current)
        const activeRows = rows.filter((row) => activePeers.has(row.id))
        // the round trips Quality reads: the dots moved on the mesh's events
        rttRef.current = new Map(rows.flatMap((row) => (row.quality?.rttMs === undefined ? [] : [[row.id, row.quality.rttMs] as const])))
        publishLinks(meshRef.current, peersRef.current)
        reportRef.current = activeRows
        for (const row of rows) {
          const q = row.quality
          if (!q?.transportId || q.localType !== "relay") continue
          const now = deviceNowMs()
          const signature = relayPairEvidenceSignature(q)
          const previous = pairEvidence.get(row.id)
          // The selected relay path changes rarely. Preserve the first row,
          // every lifecycle/path change, and a 15 s counter heartbeat without
          // flooding the durable game log on each 3 s health poll.
          if (previous?.signature === signature && now - previous.loggedAt < 15_000) continue
          pairEvidence.set(row.id, { signature, loggedAt: now })
          const evidence = {
            at: q.at,
            link: q.link,
            pair: q.transportId,
            state: q.pairState,
            nominated: q.nominated,
            local: q.localType,
            remote: q.remoteType,
            protocol: q.protocol,
            relayProtocol: q.relayProtocol,
            relayHost: q.relayHost,
            relayEndpoint: q.relayEndpoint,
            bytesSent: q.transportBytesSent,
            bytesReceived: q.transportBytesReceived,
            packetsSent: q.transportPacketsSent,
            packetsReceived: q.transportPacketsReceived,
            requestsSent: q.requestsSent,
            responsesReceived: q.responsesReceived,
            consentRequestsSent: q.consentRequestsSent,
            rttMs: q.rttMs,
            lastPacketReceivedAt: q.lastPacketReceivedAt,
          }
          devLog("rtc", `[jollity-rtc] pair ${row.id} ${JSON.stringify(evidence)}`)
        }
        setNoUsablePath(noUsablePathGate.update(rows, monoNow()))
        // the link-quality metrics ride this same getStats: no timer of their own
        observeRtcReport(activeRows)
        observeCameraOutbound(activeRows)
        await adaptation.observeReports(activeRows)
        // and the weak signal: a bad window on a link that decodes video. When
        // every such link is bad at once, the common factor is this phone
        const windows: LinkWindow[] = []
        for (const row of activeRows) {
          if (!row.quality) continue
          const prev = qualityRef.current.get(row.id)
          const window = linkWindow(prev?.link === row.quality.link ? prev : undefined, row.quality)
          const weak = streak(weakStreakRef.current.get(row.id) ?? { on: false, count: 0 }, window.weak)
          weakStreakRef.current.set(row.id, weak)
          if (weak.on) weakRef.current.add(row.id)
          else weakRef.current.delete(row.id)
          qualityRef.current.set(row.id, row.quality)
          windows.push(window)
        }
        if (windows.some((w) => w.video || w.cpuLimitedS > 0) || struggleRef.current) {
          const was = struggleRef.current ?? { on: false, count: 0 }
          const next = streak(was, phoneStruggles(windows))
          if (next.on !== was.on) devLog("rtc", `[jollity-rtc] this phone ${next.on ? "struggles with" : "keeps up with"} the video`)
          struggleRef.current = next
        }
      } catch {
        /* getStats can throw as a peer is torn down; the next tick retries */
      } finally {
        reporting = false
      }
    }

    // each co-player's seat, settled; a change is a line in the debug log
    const settleSeats = () => {
      const mesh = meshRef.current
      if (!mesh) return
      const now = monoNow()
      const facts = mesh.seats()
      // our own trouble blames nobody: offline, hidden, or the ladder's blame
      // (last tick's) on our side of the room
      const selfSuspect = pageHidden() || (typeof navigator !== "undefined" && !navigator.onLine) || OUR_SIDE.has(blameRef.current)
      // no own key: no co-player gets a frame of ours, so none of them is to blame
      const sealed = transportRef.current?.stats?.()?.sealed
      const ownKeyMissing = !!sealed && sealed.ownKeyMissing > 0 && !sealed.ownKeyFound
      // a phone that cannot keep up says so once, in the notice, not on every tile
      const struggling = struggleRef.current?.on === true
      const heardFrom = signalStartedAtRef.current ?? now
      let changed = false
      for (const peer of peersRef.current) {
        const prev = shownRef.current.get(peer)
        const weak = weakRef.current.has(peer) && !struggling
        const next = settleSeat(prev, seatState(facts.get(peer), { now, heardFrom, selfSuspect, ownKeyMissing, weak }), now)
        shownRef.current.set(peer, next)
        if (prev?.state === next.state) continue
        changed = true
        devLog("rtc", seatTransitionMessage(peer, prev?.state, next.state, facts.get(peer)?.signalingState))
      }
      if (changed) setSeats(new Map([...shownRef.current].map(([peer, shown]) => [peer, shown.state])))
    }

    const compute = () => {
      settleSeats()
      // the wall time the ladder reports, step-free: the transport stamps its
      // stats on the same clock (lib/game-source.ts), so a stepped phone
      // clock cannot age a fresh submit into a stall (#331)
      const now = deviceNowMs()
      const mono = performance.now() // elapsed times on the monotonic clock
      const stats = transportRef.current?.stats?.() ?? null
      const health = meshRef.current?.health()
      const activePeers = new Set(peersRef.current)
      const healthRows = [...(health?.entries() ?? [])].filter(([id]) => activePeers.has(id)).map(([, row]) => row)
      const next = classifyLadder({
        online: typeof navigator === "undefined" || navigator.onLine,
        ice: lastIceOutcome(),
        stats,
        signalElapsedMs: signalStartedAtRef.current ? mono - signalStartedAtRef.current : 0,
        peers: reportRef.current,
        health: healthRows,
        struggling: struggleRef.current?.on,
        connectionNowMs: mono,
        nowMs: now,
      })

      const recovery = iceRecoveryEpisode(healthRows, mono)
      if (recovery) {
        let logged = iceRecoveryLogRef.current
        if (!logged || logged.startedAt !== recovery.startedAt) {
          logged = { startedAt: recovery.startedAt, holdLogged: false, expiryLogged: false }
        }
        // the episode's age as the page experienced it: a hidden page or a
        // phone off the network is not the self-heal failing to land, and a
        // frozen page's timers did not run at all (settleSeats' selfSuspect)
        const awake = !pageHidden() && (typeof navigator === "undefined" || navigator.onLine)
        if (recoveryEpisodeRef.current !== recovery.startedAt) {
          recoveryEpisodeRef.current = recovery.startedAt
          recoveryAwakeRef.current = undefined
        }
        recoveryAwakeRef.current = advanceAwakeClock(recoveryAwakeRef.current, mono, awake)
        const heldAwakeMs = recoveryAwakeRef.current.awakeMs
        const iceRung = next.rungs.find((rung) => rung.layer === "ice")
        if (recovery.held && iceRung?.detail.startsWith("self-heal in progress") && !logged.holdLogged) {
          devLog("health", "ice verdict held: self-heal in progress", {
            episodeAgeMs: Math.round(recovery.ageMs),
            peersRecovering: recovery.peersRecovering,
          })
          logged.holdLogged = true
        } else if (!recovery.held && iceRung?.status === "fail" && !logged.expiryLogged) {
          devLog(
            "health",
            "ice verdict hold expired",
            {
              episodeAgeMs: Math.round(recovery.ageMs),
              peersRecovering: recovery.peersRecovering,
            },
            "warn",
          )
          logged.expiryLogged = true
        }
        // INVARIANT (lib/invariants.ts): the recovery EPISODE outlived two
        // graces OF AWAKE TIME. One grace is the ladder's own allowance for an
        // established link to come back; an episode still open after two is a
        // self-heal that never lands, and the report should say so. The clock
        // counts visible + online + running time only, so the player's own
        // backgrounding or lost network never ages the hold (their trouble is
        // not the mesh's failure). The line carries both ages.
        if (recoveryHoldExpired(heldAwakeMs)) {
          noteInvariant({
            kind: "recovery-hold-never-ends",
            valueMs: heldAwakeMs,
            detail: {
              "invariant.peers_recovering": recovery.peersRecovering,
              "invariant.episode_age_ms": Math.round(recovery.ageMs),
            },
          })
        }
        iceRecoveryLogRef.current = logged
      } else {
        const logged = iceRecoveryLogRef.current
        const episodeStillOpen =
          logged !== null &&
          healthRows.some(
            (row) => row.recovering && row.recoveryStartedAt === logged.startedAt,
          )
        if (!episodeStillOpen) iceRecoveryLogRef.current = null
      }

      // re-render only on a real change of shape: this runs every second, and
      // the notice it drives sits over live gameplay
      const shape = next.rungs.map((r) => `${r.layer}:${r.status}`).join("|")
      if (shape !== shapeRef.current) {
        shapeRef.current = shape
        setVerdict(next)
      }
      setHealthSnapshot({
        selfId,
        at: now,
        verdict: next,
        stats,
        sessions: transportRef.current?.sessionStats?.() ?? null,
        peers: reportRef.current,
        signalElapsedMs: signalStartedAtRef.current ? mono - signalStartedAtRef.current : 0,
        inCallElapsedMs: roomOpenAtRef.current ? mono - roomOpenAtRef.current : 0,
        turnServers: turnServersRef.current,
      })
      // the trace cares about a peer arriving, leaving or changing state, not
      // about every tick that finds the same thing. The candidate pair counts:
      // it lands from the slower getStats loop after the peer connected, and
      // the peer's rtc.peer step waits for it
      if (health) {
        const traceShape = [
          [...health].map(([id, row]) => `${id}:${row.conn}`).join("|"),
          [...presentRef.current].join("|"),
          reportRef.current.map((row) => `${row.id}:${row.pair ?? ""}`).join("|"),
        ].join("/")
        if (traceShape !== traceShapeRef.current) {
          traceShapeRef.current = traceShape
          observeMesh({
            states: new Map([...health].map(([id, row]) => [id, row.conn])),
            reports: reportRef.current,
            present: presentRef.current,
            turnServers: turnServersRef.current,
          })
        }
      }

      const stall = stallTransition({
        blame: next.blame,
        now,
        prev: stallRef.current,
        // no manual reconnect exists yet, so every recovery reads as self-heal
        // — which is the honest answer until a remedy button lands
        lastReconnectAt: 0,
        stats,
        context: { groupId: deriveGroupId([...peersRef.current, selfId]) },
      })
      stallRef.current = stall.next
      if (stall.event) stallChanged({ kind: stall.event.kind, layer: stall.event.layer, detail: stall.event.detail })
      if (stall.event && shouldEmit(seenRef.current, dedupeKey(stall.event), now)) {
        devLog(
          "health",
          `${stall.event.kind}: ${stall.event.layer}`,
          stall.event.detail,
          stall.event.kind === "connection_stalled" ? "error" : "info",
        )
      } else if (next.blame && stallRef.current.since !== 0 && next.blame.layer !== blameRef.current) {
        // one cause replacing another WITHIN a stall — not a transition, but
        // the most useful line in the log when a fault moves down the ladder
        devLog("health", `blame moved: ${blameRef.current} → ${next.blame.layer}`, { detail: next.blame.detail }, "warn")
      }
      blameRef.current = next.blame?.layer ?? ""
    }

    // and looks at the links whose seat is not live, settling again on new frames (Mesh.probeStaleFrames, #672)
    const tick = () => {
      compute()
      const mesh = meshRef.current
      if (!mesh) return
      void mesh.probeStaleFrames().then((found) => {
        if (found && !stop && meshRef.current === mesh) settleSeats()
      })
    }

    void refresh()
    compute()
    const verdictTimer = setInterval(tick, 1000)
    const reportTimer = setInterval(() => void refresh(), SEND_ADAPTATION_OBSERVE_MS)
    return () => {
      stop = true
      rtcpClockCapture?.flush()
      stopReceiverActivity()
      clearInterval(verdictTimer)
      clearInterval(reportTimer)
      // a teardown mid-stall must not leak into the next room as a phantom
      // "still stalled" or an inflated stallMs on a later recovery
      reportRef.current = []
      linksShapeRef.current = ""
      rttRef.current = new Map()
      setLinks([])
      shownRef.current = new Map()
      weakRef.current = new Set()
      weakStreakRef.current = new Map()
      qualityRef.current = new Map()
      struggleRef.current = null
      setSeats(new Map())
      stallRef.current = NOT_STALLED
      shapeRef.current = ""
      traceShapeRef.current = ""
      blameRef.current = ""
      iceRecoveryLogRef.current = null
      recoveryAwakeRef.current = undefined
      recoveryEpisodeRef.current = null
      setVerdict(null)
      setNoUsablePath(false)
      // The SNAPSHOT deliberately survives teardown. /connection-help is a
      // route, so the mesh is already gone by the time it mounts — the last
      // reading before the room closed is precisely the one that explains why
      // the player is looking at that page. Its `at` says how stale it is.
    }
  }, [roomKey, selfId, createTransport, adaptation, publishLinks])

  return {
    localStream,
    streams,
    states,
    gestures,
    sendGesture,
    away,
    saidAway,
    peerReturnEpoch,
    present,
    stats: () => transportRef.current?.stats?.(),
    health: () => meshRef.current?.health() ?? new Map(),
    verdict,
    noUsablePath,
    seats,
    links,
  }
}


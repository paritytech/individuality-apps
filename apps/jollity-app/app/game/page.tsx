// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The game screen — PURE RENDERING over lib/game-session.ts (which owns the
 * pre-game screens, the state machine, votes, the mesh, and report
 * submission). This file decides pixels only: the fixed-height band, the
 * tile grid + FLIP refs, the turn bar, and the vote screen with its CTA.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, type ComponentProps } from "react"
import { TILES_ENTER_SECONDS } from "@jollity/game-chain/game"
import { FinalTile, warmTileMarks, type FinalTileProps, type TileVerdict } from "@/components/game/tile/final-tile"
import { tileSeed } from "@/components/game/tile/tile-geometry"
import { TileStill } from "@/components/game/tile/tile-faces"
import { HealthNotice } from "@/components/health/health-notice"
import { MessageScreen } from "@/components/ui/screen"
import { GameHints } from "@/components/game/hints"
import { TurnPills } from "@/components/game/round-counter"
import {
  useGridChoreography,
  useHintCue,
  useRewardCue,
  useTeachSignal,
  useTilesEnter,
  autoRejectCue,
  INTRO_HEADLINE_PX,
  INTRO_HEADLINE_TRACKING,
  INTRO_SHADOW_ABOVE,
  LAYOUT_FADE_MS,
  PILL_BAR_BOTTOM_PX,
  ROTATION_LINE_BOTTOM_PX,
  introHeadlineStyle,
  turnPillIndex,
  type AutoRejectCue,
} from "@/components/game/animations"
import type { PlayerId } from "@/lib/game-source"
import { RewardBurst } from "@/components/game/reward-burst"
import { Button } from "@/components/ui/button"
import { ctaLabel, sessionNowMs, useGameSession } from "@/lib/game-session"
import { useWakeLock } from "@/lib/wake-lock"
import { useMoment } from "@/lib/telemetry/use-scene"
import { ConnectStatus } from "@/components/game/connect-status"
import { SignalIndicator, signalStatus } from "@/components/game/signal-indicator"
import { SEAT_STATIC_FADE_MS, SEAT_WORD, SeatPanel, TOP_SHADE, seatRecovering } from "@/components/game/seat-face"
import type { SeatState } from "@/lib/webrtc/seat-state"
import { CameraOff, Pause, UserRound, type LucideIcon } from "lucide-react"
import {
  GRAIN_DIM_HOST_MISSING,
  GRAIN_DIM_LOST,
  GRAIN_DIM_RECOVERING,
  GRAIN_OPACITY_RECOVERING,
  TvStatic,
} from "@/components/game/tv-static"
import { useSnapshots } from "@/lib/use-snapshots"
import { acceptFirstRemoteFrame, type RemoteVideoObservation } from "@/lib/peer-video-observation"
import { useCameraGaveUp, useCameraState, useCameraTapState } from "@/lib/camera"
import { CameraNeededOverlay, CameraRestartBanner, CameraTapBanner } from "@/components/camera-needed"
import { useLowPower } from "@/lib/low-power"
import { PROBE_AT_SECONDS, useProbeResult } from "@/lib/device-probe"
import { DeviceProbe } from "@/components/game/device-probe"
import { restartCardCopy } from "@/lib/chain-health"
import { healthNoticeVariant } from "@/lib/health/notice"
import { useDebouncedBlame } from "@/lib/health/use-debounced-blame"
import { waitingFooter } from "@/lib/waiting-room"
import { WaitingRoom } from "@/components/waiting-room/waiting-room"
import { useReconnectWindow } from "@/lib/use-reconnect-window"

/** the top gradient that keeps the signal bars legible, the bars on it (or
 *  the icon of a player who paused themselves), and the word beside them in
 *  the bars' own color */
function SignalCorner({
  state,
  label,
  icon: Icon,
}: {
  state: "connecting" | "weak" | "disconnected"
  label?: string
  icon?: LucideIcon
}) {
  const color = signalStatus(state).color
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: TOP_SHADE }}
      />
      {/* the word rides beside the bars: the top-right corner is the eye chip's */}
      <div className="pointer-events-none absolute top-3 left-3 flex items-center gap-1.5">
        {Icon ? (
          <Icon aria-hidden size={16} strokeWidth={2.25} style={{ color }} />
        ) : (
          <SignalIndicator state={state} strength={state === "weak" ? 0.4 : 0} size={16} />
        )}
        {label ? (
          <span className="text-xs leading-4 font-medium whitespace-nowrap" style={{ color }}>
            {label}
          </span>
        ) : null}
      </div>
    </>
  )
}

/** what a tile can do to the session, stable for the screen's whole life */
interface TileActions {
  ban: (id: PlayerId) => void
  unban: (id: PlayerId) => void
  vote: (id: PlayerId, given: TileVerdict) => void
}

/**
 * What lies over a co-player's face. With a live mesh it is their seat state
 * (lib/webrtc/seat-state.ts) and its word; without one the bare link: `lost`
 * is a dropped link, `no-feed` a feed not here.
 */
type Link = Exclude<SeatState, "empty" | "live"> | "host-missing" | "lost" | "no-feed" | null

/** a seat state as the tile's overlay: an empty chair is the ghost tile itself,
 *  and a live seat shows its face */
function seatLink(seat: SeatState, feed: boolean): Link {
  if (seat === "empty") return null
  if (seat === "live") return feed ? null : "no-feed"
  return seat
}

/** one grid tile, from plain values: on the session's twice-a-second tick, an unchanged tile skips its render */
const GameTile = memo(function GameTile({
  id,
  variant,
  stream,
  you,
  photo,
  flippable,
  verdict,
  autoReject,
  teach,
  banned,
  canBan,
  voting,
  link,
  badge,
  badgeLeaving,
  rewardBurst,
  rewardStart,
  rewardEnd,
  actions,
  observeRemote,
}: {
  id: PlayerId
  variant: FinalTileProps["variant"]
  stream: MediaStream | null
  you: boolean
  photo: string | undefined
  flippable: boolean
  verdict: TileVerdict | undefined
  autoReject: AutoRejectCue | undefined
  teach: number
  banned: boolean
  canBan: boolean
  voting: boolean
  link: Link
  badge: ComponentProps<typeof ConnectStatus>["state"] | undefined
  badgeLeaving: boolean
  rewardBurst: number
  rewardStart: number
  rewardEnd: number
  actions: TileActions
  observeRemote?: RemoteVideoObservation
}) {
  return (
    <FinalTile
      seed={tileSeed(id)}
      variant={variant}
      stream={stream}
      mirrored={you}
      still={photo}
      // only votable peers turn: your own tile and the host's are
      // static, so becoming the host never turns a tile
      flippable={flippable}
      verdict={verdict}
      autoReject={autoReject}
      teach={teach}
      banned={banned}
      onBan={canBan ? () => actions.ban(id) : undefined}
      onUnban={() => actions.unban(id)}
      onVerdict={voting ? (given) => actions.vote(id, given) : undefined}
      observeRemote={observeRemote}
    >
      {link === "host-missing" || link === "no-signal" ? (
        // nothing of theirs is coming through: near-black static, no word
        <TvStatic dim={GRAIN_DIM_HOST_MISSING} />
      ) : link === "weak" ? (
        // the face still comes through, badly: it stays clean under the low bars
        badge ? null : <SignalCorner state="weak" />
      ) : link !== null ? (
        // their face is not coming through: the static lands OVER their last
        // photo (or, while the link forms, the last frame), so the player
        // stays faintly visible under the grain. A link still trying gets a
        // light grain that fades in, so a blip does not read as a player gone.
        // Searching bars while the link forms, empty ones once it did not
        // form in time; a player who paused themselves wears its icon instead
        <>
          {photo && link !== "connecting" ? <TileStill still={photo} /> : null}
          <TvStatic
            dim={seatRecovering(link) ? GRAIN_DIM_RECOVERING : GRAIN_DIM_LOST}
            grain={seatRecovering(link) ? GRAIN_OPACITY_RECOVERING : undefined}
            fadeInMs={link === "lost" || link === "no-feed" ? undefined : SEAT_STATIC_FADE_MS[link]}
            // their endpoint is out there, the link will not form: the
            // can't-reach static, against a no-show's plain one (#1349)
            cantReach={link === "cant-connect"}
          />
          {badge || link === "no-feed" ? null : (
            <SignalCorner
              state={link === "connecting" ? "connecting" : "disconnected"}
              icon={link === "away" ? Pause : link === "camera-off" ? CameraOff : undefined}
              label={link === "lost" ? undefined : SEAT_WORD[link]}
            />
          )}
        </>
      ) : null}
      {badge ? <ConnectStatus state={badge} leaving={badgeLeaving} /> : null}
      {/* the celebration is YOURS: no other tile mounts a canvas */}
      {you ? (
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <RewardBurst burst={rewardBurst} start={rewardStart} end={rewardEnd} />
        </div>
      ) : null}
    </FinalTile>
  )
})

/**
 * One tile of the vote screen, from plain values: the screen's countdown
 * re-renders it every second, and a tile whose verdict did not change skips.
 */
const VoteTile = memo(function VoteTile({
  id,
  photo,
  flippable,
  verdict,
  voting,
  actions,
  banned,
  evidenceFrozen,
}: {
  id: PlayerId
  photo: string | undefined
  flippable: boolean
  verdict: TileVerdict | undefined
  voting: boolean
  actions: TileActions
  banned: boolean
  evidenceFrozen: boolean
}) {
  return (
    <div className="relative">
      <FinalTile
        seed={tileSeed(id)}
        variant="other"
        stream={null}
        still={photo}
        flippable={flippable}
        verdict={verdict}
        negativeFace="photo"
        // every tile arrives decided: shown at rest, not turned in
        review
        banned={banned}
        onUnban={evidenceFrozen ? undefined : () => actions.unban(id)}
        onVerdict={voting ? (given) => actions.vote(id, given) : undefined}
      >
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element -- a data: URL frame; next/image can't optimize it
          <img src={photo} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <SeatPanel icon={UserRound} word="Seen earlier" />
        )}
      </FinalTile>
    </div>
  )
})

/**
 * The game, and over it the camera gate: NO CAMERA, NO GAME. The session
 * underneath keeps running (the clock, the votes already cast), so a camera
 * that comes back drops the gate and the player is straight back in.
 */
export default function GamePage() {
  return (
    <>
      <GameScreen />
      <CameraGate />
    </>
  )
}

function CameraGate() {
  const camera = useCameraState()
  const gaveUp = useCameraGaveUp()
  const cameraTap = useCameraTapState()
  return (
    <>
      {camera.kind === "unavailable" && <CameraNeededOverlay reason={camera.reason} />}
      {cameraTap.tap === "offered" || cameraTap.tap === "tapping"
        ? <CameraTapBanner disabled={cameraTap.opening || cameraTap.tap === "tapping"} />
        : gaveUp && <CameraRestartBanner />}
    </>
  )
}

function GameScreen() {
  const s = useGameSession()
  // made once (they read the session when they fire), so unchanged tiles skip renders
  const sessionRef = useRef(s)
  useLayoutEffect(() => {
    sessionRef.current = s
  })
  const tileActions = useMemo<TileActions>(
    () => ({
      ban: (id) => sessionRef.current.ban(id),
      unban: (id) => sessionRef.current.unban(id),
      vote: (id, given) => sessionRef.current.voteFor(id, given === "approve" ? "person" : "notperson"),
    }),
    [],
  )
  useWakeLock(true) // the mesh dies with a sleeping phone
  const lowPower = useLowPower()
  const probeResult = useProbeResult()
  const reconnecting = useReconnectWindow({
    visible: s.hostStuck && s.phase === "connecting",
    reason: s.hostStuckReason,
    consecutiveLost: s.hostStuckConsecutiveOpens,
    healthy: s.hostAnswering,
    where: "handover",
    since: s.hostReconnectingSince,
  })
  // the in-round bar's minute: "Reconnecting…" first, the restart advice
  // after 60 s. Armed only while the player's own network is up, so the
  // network coming back starts the minute again from zero.
  const barReconnecting = useReconnectWindow({
    visible: s.hostStuck && s.phase === "live" && !s.playerNetworkIsolated,
    reason: s.hostStuckReason,
    consecutiveLost: s.hostStuckConsecutiveOpens,
    healthy: s.hostAnswering,
    where: "recheck",
    surface: "bar",
  })
  const noticeVariant = healthNoticeVariant(s.hostStuck, s.playerNetworkIsolated, barReconnecting)

  // a real game needs a device verdict for each load, unless low power mode is already on
  const probeNeeded = !lowPower && probeResult === undefined
  const cameraStream = s.camera.kind === "live" ? s.camera.stream : null

  // the rotation countdown, ticked by the session
  const change = s.roundChange

  const pose = s.pose
  const finalWaiting = s.screen === "final-waiting"
  const joining = s.screen === "joining"
  // the kickoff the pre-game beat runs to
  const kickoffAt = s.gameAt
  // the dial's kickoff on the game clock, as on the home, so a correction never runs it back
  const dialAt = s.gameDate

  // the grid choreography (reorder slides, park, spotlight) — animations.ts.
  // The clock screen and the probe screen have no grid, so the order is empty:
  // the grid's mount then changes the key, and the driver takes its first pose there.
  const stageRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  useGridChoreography({
    stageRef,
    gridRef,
    orderKey: finalWaiting || probeNeeded ? "" : s.display.join(","),
    pose,
    hostId: s.hostId ?? "",
    lowPower,
  })
  // the tiles move in from the sides: round 0's over the last seconds before
  // kickoff, and the next group's once the last one has left the gap. The
  // probe screen holds it back, so a grid that mounts late joins the move-in.
  useTilesEnter(
    gridRef,
    probeNeeded
      ? null
      : s.screen === "tiles-enter" && kickoffAt !== undefined
        ? kickoffAt - TILES_ENTER_SECONDS
        : (change?.enterAt ?? null),
  )

  // one still per player, captured during the rounds — the vote screen's
  // evidence (a photo loop, done DOM-side)
  const voteGridRef = useRef<HTMLDivElement>(null)
  const snapshots = useSnapshots(s.confirming)
  const photoFor = (id: PlayerId) => snapshots.photoFor(id)

  // the auto-reject warning window, read off the session's stage clock: open
  // over the LAST seconds of the gameplay stage, whatever length the slot gave
  // it. Every tile shares it — which of them warns is decided per tile below.
  const autoReject = autoRejectCue({
    stage: s.stage,
    stageDuration: s.stageDuration,
    stageRemaining: s.stageRemaining,
  })

  // names the part of the round on screen for the frame sampler
  const turned = s.display.some((id) => s.votable(id) && s.voteShown(id) !== undefined)
  useMoment(
    change !== null
      ? "gap"
      : s.stage === "introduction"
        ? "intro"
        : s.stage === "ending"
          ? "ending"
          : s.stage === "gameplay"
            ? autoReject.active
              ? "warn"
              : turned
                ? "turned"
                : "play"
            : null,
  )

  // THE REWARD BURST — on YOUR tile alone. Every peer who accepts you fires
  // one wave, so the beat answers the mesh and nothing else: no clock arms it,
  // and no frame has to decide whether the moment has come. The peers who CAN
  // accept you are the round's players minus yourself — the same set you have
  // to judge — and the last of them to arrive fires the gold finale. The grid
  // holds the group's own members and nobody else, so a short group closes
  // its cascade on the finale exactly like a full one. A chair nobody holds
  // accepts nothing, so it is not counted.
  const reachableAccepters = s.display.filter((id) => id !== s.youId && !s.ghost(id)).length
  const reward = useRewardCue({ accepted: s.acceptedYou, reachable: reachableAccepters })

  // the turn intro: the host is in the spotlight, so the headlines show and
  // the pill bar ducks. The round gap parks the whole grid — the bar ducks
  // for that too, but the headlines belong to the intro alone.
  const introShowing = pose === "intro"
  const ducked = pose !== "natural" || change !== null
  const youAreHost = s.hostId === s.youId

  // THE ROTATION SCREEN's link badges: on while the next group stands in the
  // gap, and fading out over the first intro of the round after it
  const leavingGroup = change !== null && change.enterAt === null
  const badges =
    change !== null && change.enterAt !== null
      ? "in"
      : s.turn !== null && s.turn.round > 0 && s.turn.turn === 0 && s.stage === "introduction"
        ? "out"
        : null

  // the hint pills. They belong to the settled grid, so the intro and the
  // round gap hold them back. The tutorial runs on the game's very first
  // turn, and a host whose feed is missing replaces it with its own pill,
  // each time the grid settles.
  const hintsReady = s.phase === "live" && pose === "natural" && change === null
  const firstTurn = s.turn?.turn === 0 && s.turn.round === 0
  const { cue: hint, dismiss: dismissHint } = useHintCue({
    ready: hintsReady,
    hostMissing: s.hostFeedMissing,
    firstTurn: firstTurn === true,
    turn: s.turn ? `${s.turn.round}|${s.turn.turn}` : "",
  })

  // THE GESTURE LESSON. The tutorial's second pill says to tap, and every
  // votable tile presses in with it, so the words and the motion are one cue. The
  // signal rises ONCE per turn, so no re-render can replay it.
  const teach = useTeachSignal({
    armed: hint === "tap-to-identify",
  })

  // bake the glass marks from the page's first moments (the waiting room)
  useEffect(() => {
    warmTileMarks()
  }, [])
  // the waiting room's footer: the restart advice, else the network blame
  const blame = useDebouncedBlame(s.mesh.verdict, s.hostAnswering, s.noUsablePath)
  const restarting = s.hostStuck && s.phase === "connecting"

  if (restarting && !finalWaiting) {
    const copy = restartCardCopy(
      "host-unanswered",
      s.hostStuckConsecutiveOpens,
      s.secondsToStart === undefined ? "" : ` The game starts in ${s.secondsToStart}s.`,
      reconnecting,
    )
    return (
      <MessageScreen
        rootAttrs={{
          "data-testid": "chain-restart",
          "data-restart-advice": reconnecting ? "reconnecting" : "restart",
        }}
        eyebrow={copy.eyebrow}
        heading={copy.heading}
        body={copy.body}
      />
    )
  }

  if (joining) {
    const progress = s.joining
    return (
      <MessageScreen
        rootAttrs={{ "data-testid": "joining-in-progress" }}
        eyebrow={progress ? `Round ${progress.round}` : "Live"}
        heading="Joining the game in progress"
        body={progress
          ? `This round is ${progress.elapsed} of ${progress.duration} seconds in. Connecting you to the other players…`
          : "Connecting you to the other players…"}
      />
    )
  }

  // THE FINAL WAIT on /game: the waiting room from the handover until the
  // tiles move in, while the mesh forms behind it. The first render has no
  // kickoff yet, so it shows the bare frame.
  if (finalWaiting) {
    if (dialAt === undefined || s.gameDate === undefined)
      return <div className="min-h-dvh flex-1 bg-background" />
    const restart = restarting ? restartCardCopy("host-unanswered", s.hostStuckConsecutiveOpens, "", reconnecting) : null
    const footer = waitingFooter({
      restart: restart ? { heading: restart.heading, body: restart.body, advice: reconnecting ? "reconnecting" : "restart" } : null,
      unreachable: Boolean(blame) || s.connection.network === "blocked",
      room: {
        route: "game",
        network: s.connection.network,
        connected: s.connection.connected,
        expected: s.connection.expected,
        quality: s.connection.quality,
        checking: s.connection.checking,
        store: s.store,
      },
    })
    return (
      <>
        <WaitingRoom
          route="game"
          gameAt={s.gameDate}
          clock={{ kickoffAt: dialAt, nowMs: sessionNowMs }}
          camera={s.camera}
          cameraHelp={null}
          footer={footer}
          peers={s.waitingPeers}
        />
        {probeNeeded && s.secondsToStart !== undefined && s.secondsToStart <= PROBE_AT_SECONDS && cameraStream ? (
          <DeviceProbe stage="countdown" stream={cameraStream} />
        ) : null}
      </>
    )
  }

  // a player with no verdict after the dial waits here while the probe
  // runs; the session, the camera and the mesh keep running underneath
  if (probeNeeded) {
    return (
      <>
        <MessageScreen
          rootAttrs={{ "data-testid": "device-probe-screen" }}
          eyebrow="Live"
          heading="The game has started"
          body="Connecting you to the other players…"
        />
        {cameraStream ? <DeviceProbe stage="late" stream={cameraStream} /> : null}
      </>
    )
  }

  if (s.confirming) {
    // THE VOTE SCREEN: every co-player this viewer saw, with the verdict the
    // rounds left, as a scroll column under a docked CTA. A tap changes a
    // verdict, and the report files what the screen shows. A co-player never
    // seen gets no tile and keeps the default verdict.
    const recap = s.display.filter((id) => s.roleFor(id) !== "unseen")
    return (
      <div className="relative flex min-h-dvh flex-1 flex-col">
        <HealthNotice verdict={s.mesh.verdict} variant={noticeVariant} hostAnswering={s.hostAnswering} noUsablePath={s.noUsablePath} />
        <div className="vote-screen-in absolute inset-0">
          {/* x clipped: the tiles' glow canvases reach past their boxes, and a
              box that scrolls vertically scrolls sideways too, so the glow
              at the screen's edge let the whole screen slide */}
          <div className="absolute inset-0 overflow-x-hidden overflow-y-auto">
            <div className="flex flex-col px-4 pt-[66px] pb-[140px]">
              <h1
                className="pb-7 text-center leading-none text-white"
                style={{
                  fontFamily: "var(--font-heading)",
                  fontWeight: 700,
                  fontSize: INTRO_HEADLINE_PX,
                  letterSpacing: INTRO_HEADLINE_TRACKING,
                  textShadow: lowPower ? undefined : INTRO_SHADOW_ABOVE,
                }}
              >
                Check your choices!
              </h1>
              {recap.length === 0 ? (
                <p className="text-center text-sm text-muted-foreground">No one&apos;s video came through this game.</p>
              ) : null}
              <div ref={voteGridRef} className="mx-auto grid w-full max-w-[376px] grid-cols-2 gap-[10px]">
                {recap.map((id) => {
                  const vote = s.voteShown(id)
                  const photo = photoFor(id)
                  const role = s.roleFor(id)
                  // Confirm never reads a live stream. A restored Co-player
                  // without an in-page still gets the neutral seen-earlier
                  // fixture.
                  return (
                    <div key={id} data-id={id} data-tile-slot data-tile-role={role}>
                      <VoteTile
                        id={id}
                        photo={photo}
                        flippable={s.votable(id)}
                        verdict={vote ? (vote === "person" ? "approve" : "reject") : undefined}
                        voting={s.votable(id)}
                        banned={s.banned(id)}
                        evidenceFrozen={s.evidenceFrozen}
                        actions={tileActions}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          {/* the dock: the tiles fade into the floor under the CTA */}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] px-4 pt-16 pb-6"
            style={{
              background:
                "linear-gradient(180deg, rgba(11,12,15,0) 0%, rgba(11,12,15,0.55) 18%, rgba(11,12,15,0.88) 38%, #0b0c0f 55%, #0b0c0f 100%)",
            }}
          >
            {/* The self-confirming CTA. The button IS the progress track: the
                fill grows from the left edge as the count runs down. A tap
                collapses the count, and the report still fires on the
                countdown's own beat, so the report has one path. */}
            <Button
              size="lg"
              className="pointer-events-auto relative mx-auto flex w-full max-w-[358px] overflow-hidden bg-[var(--game-confirm-track)] font-semibold text-white hover:bg-[var(--game-confirm-track)]"
              disabled={s.votesMissing > 0 || s.votesLoading || s.submitState === "submitting"}
              onClick={s.autoActive ? s.rushConfirm : s.confirmVotes}
            >
              {s.autoActive && s.submitState === "idle" ? (
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 bg-[var(--game-confirm-fill)]"
                  style={{
                    width: `${(1 - s.autoCount / s.autoConfirmSeconds) * 100}%`,
                    // just under the tick, so the fill lands on the digit
                    // change instead of trailing it
                    transition: "width 980ms linear",
                  }}
                />
              ) : null}
              <span className="relative">{ctaLabel(s)}</span>
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="relative flex min-h-dvh flex-1 flex-col pt-6"
      // test hook for external end-to-end bots (attributes only): the session's own stage and the pill's turn number.
      // "ending": the auto-reject flash turns every undecided tile; a tap is refused while a tile turns and recorded
      // after it. Nothing else in the DOM tells it from play. "none" is a screen with no stage (connect, confirm); an
      // absent attribute is a build that predates it
      data-stage={s.stage ?? "none"}
      data-turn={s.turn ? turnPillIndex(s.turn) + 1 : undefined}
    >
      <HealthNotice verdict={s.mesh.verdict} variant={noticeVariant} hostAnswering={s.hostAnswering} noUsablePath={s.noUsablePath} />
      {/* THE INTRO'S SCRIM: the others stay in their slots under the hero,
          dimmed, so the headlines read over them. One layer fading, where
          sliding five live tiles off the stage was most of the intro. It
          covers the whole screen: cut to the grid, its edge showed. The hero
          (35) and the headlines (36) sit over it. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[32]"
        style={{
          background: "var(--background)",
          opacity: introShowing ? 0.82 : 0,
          transition: `opacity ${LAYOUT_FADE_MS}ms ease-out`,
        }}
      />
      {/* THE ROTATION COUNTDOWN. Over the gap between two rounds the last
          group slides out, the next one moves in, and this one line counts
          down to the next round. It takes the band the pill bar ducked out of. */}
      {change ? (
        <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
          <p
            className={`${lowPower ? "round-countdown-flat" : "round-countdown-in"} absolute inset-x-0 text-center text-[18px] leading-6 font-semibold text-white`}
            style={{ bottom: ROTATION_LINE_BOTTOM_PX }}
          >
            New players joining in{" "}
            {/* the digit changes IN PLACE: tabular numerals give every digit
                the same advance width, and the fixed min-width keeps the
                sentence from breathing as 3 → 2 → 1 */}
            <span
              className="inline-block min-w-[0.65em] text-left font-bold tabular-nums"
              style={{ color: "var(--warning)" }}
            >
              {change.seconds}
            </span>
          </p>
        </div>
      ) : null}
      {/* 8px gutters, so the 374px grid gets 183px per tile on a 390 screen.
          The stage clips at the screen's width only. A popped tile keeps
          inside it, a parked tile leaves through its side edge, and a hint
          pill can rest above its top edge. */}
      <main
        ref={stageRef}
        className="relative flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-5 overflow-x-clip px-2"
      >
        {/* The turn intro's two headlines. They bracket the hero the
            choreography measured (--game-hero), one a fixed gap above it and
            one the same gap below. The copy picks by role alone: you either
            perform this turn or you copy the player who does. */}
        <div className="pointer-events-none absolute inset-0 z-[36] select-none">
          <span
            className="absolute inset-x-0 text-center leading-none whitespace-nowrap text-white"
            style={introHeadlineStyle("above", introShowing, !lowPower)}
            aria-hidden={!introShowing}
          >
            {youAreHost ? "It's your turn!" : "Meet new host"}
          </span>
          <span
            className="absolute inset-x-0 text-center leading-none whitespace-nowrap text-white"
            style={introHeadlineStyle("below", introShowing, !lowPower)}
            aria-hidden={!introShowing}
          >
            {youAreHost ? "Show a gesture!" : "Copy the gesture!"}
          </span>
        </div>

        {/* The hint pills. They hang off the grid's top edge, which the play
            stage leaves free, and they leave through the frame's top edge. */}
        <GameHints
          cue={hint}
          gestureLabel={youAreHost ? "Show gesture" : "Copy gesture"}
          shadow={!lowPower}
          onDismiss={dismissHint}
        />

        {/* the group — order + movement come from the session/FLIP.
            2-col grid: a 374px block with an 8px gutter puts each tile at
            183px on a 390 screen, and a narrower screen shrinks the tiles */}
        <div ref={gridRef} className="relative grid w-full max-w-[374px] grid-cols-2 gap-2">
          {s.display.map((id) => {
            // the verdict the tile shows. The session owns it: a tap casts
            // one, and sealTurn casts the reject for whoever is left at the
            // turn change.
            const vote = s.voteShown(id)
            const signal = s.peerSignal(id)
            const photo = photoFor(id)
            const you = id === s.youId
            // A PLAYER'S FACE IS THEIR OWN STREAM AND NOTHING ELSE: the tile
            // shows the grain until a stream lands.
            // your tile shows the app's one camera (lib/camera), the stream the mesh sends
            const yourStream = s.camera.kind === "live" ? s.camera.stream : null
            const stream = you ? yourStream : (s.mesh.streams.get(id) ?? null)
            const role = s.roleFor(id)
            const banned = s.banned(id)
            const canBan = s.phase === "live" && s.tappable(id)
            // who the warning is for: an undecided peer the tile can still be
            // tapped on, whose feed is still there. A gone peer, and a banned
            // one, have nothing to answer for.
            const warns =
              s.phase === "live" &&
              s.tappable(id) &&
              vote === undefined &&
              !banned &&
              signal !== "disconnected"
            // the link's state over the face. The host whose feed is gone is
            // near-black static, and its own pill says why, so it takes no bars.
            // A leaving tile keeps its face: its link belongs to the last room.
            const hostMissing = !you && id === s.hostId && s.hostFeedMissing
            const seat = s.seat?.(id)
            const link: Link = you || leavingGroup
              ? null
              : hostMissing
                ? "host-missing"
                : seat !== undefined
                  ? seatLink(seat, stream !== null)
                  : s.peerAway?.(id)
                    ? "away"
                    : signal === "disconnected"
                      ? "lost"
                      : !stream
                        ? "no-feed"
                        : signal === "weak"
                          ? "weak"
                          : null
            // the rotation badge carries the link itself, so it replaces the bars
            const badge = badges !== null && !s.ghost(id) ? (you ? s.yourSignal : signal) : undefined
            const observeRemote: RemoteVideoObservation | undefined =
              !you && stream
                ? {
                    key: id,
                    generation: s.evidenceGeneration + snapshots.generation() + s.videoObservationEpoch(id),
                    accept: () => {
                      const current = sessionRef.current
                      return !current.evidenceFrozen && current.display.includes(id) && current.roleFor(id) !== "empty"
                    },
                    onFirstFrame: (video, currentAttachment) => {
                      const current = sessionRef.current
                      acceptFirstRemoteFrame(
                        currentAttachment,
                        () => current.markVideoArrived(id),
                        () => snapshots.offer(
                          id,
                          video,
                          current.roleFor(id) === "host" && current.stage === "gameplay",
                          currentAttachment,
                        ),
                      )
                    },
                    onWindow: (video, currentAttachment) => {
                      const current = sessionRef.current
                      if (currentAttachment() && current.videoSeen(id))
                        snapshots.offer(
                          id,
                          video,
                          current.roleFor(id) === "host" && current.stage === "gameplay",
                          currentAttachment,
                        )
                    },
                  }
                : undefined
            return (
              <div key={id} data-id={id} data-tile-slot data-tile-role={role} className="origin-center">
                <GameTile
                  id={id}
                  variant={s.ghost(id) ? "ghost" : s.phase === "live" ? s.variantFor(id) : "other"}
                  stream={stream}
                  you={you}
                  photo={photo}
                  flippable={s.votable(id)}
                  verdict={vote ? (vote === "person" ? "approve" : "reject") : undefined}
                  // the cue reads the clock only while its window is open: a closed
                  // one handed over each tick would re-render the tile for nothing
                  autoReject={warns && autoReject.active ? autoReject : undefined}
                  teach={teach}
                  banned={banned}
                  canBan={canBan}
                  voting={s.phase === "live" && s.tappable(id)}
                  link={link}
                  badge={badge}
                  badgeLeaving={badges === "out"}
                  rewardBurst={you ? reward.burst : 0}
                  rewardStart={you ? reward.start : 0}
                  rewardEnd={you ? reward.end : 0}
                  actions={tileActions}
                  observeRemote={observeRemote}
                />
              </div>
            )
          })}
        </div>
      </main>

      {/* bottom slot: the turn pill bar. Constant height, so the stage never
          jumps. overflow-hidden so the ducking bar leaves through the bottom
          edge instead of stretching the page. */}
      <footer className="relative min-h-[132px] overflow-hidden">
        {s.turn ? (
          <div className="absolute inset-x-0 px-6" style={{ bottom: PILL_BAR_BOTTOM_PX }}>
            <TurnPills cue={s.turn} ducked={ducked} />
          </div>
        ) : null}
      </footer>
    </div>
  )
}

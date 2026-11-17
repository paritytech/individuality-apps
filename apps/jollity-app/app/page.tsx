// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The root surface — home and waiting room MERGED into one time-banded ladder
 * (players actually arrive via the chat card; landing here far from a game is
 * the by-hand edge case):
 *
 *   queued             "Game at 5:01" — passive, time only (a schedule behind
 *                      the current game; the chain has no game to sign up for)
 *   game exists,       REGISTER (in-place when the source can sign, else the
 *   unregistered       chat-card pointer) — from the scheduling block until
 *                      the pallet closes registration, however far out
 *   game exists,       "You're in" + countdown
 *   registered
 *   <5min, registered  the WAITING ROOM (components/waiting-room): the
 *                      countdown to the dial's 00, three seconds before
 *                      kickoff, + How to play. It stops at 1:01, when the
 *                      handover fires.
 *   handover / live    hands over to /game at `handoverAt(gameAt)` — T-64, the
 *                      pre-connect window before T-0 (lib/joined)
 *   late, registered   LATE JOIN: into /game at any turn while turns remain
 *                      (#699), a first-time latecomer and a player coming
 *                      back after a reload or a relaunch alike; the bare
 *                      title shows while the handover runs
 *   missed it          ONE dead-end screen for a player who did not register,
 *                      once registration closed or the game is running
 *
 * It is also the FRONT DOOR (lib/front-door): a page load that landed on a
 * game page is sent here first, shows the bare title while the gates run, and
 * goes on to that page; an old build gets the update screen instead.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CopyAddress } from "@/components/ui/copy-address"
import { formatAmount, shortfall } from "@individuality/sign-up"
import { registerButton } from "@/lib/registration/register-button"
import { MessageScreen } from "@/components/ui/screen"
import { WaitingRoom } from "@/components/waiting-room/waiting-room"
import { CameraRestartBanner, CameraTapBanner } from "@/components/camera-needed"
import { cameraRestartNotice } from "@/lib/camera-restart-notice"
import { useCameraGaveUp, useCameraTapState } from "@/lib/camera"
import { useWaitingRoomCamera } from "@/lib/camera-help"
import { useGameStatus } from "@/lib/use-game-status"
import { useStoreCalibration } from "@/lib/store-calibration"
import { useWakeLock } from "@/lib/wake-lock"
import { formatCountdown, formatGameAt } from "@/lib/format"
import { usePermissionGate } from "@/lib/use-permission-gate"
import { describeError } from "@/lib/host/error-detail"
import { devLog } from "@/lib/debug/log-store"
import { hasJoined, markJoined } from "@/lib/joined"
import { arrivalStep, dropArrival, heldArrival, openFrontDoor, watchFrontDoor } from "@/lib/front-door"
import { useWorkerHandoff } from "@/lib/worker-bridge"
import { useScene } from "@/lib/telemetry/use-scene"
import { settlePendingReportFailure } from "@/lib/report-failure-outbox"
import { reportFailedAfterTheFact } from "@/lib/journeys/game-trace"
import { useStaleBuild } from "@/lib/release/use-stale-build"
import { useUpdatePlatform } from "@/lib/release/use-update-platform"
import { updateInstruction } from "@/lib/release/update-copy"
import { buildCheckWanted, entryBuildClear, entryRecheck, homeGate } from "@/lib/home-gate"
import { homeHandover, homeScreen, homeSituation, type HomeScreen } from "@/lib/home-screen"
import { chainHealthCardVisible, restartCardCopy } from "@/lib/chain-health"
import { useChainHealthCard } from "@/lib/use-chain-health-card"
import { useHomeFirstStatus } from "@/lib/use-home-first-status"
import { useLaunchStall } from "@/lib/use-launch-stall"
import { useReconnectWindow } from "@/lib/use-reconnect-window"
import { preloadDrawSchedule } from "@/lib/draw/draw-schedule"
import { useTurnWarmup } from "@/lib/webrtc/use-turn-warmup"
import { noteHeldSeat } from "@/lib/resume-reload"
import { useWaitingNetworkCheck } from "@/lib/webrtc/use-waiting-network-check"
import { waitingNetworkAllowsHandover, waitingNetworkRestartNotice } from "@/lib/webrtc/waiting-network-check"
import { chainNowMs } from "@/lib/chain-clock"
import { deviceNowMs } from "@/lib/device-clock"
import { waitingFooter } from "@/lib/waiting-room"

/** the prerender holds no page load (lib/front-door) */
const noArrival = () => null

export default function Home() {
  const router = useRouter()
  const real = useGameStatus()
  const { source } = real
  const now = real.now
  // a report failure the last page could not send (#600): the chain says whether it was a miss
  useEffect(() => {
    if (!source) return
    void settlePendingReportFailure(source, reportFailedAfterTheFact)
  }, [source])

  // app-open permission check
  const gateDone = usePermissionGate()
  // ONE FRONT DOOR (lib/front-door): the game's pages open from here on in
  // this page load, and a load that landed on one waits here for the gates
  const arrival = useSyncExternalStore(watchFrontDoor, heldArrival, noArrival)
  useEffect(() => openFrontDoor(), [])
  // already in the status's game: a reload or a relaunch mid-game or in its report window (lib/joined)
  const statusGameAt =
    real.status.kind === "waiting" || real.status.kind === "live"
      ? real.status.gameAt
      : real.status.kind === "none" || real.status.kind === "scheduled"
        ? real.status.reportingGameAt
        : undefined
  const joined = statusGameAt !== undefined && hasJoined(statusGameAt)
  // an old build is told to restart before the game (lib/release), and asked
  // again on the way into one (#1102)
  const build = useStaleBuild(
    gateDone && buildCheckWanted(real.status, now, { joined, held: arrival !== null }),
    entryRecheck(real.status, now, joined),
  )
  const arrivalNext =
    arrival === null
      ? null
      : arrivalStep({ href: arrival, status: real.status, now, hostOnly: real.hostOnly, joined, gateDone, build })
  const platform = useUpdatePlatform(build.state === "stale")
  // the status and the gate over it, as ONE view (lib/home-gate)
  const view = {
    status: real.status,
    gate: homeGate(real.hostOnly, build.state, real.status, now, { joined, held: arrivalNext === "hold" }),
    platform,
  }
  const { status } = view

  // chat card's "How it works" → the worker's storage flag → /nux
  useWorkerHandoff()

  // what the hooks below key off, from the status alone (lib/home-screen).
  // Not the screen: a card over the waiting room still keeps it warm. LATE
  // JOIN (`goesIn`): a registered player in a running game who is not in the
  // waiting room goes in at any turn while turns remain, whether they never
  // came or are coming back after a reload or a relaunch.
  const { gameAt, registered, inWaiting, goesIn } = homeSituation(status, now)
  useTurnWarmup(
    registered || inWaiting || goesIn,
    gameAt ?? (status.kind === "live" ? status.gameAt : undefined),
    source?.playerAccountId,
  )
  // a long return here with this seat close to kickoff reloads the page (#1157)
  const heldSeatAt = registered || inWaiting ? gameAt : undefined
  useEffect(() => {
    if (heldSeatAt === undefined) return
    noteHeldSeat(heldSeatAt)
    return () => noteHeldSeat(null)
  }, [heldSeatAt])
  const healthPhase =
    status.kind === "live" ? "round" : status.kind === "processing" ? "post-game" : "pre-game"
  const { card: chainCard, consecutiveLost, probe: probeChain } = useChainHealthCard({
    source,
    waiting: inWaiting,
    gameAt,
    phase: healthPhase,
    // Starts the registered-player health watch at T-15 min; waiting switches
    // its telemetry label from "registered" and is already in the fast band.
    registered: status.kind === "loading" ? undefined : registered || inWaiting,
  })
  const waitingCheckGameAt = gameAt ?? (status.kind === "live" ? status.gameAt : undefined)
  const waitingCheck = useWaitingNetworkCheck({
    enabled: inWaiting,
    hostAnswering: chainCard.answering === true,
    gameAt: waitingCheckGameAt,
    nowSeconds: source?.nowSeconds,
  })
  const { done: waitingCheckDone, result: waitingCheckResult } = waitingCheck
  // never the bare title for good (#530): a launch still loading after 15 s
  // re-probes the host, and a host that is lost or silent gets the restart card
  const loading = status.kind === "loading" && !real.hostOnly
  const stall = useLaunchStall({ loading, hasSource: source !== undefined, probe: probeChain })
  const chainCardVisible = chainHealthCardVisible(chainCard, healthPhase)
  const restartReason = stall ?? (chainCardVisible ? (chainCard.reason ?? "chain-lost") : undefined)
  // the restart card on screen
  const restart = restartReason ? { reason: restartReason, consecutiveLost } : undefined
  const reconnecting = useReconnectWindow({
    visible: restart !== undefined,
    reason: restart?.reason,
    consecutiveLost: restart?.consecutiveLost ?? 0,
    healthy: chainCard.answering === true,
    where: inWaiting ? "waiting" : "open",
    since: stall ? undefined : chainCard.reconnectingSince,
  })
  useHomeFirstStatus({ loading, cardReason: loading ? restartReason : undefined })
  // a phone asleep on the waiting room loses the host's chain connection
  useWakeLock(registered || inWaiting)
  // signed up, so the pallet granted the statement allowance: learn the store
  // clock's margin now, before the game (lib/store-calibration.ts)
  useStoreCalibration(source?.calibrateSignalling, registered || inWaiting)
  // The game row already says whether this game has a prize draw. Learn that
  // in the waiting room and keep retrying read failures while there is time;
  // only a successful zero may later skip the draw route (#515).
  useEffect(() => {
    if (!inWaiting || !source || gameAt === undefined) return
    void preloadDrawSchedule(source, gameAt)
  }, [inWaiting, source, gameAt])
  // THE CAMERA WARMS UP HERE, not at kickoff: the waiting room holds it, and
  // the hold's grace carries the stream across the handover to /game, which
  // takes it without a second open (lib/camera). On Android that second open
  // is what failed; on both, the first one is slow, and this is the minute
  // nobody is waiting on it. Each player starts at their own second, and the
  // room's camera, its help and the /game prefetch are one value
  // (lib/camera-help, #226).
  const room = useWaitingRoomCamera(view, { now, account: source?.player })
  const { camera } = room
  const cameraGaveUp = useCameraGaveUp()
  const cameraTap = useCameraTapState()
  // the waiting room's frame timing (lib/telemetry)
  useScene("waiting", inWaiting)
  // and /game is fetched once the camera is not opening, or anyway close to
  // the handover, so the handover lands inside the camera's grace
  useEffect(() => {
    if (inWaiting && room.prefetch) router.prefetch("/game")
  }, [inWaiting, room.prefetch, router])
  // THE HANDOVER: the pre-connect window before T-0, so the dial and
  // then the tiles move-in stand while the mesh opens and turn 1 starts on the
  // game clock. The waiting room counts to the dial's 00, so it reads 1:01 as
  // the app leaves. The marker stays keyed by the game time itself. A late joiner
  // is marked as one who came in, so a relaunch after the game still finds it;
  // the waiting-room door is the ONLY other way in, and it stays shut until
  // the camera is live (lib/home-screen homeHandover).
  useEffect(() => {
    // a page load held here goes on to its page once the gates have run
    // (lib/front-door, which lets it go when it arrives); "drop" leaves it to
    // the handover below
    if (arrival !== null) {
      if (arrivalNext === "go") {
        devLog("front-door", "home sends the page load on", { href: arrival })
        router.replace(arrival)
        return
      }
      if (arrivalNext !== "drop") return
      dropArrival()
    }
    if (!waitingNetworkAllowsHandover({ inWaiting, done: waitingCheckDone, result: waitingCheckResult })) return
    const handover = homeHandover(status, now, camera.kind === "live")
    if (!handover) return
    // a first entry waits for the build asked for it, and an old build never
    // goes in: the update screen stands instead (#1102)
    if (!entryBuildClear(status, now, joined, build)) return
    markJoined(handover.gameAt, handover.door)
    router.replace("/game")
  }, [status, now, router, camera.kind, inWaiting, waitingCheckDone, waitingCheckResult, arrival, arrivalNext, joined, build])

  const register = async () => {
    // the source files the sign-up and sees it through; a tap while one is
    // under way does nothing there, and the button is disabled by its phase
    if (!source?.register) return
    if (chainCard.lost) return
    try {
      await source.register() // registered flips via watchPlayer
    } catch (error) {
      // the refusal is not shown here: the doorway records it in the debug
      // sheet, with the route and the account, where it can be read in full.
      devLog("signup", "register rejected", describeError(error), "error")
    }
  }
  // leaving the page stops a sign-up that is still retrying
  useEffect(() => () => source?.cancelRegister?.(), [source])

  // test hooks: what this screen shows, for end-to-end tests (attributes only).
  // These names are a contract with end-to-end tests that drive the app from
  // outside (none ship in this repository), so renaming any of them breaks those.
  const hooks = {
    "data-testid": "home",
    "data-state": status.kind,
    "data-source": source?.kind,
    "data-account": source?.player,
    "data-registered": registered || inWaiting,
    "data-waiting-network-check": waitingCheck.result,
  }
  // the waiting room's clock, in the frame of the status's gameAt. Stable,
  // so the clock loop does not restart.
  const sourceNowSeconds = source?.nowSeconds
  const waitingNowMs = useCallback(
    () => (!sourceNowSeconds ? deviceNowMs() : (chainNowMs() ?? sourceNowSeconds() * 1000)),
    [sourceNowSeconds],
  )

  // ONE value says what is on screen (lib/home-screen): the gates in their
  // order, then the status. Everything below only draws it.
  const screen = homeScreen(
    { view, restart, reconnecting, passing: arrivalNext === "wait" || arrivalNext === "go" },
    now,
  )

  const webrtcRestart = waitingNetworkRestartNotice(waitingCheckResult)
  if (webrtcRestart) {
    return (
      <MessageScreen
        rootAttrs={{ ...hooks, "data-testid": "webrtc-restart-notice" }}
        eyebrow={webrtcRestart.eyebrow}
        heading={webrtcRestart.heading}
        body={webrtcRestart.body}
      />
    )
  }

  // ── the register / you're-in band ─────────────────────────────────────────
  const band = (screen: Extract<HomeScreen, { kind: "registered" | "unfunded" | "register" }>) => {
    const unfunded = screen.kind === "unfunded" ? screen.funds : undefined
    const missing = unfunded ? shortfall(unfunded) : 0n
    const countdown =
      screen.kind === "register"
        ? { at: screen.closesAt, label: "left to join" }
        : { at: screen.gameAt, label: "until the game starts" }
    // the source's sign-up phase decides the button: the first tap counts,
    // and the source waits out the seat and retries from there
    const button =
      screen.kind === "register" ? registerButton(screen.signup, formatGameAt(screen.closesAt, now)) : undefined
    return (
      <div {...hooks} className="flex min-h-dvh flex-1 flex-col pt-6">
        <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <Badge data-testid="home-status" variant="secondary" className="tracking-[0.08em] uppercase">
            {screen.kind === "registered"
              ? "You're in"
              : screen.kind === "unfunded"
                ? "Top up to play"
                : "Next game"}
          </Badge>
          <h1 className="text-[28px] leading-9 font-bold">{`Game starts at ${formatGameAt(screen.gameAt, now)}`}</h1>
          <p className="max-w-[38ch] text-base leading-6 text-muted-foreground">
            {screen.kind === "registered"
              ? "Your seat is saved. We will bring you in just before it starts."
              : unfunded
                ? `Add ${formatAmount(missing, unfunded.decimals, unfunded.symbol)} to your game account to register. It comes back when you leave.`
                : "Your seat is open. Register to take it."}
          </p>
          {unfunded && source?.player ? (
            <div className="mt-2 flex w-full max-w-sm flex-col items-center gap-2 rounded-xl bg-card px-6 py-5">
              <span className="text-xs font-medium text-muted-foreground">your game account</span>
              <CopyAddress address={source.player} />
              <span className="text-xs font-medium text-muted-foreground">
                {formatAmount(unfunded.free, unfunded.decimals, unfunded.symbol)} of{" "}
                {formatAmount(unfunded.required, unfunded.decimals, unfunded.symbol)}
              </span>
            </div>
          ) : (
            <div className="mt-2 flex w-full max-w-sm flex-col items-center gap-1 rounded-xl bg-card px-6 py-5">
              <span className="font-mono text-3xl font-semibold tabular-nums">
                {formatCountdown(countdown.at, now)}
              </span>
              <span className="text-xs font-medium text-muted-foreground">{countdown.label}</span>
            </div>
          )}
        </main>
        {/* minimum height and centred: the button, its notice and the
            top-up line swap in place, so nothing above them moves. The
            bottom padding keeps them clear of the host's docklet, which
            covers the bottom 83pt when open on iOS; a product can't read
            whether it is open yet (#480) */}
        <footer className="flex min-h-24 shrink-0 flex-col items-center justify-center px-4 py-2 pb-[max(6rem,env(safe-area-inset-bottom))]">
          {button ? (
            source?.register ? (
              <>
                {button.notice ? (
                  <span className="mb-2 max-w-sm text-center text-xs leading-4 font-medium text-muted-foreground/60" data-testid="home-register-notice">
                    {button.notice}
                  </span>
                ) : null}
                <Button
                  size="lg"
                  className="w-full max-w-sm"
                  onClick={register}
                  data-testid="home-register"
                  disabled={button.disabled}
                >
                  {button.label}
                </Button>
              </>
            ) : (
              <span className="text-xs font-medium text-muted-foreground/60">
                Register from the Jollity card in chat.
              </span>
            )
          ) : unfunded ? (
            <span className="text-xs font-medium text-muted-foreground/60">
              Waiting for your top-up…
            </span>
          ) : null}
        </footer>
      </div>
    )
  }

  // ── far out / nothing: the passive edge case ──────────────────────────────
  const passive = (screen: Extract<HomeScreen, { kind: "loading" | "queued" | "wrapping-up" | "no-game" }>) => (
    <div {...hooks} className="flex min-h-dvh flex-1 flex-col">
      <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        {screen.kind === "loading" ? (
          <h1 className="text-[28px] leading-9 font-bold">Jollity</h1>
        ) : screen.kind === "queued" ? (
          <>
            <Badge variant="secondary" className="tracking-[0.08em] uppercase">
              Next game
            </Badge>
            <h1 className="text-[28px] leading-9 font-bold">{`Game at ${formatGameAt(screen.gameAt, now)}`}</h1>
            <p className="max-w-[38ch] text-base leading-6 text-muted-foreground">
              We&apos;ll ping you in the chat when you can join.
            </p>
          </>
        ) : screen.kind === "wrapping-up" ? (
          <>
            <h1 className="text-[28px] leading-9 font-bold">Wrapping up</h1>
            <p className="max-w-[38ch] text-base leading-6 text-muted-foreground">
              The last game is being finalized. Results are on their way.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-[28px] leading-9 font-bold">No game scheduled</h1>
            <p className="max-w-[38ch] text-base leading-6 text-muted-foreground">
              There&apos;s no game on the calendar right now. We&apos;ll ping you in
              chat when the next one is up.
            </p>
          </>
        )}
      </main>
    </div>
  )

  switch (screen.kind) {
    case "host-only":
      return (
        <div {...hooks} className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <h1 className="text-[28px] leading-9 font-bold">Open Jollity in the Polkadot app</h1>
          <p className="max-w-[38ch] text-base leading-6 text-muted-foreground">
            This game runs inside the Polkadot app — identity, signing, and the
            chain connection all come from the host.
          </p>
        </div>
      )

    // ── an old build: sign-up waits for the restart ─────────────────────────
    case "update":
      return (
        <MessageScreen
          rootAttrs={{ ...hooks, "data-testid": "home-update" }}
          eyebrow="Update available"
          heading="A new version is out"
          body={updateInstruction(screen.platform)}
        />
      )

    case "restart": {
      const timeLeft = screen.gameAt === undefined ? "" : ` The game starts in ${formatCountdown(screen.gameAt, now)}.`
      // from the 2nd app open in a row with the chain lost, a restart has been
      // tried and did not help: the advice moves on (lib/chain-health)
      const copy = restartCardCopy(screen.reason, screen.consecutiveLost, timeLeft, screen.reconnecting)
      return (
        <MessageScreen
          rootAttrs={{
            ...hooks,
            "data-testid": "chain-restart",
            "data-restart-advice": screen.reconnecting ? "reconnecting" : copy.escalated ? "escalated" : "restart",
          }}
          eyebrow={copy.eyebrow}
          heading={copy.heading}
          body={copy.body}
        />
      )
    }

    // ── missed it: not in this game, and no turn left to join ───────────────
    case "missed":
      return (
        <MessageScreen
          rootAttrs={hooks}
          eyebrow="Registration closed"
          heading="You missed this one"
          body="The next game will be announced in chat."
        />
      )

    // ── the waiting room (registered, within the 5-minute join window) ──────
    case "waiting-room": {
      const card = screen.restart
      const copy = card ? restartCardCopy(card.reason, card.consecutiveLost, "", card.reconnecting) : null
      const footer = waitingFooter({
        restart:
          card && copy
            ? {
                heading: copy.heading,
                body: copy.body,
                advice: card.reconnecting ? "reconnecting" : copy.escalated ? "escalated" : "restart",
              }
            : null,
        unreachable: waitingCheck.result === "blocked",
        room: {
          route: "home",
          check: !waitingCheck.done
            ? "running"
            : waitingCheck.result === "pass" || waitingCheck.result === "blocked"
              ? waitingCheck.result
              : "other",
        },
      })
      return (
        <>
          <WaitingRoom
            route="home"
            gameAt={screen.gameAt}
            clock={{ kickoffAt: screen.gameAt, nowMs: waitingNowMs }}
            camera={camera}
            cameraHelp={room.help}
            footer={footer}
            peers={[]}
            rootAttrs={hooks}
          />
          {cameraTap.tap === "offered" || cameraTap.tap === "tapping"
            ? <CameraTapBanner disabled={cameraTap.opening || cameraTap.tap === "tapping"} />
            : cameraRestartNotice(cameraGaveUp) ? <CameraRestartBanner /> : null}
        </>
      )
    }

    case "registered":
    case "unfunded":
    case "register":
      return band(screen)

    case "loading":
    case "queued":
    case "wrapping-up":
    case "no-game":
      return passive(screen)
  }
}

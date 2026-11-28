// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE LIVE JOURNEY (#185): N real hosted players on the chosen network (E2E_NETWORK: previewnet or paseo-next-v2), from
 * the home screen to the settled game. Booted and run by
 * scripts/e2e-live/boot.mts, which hands over the slots (ports, the oracle's
 * accounts) in E2E_SLOTS. The slot list is the unit everywhere: ONE slot on a
 * CI runner (one bot per runner, #284), several on a desk.
 *
 * Every slot gets a result-<n>.json (result.ts) for the gather job, in every
 * mode. (d) reads the game from chain (public state): it asserts a
 * Game.ReportSubmitted for each of THIS process's accounts and the settlement,
 * and only reports how many others filed. The once-per-game memory is the
 * gather job's alone.
 *
 *   (a) hosted boot  every home renders inside the host (data-source=host)
 *                    and shows the oracle's account; the lite proof minted;
 *                    a never-registered account reads absent on chain
 *   (b) sign-up      registration open: each taps Register, the UI says
 *                    "You're in", and Game.Players[account].registered at
 *                    FINALIZED for every slot
 *   (c) play         the app's own handover to /game, an approve tap on
 *                    each votable tile every turn (re-tapped until it reads
 *                    approved), Confirm, then /prize-draw; each bot's
 *                    per-turn verdict table from its tile timeline
 *   (d) settlement   Game.ReportSubmitted for each account in this game, the
 *                    game settled by report_ends + a margin, each bot's
 *                    filed report DECODED from chain with every co-player
 *                    Person (a WARN under E2E_DIAGNOSE=1), scores and
 *                    collectables into the summary
 *
 * (b)–(d) need a game a human scheduled; with none in Registration they
 * SKIP and say why. E2E_STAGE=boot runs (a) alone. Every chain assertion is
 * a pure function in chain-checks.ts; the reads are chain-read.mts, run as a
 * child process so this runner never loads polkadot-api.
 *
 * The home test hooks ([data-testid=home] with data-state, data-source,
 * data-account, data-registered; home-register; home-status) arrive with
 * #202. Until then the spec falls back to the screen's words and the
 * Register button by role, and the account comparison reports UNCHECKED.
 */
import { spawn, execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium, test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test"
import {
  NEVER_REGISTERED,
  chainVoteTable,
  checkAbsent,
  checkChainVotes,
  checkSignedUp,
  compareAccounts,
  runBotAccounts,
  settleDeadline,
  type Check,
  type ChainReader,
  type FiledReport,
  type PlayerRecord,
  type ReportEvent,
} from "./chain-checks"
import { CHAIN_READ_PARENT_TIMEOUT_MS, formatSignUpPoll } from "./chain-read-runtime"
import {
  activateTelemetryFault,
  armCameraMuteLoopActivationBypass,
  applyPageProfile,
  applyTelemetryRoute,
  backgroundPage,
  chromiumArgsFor,
  botProfile,
  jumpClock,
  contextOptionsFor,
  foregroundPage,
  freezePage,
  freezePageUntilCrash,
  hostGestureIdentity,
  nextHostGestureTurn,
  profileChecks,
  displayedGameTimeCheck,
  readClockOffsetS,
  readCameraMuteLoop,
  readFreeze,
  readHostStorageHangEvidence,
  readPageFacts,
  readSavedStoreClock,
  readTelemetryGateEvidence,
  progressDuringActiveFault,
  retryAfterViolations,
  readOutboundVideo,
  resetFreezeGap,
  muteCameraMuteLoopCurrent,
  setCameraMuteLoopIgnoreActivation,
  setHostGesture,
  setOutboundVideo,
  shouldProbeCamera,
  telemetryRouteEvidence,
  telemetryActivationProven,
  timeGetUserMedia,
} from "./browser-profile"
import { handoverAt } from "../../apps/jollity-app/lib/joined"
import { REGISTER_LABEL } from "../../apps/jollity-app/lib/registration/register-button"
import { downTurns, downWindows, missedTurns, type DownInfo } from "./down-turns"
import { earlyCloseCheck, type TrailLine } from "./early-close"
import {
  NetworkController,
  blackoutAcceptanceDeadline,
  blackoutFaultWindow,
  blackoutRecoveryObserved,
  clearNetworkAfterPlay,
  isolationWithinBlackout,
  netemCheckStatus,
  netemOutcome,
  netemStep,
  networkPlan,
  outageHost,
  postOpenBurstChecks,
  scheduleBeforeGameSteps,
  waitForRoundChannelGate,
  waitForSurvivalWindow,
  type GameMoment,
  type NetemCall,
  type RunNetwork,
} from "./network"
import {
  checkVotes,
  inferSelf,
  isApproved,
  misses,
  unobserved,
  lateTaps,
  stormVerdict,
  settleRetappable,
  parseRotY,
  parseRotateY,
  parseRows,
  parseTaps,
  readStage,
  stampOf,
  type TapRecord,
  tapBlocker,
  POST_PASS_RESCAN_MS,
  nextPostPassRescan,
  type PostPassRescan,
  tapPassPriority,
  tapPassSettlementBlocker,
  verdictMarkdown,
  verdictTable,
  voteTable,
  type Box,
  VOTABLE_STAGES,
  tapResult,
  tapLogResult,
  tileTapReady,
  tileVotable,
} from "./record"
import { BotRecorder, captureRelaunchStorage, captureWithReservedRelaunchBudget, flushGameLog, installGameLogDeliveryInit, installTelemetryRecoveryInit, proveNextOpenGameLogDelivery, readPage, staleUndurableTailError } from "./recorder"
import { emptyResult, groupsOfReport, othersReported, resultFile, stageOfTitle, stageStatus, supersededRun, type RecordingSegment, type SlotResult } from "./result"
import {
  BACKGROUND_IDLE,
  HIDDEN_STEP_IDLE,
  STEP_AFTER_HIDE_MS,
  backgroundPending,
  backgroundStep,
  confirmTapStep,
  dueAtTurn,
  freezeLanded,
  freezeRecovery,
  hiddenShowDueMs,
  hiddenStepStep,
  replayedTurns,
  savedFloorOf,
  savedFloorSurvived,
  stormGapMs,
  stormTarget,
  gameEndAt,
  lateJoinAt,
  TURN_S,
  SHOW_GRACE_MS,
  turnStartS,
  roleName,
  rolePlan,
  roundOf,
  shouldKill,
  STUCK_CARD_TEXT,
  stuckCardAtKillNote,
} from "./roles"
import { reopenSettleDecision, reopenedHostVerdict, requestHostCrash, retirePageForHostCrash } from "./host-crash"
import { CutWatch, RESTART_CARD_TESTID, SignUpScreenWatch, classifySignUpScreen, hostReconnectFromLog, signUpRestartCardCheck, signUpCutCheck, cardNeverInRoundCheck, confirmCutChainAt, confirmCutDue, cutDoesNotFit, cutHoldS, cutWindowS, hostChainInapplicable, planHasHostChainCut, reportAfterCutCheck, waitInForce, withHostTargets, withoutHostChainCuts } from "./host-chain-cut"
import { clockHeldDue, clockJumpLanded, confirmFreeze, roleFeasibility, turnAtTime, verifyRoleActs, whyNotActed, type ActId, type RoleAction } from "./role-proof"
import { WireTap, priorityRefusals, wireSummary } from "./store-wire"
import { EXPECTED_NETWORK_ISOLATION_TEXT, evaluateGuards, evaluateT9Guards, scriptedNeverTextWindows, textGuardTexts, textWatchScript, type GuardResult, type PageEvidence } from "./guards"
import { cameraUnavailableOutcome, passPermissionGate, shouldWaitForExpectedPermissionGate } from "./permission-gate"
import { reportEndsFor } from "./timing"
import { advanceVideoRoleWindow, planVideoRoleWindow, type VideoRoleControlState, type VideoRoleWindow } from "./role-groups"
import { sentrySummaryLine } from "./telemetry-env"
import { acceptBuildRefresh, buildRefreshHandled, buildRefreshNote, buildRefreshTrigger, requestBuildRefresh, type LoadedApp } from "./build-refresh"
import { awaitProbedGame, parseProbedGame } from "./probe-game"
import { UPLINK_LIFT_PROFILE, identityFor, isCheckProfile, needsDevlogHarness } from "./profile"
import { bindReplacementPage } from "./replacement-page"
import { isVersionDocument, mayRefreshApp, pinnedReleaseDocument, pinnedUpdateGateWarning } from "./app-pin"
import { fixtureHits, staleBuildVerdict } from "./stale-build-check"
import { accumulateWatchedClock, readingAnchor, selectWatchedAnchor, switchPlanOf, verifySwitch } from "./switch-proof"
import { crewIdentity, scenarioPresentation } from "./crew/catalogue"
import { afterRequiredNarration, installNarrationInit, ScenarioNarrator, scenarioNarration, type NarrationSource, type NarrationState } from "./narration"
import { BotMemorySampler } from "./memory-sampler"
import { appClockSecondAt, appClockWallMsFor, appGameMoment, observationMidpointMs, turnEntryAgreements, type AppClockReading, type AppGameMoment } from "./game-clock"
import { CLOCK_CONVERGENCE_BOUND_MS, CLOCK_GROUP_SPREAD_BOUND_MS } from "./clock-proof"
import { waitForAppClock, waitForReadyValue, waitingNetworkWarningTimeoutMs } from "./persona-readiness"
import { guardConsole, runPrivacy } from "./player-privacy"
import { endOfPlayAccepted, isNoDrawCollectables, reachedEndOfPlay } from "./end-of-play"

const REPO = resolve(__dirname, "../..")
// other players are masked in this log the moment they are printed or read from the chain (player-privacy.ts)
const PRIVACY = runPrivacy(JSON.parse(readFileSync(join(__dirname, "profiles.json"), "utf8")), JSON.parse(readFileSync(join(__dirname, "persona-bootstrap.json"), "utf8")))
guardConsole(PRIVACY)
const OUT = resolve(REPO, process.env.E2E_OUT ?? "scripts/out/e2e-live")
const SHOTS = join(OUT, "screenshots")
/** An evidence screenshot is best-effort: on a CPU-throttled profile a full-page
 *  capture can outlast the 30 s action timeout, and a missing picture must
 *  never fail a stage the bot actually passed (game 185, bot 2: reached the
 *  prize draw, then failed on the screenshot of it). */
const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(SHOTS, name), timeout: 15_000 }).catch((e: unknown) => console.log(`  screenshot ${name} skipped: ${String((e as Error)?.message ?? e).split("\n")[0]}`))
mkdirSync(SHOTS, { recursive: true })
const STAGE = process.env.E2E_STAGE ?? "all"
/** E2E_DIAGNOSE=1: record everything, but a vote the bot did not file Person
 *  is a WARN, so a diagnosis run completes. Without it the same miss FAILS. */
const DIAGNOSE = process.env.E2E_DIAGNOSE === "1"
const CLOCK_WATCH_FAULT = process.env.E2E_CLOCK_WATCH_FAULT === "1"
const VIDEO_ROLE_VIEWER_ACCOUNT = (process.env.E2E_VIDEO_ROLE_VIEWER_ACCOUNT ?? "").trim()
const VIDEO_ROLE_VIEWER_RELOAD_TURN = Number(process.env.E2E_VIDEO_ROLE_VIEWER_RELOAD_TURN ?? "")
const VIDEOS = join(OUT, "video-tmp")

interface Slot {
  n: number
  user: string
  appPort: number
  pairedAs: string | null
  app: LoadedApp
  oracle: { pairedAs: string | null; account: string | null; liteProof: string; seat: { blockers: string[] } | null; error?: string }
}
const slotsFile = process.env.E2E_SLOTS
if (!slotsFile) throw new Error("E2E_SLOTS is not set: run this through scripts/e2e-live/boot.mts")
const { slots, bootSeconds, profile: PROFILE = "baseline" } = JSON.parse(readFileSync(slotsFile, "utf8")) as { slots: (Slot & { timings?: { oracleS?: number; hostReadyS?: number | null; appUpS?: number | null } })[]; bootSeconds?: number; profile?: string }
/** null = the reserved "baseline": the plain 390x844 Chromium, nothing injected. */
const BOT = botProfile(PROFILE)
const SCENARIO = scenarioPresentation(PROFILE)
const memorySamplers = slots.map((slot) => new BotMemorySampler({
  enabled: process.env.E2E_MEMORY === "1",
  bot: slot.n,
  persona: PROFILE,
  outDir: OUT,
}))
const profileIdentity = BOT ? identityFor(BOT, "previewnet") : undefined
const gameAttribution = profileIdentity ? crewIdentity(profileIdentity).displayName : "PreviewNet Harness"
const attribution = STAGE === "boot" ? "PreviewNet Boot Harness" : gameAttribution
const narrators = slots.map(() => new ScenarioNarrator(attribution))
for (const narrator of narrators) void narrator.transition(scenarioNarration(SCENARIO, "preparing", "journey"))
const narrate = async (i: number, state: NarrationState, source: NarrationSource, action: string | null = null, detail?: string): Promise<void> => {
  await narrators[i]?.transition(scenarioNarration(SCENARIO, state, source, action, detail))
}
const narrateAll = async (state: NarrationState, source: NarrationSource, action: string | null = null, detail?: string): Promise<void> => {
  await Promise.all(narrators.map((_, i) => narrate(i, state, source, action, detail)))
}
/** The profile's changes DURING the game, fired once each when due (network timeline: by game turn or seconds
 *  after it starts; clock jumps: by game turn). boot.mts applied the profile's network and says so in
 *  E2E_NETEM_ACTIVE; without it (a desk, or E2E_NETEM=0) a network step is logged and nothing is touched. The network
 *  steps run one after another off the play loop (a blackout sleeps). */
/** the run's network: boot.mts exports the canonical name in E2E_NETWORK (host-slot.mjs cannot be imported here) */
const NETWORK: RunNetwork = process.env.E2E_NETWORK === "paseo-next-v2" ? "paseo-next-v2" : "previewnet"
const PROFILE_PLAN = networkPlan(botProfile(PROFILE), undefined, NETWORK)
/** host-chain-lost is only meaningful when the app reads the chain over its OWN socket (app=local): on a deployed app its cuts
 *  are dropped from the plan and the persona is INCONCLUSIVE, never proven (host-chain-cut.ts hostChainInapplicable). */
const HOST_CHAIN_NA = planHasHostChainCut(PROFILE_PLAN) ? hostChainInapplicable(slots[0].app.app) : null
const NET_PLAN = HOST_CHAIN_NA ? withoutHostChainCuts(PROFILE_PLAN) : PROFILE_PLAN
/** what went wrong with the role or the network steps; each is a failing check in (c) (role-proof.ts verifyRoleActs) */
const roleProblems: string[] = []
const cameraMuteProofs = slots.map(() => ({ activatedTap: false, ignoredTap: false, restartShown: false }))
const firedJumps = new Set<number>()
const networkController = new NetworkController({
  plan: NET_PLAN,
  active: process.env.E2E_NETEM_ACTIVE === "1",
  shared: process.env.E2E_SHARED_NETWORK === "1",
  // a host-chain cut targets THIS runner's host: its pid file, log and in-force marker (host-chain-cut.ts)
  run: (call, onLifecycle) => netemStep(REPO, OUT, withHostTargets(call, OUT, slots[0].n), console.log, onLifecycle),
  write: (line) => appendFileSync(join(OUT, "netem.log"), line + "\n"),
  say: console.log,
  profileName: PROFILE,
  problems: roleProblems,
  captureAdaptation: () => recorderFor(0).captureSendAdaptation(),
  onNarration: ({ step, state, role, detail }) => {
    if (role === "setup" && state !== "failed" && state !== "inconclusive") return
    const narrationState: NarrationState = state === "restored" || (role === "restore" && state === "active")
      ? "recovered"
      : state === "inconclusive"
        ? "failed"
        : state
    void narrateAll(narrationState, "network", `network.${step}`, state === "inconclusive" ? "The network action was inconclusive; the run did not count it as a pass." : detail)
  },
})
/** THE GAME-MOMENT STEPS (atSignUp, atConfirm): fire the steps waiting for `moment` when a cut of their window fits before
 *  `endsAt` (game seconds) with `marginS` to spare, else record why they did not fire (the network-timeline check then fails on
 *  the missing step, with this note beside it). Returns whether anything fired. */
function fireMoment(moment: GameMoment, appNowS: number, endsAt: number, marginS: number, what: string, turn = 0): boolean {
  const due = networkController.pendingAt(moment)
  if (!due.length) return false
  const windowS = Math.max(0, ...due.map((s) => cutWindowS(s.calls) ?? 0))
  const why = windowS ? cutDoesNotFit(windowS, appNowS, endsAt, marginS, what) : null
  if (why) {
    const line = `${new Date().toISOString()} network step(s) at the ${moment} NOT fired: ${why}`
    console.log(`  ${line}`)
    appendFileSync(join(OUT, "netem.log"), line + "\n")
    slotResults.forEach((r) => r.role.notes.push(line))
    cutWatches[moment]?.disarm()
    return false
  }
  const rows = networkController.onMoment(moment, turn)
  if (rows.length) record.networkSteps = [...((record.networkSteps as unknown[]) ?? []), ...rows]
  const watch = cutWatches[moment]
  if (rows.length && watch?.armed) {
    watch.fired(Date.now())
    // netem.sh writes the marker the moment the host's sockets are killed; the taps wait on it (CutWatch.gateOpen, at most
    // CUT_SETUP_MS), while the marker itself is watched until the game's own deadline, so a slow setup is late, never missed
    const firedAt = Date.now()
    void waitInForce(OUT, slots[0].n, watch.markerWaitMs(firedAt)).then((ok) => {
      if (ok) watch.inForce(Date.now())
      const line = `${new Date().toISOString()} host-chain cut at the ${moment}: ${ok ? `in force ${Math.round((Date.now() - firedAt) / 100) / 10} s after it fired` : "NOT in force before the game's deadline"}`
      console.log(`  ${line}`)
      appendFileSync(join(OUT, "netem.log"), line + "\n")
    })
  }
  return rows.length > 0
}
/** wall ms of the Register tap that followed the sign-up cut (null: no cut was fired at the sign-up) */
let signUpTapAtMs: number | null = null
/** The two cuts as the taps see them; armed in (b) and (c) once the game's deadlines are known. */
const cutWatches: Partial<Record<GameMoment, CutWatch>> = {}
const cutArmed = (moment: GameMoment): boolean => !HOST_CHAIN_NA && networkController.isActive && networkController.pendingAt(moment).some((s) => cutWindowS(s.calls) !== null)
/** the round on the PAGE's clock: the first and the latest turn it showed (wall ms), for the restart-card check */
const pageRound: { fromMs: number | null; toMs: number | null } = { fromMs: null, toMs: null }
/** Freshest independent best-block anchor. Diagnostic only: it never schedules or judges an action. */
let switchAnchor: ReturnType<typeof readingAnchor> = null
const clockDiagnostic = (label: string, clock: AppClockReading): string => {
  const wallMs = Date.now()
  const appGapS = appClockSecondAt(clock, wallMs) - wallMs / 1000
  const bestGap = switchAnchor ? `${(switchAnchor.chainNowS - switchAnchor.wallNowMs / 1000).toFixed(3)} s` : "unavailable"
  const line = `${label}: app clock ${appGapS >= 0 ? "+" : ""}${appGapS.toFixed(3)} s vs runner wall; independent best-block diagnostic ${bestGap} vs runner wall`
  console.log(`  ${line}`)
  slotResults.forEach((result) => result.role.notes.push(line))
  return line
}
/** Last app-clock reading per page, retained when a late-join role leaves the app. */
const appClockSeeds: Array<AppClockReading | null> = slots.map(() => null)
/** App-clock reading that made the switch step due. */
let switchAppClock: AppClockReading | null = null
/** First runner-wall observation of each canonical app turn, by slot. */
const appTurnEntries = new Map<number, Map<number, number>>()
/** #1060 convergence bound: 250 ms dead band plus half its 1 s accepted RTT. */
const CLOCK_AGREEMENT_TOLERANCE_MS = CLOCK_CONVERGENCE_BOUND_MS
const recordClockSample = (slotIndex: number, label: string, clock: AppClockReading): void => {
  if (!clock.sync) return
  const evidence = slotResults[slotIndex]?.appClockEvidence
  if (!evidence) return
  const previous = evidence.samples.at(-1)
  if (previous?.label === label && previous.offsetMs === clock.sync.offsetMs && previous.method === clock.sync.method && previous.peers === clock.sync.peers) return
  evidence.samples.push({ label, readAtMs: clock.readAtMs, nowMs: clock.nowMs, offsetMs: clock.sync.offsetMs, method: clock.sync.method, peers: clock.sync.peers })
}
/** The confirm cut: fire from the canonical app turn, with a timer projected
 * from that same app clock as fallback. */
let fireConfirmCut: ((turn?: number) => void) | null = null
let telemetryFaultStarted = false
let telemetryFaultStartedAtMs: number | null = null
let telemetryRecoveryAtMs: number | null = null
let telemetryFaultRecovered = false
let telemetryActivation: Promise<void> | null = null
let telemetryStorageDrops = 0
const telemetryProgressAtMs: Array<number | null> = slots.map(() => null)
const duringGame = (moment: AppGameMoment, slotIndex: number): void => {
  recordClockSample(slotIndex, moment.turn === null ? moment.stage : `turn-${moment.turn}`, moment.clock)
  const turn = moment.turn
  if (turn === null) return
  const bySlot = appTurnEntries.get(turn) ?? new Map<number, number>()
  if (!bySlot.has(slotIndex) && game) {
    // Infer this page's wall-time turn boundary from its own app clock. The
    // loop may observe two pages at different instants; comparing read times
    // would measure runner scheduling rather than clock agreement.
    bySlot.set(slotIndex, appClockWallMsFor(moment.clock, game.gameAt + turnStartS(game, turn)))
    slotResults[slotIndex].appClockEvidence = {
      toleranceMs: CLOCK_AGREEMENT_TOLERANCE_MS,
      samples: slotResults[slotIndex].appClockEvidence?.samples ?? [],
      timeline: slotResults[slotIndex].appClockEvidence?.timeline ?? [],
      turnEntries: [...(slotResults[slotIndex].appClockEvidence?.turnEntries ?? []), {
        round: moment.snapshot.kind === "round" ? moment.snapshot.round : Math.floor((turn - 1) / game.maxGroupSize),
        turn,
        atMs: bySlot.get(slotIndex)!,
      }],
    }
  }
  appTurnEntries.set(turn, bySlot)
  pageRound.fromMs ??= Date.now()
  pageRound.toMs = Date.now()
  if (game && confirmCutDue(turn, game.rounds * game.maxGroupSize)) fireConfirmCut?.(turn)
  const sinceStartS = game ? moment.clock.nowMs / 1000 - game.gameAt : null
  const rows = networkController.onTurn({ turn, sinceStartS })
  if (rows.some((row) => row.calls.some((call) => call[0] === "swap")) && BOT && switchPlanOf(BOT.network)) switchAppClock ??= moment.clock
  if (rows.length) record.networkSteps = [...((record.networkSteps as unknown[]) ?? []), ...rows]
  const torture = BOT?.telemetryTorture
  if (torture?.activateAtTurn !== undefined && !telemetryFaultStarted && turn >= torture.activateAtTurn) {
    telemetryFaultStarted = true
    telemetryFaultStartedAtMs = Date.now()
    telemetryActivation = Promise.all(pages.map((page) => activateTelemetryFault(page, torture))).then((deadlines) => {
      telemetryRecoveryAtMs = Math.max(0, ...deadlines.flatMap((deadline) => (deadline === null ? [] : [deadline]))) || null
      const note = `${torture.id}: telemetry fault activated at turn ${turn}${telemetryRecoveryAtMs ? ` until ${new Date(telemetryRecoveryAtMs).toISOString()}` : ""}`
      slotResults.forEach((result) => result.role.notes.push(note))
      void narrateAll("active", "role", `telemetry.${torture.id}`)
    })
  }
  // a clock that starts wrong must still read wrong once the game runs, before its correction (clock-held)
  if (!heldInGame && clockHeldDue(BOT).length && BOT && !BOT.clockJumps?.some((j) => turn >= j.atTurn)) {
    heldInGame = true
    pages.forEach((p, i) => void clockHeld(i, p, `at game turn ${turn}`))
  }
  BOT?.clockJumps?.forEach((j, k) => {
    if (firedJumps.has(k) || turn < j.atTurn) return
    firedJumps.add(k)
    const line = `${new Date().toISOString()} clock jump at game turn ${turn}: the page clock is now ${j.offsetS >= 0 ? "+" : ""}${j.offsetS} s`
    console.log(`  ${line}`)
    appendFileSync(join(OUT, "netem.log"), line + "\n")
    slotResults.forEach((r) => r.role.notes.push(line))
    // proof the jump LANDED: the offset read back from the page itself, recorded as the role's action (#321)
    const sign = (s: number) => `${s >= 0 ? "+" : ""}${s}`
    pages.forEach((p, i) =>
      void jumpClock(p, j.offsetS)
        .then(() => readClockOffsetS(p))
        .then((read) => {
          const back = `read back ${sign(Math.round(read * 10) / 10)} s`
          if (clockJumpLanded(j.offsetS, read)) {
            roleAct(i, "clock-jump", `at game turn ${turn}: page clock set to ${sign(j.offsetS)} s, ${back}`)
            void narrate(i, "active", "role", `clock.${k + 1}`)
          }
          else roleProblems.push(`clock jump at turn ${turn} did not take: wanted ${sign(j.offsetS)} s, ${back} (page ${i})`)
        })
        .catch((e: Error) => console.log(`  clock jump on page ${i} failed: ${String(e.message).split("\n")[0]}`)),
    )
  })
}

/** The boot-only proof of the host-chain cut: short, so stage (a) stays quick; the hold is long enough for the during probes.
 *  Flat on purpose: a boot-only run has no game whose times could size it. */
const HOST_CHAIN_SELF_TEST = { windowS: 25, holdS: 8 }
let heldInGame = false
/** CLOCK-HELD: a clock that starts wrong (clockOffsetS) and is corrected mid-game must read wrong at the sign-up and in
 *  the game before its correction, read back from the page itself; that is what makes the correction a correction. */
async function clockHeld(i: number, page: Page, where: string): Promise<void> {
  if (!BOT) return
  const sign = (s: number) => `${s >= 0 ? "+" : ""}${s}`
  const read = await readClockOffsetS(page).catch(() => null)
  if (read !== null && clockJumpLanded(BOT.clockOffsetS, read)) roleAct(i, "clock-held", `${where}: the page clock reads ${sign(Math.round(read * 10) / 10)} s (the profile starts it at ${sign(BOT.clockOffsetS)} s)`)
  else roleProblems.push(`clock-held ${where}: wanted the page clock at ${sign(BOT.clockOffsetS)} s, read ${read === null ? "nothing" : `${sign(Math.round(read * 10) / 10)} s`}`)
}
/** what the profile's role does in the game (roles.ts); a bot-null check-* profile is a CHECK and never signs up, except seat-preparing, which signs up as a fresh person */
const ROLE = rolePlan(BOT, process.env.E2E_ROLES === "1")
const CHECK = isCheckProfile(BOT) && BOT?.role.kind !== "seat-preparing"
/** the profiles whose Sentry guards judge only the page after the reload or the relaunch */
const GUARDS_AFTER_REOPEN = new Set(["reload-clean-close", "turn-cache-relaunch"])
const EXPECTED_NO_JOIN = BOT?.expectedOutcome?.kind === "camera-unavailable" ? `expected: camera ${BOT.expectedOutcome.reason}, help shown, not handed over` : null
const accounts = slots.map((s) => s.oracle.account ?? "")
const allRunBotAccounts = runBotAccounts(process.env.E2E_RUN_BOT_ACCOUNTS, accounts)
const who = slots.length === 1 ? "the player" : `all ${slots.length} players`

// ── one result per slot, for the gather job ─────────────────────────────────
const slotResults: SlotResult[] = slots.map((sl) => {
  const r = emptyResult(sl.n, sl.oracle.account, sl.oracle.pairedAs ?? sl.pairedAs, new Date(), PROFILE)
  r.role.kind = roleName(ROLE)
  r.appClockEvidence = { toleranceMs: CLOCK_AGREEMENT_TOLERANCE_MS, turnEntries: [], samples: [], timeline: [] }
  r.timings = { bootS: bootSeconds ?? null, oracleS: sl.timings?.oracleS ?? null, hostReadyS: sl.timings?.hostReadyS ?? null, appUpS: sl.timings?.appUpS ?? null }
  return r
})
const overlayGuards: GuardResult[][] = slots.map(() => [])
const saveResults = () => {
  for (const [i, r] of slotResults.entries()) {
    r.guards = [...r.guards.filter((guard) => guard.note !== "recording-overlay"), ...overlayGuards[i]]
    r.narration = [...(narrators[i]?.snapshot() ?? [])]
    const recorder = recorders.get(i)
    if (recorder) {
      const devlog = recorder.devlogEvidence().lines
      if (r.appClockEvidence) {
        r.appClockEvidence.timeline = devlog
          .filter((line) => line.tag === "clock" && typeof line.ts === "number")
          .map(({ ts, sessionId, message, data }) => ({ ts: ts!, ...(sessionId === undefined ? {} : { sessionId }), message, ...(data && typeof data === "object" ? { data: data as Record<string, unknown> } : {}) }))
      }
      r.telemetryGroundTruth = {
        ...recorder.telemetryGroundTruth(game?.index, allPages[i]?.length ?? 1),
        ...(BOT?.clockOffsetS ? { clockOffsetMs: BOT.clockOffsetS * 1000 } : {}),
        ...(telemetryFaultStartedAtMs !== null ? { faultStartedAt: new Date(telemetryFaultStartedAtMs).toISOString() } : {}),
        ...(telemetryRecoveryAtMs !== null && Date.now() >= telemetryRecoveryAtMs ? { recoveredAt: new Date(telemetryRecoveryAtMs).toISOString() } : {}),
      }
    }
    r.finishedAt = new Date().toISOString()
    writeFileSync(join(OUT, resultFile(r.slot)), JSON.stringify(r, null, 2))
  }
}

// ── chain reads (chain-read.mts) ───────────────────────────────────────────
interface ChainState {
  chainNow: number
  /** Timestamp.Now at the BEST block (chain-read.mts); absent from an older reader */
  chainBestNow?: number | null
  /** consecutive best-chain Timestamp.Now delta, measured by chain-read */
  chainBlockMs?: number | null
  reportingS: number
  game: { index: number; state: string; registrationEnds: number; gameAt: number; reportEnds: number; rounds: number; maxGroupSize: number } | null
  schedules: number[]
}
const chainReadFor = <T,>(timeout: number, ...args: string[]): T =>
  JSON.parse(
    execFileSync("npx", ["tsx", "scripts/e2e-live/chain-read.mts", ...args], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    }),
  ) as T
const chainRead = <T,>(...args: string[]): T => chainReadFor<T>(CHAIN_READ_PARENT_TIMEOUT_MS.default, ...args)
const readState = () => chainRead<ChainState>("state")
const reader: ChainReader = {
  async player(account) {
    const { players } = chainRead<{ players: Record<string, PlayerRecord | null> }>("players", account)
    return players[account] ?? undefined
  },
}
const appTiming = (g: NonNullable<ChainState["game"]>) => ({
  gameDate: g.gameAt,
  reportEnds: g.reportEnds,
  rounds: g.rounds,
  maxGroupSize: g.maxGroupSize,
})

async function readAppClock(page: Page): Promise<AppClockReading | null> {
  const beforeMs = Date.now()
  const clock = await page.evaluate(() => {
    const hook = (window as unknown as { __jollityHarness?: { gameClock?(): { nowMs: number; nowSeconds: number; offset: number; block: number | null; sync: { offsetMs: number; method: string; peers: number } | null } | null } }).__jollityHarness
    return hook?.gameClock?.() ?? null
  }).catch(() => null)
  const afterMs = Date.now()
  return clock ? { ...clock, readAtMs: observationMidpointMs(beforeMs, afterMs) } : null
}

async function readAppMoment(page: Page, g: NonNullable<ChainState["game"]>): Promise<AppGameMoment | null> {
  const clock = await readAppClock(page)
  return clock ? appGameMoment(clock, appTiming(g)) : null
}

// ── the record ─────────────────────────────────────────────────────────────
const record: Record<string, unknown> = { slots: slots.map(({ n, user, appPort, oracle }) => ({ n, user, appPort, account: oracle.account })) }
const save = () => writeFileSync(join(OUT, "journey.json"), JSON.stringify(record, null, 2))
const summary = (line: string) => {
  PRIVACY.seeIn(line)
  appendFileSync(join(OUT, "summary.md"), line + "\n")
}
const printChecks = (checks: Check[]) => {
  for (const c of checks) console.log(`  ${c.status.toUpperCase().padEnd(9)} ${c.name} — ${c.detail}`)
}
const expectChecks = (checks: Check[]) => {
  printChecks(checks)
  const failed = checks.filter((c) => c.status === "fail")
  expect(failed, failed.map((c) => `${c.name}: ${c.detail}`).join("\n")).toEqual([])
}

/** Builds already left successfully, per slot. A second stale gate may mean a
 *  second deploy; it may move on from the new CID, but never loop from one the
 *  bot has already left. */
const refreshedFrom = slots.map(() => new Set<string>())
const refreshAttemptAt = slots.map(() => 0)
const REFRESH_RETRY_MS = 3000

/** Do what a player does when the pre-handover update gate appears: re-resolve
 *  the name through this slot's local server, then reload the same page and
 *  host context. Returns true whenever the loop must stay on refresh handling:
 *  an explicit app update message is never skipped while dotNS catches up. */
async function recoverStaleBuild(page: Page, i: number, notes: string[], previewHandoverMs?: number): Promise<boolean> {
  const update = page.getByTestId("home-update").or(page.getByText("Update available"))
  const slot = slots[i]
  const updateVisible = await update.first().isVisible().catch(() => false)
  const pinWarning = pinnedUpdateGateWarning(slot.app, updateVisible)
  if (pinWarning) console.log(`  player ${slot.n}: ${pinWarning}`)
  if (!mayRefreshApp(slot.app)) return false
  const trigger = buildRefreshTrigger({ updateVisible, app: slot.app.app, nowMs: Date.now(), lastAttemptMs: refreshAttemptAt[i], handoverMs: previewHandoverMs })
  if (!trigger) return false
  const proactivePreview = trigger === "pr-preview"
  if (!slot.app.cid) throw new Error(`player ${slot.n}: the update gate appeared on a local build, which has no deployed name to re-resolve`)
  const wait = proactivePreview ? 0 : REFRESH_RETRY_MS - (Date.now() - refreshAttemptAt[i])
  if (wait > 0) await page.waitForTimeout(wait)
  refreshAttemptAt[i] = Date.now()
  const started = Date.now()
  const answer = await requestBuildRefresh(slot.appPort).catch((error: unknown) => {
    if (!proactivePreview) throw error
    console.log(`  player ${slot.n}: preview refresh check failed without delaying dispatch: ${error instanceof Error ? error.message : String(error)}`)
    return null
  })
  if (!answer) return false
  const accepted = acceptBuildRefresh(answer, refreshedFrom[i])
  if (!accepted) {
    console.log(`  player ${slot.n}: app.${slot.app.app} still resolves ${answer.from.cid}; ${proactivePreview ? "continuing on time" : "retrying update gate"}`)
    return buildRefreshHandled(trigger, false)
  }
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 })
  const completed = { ...accepted, seconds: (Date.now() - started) / 1000 }
  const note = buildRefreshNote(slot.n, completed)
  console.log(`  ${note}`)
  notes.push(note)
  ;(slotResults[i].buildReloads ??= []).push({
    from: { cid: completed.from.cid, version: completed.from.version },
    to: { cid: completed.to.cid, version: completed.to.version },
    seconds: completed.seconds,
  })
  return buildRefreshHandled(trigger, true)
}

// ── the home screen ────────────────────────────────────────────────────────
interface Home {
  hooks: boolean
  gate: boolean
  state: string | null
  source: string | null
  account: string | null
  registered: string | null
  text: string
  /** the reopen stopped on /game before the home settled: the read above is a loading home's (reopenedHostVerdict) */
  onGame?: boolean
  expectedOutcome?: { kind: "camera-unavailable"; reason: "denied" | "no-camera"; helpShown: boolean; handedOver: boolean }
}
const HOME_WORDS = /Update available|No game scheduled|Next game|Registration soon|You're in|Game at|Game starts at|Game starting|Wrapping up|You missed this one|Waiting room|Top up to play|Joining your group|round (finished|started) without you/
async function readHome(page: Page): Promise<Home> {
  // ONE in-page read: the root, its attributes and the words in the same tick, never a locator count and then a getAttribute
  // per attribute. Those auto-wait: a home that router.replace()d to /game between the count and the reads left each of
  // four waiting out its 5 s timeout (game 317, bot 20: 20 s blind after the reopen, every attribute null). A read that a
  // navigation destroys is no home this tick; the caller reads again.
  const r = await page
    .evaluate(() => {
      const root = document.querySelector("[data-testid=home]")
      const [state, source, account, registered] = ["data-state", "data-source", "data-account", "data-registered"].map((name) => root?.getAttribute(name) ?? null)
      return { hooks: !!root, state, source, account, registered, text: document.body?.innerText ?? "" }
    })
    .catch(() => ({ hooks: false, state: null, source: null, account: null, registered: null, text: "" }))
  const text = r.text.replace(/\s+/g, " ").trim()
  return { ...r, gate: /Open Jollity in the Polkadot app/.test(text), text: text.slice(0, 200) }
}
/** Wait until the home has left its loading state (or shows the host gate). */
async function settledHome(page: Page, timeoutMs: number, opts: { stopOnGame?: boolean } = {}): Promise<Home> {
  let deadline = Date.now() + timeoutMs
  let home = await readHome(page)
  while (Date.now() < deadline) {
    // a DEPLOYED build has no dev skip of the permission gate (permission-gate.ts): pass it as a player does
    const cameraExpectation = BOT?.expectedOutcome?.kind === "camera-unavailable" ? BOT.expectedOutcome : undefined
    const gate = await passPermissionGate(page, console.log, 300_000, cameraExpectation)
    if (gate.kind === "passed") deadline = Date.now() + timeoutMs
    if (gate.kind === "camera-unavailable") return { ...(await readHome(page)), expectedOutcome: gate }
    home = await readHome(page)
    if (home.gate) return home
    const settled = home.hooks ? home.state !== null && home.state !== "loading" && !!home.source : HOME_WORDS.test(home.text)
    if (settled && !shouldWaitForExpectedPermissionGate(page.url(), cameraExpectation)) return home
    // a reopen during a live game goes straight to /game, which has no home hooks or words: stop now, not at the deadline (#638)
    if (opts.stopOnGame && reopenSettleDecision({ url: page.url(), homeSettled: false, elapsedMs: 0, timeoutMs }) === "on-game") {
      console.log(`  reopened page is on /game, not waiting for the home to settle`)
      return { ...home, onGame: true }
    }
    await page.waitForTimeout(1000)
  }
  return home
}

// ── the browsers ───────────────────────────────────────────────────────────
let contexts: BrowserContext[] = []
let theBrowser: Browser | null = null
/** Reject after `ms` with the step named: a relaunch that goes wrong fails in seconds, not at the stage timeout (game 188: 30 min). */
/** browsers launched by a relaunch, closed with the rest */
const launchedAfterKill: Browser[] = []
const bounded = <T,>(p: Promise<T>, ms: number, step: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`relaunch step "${step}" did not finish within ${ms / 1000} s`)), ms))])
let pages: Page[] = []
/** every page a slot ever had (a relaunch makes another), for the videos */
const allPages: Page[][] = []
/** Node clock bounds for each Playwright video. The narration timeline uses
 * the same runner clock; preserving each relaunch as its own domain avoids
 * guessing where a later WebM begins. */
const recordingBounds = new Map<Page, { startedAt: string; finishedAt?: string }>()
let signedUp = false
let played = false
/** (c): the page the app handed to the chest after /game, with no report counted (#303 missed, #601 gone): (d) judges it */
const chestEnded: boolean[] = []
let game: NonNullable<ChainState["game"]> | null = null

/** test.skip, with the reason in the log and the summary (the list reporter
 *  shows a skipped test without one). */
const skipIf = (condition: boolean, reason: string) => {
  if (!condition) return
  console.log(`  SKIP      ${reason}`)
  summary(`\n- skipped: ${reason}`)
  test.skip(true, reason)
}

test.describe.configure({ mode: "serial" })

test.afterEach(async ({}, testInfo) => {
  const stage = stageOfTitle(testInfo.title)
  if (!stage) return
  const first = testInfo.errors[0]?.message?.split("\n")[0]
  for (const r of slotResults) {
    const st = r.stages[stage]
    st.status = stageStatus(testInfo.status ?? "failed")
    st.seconds = +(testInfo.duration / 1000).toFixed(1)
    if (first && st.status === "fail") st.notes.push(first.slice(0, 300))
  }
  const failed = testInfo.status !== "passed" && testInfo.status !== "skipped"
  const outcomeState: NarrationState | null = failed
    ? "failed"
    : testInfo.status === "passed" && stage === "c"
      ? "verifying"
      : testInfo.status === "passed" && (stage === "d" || (stage === "a" && (STAGE === "boot" || EXPECTED_NO_JOIN !== null)))
        ? "passed"
        : null
  const persistStage = async () => {
    if (failed) await keepFailureEvidence(stage)
    saveResults()
  }
  await persistStage()
  if (outcomeState) {
    await afterRequiredNarration(narrators, scenarioNarration(SCENARIO, outcomeState, "outcome"), (failures) => {
      for (const { narrator, error } of failures) {
        const evidence = String(error).replace(/\s+/g, " ").trim().slice(0, 300)
        overlayGuards[narrator].push({
          kind: "text",
          description: "recording overlay acknowledged the final stage outcome",
          status: "fail",
          evidence,
          note: "recording-overlay",
        })
      }
      saveResults()
    })
  }
})

/** A STAGE FAILED OR TIMED OUT: keep what the app knew. The per-bot recorder only exports in (c), so without this a sign-up that
 *  never landed lost the app's own devLog (game 195: hang or failed-and-retried?). Written to devlog-<n>.json, which the workflow's
 *  devlog-*.json glob uploads. Every export is best-effort: a gone page is a logged warning, never a new failure. For stage (b) the
 *  named host-chain-lost check (#507) is then judged here, because (c) never runs after a failed (b). */
async function keepFailureEvidence(stage: string): Promise<void> {
  await Promise.all(
    slots.map(async (slot, i) => {
      if (!pages[i] || pages[i].isClosed()) return console.log(`  WARN      player ${slot.n}: devLog not exported after the failed stage (${stage}): the page is gone`)
      try {
        await recorderFor(i).exportDevLog()
      } catch (e) {
        console.log(`  WARN      player ${slot.n}: devLog not exported after the failed stage (${stage}): ${String(e).split("\n")[0]}`)
      }
    }),
  )
  const watch = cutWatches["sign-up"]
  if (stage !== "b" || !watch?.armed) return
  let check: Check
  try {
    const netemPath = join(OUT, "netem.log")
    check = signUpRestartCardCheck(slots[0].n, { watch, landed: slot0SignedUp, screen: signUpScreen, host: hostReconnectFromLog(existsSync(netemPath) ? readFileSync(netemPath, "utf8") : ""), nowMs: Date.now() })
  } catch (e) {
    return console.log(`  WARN      the sign-up restart-card check could not be judged: ${String(e).split("\n")[0]}`)
  }
  printChecks([check])
  summary(`\n### (b) sign-up check, game ${game?.index ?? "?"}\n\n- ${check.status}: ${check.name} (${check.detail})`)
  record.b = { ...((record.b as object) ?? {}), signUpRestartCard: check }
  save()
  if (check.status === "fail") slotResults.forEach((r) => r.stages.b.notes.push(`CHECK FAIL: ${check.name}: ${check.detail}`.slice(0, 600)))
}

/** A bot's context: the profile's device (viewport, UA, touch) or the baseline phone, recording video. */
const deviceOptions = () => (BOT ? contextOptionsFor(BOT) : { viewport: { width: 390, height: 844 }, permissions: ["camera"] })
type RelaunchStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>
const newContext = async (browser: Browser, storageState?: RelaunchStorageState) => {
  const o = deviceOptions()
  const size = (o.viewport ?? { width: 390, height: 844 }) as { width: number; height: number }
  const context = await browser.newContext({ ...o, recordVideo: { dir: VIDEOS, size }, ...(storageState ? { storageState } : {}) })
  const release = pinnedReleaseDocument(slots[0].app, process.env.E2E_APP_PIN_SOURCE)
  if (release) {
    await context.route(isVersionDocument, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
      body: JSON.stringify(release.body),
    }))
    console.log(`  app release: ${release.product} ${release.version.slice(0, 12)} (pinned by input)`)
  }
  return context
}
/** A page with the profile's CPU limit, clock and camera delay applied BEFORE anything loads. */
const newBotPage = async (context: BrowserContext, i: number): Promise<Page> => {
  await installGameLogDeliveryInit(context)
  await installTelemetryRecoveryInit(context)
  await installNarrationInit(context, attribution)
  // Playwright begins its WebM while newPage is resolving, so take the lower
  // clock bound before asking for the page rather than after the first frames.
  const recordingStartedAt = new Date().toISOString()
  const page = await context.newPage()
  recordingBounds.set(page, { startedAt: recordingStartedAt })
  await memorySamplers[i].attach(page)
  await narrators[i].attach(page)
  wireTaps[i].attach(page)
  if (BOT) {
    const pageLoad = allPages[i]?.length ?? 0
    await applyPageProfile(page, BOT, pageLoad, ROLE.kind)
    if (BOT.telemetryTorture) await applyTelemetryRoute(page, BOT.telemetryTorture, pageLoad)
    // which of the profile's text guards ever show on the page (an observer, so a text that comes and goes is caught)
    const texts = textGuardTexts(BOT)
    if (texts.length) await page.addInitScript(textWatchScript(texts))
  }
  return page
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  theBrowser = browser
  contexts = await Promise.all(slots.map(() => newContext(browser)))
  pages = await Promise.all(contexts.map((c, i) => newBotPage(c, i)))
  pages.forEach((page, i) => {
    allPages[i] = [page]
    attachLogs(page, i)
  })
  // Every profile has a visible story even when its impairment is static
  // (CPU, camera, locale, relay-only, or a fault armed at app open). Specific
  // role and network actions replace this summary as they happen.
  await narrateAll("active", "journey")
})

/** The page's console, errors and navigations into browser-<n>.log. */
function attachLogs(page: Page, i: number) {
  const log = join(OUT, `browser-${slots[i].n}.log`)
  const stamp = () => new Date().toISOString().slice(11, 19)
  page.on("console", (m) => appendFileSync(log, `${stamp()} ${m.type()} ${m.text().slice(0, 500)}\n`))
  page.on("pageerror", (e) => appendFileSync(log, `${stamp()} PAGEERROR ${e.message}\n`))
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) {
      appendFileSync(log, `${stamp()} NAV ${f.url()}\n`)
      // installNarrationInit runs in every new document and restores the latest
      // session payload. A second runner-side evaluate here races the required
      // outcome write while /game hands over to /prize-draw.
    }
  })
}

/** One host-websocket tap per slot (store-wire.ts): the store's own refusals, with their reasons, across reloads and relaunches. */
const wireTaps = slots.map((_, i) => new WireTap((r) => console.log(`  STORE     player ${slots[i].n} refused a submit: ${r.reason}`)))

/** One recorder per bot (tiles-N.jsonl, screenshots, devlog-N.json). */
const recorders = new Map<number, BotRecorder>()
const recorderFor = (i: number) => {
  let r = recorders.get(i)
  if (!r) {
    r = new BotRecorder(pages[i], slots[i].n, OUT, SHOTS)
    recorders.set(i, r)
  }
  return r
}

async function forceClockWatchFailure(page: Page, i: number): Promise<Check> {
  const invoked = await page
    .evaluate(() => {
      const requestedAt = Date.now()
      const hook = (window as unknown as { __jollityHarness?: { failClockWatchOnce?(): boolean } }).__jollityHarness
      return { requestedAt, harness: hook !== undefined, fired: hook?.failClockWatchOnce?.() ?? false }
    })
    .catch(() => ({ requestedAt: null, harness: false, fired: false }))
  if (!invoked.harness)
    return { name: "clock watch one-shot fault", status: "fail", detail: "the test-tagged page has no jollity harness" }
  if (!invoked.fired)
    return { name: "clock watch one-shot fault", status: "fail", detail: "the page had no active clock watch to fail" }
  if (invoked.requestedAt === null)
    return { name: "clock watch one-shot fault", status: "fail", detail: "the page clock was unavailable at fault request" }

  const requestedAt = invoked.requestedAt
  const deadline = Date.now() + 20_000
  let failedAt: number | null = null
  while ((failedAt === null || failedAt < requestedAt) && Date.now() < deadline) {
    failedAt = await recorderFor(i).observeDevLogAt("clock", "chain clock subscription failed; resubscribing")
    if (failedAt === null || failedAt < requestedAt) await page.waitForTimeout(100)
  }
  if (failedAt === null || failedAt < requestedAt)
    return { name: "clock watch one-shot fault", status: "fail", detail: "the forced failure produced no new resubscribe log within 20 seconds" }

  let recoveredAt: number | null = null
  while ((recoveredAt === null || recoveredAt <= failedAt) && Date.now() < deadline) {
    recoveredAt = await recorderFor(i).observeDevLogAt("clock", "chain clock subscription recovered")
    if (recoveredAt === null || recoveredAt <= failedAt) await page.waitForTimeout(100)
  }
  return recoveredAt === null || recoveredAt <= failedAt
    ? { name: "clock watch one-shot fault", status: "fail", detail: "the replacement watch produced no post-fault chain anchor within 20 seconds" }
    : { name: "clock watch one-shot fault", status: "pass", detail: `failed at ${new Date(failedAt).toISOString()}, resubscribed, and anchored again at ${new Date(recoveredAt).toISOString()}` }
}

test.afterAll(async () => {
  // A play-stage failure can bypass the normal post-play recovery point. Drain
  // any deferred reopen comparison while the replacement documents are still
  // alive so the final artifacts never silently omit crash durability.
  await recoverPendingReopenedTelemetry("after-all-fallback")
  // the game's log to Sentry before the page goes (recorder.ts flushGameLog):
  // a bot that failed before the payoff sends none otherwise. Not the boot-only
  // run, which never reaches a game.
  if (STAGE !== "boot") {
    const notes = await Promise.all(pages.map((p) => flushGameLog(p)))
    record.gameLog = notes.map((note, i) => ({ n: slots[i].n, note }))
    summary(`\n### game log to Sentry\n\n${notes.map((note, i) => `- player ${slots[i].n}: ${note}`).join("\n")}`)
    notes.forEach((note, i) => console.log(`  game log ${slots[i].n}: ${note}`))
    // Snapshot after the flush attempt so every live document is covered and
    // diagnostics retain the chest/payoff tail. The oracle separately caps
    // truth at the last checkpoint/send boundary the page itself recorded.
    await Promise.all([...recorders.entries()].map(async ([i, recorder]) => {
      const snap = await recorder.snapshotDevLog("post-checkpoint-flush")
      slotResults[i].role.notes.push(`post-checkpoint telemetry truth: ${snap}`)
    }))
  }
  // Finish while the documents and their CDP sessions are still alive. The
  // sampler is diagnostic during play, but an explicitly requested run must
  // produce at least one valid sample for every bot.
  const memoryFailures: string[] = []
  const memoryResults = await Promise.allSettled(memorySamplers.map((sampler) => sampler.finish()))
  memoryResults.forEach((result, i) => {
    if (result.status === "rejected") memoryFailures.push(`player ${slots[i].n}: ${String(result.reason)}`)
  })
  save()
  // the devLog needs a live page; the video needs a CLOSED context
  await Promise.all([...recorders.values()].map(async (r) => (await r.stop(), await r.exportDevLog())))
  // exportDevLog is the final page-side ground truth. Persist it before any
  // context closes so every played persona reaches the completeness oracle.
  const recordingFinishedAt = new Date().toISOString()
  for (const documents of allPages) {
    for (const page of documents) {
      const bounds = recordingBounds.get(page)
      if (bounds && bounds.finishedAt === undefined) bounds.finishedAt = recordingFinishedAt
    }
  }
  // Persist the final page-side truth before closing contexts. Recording
  // provenance is added only after Playwright confirms that each saveAs
  // actually produced a file; failed video export must not poison the result.
  saveResults()
  await Promise.all(contexts.map((c) => c.close().catch(() => {})))
  await Promise.all(launchedAfterKill.map((b) => b.close().catch(() => {})))
  const savedRecordings: RecordingSegment[][] = slotResults.map(() => [])
  await Promise.all(
    allPages.flatMap((ps, i) =>
      ps.map(async (p, k) => {
        // a relaunched slot has several pages: the last is the full session's tail (video-<n>.webm), the earlier ones are the parts before each kill
        const file = k === ps.length - 1 ? `video-${slots[i].n}.webm` : `video-${slots[i].n}-part${k + 1}.webm`
        const path = join(OUT, file)
        const bounds = recordingBounds.get(p)
        try {
          const video = p.video()
          if (!video) throw new Error("Playwright did not create a video")
          await Promise.race([
            video.saveAs(path),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("video save did not finish within 20 s")), 20_000)),
          ])
          if (!bounds?.finishedAt) throw new Error("recording clock bounds are unavailable")
          console.log(`  video ${slots[i].n}: ${path} (${(statSync(path).size / 1024).toFixed(0)} KiB)`)
          savedRecordings[i].push({ file, pageOrdinal: k, startedAt: bounds.startedAt, finishedAt: bounds.finishedAt })
        } catch (error) {
          console.log(`  video ${slots[i].n}: ${error}`)
        }
      }),
    ),
  )
  for (const [i, result] of slotResults.entries()) result.recordings = savedRecordings[i].sort((one, two) => one.pageOrdinal - two.pageOrdinal)
  saveResults()
  rmSync(VIDEOS, { recursive: true, force: true })
  if (memoryFailures.length) throw new Error(`memory evidence failed:\n${memoryFailures.join("\n")}`)
})

/** The stale-build check: the home must show the update screen and never a Register button.
 *  The version check runs after the permission gate and backs off, so it is given a minute. */
async function staleBuildChecks(page: Page, n: number): Promise<Check[]> {
  const update = page.getByTestId("home-update").or(page.getByText("Update available"))
  const shown = await update.first().waitFor({ state: "visible", timeout: 60_000 }).then(() => true, () => false)
  const home = await readHome(page)
  const register = await page.locator("[data-testid=home-register]").or(page.getByRole("button", { name: REGISTER_LABEL, exact: true })).count()
  const read = (file: string): string | null => {
    try {
      return readFileSync(join(OUT, file), "utf8")
    } catch {
      return null
    }
  }
  // the screen counts only beside a read of THIS run's fixture; a failure quotes the refusal and the host version (stale-build-check.ts)
  return staleBuildVerdict(n, {
    shown,
    registerButtons: register,
    homeText: home.text,
    fixtureHits: BOT?.fixture ? fixtureHits(read("fixture.log"), BOT.fixture.path) : null,
    browserLog: read(`browser-${n}.log`) ?? "",
    slotLog: `${read(`slot-${n}.log`) ?? ""}\n${read("host-version.txt") ?? ""}`,
  })
}

test("(a) hosted boot: each home renders in the host with the oracle's account", async () => {
  await networkController.captureInitialQdisc()
  summary(`## Live journey (${NETWORK})\n\n### (a) hosted boot\n\n| player | paired | playing account (oracle) | lite proof | data-source | data-state | data-account vs oracle |\n|---|---|---|---|---|---|---|`)
  const checks: Check[] = []
  const homes = await Promise.all(
    slots.map(async (slot, i) => {
      const started = Date.now()
      await pages[i].goto(`http://localhost:${slot.appPort}/`, { waitUntil: "domcontentloaded", timeout: 180_000 })
      const home = await settledHome(pages[i], 180_000)
      await shot(pages[i], `a-home-${slot.n}.png`)
      // the profile took: what the page itself reports (browser-profile.ts profileChecks)
      // Delays are probed only on boot; a terminal camera failure is also
      // probed in a game because that rejection is the persona's outcome.
      const cam = shouldProbeCamera(BOT, STAGE) ? await timeGetUserMedia(pages[i]) : null
      const applied = BOT ? profileChecks(BOT, deviceOptions(), await readPageFacts(pages[i]), cam?.ms ?? null, cam?.error) : []
      const stale = BOT?.fixture ? await staleBuildChecks(pages[i], slot.n) : []
      // the devLog handle (lib/telemetry/harness.ts): present on a dev build or a served bundle with the test tag patched in
      const harness = await pages[i].evaluate(() => typeof (window as unknown as { __jollityHarness?: unknown }).__jollityHarness).catch(() => "unreadable")
      return { home, seconds: (Date.now() - started) / 1000, applied, stale, harness }
    }),
  )
  if (CLOCK_WATCH_FAULT) {
    const clockFault = await forceClockWatchFailure(pages[0], 0)
    checks.push(clockFault)
    slotResults[0].role.notes.push(`${clockFault.status}: ${clockFault.name} (${clockFault.detail})`)
  }
  if (BOT?.telemetryTorture?.id === "T2") {
    const storage = await Promise.all(pages.map(readHostStorageHangEvidence))
    const active = storage.filter((fact): fact is NonNullable<typeof fact> => fact !== null && fact.activatedAt > 0 && fact.release > fact.activatedAt)
    if (active.length !== pages.length) throw new Error(`T2 NOT PROVEN: host-storage fault armed on ${active.length}/${pages.length} document(s)`)
    telemetryFaultStarted = true
    telemetryFaultStartedAtMs = Math.min(...active.map((fact) => fact.activatedAt))
    telemetryRecoveryAtMs = Math.max(...active.map((fact) => fact.release))
    slotResults.forEach((result) => result.role.notes.push(`T2: host-storage fault armed at open until ${new Date(telemetryRecoveryAtMs!).toISOString()}`))
  }
  const currentGame = BOT?.locale && BOT.timezoneId ? readState().game : null
  homes.forEach(({ home, seconds, applied, stale, harness }, i) => {
    const slot = slots[i]
    const time = BOT && currentGame && /Game (?:starts |starting\s+)?at/i.test(home.text) ? [displayedGameTimeCheck(BOT, currentGame.gameAt, home.text)] : []
    checks.push(...applied.map((c) => ({ ...c, name: `player ${slot.n} ${c.name}` })), ...time.map((c) => ({ ...c, name: `player ${slot.n} ${c.name}` })), ...stale)
    // the update screen carries no account and no home hooks: a stale-build bot is checked by the checks above
    if (BOT?.fixture) {
      checks.push({ name: `player ${slot.n} paired as ${slot.user}`, status: slot.pairedAs === slot.user && slot.oracle.pairedAs === slot.user ? "pass" : "fail", detail: `app host ${slot.pairedAs}, oracle host ${slot.oracle.pairedAs}` })
      slotResults[i].role.notes.push(...stale.map((c) => `${c.status}: ${c.name} (${c.detail})`))
      return
    }
    if (BOT?.expectedOutcome?.kind === "camera-unavailable") {
      const outcome = home.expectedOutcome ?? cameraUnavailableOutcome(pages[i].url(), BOT.expectedOutcome, false)
      slotResults[i].expectedOutcome = outcome
      checks.push(
        { name: `player ${slot.n} paired as ${slot.user}`, status: slot.pairedAs === slot.user && slot.oracle.pairedAs === slot.user ? "pass" : "fail", detail: `app host ${slot.pairedAs}, oracle host ${slot.oracle.pairedAs}` },
        { name: `player ${slot.n} lite proof as dim2`, status: slot.oracle.liteProof === "ok" ? "pass" : "fail", detail: slot.oracle.liteProof },
        { name: `player ${slot.n} expected camera ${outcome.reason} help is shown`, status: outcome.helpShown ? "pass" : "fail", detail: outcome.helpShown ? "the exact permission row and reason-specific guidance are visible" : `help missing at ${pages[i].url()}` },
        { name: `player ${slot.n} camera-unavailable profile is not handed over`, status: !outcome.handedOver ? "pass" : "fail", detail: outcome.handedOver ? `unexpectedly reached ${pages[i].url()}` : "stayed on /permissions" },
      )
      slotResults[i].stages.a.notes.push(`expected camera ${outcome.reason}: help ${outcome.helpShown ? "shown" : "missing"}, ${outcome.handedOver ? "handed over" : "not handed over"}`)
      summary(`| ${slot.user} | ${slot.pairedAs} | ${slot.oracle.account} | ${slot.oracle.liteProof} | expected camera ${outcome.reason} | /permissions | help ${outcome.helpShown ? "shown" : "missing"}, ${outcome.handedOver ? "handed over" : "not handed over"} |`)
      return
    }
    const cmp = compareAccounts(home.account, slot.oracle.account ?? "")
    checks.push(
      { name: `player ${slot.n} paired as ${slot.user}`, status: slot.pairedAs === slot.user && slot.oracle.pairedAs === slot.user ? "pass" : "fail", detail: `app host ${slot.pairedAs}, oracle host ${slot.oracle.pairedAs}` },
      { name: `player ${slot.n} lite proof as dim2`, status: slot.oracle.liteProof === "ok" ? "pass" : "fail", detail: slot.oracle.liteProof },
      { name: `player ${slot.n} inside the host`, status: home.gate ? "fail" : "pass", detail: home.gate ? "shows the 'Open Jollity in the Polkadot app' gate" : `home settled in ${seconds.toFixed(1)} s: "${home.text.slice(0, 80)}"` },
      home.hooks
        ? { name: `player ${slot.n} data-source=host`, status: home.source === "host" ? "pass" : "fail", detail: `data-source=${home.source} data-state=${home.state}` }
        : { name: `player ${slot.n} data-source=host`, status: "unchecked", detail: "no home test hooks on this build (#202)" },
      { ...cmp, name: `player ${slot.n} ${cmp.name}` },
      // informational (an app built before the test-tag gate has none): without it the game's vote trail is not evaluated
      harness === "object"
        ? { name: `player ${slot.n} devLog harness`, status: "pass", detail: "window.__jollityHarness is installed: the vote trail can be exported" }
        : { name: `player ${slot.n} devLog harness`, status: needsDevlogHarness(BOT) ? "fail" : "unchecked", detail: `no window.__jollityHarness (${harness}): this build installs it only under next dev or with a test tag set` },
    )
    summary(`| ${slot.user} | ${slot.pairedAs} | ${slot.oracle.account} | ${slot.oracle.liteProof} | ${home.source ?? "n/a"} | ${home.state ?? "n/a"} | ${cmp.status}${home.account && cmp.status === "fail" ? ` (${home.account})` : ""} |`)
  })
  // THE HOST-CRASH CHECK on the home (a boot-only run, no game needed): the host and its page go down together, then the
  // harness reopens the app only after the replacement host listens (the phone lifecycle, see host-crash.ts).
  if (ROLE.kind === "host-crash" && STAGE === "boot") {
    for (const [i, slot] of slots.entries()) {
      const r = await crashHost(i, pages[i], "home")
      checks.push(
        ...verifyRoleActs(slot.n, ROLE, roleActs[i] ?? [], { live: false, planned: 0, fired: 0 }, 0, roleProblems),
        { name: `player ${slot.n} host crash: the reopened page uses the restarted host`, status: r.reopened && r.source === "host" ? "pass" : "fail", detail: `${r.reopened ? "page reopened after host ready" : "page did not reopen"}, data-source=${r.source ?? "n/a"}, host back after ${r.upS} s (down ${ROLE.downS} s)` },
      )
    }
  }
  // THE RELOAD, HIDDEN-STEP AND FREEZE ACTS on the home (a boot-only run, no game needed): the same act the game runs,
  // its read-backs, and the page still inside the host afterwards
  if ((ROLE.kind === "reload" || ROLE.kind === "hidden-step" || ROLE.kind === "freeze") && STAGE === "boot") {
    for (const [i, slot] of slots.entries()) {
      if (ROLE.kind === "reload") await reloadAct(i, pages[i], "home", false)
      else if (ROLE.kind === "freeze") await freezeAct(i, pages[i], "home")
      else {
        await hideAct(i, pages[i], "home")
        await pages[i].waitForTimeout(STEP_AFTER_HIDE_MS)
        await stepAct(i, pages[i], "home")
        await pages[i].waitForTimeout(STEP_AFTER_HIDE_MS)
        await showAct(i, pages[i], "home")
      }
      const after = await settledHome(pages[i], 60_000)
      checks.push(
        ...verifyRoleActs(slot.n, ROLE, roleActs[i] ?? [], { live: false, planned: 0, fired: 0 }, 0, roleProblems),
        { name: `player ${slot.n} ${ROLE.kind}: the home is still in the host afterwards`, status: !after.gate && (!after.hooks || after.source === "host") ? "pass" : "fail", detail: `data-source=${after.source ?? "n/a"}, "${after.text.slice(0, 80)}"` },
      )
      slotResults[i].role.notes.push(`host wire: ${wireSummary(wireTaps[i].evidence)}`)
    }
  }
  // THE HOST-CHAIN CUT'S MECHANISM on the open home (a boot-only run, no game needed): a short cut with every probe of the game's,
  // then the page must still be in the host. netem.sh fails NOT PROVEN when the host's cut, or the browser's own socket, cannot be shown.
  if (HOST_CHAIN_NA) checks.push({ name: "host-chain-lost applies to this run", status: "inconclusive", detail: `${HOST_CHAIN_NA}; its cuts are NOT played` })
  if (STAGE === "boot" && planHasHostChainCut(NET_PLAN)) {
    const call: NetemCall = ["host-chain-cut", String(HOST_CHAIN_SELF_TEST.windowS), String(HOST_CHAIN_SELF_TEST.holdS), outageHost("people-rpc", NETWORK)]
    if (!networkController.isActive) checks.push({ name: "host-chain cut self-test", status: "unchecked", detail: "boot.mts did not shape this runner (not a Linux CI runner, or E2E_NETEM=0)" })
    else {
      const proof = await netemStep(REPO, OUT, withHostTargets(call, OUT, slots[0].n), console.log).then(
        (text) => ({ outcome: netemOutcome(null), text }),
        (error: Error) => ({ outcome: netemOutcome(error), text: error.message }),
      )
      const verdict = proof.text.split("\n").filter((l) => /proven|NOT PROVEN|reconnect|browser/.test(l)).join(" | ").slice(0, 600)
      // netem.sh exits NETEM_INCONCLUSIVE_EXIT when the browser held no socket of its own: the app's side is then unproven
      checks.push({ name: "host-chain cut self-test: the host's chain cut, the rest of the runner up", status: netemCheckStatus(proof.outcome), detail: verdict || proof.text.slice(-300) })
      for (const [i, slot] of slots.entries()) {
        // the same bounded settle stage (a) gives a fresh home (a local page wait, no game is involved in a boot-only run)
        const after = await settledHome(pages[i], 60_000)
        checks.push({ name: `player ${slot.n} host-chain cut: the home is still in the host afterwards`, status: !after.gate && (!after.hooks || after.source === "host") ? "pass" : "fail", detail: `data-source=${after.source ?? "n/a"}, "${after.text.slice(0, 80)}"` })
        slotResults[i].role.notes.push(`host-chain self-test: ${verdict}`)
      }
    }
  }
  // the negative control, live: an account nobody holds is absent on chain
  checks.push(await checkAbsent(reader, NEVER_REGISTERED))
  record.a = { homes: homes.map(({ home, seconds }, i) => ({ n: slots[i].n, seconds, ...home })), checks }
  save()
  expectChecks(checks)
})

/** What slot 0's home showed while its sign-up ran (host-chain-cut.ts SignUpScreenWatch: only the host-chain persona's slot 0 is
 *  watched, the cut targets its host), and whether THAT slot's sign-up landed: the evidence stage (b)'s failure path turns into the
 *  named restart-card check (#507) and the devlog export. */
const signUpScreen = new SignUpScreenWatch()
let slot0SignedUp = false
/** One read of the home's screen (the card's testid and the whitespace-collapsed body text, in one round-trip), fed to the watch;
 *  never throws (a page that is gone reads as nothing). */
async function watchSignUpScreen(page: Page, cut: CutWatch): Promise<void> {
  try {
    const { card, text } = await page.evaluate((testid) => ({ card: document.querySelector(`[data-testid=${testid}]`) !== null, text: document.body.innerText.replace(/\s+/g, " ") }), RESTART_CARD_TESTID)
    signUpScreen.see(Date.now(), classifySignUpScreen(text, card), cut.inForceAtMs)
  } catch {
    /* the page is gone or mid-navigation: no reading this tick */
  }
}

const REGISTER_POLL_MS = 1000
/** How long past the journey's deadline the watched sign-up keeps polling: registration closes 5 s after it, and the page needs a
 *  moment to show what it closed on. */
const SIGN_UP_WATCH_GRACE_MS = 8000

/** The Register tap (the game is the test; the draw is reported). */
async function register(page: Page, i: number, deadlineMs: number, previewHandoverMs: number): Promise<string[]> {
  const n = slots[i].n
  const notes: string[] = []
  // only the host-chain persona's sign-up is watched for the restart card (the cut targets slot 0's host); registration closes
  // 5 s after the deadline, so the watch runs on past it (until the missed screen reads) to see what the page closed on
  const cut = cutWatches["sign-up"]
  const watched = i === 0 && cut?.armed ? cut : null
  const stopAt = deadlineMs + (watched ? SIGN_UP_WATCH_GRACE_MS : 0)
  const button = page.locator("[data-testid=home-register]").or(page.getByRole("button", { name: REGISTER_LABEL, exact: true })).first()
  while (Date.now() < stopAt && signUpScreen.missedAtMs === null) {
    if (await recoverStaleBuild(page, i, notes, previewHandoverMs)) continue
    // past the deadline the watch only reads the page: it never taps, so the grace cannot land a sign-up the journey gave up on
    const open = Date.now() < deadlineMs
    if (open && (await button.count()) && (await button.isEnabled({ timeout: 1000 }).catch(() => false))) {
      // The app swaps the button for its "you're in" state the moment the
      // sign-up lands, so it can vanish between count() and these reads: a
      // missing button is a tick to skip, never a 30 s wait that fails the
      // stage (game 185, bot 3: registered on chain, browser closed).
      const label = (await button.innerText({ timeout: 1000 }).catch(() => "")).trim()
      // the app's own label (#70 renamed it from Register): a tap only while the button offers the sign-up
      if (label === REGISTER_LABEL) {
        const tapped = await button.click({ timeout: 1000 }).then(() => true).catch(() => false)
        if (tapped) {
          notes.push(`tapped Register at ${new Date().toISOString().slice(11, 19)}`)
        }
      }
    }
    const home = await readHome(page)
    if (home.registered === "true" || /You're in/.test(home.text)) {
      if (BOT?.telemetryTorture?.id === "T2") telemetryProgressAtMs[i] ??= Date.now()
      notes.push(`UI: ${home.hooks ? `data-registered=${home.registered}` : "You're in"}`)
      // set here, not after the allSettled: a (b) timeout while another slot is stuck must still see slot 0 landed
      if (i === 0) slot0SignedUp = true
      return notes
    }
    if (BOT?.telemetryTorture?.id === "T2" && telemetryProgressAtMs[i] === null) {
      telemetryProgressAtMs[i] = await recorderFor(i).observeDevLogAt("signup", "sign-up broadcast for")
    }
    if (watched) await watchSignUpScreen(page, watched)
    await page.waitForTimeout(REGISTER_POLL_MS)
  }
  const url = page.url()
  const path = (() => { try { return new URL(url).pathname } catch { return url } })()
  const home = await readHome(page).catch(() => null)
  const registerCount = await button.count().catch(() => 0)
  const registerEnabled = registerCount > 0 && (await button.isEnabled({ timeout: 500 }).catch(() => false))
  const screen = home?.text.replace(/\s+/g, " ").trim().slice(0, 240) || "unreadable"
  const stranded = path.startsWith("/permissions") ? "STRANDED on /permissions" : `stopped at ${path}`
  throw new Error(`player ${n}: not registered in the UI before the window closed (${notes.join("; ") || "Register never enabled"}); ${stranded}; Register count=${registerCount}, enabled=${registerEnabled}; screen=${JSON.stringify(screen)}`)
}

test("(b) sign-up: Register in the UI, Game.Players at finalized", async () => {
  skipIf(EXPECTED_NO_JOIN !== null, `${EXPECTED_NO_JOIN}: stages (b)–(d) are not run`)
  skipIf(STAGE === "boot", "boot only (E2E_STAGE=boot / boot_only): stages (b)–(d) not run")
  // a CHECK role never reaches a Register tap, whatever its check in (a) said
  skipIf(CHECK, `the ${roleName(ROLE)} profile is a check, not a game: it never signs up`)
  const expected = parseProbedGame(process.env)
  let state = readState()
  if (expected) {
    const wasScheduled = expected.index === null
    const decision = await awaitProbedGame(slotResults[0]?.run?.attempt ?? 1, expected, async () => {
      state = readState()
      return {
        chainNow: state.chainNow,
        game: state.game
          ? { index: state.game.index, gameAt: state.game.gameAt, registrationEnds: state.game.registrationEnds, state: state.game.state }
          : null,
      }
    })
    if (decision.action !== "continue") {
      for (const r of slotResults) {
        if (decision.action === "skip")
          r.run = supersededRun(r.run, decision.skipped)
        r.stages.b.notes.push(decision.reason)
      }
      saveResults()
      if (decision.action === "fail") throw new Error(decision.reason)
      skipIf(true, decision.reason)
    }
    if (wasScheduled && decision.action === "continue") {
      for (const r of slotResults) r.stages.b.notes.push(`bound scheduled kickoff ${decision.game.gameAt} to concrete game ${decision.game.index}`)
    }
  } else {
    skipIf(
      !state.game || state.game.state !== "Registration",
      `no game in Registration on ${NETWORK} (${state.game ? `game ${state.game.index} is ${state.game.state}` : `Game.Game empty, ${state.schedules.length} schedule(s)`}); (b)–(d) need a game scheduled by a human`,
    )
  }
  const registrationClock = await readAppClock(pages[0])
  if (!registrationClock) throw new Error("sign-up scheduling needs the app's GameSource clock")
  const left = state.game!.registrationEnds - registrationClock.nowMs / 1000
  skipIf(left < SIGN_UP_NEEDS_S, `game ${state.game!.index}'s registration closes in ${left} s, too late to sign up ${who} (boot took too long)`)
  game = state.game!
  if (!state.chainBlockMs || state.chainBlockMs <= 0) throw new Error(`chain reader returned no positive best-block duration (${String(state.chainBlockMs)})`)
  // a role whose trigger the game's shape makes impossible fails HERE, before a sign-up that would only make a no-show
  const impossible = ROLE && !CHECK ? roleFeasibility(ROLE, game, BOT?.clockJumps?.map((j) => j.atTurn)) : null
  if (impossible) throw new Error(`role ${roleName(ROLE)} is impossible for game ${game.index}: ${impossible}`)
  const closeAt = appClockWallMsFor(registrationClock, game.registrationEnds) - 5000
  const previewHandoverMs = appClockWallMsFor(registrationClock, handoverAt(game.gameAt))
  record.game = game
  for (const r of slotResults) {
    r.game = { index: game.index, gameAt: game.gameAt, registrationEnds: game.registrationEnds, reportEnds: game.reportEnds }
    r.chainBlockMs = state.chainBlockMs
  }
  const before = await Promise.all(accounts.map((a) => reader.player(a)))
  // THE SIGN-UP CUT (atSignUp): the host loses its chain just before the Register tap, which waits until the cut is in force.
  // It fires only when the cut's window still leaves the SIGN_UP_NEEDS_S a sign-up needs before registration closes.
  const appNowAtTap = appClockSecondAt(registrationClock, Date.now())
  const signUpHoldS = networkController.pendingAt("sign-up").map((s) => cutHoldS(s.calls)).find((h) => h !== null) ?? null
  const signUpCut = (cutWatches["sign-up"] = new CutWatch(cutArmed("sign-up"), closeAt, signUpHoldS === null ? null : signUpHoldS * 1000))
  if (fireMoment("sign-up", appNowAtTap, game.registrationEnds, SIGN_UP_NEEDS_S, "registration") && signUpCut.armed) {
    while (!signUpCut.gateOpen(Date.now())) await pages[0].waitForTimeout(250)
    signUpTapAtMs = Date.now()
    // judged in (c) by signUpCutCheck, once the marker watch has had until the registration close: a slow setup is late, not missed
    const line = signUpCut.inForceAtMs !== null ? `host-chain cut in force at ${new Date(signUpCut.inForceAtMs).toISOString().slice(11, 19)}: tapping Register under it` : "host-chain cut not in force yet after the setup bound: tapping Register, the marker is still watched"
    console.log(`  ${line}`)
    slotResults.forEach((r) => r.stages.b.notes.push(line))
  }
  const settled = await Promise.allSettled(pages.map((page, i) => register(page, i, closeAt, previewHandoverMs)))
  // allSettled, not all: every slot finishes first, so slot 0's screen evidence is complete before afterEach reads it
  const failed = settled.find((r) => r.status === "rejected")
  if (failed) throw failed.reason
  const notes = settled.map((r) => (r.status === "fulfilled" ? r.value : []))
  if (clockHeldDue(BOT).length) await Promise.all(pages.map((p, i) => clockHeld(i, p, "at the sign-up")))
  await Promise.all(pages.map((p, i) => shot(p, `b-registered-${slots[i].n}.png`)))
  // finalized lags best by a few blocks: poll until every slot is in, bounded
  let checks: Check[] = []
  let pollAttempt = 0
  const pollStartedAt = Date.now()
  const until = Date.now() + 120_000
  do {
    pollAttempt++
    checks = await Promise.all(accounts.map((a) => checkSignedUp(reader, a)))
    console.log(formatSignUpPoll(pollAttempt, Date.now() - pollStartedAt, checks))
    if (checks.every((c) => c.status === "pass")) break
    await new Promise((r) => setTimeout(r, 6000))
  } while (Date.now() < until)
  // a sign-up cut still not in force once the sign-up is settled is written down HERE too, so it survives a (c) that never runs
  const suWatch = cutWatches["sign-up"]
  if (suWatch?.armed && suWatch.firedAtMs !== null && suWatch.inForceAtMs === null) {
    const line = `the sign-up host-chain cut fired at ${new Date(suWatch.firedAtMs).toISOString().slice(11, 19)} UTC and was still not in force when the sign-up settled`
    console.log(`  ${line}`)
    slotResults.forEach((r) => r.stages.b.notes.push(line))
  }
  record.b = { before, notes, checks }
  save()
  summary(`\n### (b) sign-up, game ${game.index}\n\n${notes.map((n, i) => `- ${slots[i].user}: ${n.join("; ")}`).join("\n")}\n${checks.map((c) => `- ${c.status}: ${c.name} (${c.detail})`).join("\n")}\n${sentrySummaryLine(process.env, game.index)}`)
  slotResults.forEach((r, i) => {
    r.signedUp = checks[i]?.status === "pass"
    r.stages.b.notes.push(...(notes[i] ?? []))
  })
  saveResults()
  expectChecks(checks)
  signedUp = true
  if (ROLE.kind === "late-join" || ROLE.kind === "video-return") {
    await Promise.all(pages.map(async (page, i) => (appClockSeeds[i] = await readAppClock(page))))
    if (appClockSeeds.some((clock) => clock === null)) throw new Error("late-join scheduling needs the app's game clock before leaving the page")
    // MISS the waiting room: be gone before the handover (T-64), come back in (c)
    await Promise.all(pages.map((p) => p.goto("about:blank")))
    slots.forEach((_, i) => roleAct(i, "left-app", "skipped the waiting room: left after sign-up, before the handover"))
    slotResults.forEach((r) => r.role.notes.push(`left the app after sign-up at ${new Date().toISOString().slice(11, 19)}, before the handover`))
    saveResults()
  }
})

/** The least registration time a sign-up needs once the bot taps (stage (b) skips below it). The sign-up cut fires only when
 *  its window still leaves this much. */
const SIGN_UP_NEEDS_S = 45

/** One player through the game: follow the app to /game, APPROVE every
 *  votable tile each turn, press Confirm, land on /prize-draw.
 *
 *  A VOTABLE tile (a peer, in the live phase) carries stable
 *  `data-tile-votable`; `data-tile-tap-ready` / `.cursor-pointer` say its
 *  gesture is open now. The controlled verdict is explicit because signed
 *  rotateY returns to 0 after reject -> approve. A tap is successful only
 *  when that verdict reads approved in the same turn. A reset-swallowed tap
 *  retries on the next ready pass; other unsettled attempts keep the 1.5 s
 *  spacing, until the tile reads approved or the turn moves on.
 *
 *  A tap goes only to a tile `tapBlocker` clears: play stage, pill up, the
 *  whole box on screen, its centre hitting the tile, standing still since the
 *  last read. It is a mouse click at that checked centre (no locator
 *  scroll-into-view, which is what threw "Element is outside of the viewport"
 *  on tiles flying in at turn start). A click that throws anyway is recorded,
 *  never swallowed: in the timeline, taps-N.log and the result.
 *
 *  `stopAtConfirm` ends at an enabled Confirm instead (the demo game cannot
 *  go further on main). */
/** What the role asks of the play loop (roles.ts), besides the plain approve-every-tile. */
interface PlayOpts {
  stopAtConfirm?: boolean
  rec?: BotRecorder
  /** canonical position from the page's own GameSource clock */
  game?: NonNullable<ChainState["game"]>
  onGameMoment?: (moment: AppGameMoment, slotIndex: number) => void
  /** Synthetic demo only: it has no scheduled game or app-chain clock. */
  onDemoTurn?: (gameTurn: number) => void
  /** baseline + changeVerdictThenConfirm: flip one confirm-stage verdict and back, then tap the CTA during its countdown */
  changeVerdictThenConfirm?: boolean
  /** the hide window and the kill (kill-relaunch / background roles) */
  driver?: RoleDriver
  /** record a thing the role did (role-proof.ts) */
  act?: (id: ActId, detail: string) => void
  /** host-chain-lost: hold the Confirm tap until the confirm cut is in force (CutWatch.gateOpen); the app's own auto-confirm is
   *  not the harness's to hold, so the report-after-cut check says afterwards whether the report really met the cut */
  confirmGate?: () => boolean
  /** tap-storm: pairs of rapid flip-flop taps before each approving tap */
  stormFlips?: number
  /** the demo's proof of the kill: return right after the relaunch (the demo game does not survive a reload) */
  stopAfterKill?: boolean
  /** the demo's proof of the role: return right after the CTA tap */
  stopAfterConfirmTap?: boolean
  /** the demo's proof of a mid-game act (reload, hidden-step, freeze): return once it says the act is over */
  stopAfterAct?: () => boolean
  /** T6 freezes and kills on the first observed report landing. */
  onReportLanded?: () => Promise<void>
  /** T9's declared 120 s whole-link blackout exceeds the app's isolation
   * grace, so /connection-help is the intended terminal UI for this persona. */
  expectIsolation?: boolean
  /** PR previews have no in-app version gate; stop proactive name checks well before this handover. */
  previewHandoverMs?: number
  /** PreviewNet crew: replace the labelled idle card only while this account
   * owns the host tile. The controller is document-local and never negotiates. */
  setHostGesture?: (page: Page, active: boolean) => Promise<unknown>
}
/** The loop's view of a role that moves the page about. */
interface RoleDriver {
  hidden(): boolean
  /** every loop turn: hide or show the page (roles.ts backgroundStep: off the page's confirm stage, not a clock) */
  clockTick(page: Page): Promise<void>
  /** the page shows the confirm stage (its first sighting starts the background act) */
  sawConfirm(): void
  /** the background act is under way: no Confirm tap, no exit on /prize-draw */
  pending(): boolean
  /** mid-game, at every read of the page (hidden too): the role's act keyed on the turn the page shows. Any act that
   *  replaces the page returns the new one; every other act returns null. */
  midGame(at: { turn: number | null; turnsInGame: number | null; stage: string; clock?: AppClockReading }): Promise<Page | null>
  /** the last midGame call acted on the page (a reload, a freeze, a hide): what was read before it is stale */
  held(): boolean
}
async function play(
  startPage: Page,
  n: number,
  deadlineMs: number,
  o: PlayOpts = {},
): Promise<{ taps: number; clickErrors: TapRecord[]; approvedTurns: number; confirmed: boolean; url: string; roleNotes: string[]; overridesMade: number; isolationAtMs: number | null }> {
  const { stopAtConfirm = false, rec, onGameMoment, driver } = o
  const slotIndex = slots.findIndex((slot) => slot.n === n)
  if (slotIndex < 0) throw new Error(`player ${n}: no slot for the play loop`)
  let page = startPage
  const roleNotes: string[] = []
  let verdictChanged = false
  let overridesMade = 0
  let stormTaps = 0
  const stormedTurns = new Set<number>()
  let confirmSeenMs: number | null = null
  let recapCaptured = false
  const vp = page.viewportSize() ?? { width: 390, height: 844 }
  const logFile = join(OUT, `taps-${n}.log`)
  let taps = 0
  let confirmed = false
  let isolationAtMs: number | null = null
  const clickErrors: TapRecord[] = []
  const tappedAt = new Map<string, number>()
  const lastBox = new Map<string, Box | null>()
  const approved = new Set<string>()
  let hostGestureActive = false
  let hostGestureTurn: number | null = null
  let hostGestureDocument: string | null = null
  const hostGestureWarnings = new Set<string>()
  const missedHostGestureTurns = new Set<number>()
  const syncHostGesture = async (snapshot: Awaited<ReturnType<typeof readPage>>): Promise<void> => {
    if (!o.setHostGesture) return
    const { stage, turn } = readStage(snapshot)
    hostGestureTurn = nextHostGestureTurn(hostGestureTurn, { hostIntroHeadline: snapshot.hostIntroHeadline, turn, stage, sessionStage: snapshot.sessionStage })
    const account = accounts[slotIndex]
    const gridSaysSelfIsHost = !!account
      && snapshot.tiles.some((tile) => tile.id === account && tile.role === "you")
      && !snapshot.tiles.some((tile) => tile.role === "host")
    if (gridSaysSelfIsHost && stage === "play" && turn !== null && hostGestureTurn === null && !missedHostGestureTurns.has(turn)) {
      missedHostGestureTurns.add(turn)
      roleNotes.push(`host gesture warning: missed the host intro latch for turn ${turn}`)
    }
    const next = hostGestureTurn !== null && turn === hostGestureTurn
    const documentChanged = snapshot.documentIdentity !== hostGestureDocument
    if (next === hostGestureActive && !documentChanged) return
    try {
      await o.setHostGesture(page, next)
      hostGestureActive = next
      hostGestureDocument = snapshot.documentIdentity
    } catch (error) {
      const key = `${snapshot.documentIdentity}|${next}|${error instanceof Error ? error.message : String(error)}`
      if (!hostGestureWarnings.has(key)) {
        hostGestureWarnings.add(key)
        roleNotes.push(`host gesture ${next ? "enable" : "disable"} warning: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  let postPassRescan: PostPassRescan | null = null
  const postPassRescanTurns = new Set<number>()
  // `at` the page's stamp (stampOf) when the click was decided: the oracle (down-turns.ts) counts a tap only if the page
  // said a votable stage (VOTABLE_STAGES: introduction or gameplay) of that turn. A skipped click is no error: it is the guard doing its work
  const note = (turn: number | null, id: string, result: string, stage?: string) => {
    const entry: TapRecord = { at: new Date().toISOString(), turn, id, result, ...(stage !== undefined && { stage }) }
    appendFileSync(logFile, JSON.stringify(entry) + "\n")
    if (result !== "ok" && !result.startsWith("skipped") && !result.startsWith("late")) {
      clickErrors.push(entry)
      console.log(`  player ${n}: click on ${id.slice(0, 8)} (turn ${turn}) failed: ${result}`)
    }
    if (!result.startsWith("skipped")) rec?.tapped(id, result)
  }
  const done = (url: string) => ({ taps, clickErrors, approvedTurns: approved.size, confirmed, url, roleNotes: stormTaps ? [...roleNotes, `${stormTaps} flip-flop taps before the real ones`] : roleNotes, overridesMade, isolationAtMs })
  let sawGame = false
  while (Date.now() < deadlineMs) {
    await driver?.clockTick(page)
    if (o.stopAfterAct?.()) return done(page.url())
    const appMoment = o.game ? await readAppMoment(page, o.game) : null
    if (appMoment) {
      onGameMoment?.(appMoment, slotIndex)
      if (appMoment.stage === "confirm") driver?.sawConfirm()
    }
    // a hidden page is not tapped: a backgrounded phone has no screen to touch. It is still READ, so an act keyed on
    // the turn the page shows (the hidden-step role's show) can fire while it is hidden
    if (driver?.hidden()) {
      const p = await readPage(page).catch(() => null)
      if (p) await syncHostGesture(p)
      if (appMoment) await driver.midGame({ turn: appMoment.turn, turnsInGame: appMoment.turnsInGame, stage: appMoment.stage })
      await page.waitForTimeout(250)
      continue
    }
    const url = page.url()
    // homeGate can appear both before sign-up and in the signed-up waiting
    // room. Keep checking until /game takes over at handover.
    if (!url.includes("/game") && (await recoverStaleBuild(page, slotIndex, roleNotes, o.previewHandoverMs))) continue
    // the background act's "visible" is still due: stay in the loop until the page is shown again
    // a game with no draw ends on its own collectables page (end-of-play.ts), only once /game was seen
    const atEnd = url.includes("/prize-draw") || (sawGame && isNoDrawCollectables(url, (o.game ?? game)?.index))
    if (atEnd && driver?.pending()) {
      await page.waitForTimeout(250)
      continue
    }
    if (atEnd) {
      await o.onReportLanded?.()
      return done(url)
    }
    if (sawGame && o.expectIsolation && url.includes("/connection-help")) {
      isolationAtMs = Date.now()
      return done(url)
    }
    // THE CHEST AFTER /game is the app's own handover with no report counted (#303 missed, #601 gone): nothing more
    // happens on this page, so the loop ends here and (d) judges it against the chain (game 327, bot 13 sat on
    // /chest for nine minutes until the play deadline)
    if (sawGame && url.includes("/chest")) return done(url)
    if (url.includes("/game")) {
      sawGame = true
      const confirm = page.getByRole("button", { name: /Confirm votes|Confirming|tap to retry/ })
      if (await confirm.count()) {
        const enabled = await confirm.first().isEnabled().catch(() => false)
        if (stopAtConfirm && enabled) return done(url)
        // THE BACKGROUND ACT starts here: the app must file the report on its own across the hide, so the bot does not tap
        if (driver?.pending()) {
          await page.waitForTimeout(250)
          continue
        }
        if (!recapCaptured && rec) {
          await rec.captureRecap()
          recapCaptured = true
        }
        const label = await confirm.first().innerText().catch(() => "")
        confirmSeenMs ??= Date.now()
        // THE CHANGED-VERDICT ROLE: flip one verdict and flip it back (the filed
        // report stays all-Person, so no co-player is charged), then tap the CTA
        // inside its countdown so the report is filed by a tap
        // flipping a verdict is OPT-IN (E2E_FLIP_VERDICT=1): on the demo the restore tap
        // was seen to miss, and a flip left in place would charge a real co-player a NotPerson.
        // Without it the role still taps the CTA inside its countdown (the #285 proof)
        if (o.changeVerdictThenConfirm && !verdictChanged && process.env.E2E_FLIP_VERDICT !== "1") verdictChanged = true
        if (o.changeVerdictThenConfirm && !verdictChanged && enabled && /Confirming in|Confirm votes/.test(label)) {
          verdictChanged = true
          const made = await changeThenRestoreVerdict(page)
          overridesMade = made.overrides
          roleNotes.push(made.note)
          note(null, "verdict-change", made.overrides >= 2 ? "ok" : `error: ${made.note}`)
          continue
        }
        // the countdown role taps on the label the PAGE shows ("Confirming in N"); the bare CTA is left alone until the grace has passed
        const tapNow = (!o.changeVerdictThenConfirm || verdictChanged) && confirmTapStep(!!o.changeVerdictThenConfirm, label, confirmSeenMs, Date.now()) === "tap" && (o.confirmGate?.() ?? true)
        if (enabled && tapNow) {
          try {
            await confirm.first().click({ timeout: 1000 })
            confirmed = true
            if (/Confirming in/.test(label)) {
              roleNotes.push(`tapped the CTA at "${label.trim()}"`)
              o.act?.("confirm-tap", `tapped Confirm during the countdown at "${label.trim()}"`)
            } else if (o.changeVerdictThenConfirm && /Confirm votes/.test(label)) {
              roleNotes.push(`the countdown never showed: tapped the bare CTA "${label.trim()}" ${Math.round((Date.now() - confirmSeenMs) / 1000)} s after the confirm stage opened`)
            }
            // every bare tap is an act of its own, with the label the bot saw: the bot always confirms when the page asks
            if (/Confirm votes/.test(label)) o.act?.("confirm-tap-bare", `label "${label.trim()}", ${Math.round((Date.now() - confirmSeenMs) / 1000)} s after the confirm stage opened`)
            note(null, "confirm", "ok")
            if (o.stopAfterConfirmTap) return done(page.url())
          } catch (e) {
            note(null, "confirm", `error: ${String((e as Error).message).split("\n")[0].slice(0, 160)}`)
          }
        }
      } else {
        // a navigation mid-read is not a tap failure: read again next tick
        const p = await readPage(page).catch(() => null)
        if (p) {
          await syncHostGesture(p)
          const { stage, turn, turnsPerRound } = readStage(p)
          if (!o.game && turn !== null) o.onDemoTurn?.(turn)
          if (postPassRescan && (postPassRescan.turn !== turn || stage !== "play")) postPassRescan = null
          const rescanDueBeforeDriver = postPassRescan?.turn === turn && postPassRescan.remaining > 0
          // A verified pass buys one finite priority window in this turn. It
          // never rearms on a moving tile or a click whose landed read stayed
          // pending, so mandatory disable/reload/freeze work resumes when the
          // five browser snapshots are spent.
          const runDriver = !rescanDueBeforeDriver
          const driverMoment = appMoment ?? (!o.game ? { turn, turnsInGame: turnsPerRound, stage } : null)
          const relaunched = runDriver && driverMoment ? await driver?.midGame(driverMoment) : null
          // an act that held the loop (a reload, a freeze) or hid the page: read the page afresh before any tap
          if (runDriver && !relaunched && driver?.held()) continue
          if (relaunched) {
            page = relaunched
            hostGestureActive = false
            hostGestureDocument = null
            rec?.rebind(relaunched)
            roleNotes.push(`killed and relaunched at turn ${turn} of ${turnsPerRound}`)
            if (o.stopAfterKill) return done(relaunched.url())
            continue
          }
          // the tiles this pass may tap, then the storm's tile (one a turn) goes LAST
          const todo: typeof p.tiles = []
          const tapPriorities = new Map<string, 0 | 1>()
          for (const t of p.tiles) {
            const tile = { ...t, rotateY: parseRotateY(t.transform), rotY: parseRotY(t.transform) }
            const prev = lastBox.get(t.id) ?? null
            lastBox.set(t.id, t.box)
            if (tile.role === "unseen" || tile.role === "host" || tile.role === "you" || tile.role === "empty") continue
            if (!tileVotable(tile)) continue
            if (isApproved(tile)) {
              approved.add(`${turn}:${t.id}`)
              continue
            }
            const priority = tapPassPriority(tapBlocker(tile, { stage, ducked: p.ducked }, vp, prev))
            if (priority === null) continue
            if (Date.now() - (tappedAt.get(t.id) ?? 0) < 1500) continue
            tapPriorities.set(t.id, priority)
            todo.push(t)
          }
          const stormId = stormTarget(todo.map((t) => t.id), turn, o.stormFlips ?? 0, stormedTurns)
          todo.sort(
            (x, y) =>
              Number(x.id === stormId) - Number(y.id === stormId) ||
              (tapPriorities.get(x.id) ?? 0) - (tapPriorities.get(y.id) ?? 0),
          )
          let verifiedThisPass = 0
          for (const pass of todo) {
            // THE GUARD, per click: the pass was decided from one read, and a click can stall (a cold page, a long task)
            // until the turn is over. Read again, and click only a tile that is still votable in a votable stage (intro or gameplay) of
            // the same turn, at its place NOW. The stamp goes in the log with the click (#399)
            const fresh = await readPage(page).catch(() => null)
            if (!fresh) continue
            const stamp = stampOf(fresh)
            const seen = readStage(fresh)
            const stamped = stamp.stage !== "unknown"
            const inPlay = stamped ? VOTABLE_STAGES.has(stamp.stage) : seen.stage === "play" || seen.stage === "intro"
            if (!inPlay || stamp.turn !== turn) {
              note(turn, pass.id, `skipped: page showed ${stamped ? stamp.stage : seen.stage}, turn ${stamp.turn}`, stamp.stage)
              break
            }
            const cur = fresh.tiles.find((x) => x.id === pass.id)
            if (!cur) continue
            const live = { ...cur, rotateY: parseRotateY(cur.transform), rotY: parseRotY(cur.transform) }
            // A just-transitioned Host-to-Co-player tile may have moved since
            // the previous outer read and was retained as a deferred
            // candidate. It is clickable only after this fresh read proves it
            // settled at the candidate's checked box; all other guards are
            // re-evaluated here too.
            if (tapBlocker(live, { stage: seen.stage, ducked: fresh.ducked }, vp, pass.box) !== null) continue
            const t = cur
            // after the click returns: a click can stall until the turn is over (1.6 s in game 57) and land in the ending
            // flip, which the log would call "ok gameplay". Read the page again; if it moved on, the tap is LATE and the
            // oracle takes no side on that co-player (down-turns.ts)
            const landed = async () => {
              const after = await readPage(page).catch(() => null)
              const afterTile = after?.tiles.find((x) => x.id === pass.id)
              return tapResult(
                stamp,
                after ? stampOf(after) : null,
                afterTile
                  ? { verdict: afterTile.verdict, rotateY: parseRotateY(afterTile.transform), rotY: parseRotY(afterTile.transform) }
                  : null,
              )
            }
            tappedAt.set(t.id, Date.now())
            const cx = t.box.x + t.box.w / 2
            const cy = t.box.y + t.box.h / 2
            try {
              if (t.id === stormId) {
                // the tap-storm role: rapid flip-flops. A tile ignores the finger while it turns, so some of these are
                // swallowed and the parity is unknown: the tile is then SETTLED to approved by reading it (below)
                for (let k = 0; k < (o.stormFlips ?? 0) * 2; k++) {
                  await page.mouse.click(cx, cy)
                  await page.waitForTimeout(stormGapMs(cy, vp.height))
                  stormTaps++
                  if (stormTaps === 1) o.act?.("storm-taps", `first flip-flop tap before the real one (${o.stormFlips} pair(s) on one tile a turn)`)
                }
                // SETTLE THE WHOLE PASS, not just the storm tile (game 194: the storm held the loop for 8 s while the
                // pass's other tiles, whose first taps the turn change had swallowed, waited for a re-tap that came 2 s
                // before the seal). Read, and re-tap every tile of this pass that is at rest and still undecided, until
                // each is approved or the turn moves on
                for (let k = 0; k < 4; k++) {
                  await page.waitForTimeout(800)
                  const now = await readPage(page).catch(() => null)
                  if (!now || (turn !== null && readStage(now).turn !== turn)) break
                  let pending = 0
                  for (const w of todo) {
                    const cur = now.tiles.find((x) => x.id === w.id)
                    if (!cur || !tileTapReady(cur)) continue
                    const live = { verdict: cur.verdict, rotateY: parseRotateY(cur.transform), rotY: parseRotY(cur.transform) }
                    if (isApproved(live)) continue
                    pending++
                    if (!settleRetappable(live)) continue
                    const settlementBlocker = tapPassSettlementBlocker(tapPriorities.get(w.id) ?? 0, { ...cur, ...live }, { stage: readStage(now).stage, ducked: now.ducked }, vp, w.box)
                    if (settlementBlocker !== null) continue
                    await page.mouse.click(cur.box.x + cur.box.w / 2, cur.box.y + cur.box.h / 2)
                    await page.waitForTimeout(stormGapMs(cur.box.y + cur.box.h / 2, vp.height))
                  }
                  if (pending === 0) break
                }
                taps++
              } else {
                await page.mouse.click(cx, cy)
                taps++
              }
              const result = tapLogResult(await landed())
              if (result.logged === "ok") verifiedThisPass++
              if (result.retry) tappedAt.delete(t.id)
              note(turn, t.id, result.logged, stamp.stage)
              // the real tap counts toward the debug gesture too: keep the next tile's first tap out of its window
              if (t.id !== stormId && (o.stormFlips ?? 0) > 0) {
                await page.waitForTimeout(stormGapMs(cy, vp.height))
              }
            } catch (e) {
              note(turn, t.id, `error: ${String((e as Error).message).split("\n")[0].slice(0, 160)}`, stamp.stage)
            }
          }
          const alreadyArmed = turn !== null && postPassRescanTurns.has(turn)
          postPassRescan = nextPostPassRescan(postPassRescan, turn, stage, verifiedThisPass, alreadyArmed)
          if (turn !== null && verifiedThisPass > 0 && !alreadyArmed && postPassRescan) postPassRescanTurns.add(turn)
          if (postPassRescan && postPassRescan.remaining > 0) {
            await page.waitForTimeout(POST_PASS_RESCAN_MS)
            continue
          }
          postPassRescan = null
        }
      }
    }
    await page.waitForTimeout(250)
  }
  throw new Error(`player ${n}: never reached ${stopAtConfirm ? "an enabled Confirm" : "/prize-draw (or this game's /collectables when it has no draw)"} (at ${page.url()}, ${taps} taps, ${clickErrors.length} click errors, confirmed=${confirmed})`)
}

/** Confirm stage: flip one approved verdict and flip it back, reading the tile after each tap.
 *  Casts no net verdict (the filed report stays all-Person), and leaves two "override" lines in
 *  the app's own log, which is what proves a change inside the countdown is tolerated. */
async function changeThenRestoreVerdict(page: Page): Promise<{ overrides: number; note: string }> {
  const tiles = async () => (await readPage(page)).tiles.map((t) => ({ ...t, rotateY: parseRotateY(t.transform), rotY: parseRotY(t.transform) }))
  const first = (await tiles()).find((t) => tileTapReady(t) && t.visible && isApproved(t))
  if (!first) return { overrides: 0, note: "no approved, votable tile in the confirm stage: nothing to change" }
  const tap = (t: Pick<Box, "x" | "y" | "w" | "h">) => page.mouse.click(t.x + t.w / 2, t.y + t.h / 2)
  const settle = async (want: boolean) => {
    for (let k = 0; k < 10; k++) {
      await page.waitForTimeout(250)
      const t = (await tiles()).find((x) => x.id === first.id)
      if (t && isApproved(t) === want) return true
    }
    return false
  }
  let overrides = 0
  await tap(first.box)
  overrides++
  const flipped = await settle(false)
  // the restore tap has been seen to miss on the demo (the tile stayed flipped): retry, and say so if it never lands
  let restored = false
  for (let k = 0; k < 4 && !restored; k++) {
    const back = (await tiles()).find((x) => x.id === first.id)
    if (back) await tap(back.box)
    overrides++
    restored = await settle(true)
  }
  return { overrides, note: `flipped ${first.id.slice(0, 8)} (${flipped ? "read as changed" : "NOT read as changed"}) and back (${restored ? "read as approved again" : "NOT read as approved again"})` }
}

/** The bot's own tap log (taps-N.log), once: a torn line drops only itself, a missing file is no taps. */
const readTaps = (n: number): TapRecord[] => {
  try {
    return parseTaps(readFileSync(join(OUT, `taps-${n}.log`), "utf8"))
  } catch {
    return []
  }
}

/** The bot's turns as its timeline shows them (tiles-N.jsonl): turn →
 *  co-player → approved / missed / not-votable, at each turn's end frame. */
const uiRows = (n: number) => {
  let rows: ReturnType<typeof parseRows> = []
  try {
    rows = parseRows(readFileSync(join(OUT, `tiles-${n}.jsonl`), "utf8"))
  } catch {
    /* no timeline */
  }
  return rows
}
const uiVerdicts = (n: number, self: string | null) => {
  const rows = uiRows(n)
  const me = self ?? inferSelf(rows) ?? ""
  // a tap the bot made after its turn's last frame cannot be judged by that frame (recorder.ts: the tick stretches to 2-3 s)
  const taps = readTaps(n)
  return verdictTable(rows, me, lateTaps(rows, taps), taps)
}

/** The turns this slot's role was down for (kill-relaunch, host-crash): read off the role's own acts against its timeline. */
const downBySlot: (DownInfo | undefined)[] = []
const videoRoleTables: ReturnType<typeof verdictTable>[] = []
function downFor(i: number, g: { rounds: number; maxGroupSize: number }): DownInfo | undefined {
  const windows = downWindows(roleActs[i] ?? [])
  if (windows.length === 0) return undefined
  let rows: ReturnType<typeof parseRows> = []
  try {
    rows = parseRows(readFileSync(join(OUT, `tiles-${slots[i].n}.jsonl`), "utf8"))
  } catch {
    /* no timeline */
  }
  const at = (iso: string | null) => (iso ? iso.slice(11, 19) : "never")
  return {
    missed: missedTurns(rows, windows, g.rounds * g.maxGroupSize),
    downTurns: downTurns(rows, windows, g.rounds * g.maxGroupSize),
    taps: readTaps(slots[i].n),
    maxGroupSize: g.maxGroupSize,
    windows: windows.map((w) => `${w.what.split(", ")[0]} ${at(w.from)} UTC, ${w.what.split(", ")[1]} ${at(w.to)} UTC`).join("; "),
  }
}

/** Opt-in (E2E_DEMO_PLAY=1): the tap loop above on the demo game, which
 *  needs no chain, so (c)'s selectors can be proven with no game scheduled. */
test("(c0) the tap loop on the demo game (/game?preview=play)", async () => {
  skipIf(process.env.E2E_DEMO_PLAY !== "1", "(c0) demo play is opt-in: E2E_DEMO_PLAY=1")
  skipIf(signedUp, "(c0) demo play: a real game is on, player 1's page is needed for it")
  test.setTimeout(6 * 60_000)
  const page = pages[0]
  await page.goto(`http://localhost:${slots[0].appPort}/game?preview=play`, { waitUntil: "domcontentloaded" })
  const rec = recorderFor(0)
  rec.start()
  const demoGame = { index: 0, state: "demo", registrationEnds: 0, gameAt: 0, reportEnds: 0, rounds: 2, maxGroupSize: 6 }
  // The demo uses the same close-with-host/reopen-after-listen driver as a live game. It stops at the relaunch because a
  // fresh page cannot resume the synthetic preview game the way an on-chain session resumes.
  const hostCrashDriver = ROLE.kind === "host-crash" ? makeDriver(0, demoGame) : undefined
  // E2E_DEMO_ROLE=1: run the changed-verdict role on the demo's confirm stage (no chain, no report)
  const demoRole = process.env.E2E_DEMO_ROLE === "1"
  // E2E_DEMO_KILL=1: crash the demo page at turn 3 and relaunch it (the same relaunch() a live kill-relaunch role runs)
  let demoKilled = false
  const killDriver: RoleDriver | undefined =
    process.env.E2E_DEMO_KILL === "1"
      ? {
          hidden: () => false,
          clockTick: async () => {},
          sawConfirm: () => {},
          pending: () => false,
          held: () => false,
          midGame: async (at) => {
            if (demoKilled || (at.turn ?? 0) < 3) return null
            demoKilled = true
            roleAct(0, "killed", `demo page at turn ${at.turn}`)
            const fresh = await relaunch(0)
            roleAct(0, "relaunched", "new browser context opened, app reopened on the same host slot, home settled")
            return fresh
          },
        }
      : undefined
  // the reload, hidden-step and freeze roles on the demo: the same driver a live game gets, on the demo's shape (two
  // rounds of six seats), and the demo ends once the act is over (a reloaded demo starts again from turn 1)
  const actRole = ROLE.kind === "reload" || ROLE.kind === "hidden-step" || ROLE.kind === "freeze"
  const actDriver = actRole ? makeDriver(0, demoGame) : undefined
  // only the acts the DEMO makes: a boot-stage act on the home (stage (a)) is already in the list
  const actsBefore = (roleActs[0] ?? []).length
  const problemsBefore = roleProblems.length
  const actOver = () => {
    const ids = (roleActs[0] ?? []).slice(actsBefore).map((a) => a.id)
    return ids.includes(ROLE.kind === "reload" ? "reloaded" : ROLE.kind === "freeze" ? "thawed" : "visible") || roleProblems.length > problemsBefore
  }
  const r = await play(page, slots[0].n, Date.now() + 5 * 60_000, {
    onDemoTurn: (turn) => networkController.onTurn({ turn, sinceStartS: null }),
    stopAtConfirm: !demoRole && !killDriver,
    stormFlips: ROLE.kind === "tap-storm" ? ROLE.flips : 0,
    rec,
    changeVerdictThenConfirm: demoRole,
    stopAfterConfirmTap: demoRole,
    driver: killDriver ?? hostCrashDriver ?? actDriver,
    stopAfterKill: !!killDriver || !!hostCrashDriver,
    ...(actRole && { stopAfterAct: actOver }),
    act: (id, d) => roleAct(0, id, d),
  })
  if (actRole) {
    await rec.stop()
    const demoActs = (roleActs[0] ?? []).slice(actsBefore)
    const checks = verifyRoleActs(slots[0].n, ROLE, demoActs, { live: false, planned: 0, fired: 0 }, 0, roleProblems.slice(problemsBefore))
    console.log(`  demo ${ROLE.kind}: ${demoActs.map((a) => `${a.id} (${a.detail})`).join("; ")}`)
    summary(`\n### (c0) demo ${ROLE.kind}\n\n${checks.map((c) => `- ${c.status}: ${c.name} (${c.detail})`).join("\n")}`)
    expectChecks(checks)
    return
  }
  if (demoRole) {
    console.log(`  demo role: ${r.overridesMade} overrides, confirmed=${r.confirmed}; ${r.roleNotes.join("; ")}`)
    if (process.env.E2E_FLIP_VERDICT === "1") expect(r.overridesMade, "the verdict was flipped and flipped back").toBeGreaterThanOrEqual(2)
    expect(r.confirmed, "the CTA was tapped during its countdown").toBe(true)
    expect(r.roleNotes.join(";")).toMatch(/tapped the CTA at "Confirming in/)
  }
  if (ROLE.kind === "host-crash") {
    expect(verifyRoleActs(slots[0].n, ROLE, roleActs[0] ?? [], { live: false, planned: 0, fired: 0 }).map((c) => c.status), "host-killed and host-restarted were recorded").toEqual(["pass", "pass"])
    expect(roleProblems, "the host crash left problems").toEqual([])
    await rec.stop()
    return
  }
  await rec.stop()
  if (killDriver) {
    // the kill demo ends at the relaunch: the new browser/context opened, the app reopened and the home settled
    const ids = slotResults[0].role.actions.map((a) => a.id)
    console.log(`  demo kill: ${ids.join(", ")}; ${slotResults[0].role.notes.slice(-1)[0]}`)
    expect(ids, "the kill and the relaunch were both recorded").toEqual(["killed", "relaunched"])
    return
  }
  await rec.exportDevLog()
  await shot(page, "c0-demo-confirm.png")
  const table = uiVerdicts(slots[0].n, null)
  const missed = misses(table)
  console.log(`  demo game: ${r.taps} taps, ${r.clickErrors.length} click errors, ${r.approvedTurns} approvals seen, ${missed.length} missed, ended at an enabled Confirm`)
  summary(
    `\n### (c0) demo tap loop\n\n- ${r.taps} taps, ${r.clickErrors.length} click errors, ${r.approvedTurns} tile-turn approvals, ${missed.length} missed, reached an enabled Confirm\n\n${verdictMarkdown(table)}`,
  )
  record.c0 = { ...r, table, missed }
  // the demo seats you with four votable peers over twelve turns
  expect(r.approvedTurns).toBeGreaterThanOrEqual(12)
  expect(r.clickErrors, "click errors on tiles the gate said were tappable").toEqual([])
  expect(missed, "turns that ended with a votable co-player not approved").toEqual([])
})

/** the guard texts a slot's earlier pages (before a kill) showed */
const preSeen: string[][] = []
/** Visible intervals from those retired documents. Timed fault-window
 * exemptions fail closed when this evidence is absent. */
const preAppearances: NonNullable<PageEvidence["appearances"]>[] = []
/** Immediate samples after a persona's real network switch; unlike finalText, these cannot be
 *  accidentally satisfied by the page navigating away later in the run. */
const afterNetworkText: Array<string | undefined> = []
/** localStorage survives an iOS web-content-process death; a fresh Playwright
 *  BrowserContext does not, so preserve that exact browser boundary. */
const relaunchStorage: Array<RelaunchStorageState | undefined> = []
const relaunchStorageKillAt: Array<number | undefined> = []
const pendingReopenRecovery = new Map<number, Promise<string>[]>()

function queueReopenedTelemetryRecovery(i: number, label: string): void {
  const recorder = recorders.get(i)
  if (!recorder) return
  const queued = pendingReopenRecovery.get(i) ?? []
  // Start immediately after the replacement home settles, but do not hold the
  // eight-second play stage open. The init-script snapshot preserves chunks
  // that startup delivery removes before this bounded export completes.
  queued.push(recorder.recoverReopenedTelemetry(label, 2_000))
  pendingReopenRecovery.set(i, queued)
}

async function recoverPendingReopenedTelemetry(label: string): Promise<void> {
  await Promise.all([...pendingReopenRecovery].map(async ([i, queued]) => {
    pendingReopenRecovery.delete(i)
    const recovered = await Promise.all(queued)
    for (const note of recovered) slotResults[i].role.notes.push(`${label}: ${note}`)
  }))
}

async function readSeen(page: Page, closeOpen = false): Promise<PageEvidence> {
  return page
    .evaluate((close) => {
      const evidence = window as unknown as { __e2eSeen?: string[]; __e2eAppearances?: { text: string; fromMs: number; toMs: number }[]; __e2eTextWatch?: { close(): void } }
      if (close) evidence.__e2eTextWatch?.close()
      return { seen: (evidence.__e2eSeen ?? []).slice(), appearances: (evidence.__e2eAppearances ?? []).map((appearance) => ({ ...appearance })), finalText: document.body?.innerText ?? "" }
    }, closeOpen)
    .catch(() => ({ seen: [], appearances: [], finalText: "" }))
}

/** Whether the page currently shows `text`. `null` when the page could not be read at
 *  all: a page that is gone is not a page that showed nothing. */
async function pageShowsText(page: Page, text: string): Promise<boolean | null> {
  try {
    return await page.evaluate((t) => (document.body?.innerText ?? "").includes(t), text)
  } catch {
    return null
  }
}

async function readPageSessionId(page: Page): Promise<string | null> {
  return page
    .evaluate(async () => {
      const hook = (window as unknown as { __jollityHarness?: { exportLogs(): Promise<string> } }).__jollityHarness
      if (!hook) return null
      const exported = JSON.parse(await hook.exportLogs()) as { meta?: { sessionId?: unknown } }
      return typeof exported.meta?.sessionId === "string" ? exported.meta.sessionId : null
    })
    .catch(() => null)
}

async function localPageEvidence(i: number): Promise<PageEvidence> {
  const now = await readSeen(pages[i])
  return {
    seen: [...(preSeen[i] ?? []), ...now.seen],
    appearances: [...(preAppearances[i] ?? []), ...(now.appearances ?? [])],
    ignoreNeverTextWindows: scriptedNeverTextWindows(BOT?.name, networkController.snapshot().runs),
    finalText: now.finalText,
    ...(afterNetworkText[i] !== undefined ? { afterNetworkText: afterNetworkText[i] } : {}),
  }
}

/** Crash the slot's page (CDP Page.crash: no pagehide, so the app's last-session record shows
 *  a foreground crash/kill, the way an OS kill leaves it) and reopen the app on the same host slot. */
async function collectRetirementEvidence(i: number, old: Page, budgetMs = 10_000): Promise<void> {
  const deadline = Date.now() + budgetMs
  relaunchStorage[i] = undefined
  relaunchStorageKillAt[i] = undefined
  const withinBudget = async <T>(promise: Promise<T>, label: string): Promise<T> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`${label} skipped: pre-kill evidence budget exhausted`)
    return bounded(promise, remaining, label)
  }
  const oldContext = contexts[i]
  try {
    const captured = await captureWithReservedRelaunchBudget({
      budgetMs,
      prepare: async (preparationMs) => {
        const preparationDeadline = Date.now() + preparationMs
        const withinPreparation = <T,>(promise: Promise<T>, label: string) =>
          bounded(promise, Math.max(1, preparationDeadline - Date.now()), label)
        await Promise.all([
          withinPreparation(readSeen(old, true), "pre-kill page evidence")
            .then((oldEvidence) => {
              preSeen[i] = [...(preSeen[i] ?? []), ...oldEvidence.seen]
              preAppearances[i] = [...(preAppearances[i] ?? []), ...(oldEvidence.appearances ?? [])]
            })
            .catch((error) => {
              slotResults[i].role.notes.push(`pre-kill page evidence skipped: ${String(error).split("\n")[0]}`)
              if (/timed out/.test(String(error))) throw error
            }),
          Promise.resolve(recorders.get(i)?.snapshotDevLog("prekill", Math.max(1, preparationDeadline - Date.now())))
            .then((snap) => {
              if (snap) slotResults[i].role.notes.push(`pre-kill devLog: ${snap}`)
            })
            .catch((error) => {
              slotResults[i].role.notes.push(`pre-kill devLog skipped: ${String(error).split("\n")[0]}`)
              if (/timed out/.test(String(error))) throw error
            }),
        ])
      },
      capture: (captureBudgetMs, preparationTimedOut) => captureRelaunchStorage(old, oldContext, {
        budgetMs: captureBudgetMs,
        allowPause: !preparationTimedOut,
      }),
    })
    if (captured.preparationError) slotResults[i].role.notes.push(`pre-kill page evidence budget: ${captured.preparationError.message}`)
    const { checkpointed, checkpointError, storage } = captured.snapshot
    relaunchStorage[i] = storage
    relaunchStorageKillAt[i] = Date.now()
    const staleTail = staleUndurableTailError(captured.snapshot)
    if (staleTail) roleProblems.push(`pre-kill game-log durability NOT PROVEN: ${staleTail}`)
    if (!checkpointed) slotResults[i].role.notes.push(`pre-kill game-log tail not proven durable${checkpointError ? `: ${checkpointError}` : ""}`)
  } catch (error) {
    slotResults[i].role.notes.push(`pre-kill localStorage snapshot skipped: ${String(error).split("\n")[0]}`)
  }
  const tasks: Promise<void>[] = []
  if (BOT?.telemetryTorture?.id === "T4" || BOT?.telemetryTorture?.id === "T5") {
    const tortureId = BOT.telemetryTorture.id
    tasks.push(
      withinBudget(readHostStorageHangEvidence(old), "pre-kill host-storage evidence")
        .then((storage) => {
          telemetryStorageDrops += storage?.dropped ?? 0
          if (storage?.dropped) slotResults[i].role.notes.push(`${tortureId}: document dropped ${storage.dropped} host-storage frame(s)`)
        })
        .catch((error) => {
          slotResults[i].role.notes.push(`pre-kill host-storage evidence skipped: ${String(error).split("\n")[0]}`)
        }),
      withinBudget(readTelemetryGateEvidence(old), "pre-kill telemetry-gate evidence")
        .then((gate) => {
          if (!gate || gate.held < 1) roleProblems.push(`${tortureId} NOT PROVEN: the killed document held no Sentry fetch`)
          else slotResults[i].role.notes.push(`${tortureId}: killed while ${gate.held} Sentry fetch(es) were held`)
        })
        .catch((error) => {
          roleProblems.push(`${tortureId} NOT PROVEN: telemetry-gate evidence failed: ${String(error).split("\n")[0]}`)
        }),
    )
  }
  await Promise.all(tasks)
}

async function retirePage(i: number, old: Page, evidenceAlreadyCollected = false): Promise<void> {
  const oldContext = contexts[i]
  const finishRecording = () => {
    const bounds = recordingBounds.get(old)
    if (bounds && bounds.finishedAt === undefined) bounds.finishedAt = new Date().toISOString()
  }
  await retirePageForHostCrash({
    collectEvidence: async () => {
      if (!evidenceAlreadyCollected) await collectRetirementEvidence(i, old)
    },
    evidenceFailed: (error) => slotResults[i].role.notes.push(`pre-kill evidence skipped: ${error.message}`),
    // CDP Page.crash can take the whole BrowserContext down (game 188). A
    // resulting context-close error is expected only if old.isClosed() proves
    // the executable page is gone.
    crashPage: async () => {
      finishRecording()
      const cdp = await oldContext.newCDPSession(old)
      await cdp.send("Page.crash")
    },
    closeContext: () => {
      finishRecording()
      return oldContext.close()
    },
    isPageClosed: () => old.isClosed(),
  })
  if (BOT?.name === "turn-warm-returning" && relaunchStorage[i] === undefined) {
    throw new Error("returning-player relaunch cannot prove persisted host permissions: storageState was not saved")
  }
}

/** Open a fresh browser page on a slot whose previous page has already gone away. */
async function reopenPage(i: number): Promise<{ page: Page; home: Home }> {
  // Page.crash takes the whole headless browser down too (desk and game 188: "newContext: ... browser has been closed"),
  // so the relaunch is a NEW BROWSER with the config's own launch flags, then a context with the profile's options
  let context: BrowserContext
  const storageState = relaunchStorage[i]
  const recovered = recorders.get(i)?.recoverPersistedTelemetry(storageState, `reopen-${allPages[i].length}`, relaunchStorageKillAt[i])
  if (recovered) {
    slotResults[i].role.notes.push(recovered)
  }
  try {
    if (!theBrowser) throw new Error("no browser")
    context = await bounded(newContext(theBrowser, storageState), 8_000, "new context on the old browser")
  } catch {
    theBrowser = await bounded(chromium.launch({ args: [...chromiumArgsFor(BOT), "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] }), 30_000, "launch a new browser")
    context = await bounded(newContext(theBrowser, storageState), 15_000, "new context on the new browser")
    launchedAfterKill.push(theBrowser)
  }
  relaunchStorage[i] = undefined
  relaunchStorageKillAt[i] = undefined
  contexts[i] = context
  const fresh = await bounded(newBotPage(context, i), 15_000, "new page with the profile applied")
  allPages[i].push(fresh)
  attachLogs(fresh, i)
  await bounded(fresh.goto(`http://localhost:${slots[i].appPort}/`, { waitUntil: "domcontentloaded", timeout: 45_000 }), 50_000, "open the app")
  await narrators[i].attach(fresh)
  // P1/P3 create the recorder immediately before their waiting-room relaunch.
  // Move both sources of later work once the replacement document exists:
  // play/confirm/evidence dereference the slot array, while the background
  // sampler and final export own the recorder.
  bindReplacementPage(pages, i, fresh, [recorders.get(i)])
  if (recovered) queueReopenedTelemetryRecovery(i, `reopen-${allPages[i].length - 1}-early`)
  const home = await bounded(settledHome(fresh, 40_000, { stopOnGame: true }), 45_000, "home settles")
  slotResults[i].role.notes.push(`relaunched: new context, home ${home.state ?? "?"} (${home.source ?? "?"})`)
  return { page: fresh, home }
}

/** Crash the slot's page and immediately reopen it on the same live host (kill-relaunch). */
async function relaunch(i: number): Promise<Page> {
  const gate = recorders.get(i)?.gate
  await gate?.hold()
  try {
    await retirePage(i, pages[i])
    let reopened = (await reopenPage(i)).page
    // T5 deliberately kills the first reopened document while its emulated iOS
    // fetch gate is still pending, then proves the second reopen drains cleanly.
    if (BOT?.telemetryTorture?.id === "T5") {
      // The first reopen is itself a document whose truth must be snapshotted
      // before the second kill. The outer play loop binds the final reopen after
      // relaunch() returns; bind this deliberately transient page here.
      recorders.get(i)?.rebind(reopened)
      await reopened.waitForTimeout(5_000)
      const held = await readTelemetryGateEvidence(reopened)
      if (!held || held.held < 1) roleProblems.push("T5 NOT PROVEN: first reopened document held no Sentry fetch")
      slotResults[i].role.notes.push("T5: first reopen remained behind the Sentry fetch gate for 5 s; killing it")
      await retirePage(i, reopened)
      reopened = (await reopenPage(i)).page
      slotResults[i].role.notes.push("T5: second reopen has no fetch gate and can drain the outbox")
    }
    if (BOT?.telemetryTorture?.id === "T4" || BOT?.telemetryTorture?.id === "T5") telemetryRecoveryAtMs = Date.now()
    return reopened
  } finally {
    gate?.release()
  }
}

/** Freeze T6 at the report.landed navigation and kill without resuming. */
async function freezeAndReopenAfterReport(i: number, old: Page): Promise<void> {
  const seconds = BOT?.telemetryTorture?.freezeAfterReportS
  if (!seconds) return
  const context = contexts[i]
  const oldEvidence = await readSeen(old, true)
  const oldSessionId = await readPageSessionId(old)
  if (!oldSessionId) throw new Error("T6 NOT PROVEN: old document session id was unavailable before kill")
  preSeen[i] = [...(preSeen[i] ?? []), ...oldEvidence.seen]
  preAppearances[i] = [...(preAppearances[i] ?? []), ...(oldEvidence.appearances ?? [])]
  const snap = await recorders.get(i)?.snapshotDevLog("T6-prepause")
  if (snap) slotResults[i].role.notes.push(`T6 pre-pause devLog: ${snap}`)
  const relaunch = await captureRelaunchStorage(old, context).catch(() => undefined)
  relaunchStorage[i] = relaunch?.storage
  relaunchStorageKillAt[i] = Date.now()
  if (relaunch) {
    const staleTail = staleUndurableTailError(relaunch)
    if (staleTail) throw new Error(`T6 NOT PROVEN: ${staleTail}`)
    if (!relaunch.checkpointed) slotResults[i].role.notes.push(`T6 pre-kill game-log tail not proven durable${relaunch.checkpointError ? `: ${relaunch.checkpointError}` : ""}`)
  }
  slotResults[i].role.notes.push(`T6: freezing ${seconds} s immediately after report.landed; old document will not resume`)
  const { pausedMs, leaks } = await freezePageUntilCrash(old, seconds * 1000, oldSessionId)
  if (leaks.length > 0) {
    const shown = leaks.slice(0, 3).map((leak) => `${leak.by} ${leak.url.split("?")[0]}`).join("; ")
    throw new Error(`T6 NOT PROVEN: the killed document (session ${oldSessionId}) sent ${leaks.length} telemetry request(s) after the kill began: ${shown}`)
  }
  const fresh = (await reopenPage(i)).page
  recorderFor(i).rebind(fresh)
  const recovered = await proveNextOpenGameLogDelivery(fresh)
  slotResults[i].role.notes.push(`T6: replacement page delivered ${recovered.delivered}/${recovered.pending} game-log record(s) retained before boot`)
  slotResults[i].role.notes.push(`T6: renderer destroyed while paused after ${pausedMs} ms; the browser-level collector saw no telemetry from the old document's frames or session ${oldSessionId}; new document opened to drain telemetry`)
}

/** Keep the live run open until an induced mid-game transport fault ends.
 * The online edge makes the recovery explicit; the app/Sentry retry and the
 * final full-log flush then have the oracle's 60 s budget to arrive. */
async function awaitTelemetryRecovery(): Promise<void> {
  await telemetryActivation
  if (BOT?.telemetryTorture && !telemetryActivationProven(BOT.telemetryTorture.activateAtTurn, telemetryFaultStarted, telemetryRecoveryAtMs)) {
    throw new Error(`${BOT.telemetryTorture.id} NOT PROVEN: activateAtTurn fault never started`)
  }
  if (BOT?.telemetryTorture?.id === "T2") {
    const storage = await Promise.all(pages.map(readHostStorageHangEvidence))
    if (storage.some((fact) => !fact || fact.dropped < 1)) throw new Error("T2 NOT PROVEN: the storage hang dropped no host-storage frame")
    if (storage.some((fact, i) => !fact || !progressDuringActiveFault(telemetryProgressAtMs[i], fact.activatedAt, fact.release))) {
      throw new Error("T2 NOT PROVEN: registration/home progress was not observed while the 120 s storage fault was active")
    }
    if (storage.some((fact) => !fact || fact.active || Date.now() < fact.release)) throw new Error("T2 NOT PROVEN: the storage hang did not release after its declared window")
    slotResults.forEach((result, i) => result.role.notes.push(`T2: progress observed at ${new Date(telemetryProgressAtMs[i]!).toISOString()} while storage fault active; dropped ${storage[i]!.dropped} host-storage frame(s), released at ${new Date(storage[i]!.release).toISOString()}`))
  }
  if ((BOT?.telemetryTorture?.id === "T4" || BOT?.telemetryTorture?.id === "T5") && telemetryStorageDrops < 1) {
    throw new Error(`${BOT.telemetryTorture.id} NOT PROVEN: no killed document dropped a host-storage frame`)
  }
  if (BOT?.telemetryTorture?.id === "T9") {
    await networkController.drain()
    const blackout = blackoutFaultWindow(networkController.snapshot().runs)
    if (!blackout) throw new Error("T9 NOT PROVEN: no successful whole-link blackout window")
    telemetryFaultStartedAtMs = blackout.startedAtMs
    telemetryRecoveryAtMs = blackout.recoveredAtMs
  }
  if (telemetryRecoveryAtMs === null) return
  const wait = telemetryRecoveryAtMs - Date.now()
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  const recoveryEdges = await Promise.all(pages.map((page) => page.evaluate(() => window.dispatchEvent(new Event("online"))).then(() => true).catch(() => false)))
  if (BOT?.telemetryTorture?.id === "T9") telemetryFaultRecovered = blackoutRecoveryObserved(blackoutFaultWindow(networkController.snapshot().runs), recoveryEdges)
  if (BOT?.telemetryTorture?.id === "T9") {
    const acceptanceDeadline = blackoutAcceptanceDeadline(telemetryRecoveryAtMs)
    if (acceptanceDeadline > Date.now()) await new Promise((resolve) => setTimeout(resolve, acceptanceDeadline - Date.now()))
  }
  if (BOT?.telemetryTorture?.id === "T3") {
    const gates = await Promise.all(pages.map(readTelemetryGateEvidence))
    if (gates.some((gate) => !gate || gate.held < 1)) throw new Error("T3 NOT PROVEN: the emulated iOS gate held no Sentry fetch")
    slotResults.forEach((result, i) => result.role.notes.push(`T3: emulated iOS gate held ${gates[i]!.held} Sentry fetch(es) for three minutes`))
  }
  if (BOT?.telemetryTorture?.fault === "sentry-429") {
    const retryMs = (BOT.telemetryTorture.retryAfterS ?? 120) * 1000
    const first429s = allPages.flatMap((documents) => documents.flatMap((page) => telemetryRouteEvidence(page)?.first429At ?? []))
    const retryWindowEnd = Math.max(0, ...first429s.map((first) => first + retryMs))
    if (retryWindowEnd > Date.now()) await new Promise((resolve) => setTimeout(resolve, retryWindowEnd - Date.now()))
  }
  const routeEvidence = allPages.flatMap((documents, slot) => documents.flatMap((page, document) => {
    const evidence = telemetryRouteEvidence(page)
    return evidence ? [{ ...evidence, slot, document }] : []
  }))
  if (BOT?.telemetryTorture?.fault === "sentry-block" || BOT?.telemetryTorture?.fault === "sentry-429") {
    const attempts = routeEvidence.flatMap((evidence) => evidence.attempts).sort((a, b) => a - b)
    if (attempts.length === 0) throw new Error(`${BOT.telemetryTorture.id} NOT PROVEN: no Sentry envelope reached the route intercept during the mid-game fault`)
    if (BOT.telemetryTorture.fault === "sentry-429") {
      const retryMs = (BOT.telemetryTorture.retryAfterS ?? 120) * 1000
      for (const evidence of routeEvidence) {
        if (evidence.first429At === null) throw new Error(`T8 NOT PROVEN: slot ${evidence.slot + 1} document ${evidence.document} returned no observed 429 response`)
        const premature = retryAfterViolations(evidence.attempts, retryMs, evidence.first429At)
        if (premature.length > 0) throw new Error(`T8 NOT PROVEN: slot ${evidence.slot + 1} document ${evidence.document} made ${premature.length} request(s) inside the full Retry-After window`)
      }
    }
    slotResults.forEach((result) => result.role.notes.push(`${BOT!.telemetryTorture!.id}: route intercepted ${attempts.length} Sentry envelope request(s)`))
  }
  slotResults.forEach((result) => result.role.notes.push(`telemetry transport recovered at ${new Date(telemetryRecoveryAtMs!).toISOString()}`))
}

/** The kill and background roles' driver for slot i: the kill by the pill's turn, the hide by the page's confirm stage. */
function makeDriver(i: number, g: NonNullable<ChainState["game"]>, videoWindow?: VideoRoleWindow | null): RoleDriver | undefined {
  if (BOT?.camera.muteLoop) {
    let phase: "first-offer" | "first-tapped" | "second-offer" | "second-tapped" | "done" = "first-offer"
    let acted = false
    return {
      hidden: () => false,
      async clockTick() {},
      sawConfirm() {},
      pending: () => false,
      held: () => {
        const was = acted
        acted = false
        return was
      },
      async midGame() {
        const page = pages[i]
        const tap = page.locator('[data-testid="camera-tap"]')
        if (phase === "first-offer" && await tap.isVisible().catch(() => false) && await tap.isEnabled().catch(() => false)) {
          await armCameraMuteLoopActivationBypass(page)
          await tap.click({ timeout: 2_000 })
          phase = "first-tapped"
          acted = true
          slotResults[i].role.notes.push("camera-mute-loop: tapped the offered recovery button with live user activation")
          return null
        }
        if (phase === "first-tapped") {
          const facts = await readCameraMuteLoop(page)
          if (facts.activationBypasses > 0 && !(await tap.isVisible().catch(() => false))) {
            cameraMuteProofs[i].activatedTap = true
            await setCameraMuteLoopIgnoreActivation(page, true)
            if (!(await muteCameraMuteLoopCurrent(page))) throw new Error("camera-mute-loop: no live tapped track to begin the activation-ignored episode")
            phase = "second-offer"
            acted = true
            slotResults[i].role.notes.push(`camera-mute-loop: activated tap produced frames; forcing a new episode with activation ignored (${JSON.stringify(facts)})`)
          }
          return null
        }
        if (phase === "second-offer" && await tap.isVisible().catch(() => false) && await tap.isEnabled().catch(() => false)) {
          await tap.click({ timeout: 2_000 })
          phase = "second-tapped"
          acted = true
          slotResults[i].role.notes.push("camera-mute-loop: tapped a second episode while the harness ignored user activation")
          return null
        }
        if (phase === "second-tapped" && await page.locator('[data-testid="camera-restart-notice"]').isVisible().catch(() => false)) {
          const facts = await readCameraMuteLoop(page)
          cameraMuteProofs[i].ignoredTap = facts.ignoreActivation && facts.muted >= 4
          cameraMuteProofs[i].restartShown = true
          phase = "done"
          acted = true
          slotResults[i].role.notes.push(`camera-mute-loop: activation-ignored tap muted again and showed restart (${JSON.stringify(facts)})`)
        }
        return null
      },
    }
  }
  if (ROLE.kind === "host-crash") {
    let crashedAlready = false
    return {
      hidden: () => false,
      async clockTick() {},
      sawConfirm() {},
      pending: () => false,
      held: () => false,
      async midGame(at) {
        if (!shouldKill(ROLE, { ...at, rounds: g.rounds }, crashedAlready)) return null
        crashedAlready = true
        const recovered = await crashHost(i, pages[i], `game turn ${at.turn} of ${at.turnsInGame}`)
        return recovered.page
      },
    }
  }
  if (ROLE.kind === "video-return") {
    const r = ROLE
    const schedule = videoWindow === undefined ? { enableAtTurn: r.enableAtTurn, disableAtTurn: r.disableAtTurn } : videoWindow
    let suppressed = false
    const controlState: VideoRoleControlState = { requested: false, enabled: false, disarmed: false, disabled: false }
    let acted = false
    return {
      hidden: () => false,
      async clockTick() {},
      sawConfirm() {},
      pending: () => false,
      held: () => {
        const was = acted
        acted = false
        return was
      },
      async midGame(at) {
        const page = pages[i]
        const facts = await readOutboundVideo(page).catch(() => null)
        if (!suppressed && facts && facts.senders > 0 && !facts.enabled) {
          suppressed = true
          roleAct(i, "video-suppressed", `${facts.senders} outbound video sender(s) carry no track after return`)
        }
        if (schedule !== null && schedule.enableAtTurn !== null) {
          const step = await advanceVideoRoleWindow({
            turn: at.turn,
            stage: at.stage,
            window: { enableAtTurn: schedule.enableAtTurn, disableAtTurn: schedule.disableAtTurn },
            state: controlState,
            facts,
            setEnabled: (value) => setOutboundVideo(page, value),
          })
          acted = acted || step.changed
          if (step.action === "enabled") {
            roleAct(i, "video-enabled", `game turn ${at.turn}: restored ${step.facts?.senders ?? 0} outbound video sender(s)`)
          } else if (step.action === "disabled") {
            roleAct(i, "video-disabled", `game turn ${at.turn}: removed tracks from ${step.facts?.senders ?? 0} outbound video sender(s)`)
          }
        }
        return null
      },
    }
  }
  if (ROLE.kind === "reload" || ROLE.kind === "freeze") {
    const r = ROLE
    let done = false
    let acted = false
    return {
      hidden: () => false,
      async clockTick() {},
      sawConfirm() {},
      pending: () => false,
      held: () => {
        const was = acted
        acted = false
        return was
      },
      async midGame(at) {
        // the reload at any live stage of its turn; the freeze mid-turn, in a play stage
        const due = r.kind === "reload" ? dueAtTurn(at, r.reloadAtTurn, done) : dueAtTurn(at, r.freezeAtTurn, done, ["play"])
        if (!due) return null
        done = true
        acted = true
        const where = `game turn ${at.turn} of ${at.turnsInGame} (${at.stage})`
        if (at.clock) clockDiagnostic(`${r.kind} scheduled step`, at.clock)
        if (r.kind === "reload") await reloadAct(i, pages[i], where, signedUp)
        else {
          freezeTurn[i] = at.turn as number
          await freezeAct(i, pages[i], where)
        }
        return null
      },
    }
  }
  if (ROLE.kind === "hidden-step") {
    const r = ROLE
    let st = { ...HIDDEN_STEP_IDLE }
    let acted = false
    return {
      hidden: () => st.hiddenAtMs !== null && !st.shown,
      async clockTick() {},
      sawConfirm() {},
      pending: () => false,
      held: () => {
        const was = acted
        acted = false
        return was
      },
      async midGame(at) {
        const act = hiddenStepStep(r, st, at, Date.now())
        if (!act) return null
        acted = true
        const where = `game turn ${at.turn ?? "?"} (${at.stage})`
        if (at.clock) clockDiagnostic(`${act} scheduled step`, at.clock)
        if (act === "hide") {
          // the fallback show is due off the chain's schedule (the round gap included), the demo's off the hide
          const hiddenAtMs = Date.now()
          st = {
            ...st,
            hiddenAtMs,
            showDueMs: g.gameAt > 0 && at.clock
              ? appClockWallMsFor(at.clock, g.gameAt + turnStartS(g, r.showAtTurn)) + SHOW_GRACE_MS
              : hiddenShowDueMs(r, g, hiddenAtMs, null),
          }
          await hideAct(i, pages[i], where)
        } else if (act === "step") {
          st = { ...st, stepped: true }
          await stepAct(i, pages[i], where)
        } else {
          st = { ...st, shown: true }
          // the fallback (the page never showed showAtTurn) is a failure in a live game: the app lost its turn while hidden
          const source = act === "show" ? `on the page's own turn ${at.turn}` : `on the FALLBACK: the page never showed turn ${r.showAtTurn}, it reads turn ${at.turn ?? "?"}`
          if (act === "show-late" && signedUp) roleProblems.push(`show (${where}): ${source}`)
          await showAct(i, pages[i], `${where}, ${source}`)
        }
        return null
      },
    }
  }
  if (ROLE.kind !== "kill-relaunch" && ROLE.kind !== "background") return undefined
  const bg = ROLE.background
  let killed = false
  let bgState = { ...BACKGROUND_IDLE }
  const note = (t: string) => {
    slotResults[i].role.notes.push(`${new Date().toISOString().slice(11, 19)} ${t}`)
    console.log(`  player ${slots[i].n}: ${t}`)
  }
  return {
    hidden: () => bgState.hiddenAtMs !== null && !bgState.shown,
    sawConfirm() {
      if (!bg || bgState.confirmAtMs !== null) return
      bgState = { ...bgState, confirmAtMs: Date.now() }
      note(`confirm stage seen: hiding in ${bg.fromS} s for ${bg.untilS - bg.fromS} s, no Confirm tap until shown again`)
    },
    pending: () => backgroundPending(bg, bgState),
    async clockTick(page) {
      const act = backgroundStep(bg, bgState, Date.now())
      if (!act) return
      if (act === "hide") {
        const cta = await page.getByRole("button", { name: /Confirm votes|Confirming|tap to retry|Voting has closed|Submitting/ }).first().innerText({ timeout: 500 }).catch(() => "(none)")
        await backgroundPage(page).catch(() => {})
        bgState = { ...bgState, hiddenAtMs: Date.now() }
        roleAct(i, "hidden", `at ${page.url().replace(/^.*localhost:\d+/, "")}, CTA "${cta.trim()}"`)
        note(`backgrounded at ${page.url().replace(/^.*localhost:\d+/, "")}, CTA "${cta.trim()}"`)
      } else {
        await foregroundPage(page).catch(() => {})
        bgState = { ...bgState, shown: true }
        roleAct(i, "visible", "page shown again")
        const cta = await page.getByRole("button", { name: /Confirm votes|Confirming|tap to retry|Voting has closed|Submitting/ }).first().innerText({ timeout: 500 }).catch(() => "(none)")
        note(`foregrounded at ${page.url().replace(/^.*localhost:\d+/, "")}, CTA "${cta.trim()}"`)
      }
    },
    held: () => false,
    async midGame(at) {
      if (!shouldKill(ROLE, { ...at, rounds: g.rounds }, killed)) return null
      killed = true
      const r = roundOf(at.turn as number, at.turnsInGame as number, g.rounds)
      if (at.clock) clockDiagnostic("kill scheduled step", at.clock)
      if (GUARDS_AFTER_REOPEN.has(BOT?.name ?? "")) slotResults[i].sentryGuardStartedAt = new Date().toISOString()
      note(`killing the page at turn ${at.turn} of ${at.turnsInGame}`)
      roleAct(i, "killed", `at turn ${at.turn} of ${at.turnsInGame} (round ${r.round + 1}, turn ${r.turnInRound} of it)`)
      const fresh = await relaunch(i)
      roleAct(i, "relaunched", "page reopened on the same host slot")
      return fresh
    },
  }
}

/** THE RELOAD ACT: a plain page.reload() of the SAME page (same context, so sessionStorage survives; not a kill, not a
 *  new browser). Proof: a marker written to sessionStorage before is read back after; in a game (`floor`) the store
 *  clock's saved expiry floor (lib/store-clock.ts) must be there before and survive no lower. */
async function reloadAct(i: number, page: Page, where: string, floor: boolean): Promise<void> {
  const gate = recorders.get(i)?.gate
  await gate?.hold()
  try {
  // what dies with the old document: the text guards it saw, its devLog as it stood
  const oldEvidence = await readSeen(page, true)
  preSeen[i] = [...(preSeen[i] ?? []), ...oldEvidence.seen]
  preAppearances[i] = [...(preAppearances[i] ?? []), ...(oldEvidence.appearances ?? [])]
  const snap = await recorders.get(i)?.snapshotDevLog("prereload")
  if (snap) slotResults[i].role.notes.push(`pre-reload devLog: ${snap}`)
  const marker = `e2e-${Date.now()}`
  if (GUARDS_AFTER_REOPEN.has(BOT?.name ?? "")) slotResults[i].sentryGuardStartedAt = new Date().toISOString()
  await page.evaluate((m) => sessionStorage.setItem("e2e.reload", m), marker).catch(() => {})
  const before = await readSavedStoreClock(page)
  // in a game, the floor the old page leaves the new one: a priority refusal at or below it is the restore failing
  // (store-wire.ts). A reload on the home signs nothing on the game's channels, so it sets no floor to judge by
  if (floor) wireTaps[i].reloaded(new Date().toISOString(), savedFloorOf(before))
  roleAct(i, "reloading", `${where}: page.reload() on the same page and context; saved store clock ${before ? "present" : "absent"}`)
  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 })
  } catch (e) {
    roleProblems.push(`reload (${where}): the page did not load again: ${String((e as Error).message).split("\n")[0]}`)
    return
  }
  const kept = await page.evaluate(() => sessionStorage.getItem("e2e.reload")).catch(() => null)
  const after = await readSavedStoreClock(page)
  const lost = kept !== marker ? "sessionStorage did not survive the reload (the marker written before it is gone)" : floor ? savedFloorSurvived(before, after) : null
  if (lost) roleProblems.push(`reload (${where}): ${lost}`)
  else {
    roleAct(i, "reloaded", `${where}: loaded again at ${page.url().replace(/^.*localhost:\d+/, "")}; sessionStorage kept${floor ? ", the store clock's saved floor no lower" : ""}`)
  }
  const reopened = await recorders.get(i)?.snapshotReopenedDevLog("postreload")
  if (reopened) slotResults[i].role.notes.push(`post-reload devLog: ${reopened}`)
  } finally {
    gate?.release()
  }
}

/** THE HIDDEN-STEP ACTS: hide (document.hidden + visibilitychange), step the page clock by the role's stepS while hidden,
 *  show again. Each is read back from the page. */
async function hideAct(i: number, page: Page, where: string): Promise<void> {
  await backgroundPage(page).catch(() => {})
  const hidden = await page.evaluate(() => document.hidden).catch(() => null)
  if (hidden === true) roleAct(i, "hidden", `${where}: document.hidden reads true, visibilitychange fired`)
  else roleProblems.push(`hide (${where}): document.hidden reads ${hidden}`)
}
async function stepAct(i: number, page: Page, where: string): Promise<void> {
  if (ROLE.kind !== "hidden-step") return
  const sign = (s: number) => `${s >= 0 ? "+" : ""}${s}`
  const target = (BOT?.clockOffsetS ?? 0) + ROLE.stepS
  const read = await jumpClock(page, target)
    .then(() => readClockOffsetS(page))
    .catch(() => null)
  const hidden = await page.evaluate(() => document.hidden).catch(() => null)
  if (read !== null && clockJumpLanded(target, read) && hidden === true) roleAct(i, "clock-step", `${where}: page clock stepped ${sign(ROLE.stepS)} s while hidden, read back ${sign(Math.round(read * 10) / 10)} s`)
  else roleProblems.push(`clock step (${where}): wanted ${sign(target)} s on a hidden page, read ${read === null ? "nothing" : `${sign(Math.round(read * 10) / 10)} s`}, document.hidden=${hidden}`)
}
async function showAct(i: number, page: Page, where: string): Promise<void> {
  await foregroundPage(page).catch(() => {})
  const hidden = await page.evaluate(() => document.hidden).catch(() => null)
  if (hidden === false) roleAct(i, "visible", `${where}: document.hidden reads false, visibilitychange fired`)
  else roleProblems.push(`show (${where}): document.hidden reads ${hidden}`)
}

/** THE VISIBLE FREEZE (browser-profile.ts freezePage): the page's JS stops for the role's freezeS while it stays visible.
 *  Proof, from the page after the thaw: its own timer went that long without a tick, performance.now() was held back by
 *  about as much (when the role holds it), and it never read hidden. */
async function freezeAct(i: number, page: Page, where: string): Promise<void> {
  if (ROLE.kind !== "freeze") return
  await resetFreezeGap(page).catch(() => {})
  // the recorder reads nothing while the page is paused: its evaluate and screenshot would only wait for the thaw
  const gate = recorders.get(i)?.gate
  await gate?.hold()
  roleAct(i, "frozen", `${where}: the page's JS paused ${ROLE.freezeS} s (CDP Debugger.pause), visible, no visibility event${ROLE.holdMonotonic ? ", performance.now() held" : ""}`)
  let f: Awaited<ReturnType<typeof freezePage>>
  try {
    f = await freezePage(page, ROLE.freezeS * 1000, ROLE.holdMonotonic)
  } catch (e) {
    roleProblems.push(`freeze (${where}): ${(e as Error).message}`)
    return
  } finally {
    gate?.release()
  }
  await page.waitForTimeout(1000)
  let back = await readFreeze(page).catch(() => null)
  let late = ""
  // the paused frame may belong to another world (Playwright's own): then the hold lands in the page's world now
  if (back && ROLE.holdMonotonic && Math.abs(back.heldMs - f.pausedMs) > 2000) {
    await page.evaluate((ms) => {
      const g = globalThis as unknown as { __e2ePerfOffMs?: number }
      g.__e2ePerfOffMs = (g.__e2ePerfOffMs ?? 0) + ms
    }, f.pausedMs)
    back = await readFreeze(page).catch(() => null)
    late = " (the hold was written 1 s after the thaw: the paused frame was not the page's)"
  }
  const why = !back ? "the page could not be read after the thaw" : (freezeLanded(ROLE.freezeS, back.maxGapMs, back.heldMs, ROLE.holdMonotonic) ?? (back.hidden ? "the page reads hidden after a VISIBLE freeze" : null))
  if (why || !back) roleProblems.push(`freeze (${where}): ${why}`)
  else roleAct(i, "thawed", `${where}: ${Math.round(back.maxGapMs)} ms without a timer tick, performance.now() held back ${Math.round(back.heldMs)} ms${late}, document.hidden=false`)
}

/** the turn each slot's page showed when it froze (the freeze role) */
const freezeTurn: (number | undefined)[] = []

/** Record one thing a role DID, with its time, in the result and the log: a role that was due and never acts fails in (c)'s end. */
const roleActs: RoleAction[][] = []
function roleAct(i: number, id: ActId, detail: string): void {
  const a: RoleAction = { id, at: new Date().toISOString(), detail }
  ;(roleActs[i] ??= []).push(a)
  slotResults[i].role.actions.push(a)
  console.log(`  ROLE ACT  player ${slots[i].n} ${id}: ${detail}`)
  recorders.get(i)?.mark(id, detail)
  const action = `role.${id}`
  const presentation = SCENARIO.actions[action]
  if (presentation) void narrate(i, presentation.recovered ? "recovered" : "active", "role", action, detail)
}

/** THE HOST-CRASH ROLE (host-crash.ts): ask boot.mts to SIGKILL this slot's truapi-host, retire its page before boot may
 *  respawn, then reopen on the same ports/session only after the listener is ready. This is the phone lifecycle: the WebView
 *  cannot outlive its host and reload itself into browser mode. */
async function crashHost(
  i: number,
  page: Page,
  where: string,
  killAtMs?: number,
  /** runs AFTER crashHost's own wait for a scheduled kill, i.e. at the kill itself: the
   *  only moment at which "what was on the page when we killed the host" is a true
   *  statement. Sampling earlier reports a card the app had not yet had time to raise. */
  beforeKill?: () => Promise<void>,
): Promise<{ reopened: true; source: string | null; upS: number | undefined; page: Page }> {
  const downS = ROLE.kind === "host-crash" ? ROLE.downS : BOT?.name === "host-stuck-waiting" ? 1 : null
  if (downS === null) throw new Error("crashHost called outside a host-crash or host-stuck-waiting lifecycle")
  // Keep the recorder sampler running during a long scheduled wait. Pause it
  // only for the bounded evidence window immediately before the kill.
  if (killAtMs !== undefined) {
    const beforeEvidence = killAtMs - 2_000 - Date.now()
    if (beforeEvidence > 0) await new Promise((resolve) => setTimeout(resolve, beforeEvidence))
  }
  const gate = recorders.get(i)?.gate
  await gate?.hold()
  try {
    // The host kill tears down the page before its callback runs. Give the
    // pre-kill read a strict two-second best-effort window, starting before a
    // scheduled waiting-room kill so evidence never shifts that fault target.
    await collectRetirementEvidence(i, page, Math.max(1, Math.min(2_000, (killAtMs ?? Date.now() + 2_000) - Date.now())))
      .catch((error) => slotResults[i].role.notes.push(`pre-kill evidence incomplete: ${String(error).split("\n")[0]}`))
    if (killAtMs !== undefined && killAtMs > Date.now()) await new Promise((resolve) => setTimeout(resolve, killAtMs - Date.now()))
    await beforeKill?.()
    const s = await requestHostCrash(OUT, slots[i].n, downS, async (k) => {
      roleAct(i, "host-killed", `${where}: truapi-host ${k.killedPid} killed with SIGKILL, kept down ${downS} s`)
      await retirePage(i, page, true)
    })
    if (s.error) throw new Error(`host crash: ${s.error}`)
    roleAct(i, "host-restarted", `${where}: the host listens again ${s.upS} s after the kill (same ports, same session)`)
    // the home's settled read, not a second one: a live game's home leaves for /game right after it settles (reopenedHostVerdict)
    const { page: fresh, home } = await reopenPage(i)
    const verdict = reopenedHostVerdict(home)
    const note = `${where}: old page closed with host; app reopened after listener ready${home.hooks ? `, data-source=${home.source}` : ""}`
    slotResults[i].role.notes.push(note)
    console.log(`  player ${slots[i].n}: ${note}`)
    if (verdict === "not-host") roleProblems.push(`host crash (${where}): the reopened page reads data-source=${home.source}, not host`)
    else if (verdict === "host") roleAct(i, "host-reconnected", `${where}: reopened after listener ready, data-source=host`)
    else console.log(`  player ${slots[i].n}: host-reconnected not shown on this page (no home hooks); the filed report is the proof that signing came back`)
    return { reopened: true, source: home.hooks ? home.source : null, upS: s.upS, page: fresh }
  } finally {
    gate?.release()
  }
}

/** the role's own assertions, evaluated in (d) beside the chain checks */
const roleChecks: Check[] = []
let watch: Promise<Record<string, unknown>> | null = null
/** bots by account, for the tables */
const botNames = () => Object.fromEntries(slots.map((sl) => [sl.oracle.account ?? "", `${sl.user} (bot)`]))

test("(c) play: the app's handover, a tap per turn, Confirm, /prize-draw", async () => {
  skipIf(EXPECTED_NO_JOIN !== null, `${EXPECTED_NO_JOIN}: stages (b)–(d) are not run`)
  skipIf(!signedUp || !game, "(c) play: no sign-up in (b), so no game to play")
  // re-read: never trust a report_ends read during Registration
  const readStartMs = Date.now()
  const now = readState()
  // Seed the independent diagnostic from this read; the settlement watch replaces it whenever a fresher best-block offset arrives.
  switchAnchor = readingAnchor(readStartMs, Date.now(), now.chainBestNow ?? undefined, "seed")
  let watchClockSamples = 0
  if (now.game && now.game.index === game!.index) game = now.game
  const g = game!
  // the same report_ends the probe sized the job from (timing.ts)
  const reportEnds = reportEndsFor(g, { reporting: now.reportingS })
  const liveGame = { ...g, reportEnds }
  let game259PeerCount: number | null = null
  let game259Round: number | null = null
  let game259Peers: string[] | null = null
  let game259RemovedPeers: string[] | null = null
  // Re-read at the stage boundary. A deliberate late join is on about:blank,
  // so only that role falls back to the reading captured immediately before
  // it left the app in (b).
  const schedulingClock = await readAppClock(pages[0]) ?? appClockSeeds[0]
  if (!schedulingClock) throw new Error("stage (c) scheduling needs the app's GameSource clock")
  recordClockSample(0, "stage-c", schedulingClock)
  // the report watch starts BEFORE play, so no ReportSubmitted is missed; it
  // also follows the live report_ends (chain-read.mts --margin)
  const deadline = settleDeadline(reportEnds, 300)
  watch = new Promise((done, fail) => {
    const child = spawn("npx", ["tsx", "scripts/e2e-live/chain-read.mts", "watch", "--game", String(g.index), "--accounts", accounts.join(","), "--deadline", String(deadline), "--margin", "300"], {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let errTail = ""
    child.stdout.on("data", (c: Buffer) => (out += c.toString()))
    child.stderr.on("data", (c: Buffer) => {
      const chunk = c.toString()
      appendFileSync(join(OUT, "watch.log"), chunk)
      const decoded = accumulateWatchedClock(errTail, chunk)
      errTail = decoded.tail
      for (const sample of decoded.anchors) {
        watchClockSamples++
        // A watch read excludes npx/tsx startup and is the first trustworthy live sample; never let the subprocess seed
        // compete with it. Later samples keep the greatest stale-only offset, independent of arrival order.
        switchAnchor = selectWatchedAnchor(switchAnchor, sample, watchClockSamples)
      }
    })
    child.on("exit", (code) => (code === 0 ? done(JSON.parse(out)) : fail(new Error(`watch exited ${code} (see watch.log)`))))
  })
  const playDeadline = appClockWallMsFor(schedulingClock, reportEnds) + 60_000
  // The game sets this test's clock, not the config. A game is in Registration
  // from its schedule_games block, so a sign-up can land 25 minutes before the
  // handover; the flat 20-minute test timeout then expired four minutes before
  // game 173 began (CI a live run, #294). Size it from report_ends.
  test.setTimeout(Math.max(playDeadline - Date.now(), 60_000) + 120_000)
  if (BOT?.name === "game259-lossy-video") {
    // Group indices do not exist during Registration. Read them at the
    // handover boundary, after the finalized roster exists but before the
    // second-round gate can fire.
    const rosterWaitMs = appClockWallMsFor(schedulingClock, handoverAt(g.gameAt)) - Date.now()
    if (rosterWaitMs > 0) await pages[0].waitForTimeout(rosterWaitMs)
    const roster = await waitForReadyValue(
      () => chainRead<{ rounds: string[][]; roundPeers: string[][]; peers: string[] }>(
        "group-peers",
        "--game",
        String(g.index),
        "--accounts",
        accounts[0],
      ),
      (value) => value.roundPeers.length > 0 && (value.roundPeers.at(-1)?.length ?? 0) > 0,
      { deadlineMs: appClockWallMsFor(schedulingClock, g.gameAt - 30) },
    )
    game259Round = roster.roundPeers.length
    game259Peers = roster.roundPeers.at(-1) ?? []
    game259RemovedPeers = roster.peers.filter((peerId) => !game259Peers!.includes(peerId))
    game259PeerCount = game259Peers.length
    if (game259PeerCount < 1) throw new Error("game259-lossy-video needs at least one finalized shared-group peer")
    slotResults[0].role.notes.push(
      `renegotiation targets the final group's ${game259PeerCount} peer(s) after ${roster.peers.length} distinct shared-group connections narrow at round ${game259Round}`,
    )
  }
  const recs = pages.map((_, i) => recorderFor(i))
  const beforeGameSteps = scheduleBeforeGameSteps(
    NET_PLAN,
    g.gameAt,
    (gameSecond) => appClockWallMsFor(schedulingClock, gameSecond),
    (beforeS) => networkController.onBeforeGame(beforeS),
    {
      excludeSeconds: BOT?.name === "turn-warm-returning" ? [90] : [],
      onRows: (rows, beforeS) => {
        if (rows.length) {
          record.networkSteps = [...((record.networkSteps as unknown[]) ?? []), ...rows]
          const line = `${new Date().toISOString()} network step(s) fired at T-${beforeS} from the app clock`
          console.log(`  ${line}`)
          appendFileSync(join(OUT, "netem.log"), line + "\n")
          clockDiagnostic(`T-${beforeS} network step`, schedulingClock)
        }
      },
      onMissed: (beforeS, lateByMs) => {
        const problem = BOT?.name === "network-blocked" && beforeS === 300
          ? `network-blocked NOT PROVEN: T-${beforeS} passed ${Math.round(lateByMs / 1000)} s ago; refusing to move the waiting-room fault into the game`
          : BOT?.name === "host-stuck-waiting"
            ? `host-stuck-waiting NOT PROVEN: T-${beforeS} passed ${Math.round(lateByMs / 1000)} s ago; refusing to move the waiting-room fault into the game`
            : `network step(s) at T-${beforeS} NOT PROVEN: deadline passed ${Math.round(lateByMs / 1000)} s ago`
        roleProblems.push(problem)
        slotResults.forEach((r) => r.role.notes.push(problem))
      },
      onScheduled: (beforeS, waitMs) => {
        if (BOT?.name === "host-stuck-waiting")
          slotResults.forEach((r) => r.role.notes.push(`host hang scheduled ${Math.round(waitMs / 1000)} s from now, at T-${beforeS} s`))
      },
    },
  )
  let cancelRoundChannelGates = false
  let roundChannelGateWork: Promise<unknown[]> = Promise.resolve([])
  try {
  // #724 P3/P4 are explicit one-player acceptance runs. They exercise the
  // pre-game credential path itself, so their faults are scheduled here,
  // before the ordinary play recorder begins and while the home/game
  // handover owns the page.
  if (BOT?.name === "turn-warm-returning") {
    await pages[0].waitForFunction(
      () => Object.keys(localStorage).some((key) => key.startsWith("jollity.turn.v1:")),
      undefined,
      { timeout: 20_000 },
    )
    await pages[0].evaluate(() => {
      for (const key of Object.keys(localStorage))
        if (key.startsWith("jollity.turn.v1:")) localStorage.removeItem(key)
    })
    // The first waiting-room warmup is only setup. Sentry-backed acceptance
    // starts here so it can prove the fresh context issued its own credentials.
    slotResults[0].sentryGuardStartedAt = new Date().toISOString()
    pages[0] = await relaunch(0)
    slotResults[0].role.notes.push("returning-player relaunch: persisted host permissions, fresh browser context, empty TURN cache")
    await pages[0].waitForFunction(
      () => Object.keys(localStorage).some((key) => key.startsWith("jollity.turn.v1:")),
      undefined,
      { timeout: 20_000 },
    )
    await reloadAct(0, pages[0], "registered returning-player waiting room after source warm-up", false)
    // This fault is intentionally relative to the completed fresh-context
    // setup. Arming it before relaunch can interrupt that setup and still look
    // like a valid waiting-room outage.
    const beforeS = 90
    const afterRelaunch = await waitForAppClock(() => readAppClock(pages[0]))
    if (!afterRelaunch) throw new Error("turn-warm-returning scheduling needs the relaunched app clock")
    const wait = appClockWallMsFor(afterRelaunch, g.gameAt - beforeS) - Date.now()
    if (wait <= 0) {
      const problem = `turn-warm-returning NOT PROVEN: T-${beforeS} passed ${Math.round(-wait / 1000)} s ago; refusing to move the issuer fault into the game`
      roleProblems.push(problem)
      slotResults.forEach((r) => r.role.notes.push(problem))
    } else {
      await pages[0].waitForTimeout(wait)
      clockDiagnostic(`T-${beforeS} returning-player outage`, afterRelaunch)
      const rows = networkController.onBeforeGame(beforeS)
      if (rows.length) record.networkSteps = [...((record.networkSteps as unknown[]) ?? []), ...rows]
    }
  }
  if (BOT?.name === "network-blocked") {
    const blockedAt = 300
    const recoveredAt = 2
    const blockedRows = await beforeGameSteps.get(blockedAt)
    if (blockedRows?.length) {
      // The outage command installs its rule before sleeping. Keep the warmed
      // TURN credentials, then deliver the browser network edge that asks the
      // waiting-room preflight to prove whether those credentials can allocate
      // a relay on the current path.
      await pages[0].waitForTimeout(2_000)
      await pages[0].evaluate(() => window.dispatchEvent(new Event("online")))
      const warningTimeoutMs = waitingNetworkWarningTimeoutMs(schedulingClock, handoverAt(g.gameAt), Date.now())
      await pages[0].locator('[data-testid="waiting-network-blocked"]').waitFor({ state: "visible", timeout: warningTimeoutMs })
      slotResults[0].role.notes.push("waiting-room network warning appeared before handover while warmed TURN could not allocate a relay")
      // Fire at T-2 even if the T-300 outage process is still completing its
      // cleanup/proof probes or the waiting-room preflight has not settled.
      // stop() joins the older background work before verdicts.
      await beforeGameSteps.get(recoveredAt)
      await networkController.drain()
      // A phone changing Wi-Fi/LTE raises an online/type edge. Netem changes
      // the runner, not Chromium's Network Information API, so deliver the
      // browser edge explicitly after the real path has changed.
      await pages[0].evaluate(() => window.dispatchEvent(new Event("online")))
      await pages[0].waitForTimeout(3_000)
      afterNetworkText[0] = await pages[0].evaluate(() => document.body?.innerText ?? "").catch(() => undefined)
    } else beforeGameSteps.cancel(recoveredAt)
  }
  // #726's waiting-room proof: the player is already registered. At T-5m the harness silently hangs the host's existing
  // People-RPC socket for 120 s, waits for that bounded fault to lift, then performs the exact recovery the card requests:
  // restart the host and reopen the app. The text observer spans both pages, so the final guards prove both appearance and clear.
  if (BOT?.name === "host-stuck-waiting") {
    const hangStep = BOT.network.timeline?.find((step) => step.hostChainHangS !== undefined)
    const beforeS = hangStep?.atBeforeGameS
    const hangS = hangStep?.hostChainHangS
    if (beforeS === undefined || hangS === undefined) throw new Error("host-stuck-waiting needs an atBeforeGameS host-chain hang")
    const scheduled = beforeGameSteps.get(beforeS)
    if (!scheduled) {
      const note = `host hang not scheduled: ${HOST_CHAIN_NA ?? `no T-${beforeS} host-chain step in the effective network plan`}`
      slotResults.forEach((r) => r.role.notes.push(note))
    }
    const rows = await scheduled
    if (rows?.length) {
      const inForce = await waitInForce(OUT, slots[0].n, 20_000)
      if (!inForce) roleProblems.push("host-stuck-waiting NOT PROVEN: the hang never came into force")
      else {
        // Reopen near the end but while DROP is still in force. Its opening
        // proof spans the lift, proving that a real restart—not merely a
        // background re-check—owns the recovery telemetry.
        const killAtMs = Date.now() + Math.max(0, (hangS - 8) * 1000)
        // Whether the card is on the page AT THE KILL decides app-vs-harness for this
        // persona, and nothing has ever recorded it: three runs (40154978844,
        // 40260175041, 40439359008) fail "Restart the Polkadot app" with every exported
        // devLog starting AFTER the hang lifted, so the only record that could hold the
        // card - the pre-kill page's own - is gone. This samples the page right before
        // the kill and states the answer either way, so the next run says which of the
        // two it is instead of leaving it to be inferred.
        const recovered = await crashHost(0, pages[0], `during the T-${beforeS} s host hang`, killAtMs, async () => {
          // Sampled HERE, not at the call site: crashHost has just finished waiting for
          // killAtMs, so this is the page as the kill finds it. Sampling before that wait
          // reads the page ~80 s early and reports a card the app had no time to raise as
          // "the app never raised it" - a false app finding.
          const cardAtKill = await pageShowsText(pages[0], STUCK_CARD_TEXT)
          slotResults[0].role.notes.push(stuckCardAtKillNote(cardAtKill, hangS - Math.max(0, (killAtMs - Date.now()) / 1000)))
        })
        pages[0] = recovered.page
      }
      await networkController.drain()
    }
  }
  let videoRoleWindow: VideoRoleWindow | null | undefined
  if (ROLE.kind === "late-join" || ROLE.kind === "video-return") {
    // The app was left in (b); project its retained GameSource clock while the page is absent.
    const lateJoinClock = await readAppClock(pages[0]) ?? appClockSeeds[0] ?? schedulingClock
    const at = appClockWallMsFor(lateJoinClock, lateJoinAt(g.gameAt, ROLE.joinAfterTurn))
    const wait = at - Date.now()
    slotResults.forEach((r) => r.role.notes.push(`returning ${Math.round(wait / 1000)} s from now, after game turn ${ROLE.joinAfterTurn}`))
    if (wait > 0) await pages[0].waitForTimeout(wait)
    clockDiagnostic("late-join scheduled return", lateJoinClock)
    await Promise.all(pages.map((p, i) => p.goto(`http://localhost:${slots[i].appPort}/`, { waitUntil: "domcontentloaded", timeout: 60_000 })))
    slots.forEach((_, i) => roleAct(i, "rejoined", `returned for game turn ${ROLE.joinAfterTurn} (chain ${lateJoinAt(g.gameAt, ROLE.joinAfterTurn)})`))
    if (ROLE.kind === "video-return" && ROLE.enableAtTurn !== null && VIDEO_ROLE_VIEWER_ACCOUNT) {
      if (!Number.isInteger(VIDEO_ROLE_VIEWER_RELOAD_TURN) || VIDEO_ROLE_VIEWER_RELOAD_TURN < 1)
        throw new Error(`E2E_VIDEO_ROLE_VIEWER_RELOAD_TURN must be a positive whole turn, got ${String(process.env.E2E_VIDEO_ROLE_VIEWER_RELOAD_TURN)}`)
      if (accounts.length !== 1) throw new Error(`dynamic video-role grouping needs exactly one sender account, got ${accounts.length}`)
      const overlap = chainRead<{
        gameIndex: number
        playerCount: number
        maxGroupSize: number
        rounds: number
        sharedRounds: number[]
      }>("group-overlap", "--game", String(g.index), "--accounts", `${accounts[0]},${VIDEO_ROLE_VIEWER_ACCOUNT}`)
      videoRoleWindow = planVideoRoleWindow({
        sharedRounds: overlap.sharedRounds,
        maxGroupSize: overlap.maxGroupSize,
        rounds: overlap.rounds,
        joinAfterTurn: ROLE.joinAfterTurn,
        reloadAtTurn: VIDEO_ROLE_VIEWER_RELOAD_TURN,
      })
      if (videoRoleWindow) {
        const detail = `finalized ${overlap.playerCount}-player grouping shares round ${videoRoleWindow.round + 1}; enable turn ${videoRoleWindow.enableAtTurn}, disable turn ${videoRoleWindow.disableAtTurn}, viewer reload turn ${VIDEO_ROLE_VIEWER_RELOAD_TURN}`
        console.log(`  video-role proof window: ${detail}`)
        slotResults.forEach((result) => result.role.notes.push(detail))
      } else {
        roleProblems.push(
          `no same-observer video proof window: sender/viewer shared rounds ${overlap.sharedRounds.map((round) => round + 1).join(",") || "none"}, join after turn ${ROLE.joinAfterTurn}, viewer reload turn ${VIDEO_ROLE_VIEWER_RELOAD_TURN}`,
        )
      }
    }
  }
  recs.forEach((r) => r.start())
  roundChannelGateWork = Promise.all(networkController.pendingRoundChannelGates().map(async (gate) => {
    const effectiveGate = BOT?.name === "game259-lossy-video" && game259PeerCount !== null && game259Round !== null
      ? { ...gate, round: game259Round, count: game259PeerCount }
      : gate
    const result = await waitForRoundChannelGate({
      gate: effectiveGate,
      ...(BOT?.name === "game259-lossy-video" && game259Peers ? { peerIds: game259Peers } : {}),
      ...(BOT?.name === "game259-lossy-video" && game259RemovedPeers ? { removedPeerIds: game259RemovedPeers } : {}),
      deadlineMs: appClockWallMsFor(schedulingClock, g.gameAt + effectiveGate.byGameS),
      readLines: async () => {
        await recs[0].observeDevLogAt("rtc", "[jollity-rtc] round-link")
        return recs[0].telemetryGroundTruth().lines
      },
      fire: (round) => networkController.onRoundChannelsOpen(round, effectiveGate.count, async () => {
        if (cancelRoundChannelGates) throw new Error("round-channel gate cancelled before renegotiation hook")
        const requestId = `game259-round-${round}-burst`
        const result = await pages[0].evaluate(async (id) => {
          const hook = (window as unknown as { __jollityHarness?: {
            forceLaneRenegotiationOnce?(requestId: string, expectedPeers: number): Promise<{
              requestedPeers: string[]
              rejectedPeers: Array<{ peerId: string; reason: string }>
            } | null>
          } }).__jollityHarness
          return hook?.forceLaneRenegotiationOnce?.(id.requestId, id.expectedPeers) ?? null
        }, { requestId, expectedPeers: effectiveGate.count })
        if (!result || result.requestedPeers.length !== effectiveGate.count || result.rejectedPeers.length) {
          const rejected = result?.rejectedPeers.map(({ peerId, reason }) => `${peerId}: ${reason}`).join(", ") || "hook unavailable"
          throw new Error(`NOT PROVEN: forced lane renegotiation requested ${result?.requestedPeers.length ?? 0}/${effectiveGate.count} peers (${rejected})`)
        }
      }, { planned: gate, effective: effectiveGate }),
      pollMs: 1_000,
      cancelled: () => cancelRoundChannelGates,
    })
    const line = `${new Date().toISOString()} ${result.detail}`
    console.log(`  ${line}`)
    appendFileSync(join(OUT, "netem.log"), line + "\n")
    if (result.rows.length) record.networkSteps = [...((record.networkSteps as unknown[]) ?? []), ...result.rows]
    if (result.status === "not-proven") {
      roleProblems.push(result.detail)
      slotResults.forEach((slot) => slot.role.notes.push(result.detail))
    }
    return result
  }))
  const survivalCounter = PROFILE === UPLINK_LIFT_PROFILE
    ? waitForSurvivalWindow({
        playDeadlineMs: playDeadline,
        waitForGame: (timeout) =>
          pages[0].waitForFunction(
            (gameIndex) => {
              const hook = (window as unknown as { __jollityHarness?: { sendAdaptation?(): { gameIndex: number | null } | null } }).__jollityHarness
              return hook?.sendAdaptation?.()?.gameIndex === gameIndex
            },
            g.index,
            { timeout },
          ),
        waitForTransition: (timeout) => pages[0].waitForFunction(() => {
          const hook = (window as unknown as {
            __jollityHarness?: {
              sendAdaptation?(): {
                currentRung: number
                transitions?: { direction: "down" | "up"; cause: "bandwidth" | "recovery"; from: number; to: number; applied: number }[]
              }
            }
          }).__jollityHarness
          const evidence = hook?.sendAdaptation?.()
          if (evidence?.currentRung !== 4) return false
          let rung = 0
          for (const transition of evidence.transitions ?? []) {
            if (transition.applied < 1) continue
            if (transition.from !== rung || transition.direction !== "down" || transition.cause !== "bandwidth" || transition.to <= transition.from) return false
            rung = transition.to
            if (rung === 4) return true
            if (rung > 4) return false
          }
          return false
        }, undefined, { timeout }),
      })
        .then(() => networkController.captureQdisc("survival-start"))
        .catch((error) => roleProblems.push(`survival-start qdisc snapshot failed: ${error instanceof Error ? error.message : String(error)}`))
    : Promise.resolve()
  // THE CONFIRM CUT (atConfirm): in force before the report is filed. It fires when the page shows the SECOND-TO-LAST turn
  // (duringGame), two turns before the confirm stage, with a chain-clock fallback at that turn's start; the fit is checked on the
  // chain time NOW, so the window plus one turn for the report to land must end before report_ends. The bot's Confirm tap waits
  // on it, and the report-after-cut check fails a report built before it was in force or after its refusal ended.
  const turns = g.rounds * g.maxGroupSize
  const confirmCutAt = confirmCutChainAt(gameEndAt(g), TURN_S)
  const confirmHoldS = networkController.pendingAt("confirm").map((s) => cutHoldS(s.calls)).find((h) => h !== null) ?? null
  const confirmCut = (cutWatches.confirm = new CutWatch(cutArmed("confirm"), appClockWallMsFor(schedulingClock, reportEnds - TURN_S), confirmHoldS === null ? null : confirmHoldS * 1000))
  fireConfirmCut = (turn) => {
    fireConfirmCut = null
    clockDiagnostic("confirm-cut scheduled step", schedulingClock)
    // The evidence row's turn comes from the canonical app moment; the timer is projected from the same app clock.
    void fireMoment("confirm", appClockSecondAt(schedulingClock, Date.now()), reportEnds, TURN_S, "the report window", turn ?? turns - 1)
  }
  const confirmTimer = networkController.pendingAt("confirm").length ? setTimeout(() => fireConfirmCut?.(), Math.max(0, appClockWallMsFor(schedulingClock, confirmCutAt) - Date.now())) : undefined
  let results: Awaited<ReturnType<typeof play>>[]
  try {
    results = await Promise.all(pages.map((page, i) => play(page, slots[i].n, playDeadline, { game: liveGame, rec: recs[i], onGameMoment: duringGame, changeVerdictThenConfirm: ROLE.kind === "baseline" && ROLE.changeVerdictThenConfirm, stormFlips: ROLE.kind === "tap-storm" ? ROLE.flips : 0, driver: makeDriver(i, g, videoRoleWindow), act: (id, d) => roleAct(i, id, d), confirmGate: () => confirmCut.gateOpen(Date.now()), onReportLanded: BOT?.telemetryTorture?.freezeAfterReportS ? () => freezeAndReopenAfterReport(i, page) : undefined, expectIsolation: BOT?.telemetryTorture?.id === "T9", previewHandoverMs: appClockWallMsFor(schedulingClock, handoverAt(g.gameAt)), setHostGesture: hostGestureIdentity(BOT) ? setHostGesture : undefined })))
  } finally {
    clearTimeout(confirmTimer)
    fireConfirmCut = null
    // on any failure too: what the bots saw and filed is the evidence
    await recoverPendingReopenedTelemetry("post-play")
    await Promise.all(recs.map(async (r, i) => {
      // Keep the sampler alive through payoff/draw/chest and settlement. Those
      // checkpoints can be acknowledged and retired before the final export;
      // stopping here would cap truth at the earlier report checkpoint.
      await r.exportDevLog()
      slotResults[i].adaptiveUpload = { page: await r.captureSendAdaptation() }
    }))
  }
  await awaitTelemetryRecovery()
  if (BOT?.telemetryTorture?.id === "T9") {
    const blackout = blackoutFaultWindow(networkController.snapshot().runs)
    const isolationGuardIndex = BOT.expect.findIndex((guard) => guard.kind === "text" && guard.never && guard.text === EXPECTED_NETWORK_ISOLATION_TEXT)
    for (const [i, result] of slotResults.entries()) {
      const isolationTimed = isolationWithinBlackout(results[i].isolationAtMs, blackout)
      const page = await localPageEvidence(i)
      result.guards = evaluateT9Guards(BOT, {
        rolesOn: process.env.E2E_ROLES === "1",
        page,
        wire: wireTaps[i].evidence,
        devlog: recorderFor(i).devlogEvidence(),
      }, { isolationWithinWindow: isolationTimed, faultRecovered: telemetryFaultRecovered })
      const isolationCopyProven = isolationGuardIndex >= 0 && result.guards[isolationGuardIndex]?.status === "pass"
      const isolated = results[i].url.includes("/connection-help") && isolationTimed && telemetryFaultRecovered && isolationCopyProven
      result.expectedOutcome = {
        kind: "network-isolation",
        isolated,
        faultRecovered: telemetryFaultRecovered,
        ...(results[i].isolationAtMs === null ? {} : { isolationAt: new Date(results[i].isolationAtMs!).toISOString() }),
        ...(blackout === null ? {} : { blackout: { startedAt: new Date(blackout.startedAtMs).toISOString(), recoveredAt: new Date(blackout.recoveredAtMs).toISOString() } }),
      }
      result.role.notes.push(`T9 isolation proof: route ${results[i].url.includes("/connection-help") ? "observed" : "missing"}, timing ${isolationTimed ? "valid" : "invalid"}, copy ${isolationCopyProven ? "seen" : "missing"}, harness restore ${telemetryFaultRecovered ? "observed" : "missing"}`)
      for (const guard of result.guards) console.log(`  GUARD ${guard.status.toUpperCase().padEnd(13)} player ${result.slot}: ${guard.description} - ${guard.evidence}`)
    }
  }
  await Promise.all(pages.map((p, i) => shot(p, `c-prize-draw-${slots[i].n}.png`)))
  record.c = results
  save()
  slotResults.forEach((sr, i) => {
    const r = results[i]
    Object.assign(sr, { taps: r.taps, clickErrors: r.clickErrors.length, confirmed: r.confirmed, reachedPrizeDraw: reachedEndOfPlay(r.url, game?.index) })
    sr.stages.c.notes.push(`${r.taps} taps, ${r.clickErrors.length} click errors, confirmed=${r.confirmed}`)
  })
  saveResults()
  summary(
    `\n### (c) play\n\n${results.map((r, i) => `- ${slots[i].user}: ${r.taps} taps, ${r.clickErrors.length} click errors, ${r.approvedTurns} tile-turn approvals, confirmed=${r.confirmed}, ended at ${r.url}`).join("\n")}`,
  )
  // what each bot's screen ended each turn on (diagnostics; (d) asserts on chain)
  const names = botNames()
  const tables = slots.map((sl) => uiVerdicts(sl.n, sl.oracle.account))
  const timelines = slots.map((sl) => uiRows(sl.n))
  videoRoleTables.splice(0, videoRoleTables.length, ...tables)
  slotResults.forEach((sr, i) => {
    const rows = timelines[i]
    const previous = new Map<string, string>()
    const markers: NonNullable<SlotResult["videoRoleProof"]>["markers"] = []
    for (const row of rows) for (const tile of row.tiles ?? []) {
      if (!tile.role || !row.t || previous.get(tile.id) === tile.role) continue
      previous.set(tile.id, tile.role)
      markers.push({ at: row.t, id: tile.id, role: tile.role })
    }
    const recapRow = recs[i].recap ?? rows.filter((row) => row.stage === "confirm" && row.t).at(-1)
    sr.videoRoleProof = {
      turns: tables[i].turns.map((turn) => ({
        ...turn,
        at: rows.filter((row) => row.turn === turn.turn && row.t).at(-1)?.t ?? "",
      })),
      markers,
      recap: (recapRow?.tiles ?? []).map((tile) => ({
        at: recapRow?.t ?? "",
        id: tile.id,
        role: tile.role,
        text: tile.text,
        verdict: tile.verdict,
        votable: tile.votable,
      })),
      report: recs[i].trail?.reports.at(-1)?.players,
    }
  })
  summary(
    `\n### (c) per-turn verdicts (each bot's tile timeline, at each turn's end)\n\n${tables
      .map((t, i) => `#### ${slots[i].user}: ${misses(t).length} missed\n\n${verdictMarkdown(t, names)}`)
      .join("\n\n")}`,
  )
  // the devLog vote trail: best-effort (its IndexedDB mirror can be empty)
  const none = { reports: [], taps: 0, sealed: 0, overrides: 0 }
  const devLog = recs.map((r, i) => ({ ...checkVotes(`player ${slots[i].n} devLog vote trail`, r.trail ?? none, true), note: r.devLogNote }))
  summary(
    `\n### (c) devLog vote trail (best-effort, not asserted)\n\n${voteTable(recs.map((r, i) => ({ user: slots[i].user, trail: r.trail ?? none })), names)}\n\n${devLog.map((c) => `- ${c.name}: ${c.note}; ${c.detail}`).join("\n")}`,
  )
  record.c = { results, tables: tables.map((t) => ({ ...t, missed: misses(t) })), devLog }
  // a role that was down missed turns, and the app seals those as rejects: (d) expects that, not all-Person
  slots.forEach((_, i) => (downBySlot[i] = downFor(i, g)))
  const downLines = downBySlot.flatMap((d, i) => (d ? [`- ${slots[i].user}: was down (${d.windows}); turns missed: ${d.missed.length ? d.missed.join(", ") : "none (every turn shows in its timeline)"}`] : []))
  if (downLines.length) summary(`\n### (c) turns missed while down\n\n${downLines.join("\n")}`)
  // WHO filed the report: the app's own "report built" line (filedBy), else the bot's own CTA tap
  slotResults.forEach((sr, i) => {
    const filedBy = recs[i].trail?.reports.at(-1)?.filedBy
    sr.confirmedBy = filedBy === "tap" ? "tap" : filedBy === "auto-confirm" ? "auto" : results[i].confirmed ? "tap" : null
    sr.role.notes.push(...results[i].roleNotes)
  })
  // THE ROLE MUST HAVE ACTED: each due action is a check, so a role that never fired fails the bot in (d)
  await survivalCounter
  await roundChannelGateWork
  const networkProof = await networkController.stop() // a network step still running (an outage sleeps) is counted when it ends, not before
  slotResults.forEach((result) => {
    if (result.adaptiveUpload) result.adaptiveUpload.network = networkProof
  })
  if (BOT?.name === "game259-lossy-video") {
    for (const [i, sr] of slotResults.entries()) {
      const checks = postOpenBurstChecks(sr.slot, recorderFor(i).telemetryGroundTruth().lines, networkProof.runs, {
        round: game259Round ?? 2,
        count: game259PeerCount ?? 5,
        ...(game259Peers ? { peerIds: game259Peers } : {}),
        baseProfile: "game259-lossy",
        burstS: 15,
        ...(i === 0 ? { requestId: `game259-round-${game259Round ?? 2}-burst` } : {}),
      })
      roleChecks.push(...checks)
      for (const check of checks) {
        sr.role.notes.push(check.detail)
        const line = `${new Date().toISOString()} ${check.status.toUpperCase()} ${check.name}: ${check.detail}`
        console.log(`  ${line}`)
        appendFileSync(join(OUT, "netem.log"), line + "\n")
      }
    }
  }
  // a missing confirm-tap beside a stall the APP measured (its long tasks, via the harness) is a freeze, not a failure (#341)
  const freezeOf = (i: number) => {
    let rows: ReturnType<typeof parseRows> = []
    try {
      rows = parseRows(readFileSync(join(OUT, `tiles-${slots[i].n}.jsonl`), "utf8"))
    } catch {
      /* no timeline: the turn is left out of the message */
    }
    return confirmFreeze({ trail: recs[i].trail, longTasks: recs[i].longTasks, acts: roleActs[i] ?? [], turnAt: (ms) => turnAtTime(rows, ms) })
  }
  const agreements = turnEntryAgreements(appTurnEntries, CLOCK_GROUP_SPREAD_BOUND_MS)
  if (slots.length > 1) {
    roleChecks.push(
      agreements.length === 0
        ? { name: "app clocks agree at turn entry", status: "unchecked", detail: "no turn was observed by at least two pages" }
        : {
            name: "app clocks agree at turn entry",
            status: agreements.every((entry) => entry.ok) ? "pass" : "fail",
            detail: agreements.map((entry) => `turn ${entry.turn}: ${entry.participants} pages, ${entry.spreadMs} ms spread`).join("; ") + ` (limit ${CLOCK_GROUP_SPREAD_BOUND_MS} ms)`,
          },
    )
  }
  // THE MID-GAME SWITCH (#541): the swap landed in its turn on the app's GameSource clock, the cut ran its length, the link came back
  const switchPlan = BOT ? switchPlanOf(BOT.network) : null
  if (switchPlan) {
    const switchTurn = switchAppClock ? appGameMoment(switchAppClock, appTiming({ ...g, reportEnds })).turn : null
    const gameEndMs = switchAppClock ? appClockWallMsFor(switchAppClock, gameEndAt(g)) : playDeadline - 60_000
    slotResults.forEach((sr, i) => {
      let rows: ReturnType<typeof parseRows> = []
      try {
        rows = parseRows(readFileSync(join(OUT, `tiles-${slots[i].n}.jsonl`), "utf8"))
      } catch {
        /* no timeline: the recovery check says so */
      }
      roleChecks.push(...verifySwitch(sr.slot, { plan: switchPlan, live: networkProof.live, runs: networkProof.runs, pageTurn: switchTurn, appClock: switchAppClock, anchor: switchAnchor, game: g, rows, gameEndMs }))
    })
  }
  slotResults.forEach((sr, i) => roleChecks.push(...verifyRoleActs(sr.slot, ROLE, roleActs[i] ?? [], networkProof, BOT?.clockJumps?.length ?? 0, roleProblems, clockHeldDue(BOT), whyNotActed(recs[i].trail, results[i].roleNotes), freezeOf(i))))
  if (BOT?.camera.muteLoop) {
    slotResults.forEach((sr, i) => {
      const proof = cameraMuteProofs[i]
      roleChecks.push(
        { name: `player ${sr.slot} activated camera tap`, status: proof.activatedTap ? "pass" : "fail", detail: proof.activatedTap ? "the tap-time getUserMedia was spared and its 5 s frame window completed" : "the activated tap never completed with frames" },
        { name: `player ${sr.slot} activation-ignored camera tap`, status: proof.ignoredTap ? "pass" : "fail", detail: proof.ignoredTap ? "the harness muted the second episode's tap-time track" : "the activation-ignored tap did not mute again" },
        { name: `player ${sr.slot} spent-tap restart notice`, status: proof.restartShown ? "pass" : "fail", detail: proof.restartShown ? "the existing restart banner appeared after still_muted" : "the restart banner did not appear" },
      )
    })
  }
  // HOST-CHAIN-LOST, LIVE from the app's own devLog (devlog-N.json, written by exportDevLog with each line's time): the report met
  // the cut, and the restart card never showed during the round. Unchecked, never a pass, when the evidence is missing.
  if (planHasHostChainCut(PROFILE_PLAN)) {
    // a cut that came back INCONCLUSIVE (netem.sh exit NETEM_INCONCLUSIVE_EXIT) is neither a pass nor a fail
    for (const why of networkController.inconclusive()) slotResults.forEach((sr) => roleChecks.push({ name: `player ${sr.slot} host-chain cut`, status: "inconclusive", detail: why }))
    slotResults.forEach((sr) => {
      if (HOST_CHAIN_NA) return void roleChecks.push({ name: `player ${sr.slot} host-chain-lost applies to this run`, status: "inconclusive", detail: HOST_CHAIN_NA })
      let lines: { ts: number; tag: string; message: string }[] = []
      try {
        lines = (JSON.parse(readFileSync(join(OUT, `devlog-${sr.slot}.json`), "utf8")) as { lines?: typeof lines }).lines ?? []
      } catch {
        /* no export: both checks say unchecked */
      }
      const su = cutWatches["sign-up"]
      if (su) roleChecks.push(signUpCutCheck(sr.slot, su, signUpTapAtMs, lines))
      roleChecks.push(reportAfterCutCheck(sr.slot, lines, confirmCut))
      roleChecks.push(cardNeverInRoundCheck(sr.slot, lines, pageRound.fromMs !== null && pageRound.toMs !== null ? { fromMs: pageRound.fromMs, toMs: pageRound.toMs + TURN_S * 1000 } : null))
    })
  }
  // NO TURN REPLAYED (#331): a page whose clock moved (a jump, a step, a reload, a freeze) never shows a turn again after a later one
  if (ROLE.kind === "reload" || ROLE.kind === "hidden-step" || ROLE.kind === "freeze" || BOT?.clockJumps?.length) {
    slotResults.forEach((sr) => {
      let rows: ReturnType<typeof parseRows> = []
      try {
        rows = parseRows(readFileSync(join(OUT, `tiles-${sr.slot}.jsonl`), "utf8"))
      } catch {
        /* no timeline */
      }
      const back = replayedTurns(rows)
      roleChecks.push(
        rows.length === 0
          ? { name: `player ${sr.slot} no turn replayed`, status: "unchecked", detail: "no tile timeline" }
          : { name: `player ${sr.slot} no turn replayed`, status: back.length ? "fail" : "pass", detail: back.length ? back.map((b) => `turn ${b.to} again after turn ${b.from} at ${b.at.slice(11, 19)} UTC`).join("; ") : `the turns the page showed never went back (${rows.filter((r) => r.turn != null).length} frames)` },
      )
    })
  }
  // THE VISIBLE FREEZE: the bot plays again within FREEZE_RESUME_TURNS of the turn it froze in, and plays the last turn
  if (ROLE.kind === "freeze") {
    slotResults.forEach((sr, i) => {
      const acts = roleActs[i] ?? []
      const from = acts.find((a) => a.id === "frozen")?.at
      const to = acts.find((a) => a.id === "thawed")?.at
      let rows: ReturnType<typeof parseRows> = []
      try {
        rows = parseRows(readFileSync(join(OUT, `tiles-${sr.slot}.jsonl`), "utf8"))
      } catch {
        /* no timeline */
      }
      const name = `player ${sr.slot} freeze: plays again within 3 turns of the freeze and plays the last turn`
      if (!from || !to || freezeTurn[i] === undefined) roleChecks.push({ name, status: "fail", detail: "the freeze never froze and thawed (see the role's acts)" })
      else {
        const r = freezeRecovery(rows, { from, to }, freezeTurn[i] as number, g.rounds * g.maxGroupSize)
        roleChecks.push({ name, status: r.ok ? "pass" : "fail", detail: r.detail })
      }
    })
  }
  // THE RELOAD's first descs go out on the saved floor: the store refuses none for channel priority over a statement at
  // or below the floor the old page saved. A refusal naming the page's own newer frame (two in flight on one channel) is
  // superseded, not the floor failing (store-wire.ts priorityRefusals; game 199 bot 16)
  if (ROLE.kind === "reload") {
    slotResults.forEach((sr, i) => {
      const at = (roleActs[i] ?? []).find((a) => a.id === "reloading")?.at ?? null
      const w = wireTaps[i].evidence
      const { stale, superseded } = at ? priorityRefusals(w, at) : { stale: [], superseded: [] }
      const own = superseded.length ? `; ${superseded.length} superseded by the page's own newer frame, first at ${superseded[0].at.slice(11, 19)} UTC` : ""
      const name = `player ${sr.slot} reload: no channelPriorityTooLow over a statement the saved floor covers`
      roleChecks.push(
        !at || w.frames === 0
          ? { name, status: "unchecked", detail: !at ? "the reload never happened" : "the host websocket tap read no frame" }
          : { name, status: stale.length ? "fail" : "pass", detail: stale.length ? `${stale.length} refusal(s), first at ${stale[0].at.slice(11, 19)} UTC (reloaded ${at.slice(11, 19)})${own}` : `none after ${at.slice(11, 19)} UTC${own}; ${wireSummary(w)}` },
      )
    })
  }
  slotResults.forEach((sr, i) => sr.role.notes.push(`host wire: ${wireSummary(wireTaps[i].evidence)}`))
  // THE STORM'S INTENT: the chain-report guard compares the filed report with the app's OWN devLog trail, so an odd flip-flop
  // that landed a NotPerson would sit in both and pass. The bot's intent is every votable co-player approved: its own tile
  // timeline must say so too (the flip-flops net to zero, the real tap approves)
  if (ROLE.kind === "tap-storm") {
    slotResults.forEach((sr, i) => {
      const v = stormVerdict(misses(tables[i]), unobserved(tables[i]), recs[i].trail ?? undefined)
      roleChecks.push({ name: `player ${sr.slot} tap-storm: every votable co-player ended approved`, status: v.status, detail: `${results[i].roleNotes.find((n) => /flip-flop/.test(n)) ?? "storm played"}; ${v.detail}` })
    })
  }
  if (ROLE.kind === "baseline" && ROLE.changeVerdictThenConfirm) {
    slotResults.forEach((sr, i) => {
      const trail = recs[i].trail
      roleChecks.push(
        { name: `player ${sr.slot} report filed by a TAP on the countdown`, status: sr.confirmedBy === "tap" ? "pass" : sr.confirmedBy === "auto" ? "fail" : "unchecked", detail: `confirmedBy=${sr.confirmedBy}` },
        ...(process.env.E2E_FLIP_VERDICT === "1"
          ? [{ name: `player ${sr.slot} verdict changed and restored (override lines in the devLog)`, status: (!trail || trail.reports.length === 0 ? "unchecked" : trail.overrides >= 2 ? "pass" : "fail") as Check["status"], detail: `${trail?.overrides ?? "?"} override(s); bot flipped ${results[i].overridesMade}` }]
          : []),
      )
    })
  }
  saveResults()
  save()
  // a page handed to the chest has played: whether its missing report could have counted is (d)'s question
  chestEnded.splice(0, chestEnded.length, ...results.map((r) => r.url.includes("/chest")))
  slotResults.forEach((sr, i) => {
    if (chestEnded[i]) sr.stages.c.notes.push(`ended on ${results[i].url}: the app handed over with no report counted; (d) judges it against the chain`)
  })
  saveResults()
  for (const r of results) {
    if (BOT?.telemetryTorture?.id === "T9") expect(r.url).toMatch(/\/connection-help/)
    else expect(endOfPlayAccepted(r.url, game?.index), `ended at ${r.url}: not /prize-draw, /chest or this game's /collectables`).toBe(true)
  }
  played = true
  } finally {
    cancelRoundChannelGates = true
    await roundChannelGateWork
    // A failed play must not let a future pre-game timer re-shape the runner or
    // append evidence after the result was written.
    beforeGameSteps.cancel()
    // Settlement is chain I/O, not part of the network persona. Restore the
    // runner after every play outcome so loss/latency cannot consume the
    // settlement budget and prevent guards or artifacts from being written.
    // The helper retries and records cleanup failures without replacing the
    // primary play result. boot.mts repeats clear in its own finalizer.
    const cleanup = await clearNetworkAfterPlay(networkController, (message) => {
      console.error(`  ${message}`)
      roleProblems.push(message)
      slotResults.forEach((result) => result.role.notes.push(message))
    })
    if (!cleanup.ok) roleChecks.push({
      name: "post-play network cleanup",
      status: "fail",
      detail: `terminal cleanup failure after ${cleanup.failures.length} attempts: ${cleanup.failures.at(-1) ?? "unknown error"}`,
    })
  }
})

test("(d) settlement: a report per player, the game settled, scores and collectables", async () => {
  skipIf(EXPECTED_NO_JOIN !== null, `${EXPECTED_NO_JOIN}: stages (b)–(d) are not run`)
  skipIf(BOT?.telemetryTorture?.id === "T9" && slotResults.every((result) => result.expectedOutcome?.kind === "network-isolation" && result.expectedOutcome.isolated && result.expectedOutcome.faultRecovered), "T9 expected the 120 s blackout to exceed isolation grace; telemetry recovery was observed, so no report/settlement is expected")
  skipIf(!played || !watch || !game, "(d) settlement: the game was not played in (c)")
  const g = game!
  const w = await watch!
  const reportChecks = w.reportChecks as Check[]
  const settled = w.settled as Check
  // A BOT THE APP HANDED TO THE CHEST filed no report. The chain says whether one could still have counted: an early
  // close (GameEnded before report_ends) means it was voted out already, and that is inconclusive; anything else stays
  // red (early-close.ts). The report check and the vote oracle both take the verdict, so neither fails a moot report.
  const earlyClose = slots.map((sl, i) => {
    if (!chestEnded[i] || reportChecks[i]?.status === "pass") return null
    let lines: TrailLine[] = []
    try {
      lines = (JSON.parse(readFileSync(join(OUT, `devlog-${sl.n}.json`), "utf8")) as { lines?: TrailLine[] }).lines ?? []
    } catch {
      /* no export: the check says the trail never explains the chest */
    }
    const c = earlyCloseCheck({ slot: sl.n, reported: false, ended: (w.endedAt as { block: number; atS: number | null } | null | undefined) ?? null, reportEnds: g.reportEnds, lines, playEndsS: gameEndAt(g) })
    reportChecks[i] = { ...c, name: reportChecks[i]?.name ?? c.name }
    return c
  })
  let results: unknown = null
  try {
    results = chainRead("results", "--game", String(g.index), "--rounds", String(g.rounds), "--accounts", accounts.join(","))
  } catch (error) {
    results = { error: String(error) }
  }
  // the oracle for the votes: each bot's filed Game.report, decoded from chain
  const reportEvents = w.reports as ReportEvent[]
  // only this process's players' reports are asserted, so only their blocks are decoded
  const blocks = [...new Set(reportEvents.filter((e) => e.game_index === g.index && e.block !== undefined && accounts.includes(e.who.value)).map((e) => e.block as number))]
  let votes: { reports: FiledReport[]; errors: { who: string; block: number; error: string }[] } = { reports: [], errors: [] }
  try {
    votes = chainReadFor(CHAIN_READ_PARENT_TIMEOUT_MS.votes, "votes", "--game", String(g.index), "--accounts", accounts.join(","), ...(blocks.length ? ["--blocks", blocks.join(",")] : []))
  } catch (error) {
    votes.errors.push({ who: "*", block: 0, error: String(error).slice(0, 300) })
  }
  // the game's roster as the chain tells it: every other player is masked before anything prints it
  PRIVACY.seeIn(JSON.stringify({ results, votes, reportEvents }))
  const voteChecks = slots.map((sl, i): Check => {
    const name = `player ${sl.n} filed each co-player verdict implied by decoded-video roles (decoded from chain)`
    const moot = earlyClose[i]
    if (moot?.status === "inconclusive") return { name, status: "inconclusive", detail: `no report to decode: ${moot.detail}` }
    return checkChainVotes(name, votes.reports.find((r) => r.who === sl.oracle.account), allRunBotAccounts, DIAGNOSE, downBySlot[i], videoRoleTables[i])
  })
  summary(
    `\n### (d) filed votes, decoded from each Game.report extrinsic${DIAGNOSE ? " (E2E_DIAGNOSE=1: misses are warnings)" : ""}\n\n${chainVoteTable(votes.reports, botNames())}\n\n${[
      ...voteChecks.map((c) => `- ${c.status}: ${c.name} (${c.detail})`),
      ...votes.errors.map((e) => `- decode error: ${e.who} #${e.block}: ${e.error}`),
    ].join("\n")}`,
  )
  record.d = { watch: w, results, votes, voteChecks }
  save()
  const players = (results as { players?: { address: string; score: unknown; lastGame: number | null; collectables: { hash: string | null; state: string }[] }[] }).players ?? []
  summary(
    `\n### (d) settlement, game ${g.index}${w.timedOut ? " (TIMED OUT)" : ""}\n\n${[...reportChecks, settled].map((c) => `- ${c.status}: ${c.name} (${c.detail})`).join("\n")}\n\n| account | score | collectables |\n|---|---|---|\n${players
      .map((p) => `| ${p.address} | ${String(p.score)} | ${p.collectables.map((c) => `${c.hash ? c.hash.slice(0, 12) : "no hash"} (${c.state})`).join(", ") || "none"} |`)
      .join("\n")}`,
  )
  slotResults.forEach((sr, i) => {
    sr.reportSeen = reportChecks[i]?.status === "pass"
    if (earlyClose[i]?.status === "inconclusive") sr.reportClosedEarly = earlyClose[i]!.detail
    sr.settled = settled.status === "pass"
    sr.lastAttendedGame = players.find((player) => player.address === accounts[i])?.lastGame ?? null
    sr.othersReported = othersReported(reportEvents, g.index, accounts[i])
    // who the bot played with, from the roster the votes read decoded (gather.ts classifyGroup resolves them to profiles)
    sr.groups = groupsOfReport(votes.reports.find((r) => r.who === accounts[i]))
    sr.stages.d.notes.push(`report seen=${sr.reportSeen}, settled=${sr.settled}, ${sr.othersReported} other account(s) reported (informational)`)
    summary(`\n- other accounts that reported in game ${g.index}, seen by ${sr.username ?? sr.slot}: ${sr.othersReported} (informational, not asserted)`)
  })
  // the profile's guards that need no Sentry: text (the page) and chain-report (the chain against the vote trail)
  if (BOT) {
    for (const [i, sr] of slotResults.entries()) {
      const page = await localPageEvidence(i)
      sr.guards = evaluateGuards(BOT, {
        rolesOn: process.env.E2E_ROLES === "1",
        page,
        wire: wireTaps[i].evidence,
        devlog: recorderFor(i).devlogEvidence(),
        chain: { account: accounts[i], filed: votes.reports.find((r) => r.who === accounts[i]), trail: recorderFor(i).trail, trailNote: recorderFor(i).devLogNote, oracle: voteChecks[i] },
      })
      for (const gr of sr.guards) console.log(`  GUARD ${gr.status.toUpperCase().padEnd(13)} player ${sr.slot}: ${gr.description} - ${gr.evidence}`)
    }
  }
  // inconclusive acts ride in the result, counted apart from passes and fails by the gather job
  for (const sr of slotResults) sr.inconclusive = [...voteChecks, ...roleChecks].filter((c) => c.status === "inconclusive" && c.name.startsWith(`player ${sr.slot} `)).map((c) => ({ name: c.name, detail: c.detail }))
  saveResults()
  expectChecks([...reportChecks, settled])
  expectChecks(voteChecks)
  expectChecks(roleChecks)
})

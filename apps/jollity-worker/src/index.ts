// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The chat worker of Jollity, the executable the host runs beside the app to
 * own the chat surface of the product.
 *
 * The room follows the chat design whose pieces live in src/card: the eight
 * rules on the first open, then one card per game whose face
 * `gameSlot()` decides and `gameCardNode()` draws, from the next game through
 * sign-up to the results and what is left to collect. The worker feeds that
 * design from the People chain through chain.ts, and from what the app reports
 * the player did with the results under SEEN_KEY.
 *
 * Where a host gives a product less than the design assumes, the worker says
 * so rather than faking it. The rules go out as plain text, since iOS draws no
 * rich message from a product. The last five minutes carry their countdown on
 * the card, unless the host holds the reminder of that game and docks its own
 * pill over the thread, as iOS and Android do. Register signs up from
 * the chat through signup.ts, with a ticket the host signs for every prize
 * draw, and the card shows the player registered once the sign-up is on the
 * wire.
 *
 * Every outcome is drawn on the card. workerLog is for developers, and anything that
 * only logs is a button that does nothing from the side of the player.
 *
 * Around a game the player is registered for, the poll also keeps a TURN pass
 * in host storage, so the app opens its mesh with one even when it opens late.
 */
import {
  ACTION_OPEN_GAME,
  ACTION_REGISTER,
  ACTION_TURN_ON_CAMERA,
  ACTION_TUTORIAL,
  ACTION_USERNAME,
  ACTION_STASH,
  IDLE_UI,
  INTRO,
  MESSAGE_GAME_CARD,
  MESSAGE_INTRO,
  MESSAGE_WELCOME,
  button,
  card,
  cardCopy,
  gameCardNode,
  gameSlot,
  introRuleByPicture,
  introRuleNode,
  spacer,
  text,
  type CardUi,
  type GameResults,
  type GameSlot,
  type IntroRule,
  type RenderNode,
  type SlotGame,
  type SlotInput,
  type SlotPrize,
  type Votes,
} from "./card"
import {
  HOST_REMINDER_KEY,
  turnPassKey,
  deviceUniquenessBackendUrl,
  isTurnPass,
  turnPassLeftMs,
  stashProduct,
  personhoodProduct,
  productAccount,
  signupAccountIndex,
  CAMERA_KEY,
  type GameEngine,
} from "@jollity/protocol"
import { gameRegistrationStore, type GameRegistration } from "@individuality/shared-records"
import {
  ASK_UNDER_WAY_MS,
  askUnderClaim,
  joinAtMs,
  askUnderWay,
  type HostReminder,
  type HostReminderStore,
} from "@individuality/sign-up"
import { HOST_PILL_LEAD_S, JOIN_LEAD_S, hostPillUp } from "@individuality/sign-up/reminder"
import { GAME_REGISTRATION_KEY, liveGameRegistration } from "@individuality/shared-records"
import {
  spaPage,
  ANNOUNCED_KEY,
  BACKFILL_KEY,
  DOCKED_KEY,
  BOT_ICON,
  BOT_ID,
  BOT_NAME,
  CallDeadlineError,
  GAMES_KEY,
  INTRO_KEY,
  IS_GAME_PRODUCT,
  NOTIFICATIONS_KEY,
  RECAP_KEY,
  REMINDER_PATH,
  ROOM_ICON,
  ROOM_ID,
  ROOM_NAME,
  SEEN_KEY,
  SPA_URL,
  TUTORIAL_KEY,
  UNSEEN,
  idsOf,
  readJSON,
  startWorkerHeartbeat,
  tryWriteJSON,
  within,
  workerLog,
  writeJSON,
  type Scheduled,
  type Seen,
  type SeenGame,
  type StoredOutcome,
} from "./state"
import { connect, connectAssetHub, playerAddress, readAttendance, readClaimed, readCollectables, readGame, readOutcome, readNameReady, readStanding, readEarned, readPastGames, readPrize, type ChainRead, type Standing, type PastGames, type People, type RunningGame } from "./chain"
import { decPayload, drawsSlideToConfirm, encPayload, toWire, type GameCardData, type IntroData } from "./renderer"
import { runMigrations } from "./migrations"
import { learnUsername, readNameSet } from "./username"
import { createSignup, reportInterruptedSignup, signupEngine, type Signup, type SignupEngine, type SignupNeed, type SignupState } from "./signup"
import { createClaims, type Claims } from "./claim"
import { linkNameFromChat } from "./name-link"
import type { NameGate } from "@individuality/name-link"
import { createNameGate } from "./name-gate"
import {
  beginChatActivity,
  chatCount,
  chatFailure,
  chatMeasure,
  describeError,
  installGlobalErrorTelemetry,
  isMalformedFrameError,
  setChatGame,
  setChatHost,
  setChatUser,
} from "./telemetry"
import {
  MESSAGE_MEMBERSHIP,
  applyMembershipObservation,
  applyMembershipSent,
  isMemberStanding,
  membershipLineOf,
  membershipTree,
  planMembershipLines,
  sanitizeMembershipRecord,
  standingOf,
} from "./membership/chat"
import { DAILY_DOLLAR_TICK_MS, MESSAGE_DAILY_DOLLAR, createDailyDollar, humanityPocketLink, type DailyDollar } from "./daily-dollar/worker"
import { MESSAGE_DD_SCRATCH, createWorkerScratchCard } from "./daily-dollar/scratch-worker"
import { artWellFor } from "./host-art-well"
import {
  createWorkerHost,
  footerMessageId,
  type ActionListener,
  type RenderNode as WireNode,
  type RenderRequest,
  type RoomFooter,
  type Unsubscribe,
  type WorkerHost,
} from "./host"

const TAG = "[jollity-chat]"
// A card held this long is a blank card to the player.
const HELD_REPORT_MS = 10_000
const POLL_MS = 15_000
const MIN = 60_000
// A membership read is four storage reads, and the card only needs it to know
// whether a missed game pauses one, so once a minute is enough.
const MEMBER_EVERY_TICKS = 4
// An open card draws every second for its countdown, and reads its game record
// again only every few ticks.
const CARD_SYNC_TICKS = 3
// The native app's welcome pauses this long between two rules.
const INTRO_PAUSE_MS = 2_000
const PERMISSION_WAIT_MS = 30_000
// A booking that failed, such as under a denied permission, is tried again
// this much later rather than on every poll.
const BOOKING_RETRY_MS = 10 * 60_000
const ANSWER_POLL_MS = 1_000
let hostInfoReady: Promise<void> = Promise.resolve()
// The sign-up is a slide only once the host says it draws one, so a card drawn
// before the answer, or for any older host, is the I'll be there button.
let slideRegister = false
const MALFORMED_FRAME_DETAIL_LIMIT = 5
const malformedFrameCounts = new Map<string, number>()

/** Count a message decode refusal after the native host identity has settled. */
function countMalformedFrame(error: unknown, messageType: string): void {
  if (!isMalformedFrameError(error)) return
  const count = (malformedFrameCounts.get(messageType) ?? 0) + 1
  malformedFrameCounts.set(messageType, count)
  void hostInfoReady.then(() => {
    if (count <= MALFORMED_FRAME_DETAIL_LIMIT) {
      chatCount("chat.message.malformed_frame", { message_type: messageType }, { key: messageType, detail: { error: describeError(error) } })
    } else if (count === MALFORMED_FRAME_DETAIL_LIMIT + 1) {
      chatCount(
        "chat.message.malformed_frame.suppressed",
        { message_type: messageType, after: String(MALFORMED_FRAME_DETAIL_LIMIT) },
        { key: messageType, once: true },
      )
    }
  })
}
// A registration already open is announced this soon after the worker sees it.
const OPENS_DELAY_MS = 5_000
// Let the player finish the previous game's draw and chest before announcing
// that registration for the next one is open.
const AFTER_GAME_OPENS_DELAY_MS = 10 * MIN
const WORKER_STARTED_AT = Date.now()
console.log(TAG, "worker module loaded")

/** The card the worker posted before the room opened with the rules, still drawn where it was posted. */
export function welcomeCard(): RenderNode {
  return card([
    text("Jollity", { style: "headline.large", color: "fg.primary" }),
    spacer(6),
    text(
      "Copy the host's gesture on camera to play. I'll tell you when a game is on and share the results.",
      { style: "body.medium.regular", color: "fg.secondary" },
    ),
    spacer(14),
    button("How it works", ACTION_TUTORIAL),
  ])
}

/** A card posted before the worker read the chain, whose game it can no longer name. */
export function endedCard(): RenderNode {
  return card([text("This game has ended.", { style: "body.medium.regular", color: "fg.secondary" })])
}

/**
 * What `gameSlot()` is asked about the card of the game at `gamePlayTime`, from
 * the latest chain read, the games the worker saw running, the stored outcome
 * and what the app says the player did. It is pure, so the whole morph of a
 * card is testable without a host or a clock.
 */
export function slotInputFor(
  data: GameCardData,
  read: (ChainRead & { gamesToMembership?: number | null }) | null,
  games: SeenGame[],
  outcome: StoredOutcome | null,
  seen: Seen,
  nowMs: number,
  registeredBefore = false,
  readBefore: ChainRead | null = null,
): SlotInput {
  const nowSeconds = Math.floor((nowMs + (read?.clockOffsetMs ?? 0)) / 1000)
  const known = games.find((game) => game.gamePlayTime === data.gamePlayTime)
  const running = read?.running?.gamePlayTime === data.gamePlayTime ? read.running : null
  const slotGame = (status: SlotGame["status"]): SlotGame => ({
    id: String(running?.index ?? known?.index ?? outcome?.gameIndex ?? data.gamePlayTime),
    status,
    startAt: data.gamePlayTime,
  })
  const member = (known?.memberBefore ?? outcome?.memberBefore ?? read?.member) === true
  const gamesToMembership = read?.gamesToMembership

  if (outcome) {
    return {
      game: slotGame("finished"),
      registered: known?.registered === true || outcome.registered === true || outcome.results !== null,
      results: outcome.results && { ...outcome.results, seen },
      member,
      nowSeconds,
      cancelled: outcome.cancelled,
      gamesToMembership: outcome.gamesToMembership,
      paused: outcome.paused,
      missesLeft: outcome.missesLeft,
      reported: seen.report === true || outcome.reported === true,
      earned: outcome.earned,
    }
  }

  if (running) {
    // Registration is monotone for one game. A stale/reset row, or one the
    // chain could not read, cannot undo either the stored fact or what this
    // card already drew from an earlier read.
    const registered = running.registered === true || known?.registered === true || registeredBefore
    // The chain does not say when a draw starts taking entries, so a closed one
    // holds the sign-up at Opening soon with no time to open at, as native does.
    // A player already signed up is past that gate.
    const drawClosed = running.drawOpen === false && !registered
    const window = { opensAt: drawClosed ? Infinity : 0, closesAt: running.registrationEnds }
    const gameAfter = read?.upcoming[0]?.gamePlayTime
    const base = {
      registered,
      results: null,
      member,
      nowSeconds,
      window,
      gamesToMembership,
      resultsAt: running.reportingEnds,
      ...(gameAfter !== undefined && gameAfter > data.gamePlayTime ? { nextGameAt: gameAfter } : {}),
    }
    switch (running.phase) {
      case "registration":
      case "shuffle":
        return { ...base, game: slotGame("scheduled") }
      case "reporting": {
        // The phase runs well past the last turn, and a latecomer can only join
        // until then, so after it the card waits for the results.
        const status = nowSeconds < running.gamePlayTime ? "scheduled" : nowSeconds < running.playEnds ? "active" : "reporting"
        return { ...base, game: slotGame(status) }
      }
      case "settling":
        return { ...base, game: slotGame("reporting") }
      case "cancelled":
        return { ...base, game: slotGame("scheduled"), cancelled: true }
    }
  }

  const counting = previousPending(read, games, data.gamePlayTime, nowSeconds) ? { previousPending: true } : {}
  const upcoming = read?.upcoming.find((game) => game.gamePlayTime === data.gamePlayTime)
  if (upcoming) {
    return {
      game: slotGame("scheduled"),
      registered: false,
      results: null,
      member,
      nowSeconds,
      gamesToMembership,
      window: { opensAt: upcoming.registrationStarts, closesAt: upcoming.registrationEnds },
      ...counting,
    }
  }

  const registered = known?.registered === true
  if (data.gamePlayTime > nowSeconds) {
    return {
      game: slotGame("scheduled"),
      registered,
      results: null,
      member,
      nowSeconds,
      gamesToMembership,
      cancelled: offTheSchedule(data.gamePlayTime, read, readBefore),
      ...counting,
    }
  }
  return { game: slotGame("reporting"), registered, results: null, member, nowSeconds, gamesToMembership }
}

function previousPending(read: ChainRead | null, games: SeenGame[], gamePlayTime: number, nowSeconds: number): boolean {
  const running = read?.running
  if (!running || running.gamePlayTime === gamePlayTime) return false
  const registered = running.registered === true || games.some((game) => game.gamePlayTime === running.gamePlayTime && game.registered === true)
  const played = running.phase === "settling" || (running.phase === "reporting" && nowSeconds >= running.playEnds)
  return registered && played
}

/**
 * Whether two chain reads in a row list the game nowhere, which is when the chain took it off the schedule.
 *
 * One such read can be a gap in the read rather than the end of the game.
 */
function offTheSchedule(gamePlayTime: number, read: ChainRead | null, readBefore: ChainRead | null): boolean {
  const lists = (chain: ChainRead) => chain.running?.gamePlayTime === gamePlayTime || chain.upcoming.some((game) => game.gamePlayTime === gamePlayTime)
  return read !== null && readBefore !== null && !lists(read) && !lists(readBefore)
}

let latest: (ChainRead & { nameSet: boolean; nameReady: boolean; standing?: Standing | null; gamesToMembership?: number | null }) | null = null
let readBeforeLatest: ChainRead | null = null
// A chain read can be consumed by the sign-up cleanup and the poll. Keep its
// identity so those two paths cannot count one false result as two reads.
let readObservation = 0
let latestObservation: number | undefined
// The votes on the player in the game the chain still holds, from the last attendance read that answered.
let pendingVotes: { gameIndex: number; votes: Votes } | null = null
// The game whose reminder the host holds, whose pill takes the place of its docked card.
let hostRemindedGame: number | null = null
// The index of the game a sign-up from the chat is under way for, which the
// polls take as registered so they keep the reminders the sign-up asked for.
let joiningGame: number | null = null
// A live card drawn before the first chain read would guess its face from the
// clock alone, so cards wait until the first poll has run, read or not.
let firstPollDone = false

function renderWelcomeCardHandler(
  host: WorkerHost,
  send: (node: WireNode) => void,
  onAction: (cb: ActionListener) => Unsubscribe,
): Unsubscribe {
  send(toWire(welcomeCard()))
  return onAction((actionId) => {
    if (actionId === ACTION_TUTORIAL) void openTutorial(host)
  })
}

/** The picture rule a payload names, or null for one that names none, so the host always gets a node. */
export function introRuleOf(payload: Uint8Array): Required<IntroRule> | null {
  try {
    return introRuleByPicture(decPayload<Partial<IntroData>>(payload)?.image)
  } catch {
    return null
  }
}

function renderIntroHandler(host: WorkerHost, req: RenderRequest, send: (node: WireNode) => void): Unsubscribe | undefined {
  const rule = introRuleOf(req.payload)
  if (!rule) {
    chatFailure("chat-render-failed", "intro-payload", { message: req.messageId })
    send({ tag: "Nil" })
    return undefined
  }
  const well = artWellFor(host)
  const draw = (): void => send(toWire(introRuleNode(rule, well.current())))
  draw()
  return well.onChange(draw)
}

// The faces of a player the chain has registered. The app and the chat can
// sign up together, and only one of them lands, so the chat's own failure is
// no news on these.
const REGISTERED_SLOTS: ReadonlySet<string> = new Set(["registered", "starting", "pending", "results"])
const CAMERA_LINE_SLOTS: ReadonlySet<string> = new Set(["register", "registered"])

export type HumanitySignup = "registering" | "registered" | null

/** Why read Humanity's record at all: the chat's own 15 s poll offers Register all through Humanity's signing, and for a poll, or a whole stall, after it says Registered. */
export function humanitySignup(record: GameRegistration | null, index: number | undefined): HumanitySignup {
  if (record === null || index === undefined || record.gameIndex !== index) return null
  if (record.phase === "registering") return "registering"
  if (record.phase === "sent" || record.phase === "registered") return "registered"
  return null
}

export function signupUiWithHumanity(
  state: SignupState,
  humanity: HumanitySignup,
  gameIndex: number | undefined,
  slotKind?: string,
  nameUnowned = false,
): CardUi {
  const ui = signupUi(state, gameIndex, slotKind, nameUnowned)
  return ui === IDLE_UI && humanity === "registering" ? { busy: true, notice: null } : ui
}

/**
 * What the card of `gameIndex`, drawn as `slotKind`, shows of the sign-up from the chat.
 *
 * A sign-up that stopped on an unowned username shows only while the name gate
 * still finds it unowned, since its Register is off and a player who set the
 * username up would otherwise have no way to sign up.
 */
export function signupUi(state: SignupState, gameIndex: number | undefined, slotKind?: string, nameUnowned = false): CardUi {
  if (state.kind === "idle" || state.gameIndex !== gameIndex) return IDLE_UI
  if (state.kind === "failed" && state.needs === "username" && !nameUnowned) return IDLE_UI
  if (state.kind === "failed" && slotKind !== undefined && REGISTERED_SLOTS.has(slotKind)) return IDLE_UI
  if (state.kind === "failed" && slotKind === "closed" && state.needs) return IDLE_UI
  switch (state.kind) {
    case "busy":
      return { busy: true, notice: null }
    case "sent":
      return IDLE_UI
    case "failed":
      return {
        busy: false,
        notice: {
          text: state.notice,
          tone: "fg.error",
          ...(state.needs === "notifications" && { blocked: true as const }),
          ...((state.needs === "username" || state.needs === "update") && { registerOff: true }),
        },
      }
  }
}

function renderGameCardHandler(
  host: WorkerHost,
  signup: Signup,
  claims: Claims,
  req: RenderRequest,
  send: (node: WireNode) => void,
  onAction: (cb: ActionListener) => Unsubscribe,
): Unsubscribe | void {
  let payload: Partial<GameCardData>
  try {
    payload = decPayload<Partial<GameCardData>>(req.payload)
  } catch (error) {
    chatFailure("chat-render-failed", "game-card-payload", { message: req.messageId, error: describeError(error) })
    send(toWire(endedCard()))
    return
  }
  if (typeof payload.gamePlayTime !== "number") {
    send(toWire(endedCard()))
    return
  }
  const data: GameCardData = { gamePlayTime: payload.gamePlayTime }
  let games: SeenGame[] = []
  let outcome: StoredOutcome | null = null
  let seen: Seen = UNSEEN
  let camera: CardUi["camera"]
  let cameraAsk: Promise<void> | undefined
  let cameraAnswers = 0
  let cameraRead = false
  let cameraReading = false
  let ticks = 0
  // A finished card drawn before its stored outcome is read would flash missed.
  let synced = false
  let disposed = false
  let lastSent = ""
  // GAMES_KEY is the durable source. This covers the same rule in memory when
  // its write failed after this card had already drawn a confirmed seat. A
  // card redraw or worker restart during settling still needs that durable
  // record; the in-memory fallback deliberately does not cross card lifetimes.
  let registeredOnCard = false

  let held = ""
  let heldSince: number | null = null
  let shownSlot: string | null = null
  let openFailed: string | null = null
  let shownIndex: number | undefined
  const requestedAt = Date.now()
  let firstDrawReported = false

  const opening = (opened: Promise<boolean>, notice: string) =>
    void opened.then((ok) => {
      openFailed = ok ? null : notice
      lastSent = ""
      draw()
    })
  const draw = () => {
    if (disposed) return
    if (!synced || (!firstPollDone && outcome === null)) {
      const reason = !synced ? "storage not read yet" : "first chain poll not done"
      if (reason !== held) console.log(TAG, `card ${req.messageId} held: ${reason}`)
      held = reason
      heldSince ??= Date.now()
      if (Date.now() - heldSince > HELD_REPORT_MS) chatCount("chat.card.held", { reason }, { key: `${req.messageId}:${data.gamePlayTime}:${reason}`, once: true })
      return
    }
    heldSince = null
    const index = indexOf()
    if (index !== shownIndex) {
      shownIndex = index
      openFailed = null
    }
    const state = signup.state()
    const humanity = humanitySignup(humanityRecord, index)
    const sent = (state.kind === "sent" && state.gameIndex === index) || humanity === "registered"
    // Only a confirmed chain read enters the card-local fallback. The sent
    // state is optimistic UI and must disappear again if the transaction
    // fails before the chain observes the seat.
    if (latest?.running?.gamePlayTime === data.gamePlayTime && latest.running.registered === true) registeredOnCard = true
    const input = {
      ...slotInputFor(data, latest, games, outcome, seen, Date.now(), registeredOnCard, readBeforeLatest),
      ...(sent ? { registered: true } : {}),
      ...(pendingVotes && pendingVotes.gameIndex === index ? { votes: pendingVotes.votes } : {}),
    }
    const claim = index === undefined ? undefined : claims.state(index)
    const slot = claimedSlot(gameSlot(input), claim?.kind === "claimed")
    // A face that can draw the camera line would flash without it before its first read.
    if (CAMERA_LINE_SLOTS.has(slot.kind) && !cameraRead) {
      if (!cameraReading) void readCamera().then(draw)
      return
    }
    if (slot.kind !== shownSlot) {
      shownSlot = slot.kind
      chatCount("chat.card.shown", { slot: slot.kind, game: index === undefined ? "unknown" : String(index) }, { key: slot.kind })
    }
    const ui = signupUiWithHumanity(state, humanity, index, slot.kind, nameGateFor(host).unowned())
    const shown = ui.notice || openFailed === null ? ui : { ...ui, notice: { text: openFailed, tone: "fg.error" as const } }
    const node = toWire(
      gameCardNode(slot, { ...shown, busy: shown.busy || cameraAsk !== undefined, camera }, deviceNowSeconds(), {
        docked: req.messageId === footerMessageId(ROOM_ID),
        slide: slideRegister,
        nameSet: latest?.nameSet ?? false,
        nameReady: latest?.nameReady ?? false,
        claim: {
          busy: claim?.kind === "busy",
          failure: claim?.kind === "failed" ? claim.failure : null,
          ...(claim?.kind === "failed" ? { refusal: claim.detail } : {}),
        },
      }),
    )
    const encoded = JSON.stringify(node)
    if (encoded === lastSent) return
    lastSent = encoded
    if (!firstDrawReported) {
      firstDrawReported = true
      chatMeasure("chat.card.first_draw_ms", Date.now() - requestedAt, { slot: slot.kind })
    }
    console.log(TAG, `card ${req.messageId} drawn as ${slot.kind}`)
    send(node)
  }

  const indexOf = () =>
    outcome?.gameIndex ??
    games.find((game) => game.gamePlayTime === data.gamePlayTime)?.index ??
    (latest?.running?.gamePlayTime === data.gamePlayTime ? latest.running.index : undefined)

  const readCamera = async () => {
    cameraReading = true
    const answersBefore = cameraAnswers
    const stored = await readJSON<string>(host, `${CAMERA_KEY}:${productAccount()}`)
    cameraReading = false
    cameraRead = true
    // A read that began before an answer holds what the answer replaced.
    if (stored !== undefined && cameraAnswers === answersBefore) camera = stored === "off" ? "off" : undefined
  }

  // A failed read keeps what the card last read, and a card whose outcome was
  // never read stays undrawn rather than guess at it.
  let outcomeUnread = false
  let counting = false
  let syncing = false
  const humanityStore = humanityRecords(host)
  let humanityRecord: GameRegistration | null = null
  let humanityReadFailed = false
  const readHumanityRecord = async () => {
    try {
      humanityRecord = await humanityStore.read()
      humanityReadFailed = false
    } catch (error) {
      if (!humanityReadFailed) chatCount("chat.card.humanity_record_failed", {}, { once: true, detail: { error: describeError(error) } })
      humanityReadFailed = true
    }
  }
  const sync = async () => {
    if (syncing) return
    syncing = true
    const finishActivity = beginChatActivity("card-draw")
    try {
      const storedGames = await readJSON<SeenGame[]>(host, GAMES_KEY)
      if (storedGames !== undefined) games = storedGames ?? []
      const storedOutcome = await readJSON<StoredOutcome>(host, `${RECAP_KEY}:${data.gamePlayTime}`)
      if (storedOutcome === undefined) {
        if (!outcomeUnread) console.log(TAG, `card ${req.messageId} could not read its outcome from storage`)
        outcomeUnread = true
        return
      }
      outcomeUnread = false
      outcome = storedOutcome
      const index = indexOf()
      const storedSeen = index === undefined ? null : await readJSON<Seen>(host, `${SEEN_KEY}:${index}`)
      if (storedSeen !== undefined) seen = storedSeen ?? UNSEEN
      await readHumanityRecord()
      if (cameraRead && shownSlot !== null && CAMERA_LINE_SLOTS.has(shownSlot)) await readCamera()
      // A card drawn before the poll has counted its game asks itself, on the
      // same retry cadence, which also covers a game the poll no longer tracks.
      if (outcome && needsCount(outcome, seen) && outcome.gameIndex !== undefined && !counting) {
        counting = true
        void countEarned(host, outcome.gameIndex, `${RECAP_KEY}:${data.gamePlayTime}`).finally(() => (counting = false))
      }
      synced = true
      draw()
      // A new member card changes once more, when the player sets the full username.
      if (settledCard(outcome, seen) && (latest?.nameSet || !outcome?.results?.membership.justBecameMember)) clearInterval(interval)
    } finally {
      finishActivity()
      syncing = false
    }
  }

  // A tap during an ask joins it, so a Register tap still signs up after the ask, not beside it.
  const askForCamera = () => {
    if (cameraAsk) return cameraAsk
    cameraAsk = askCamera(host)
      .then((answer) => {
        if (answer === undefined) return
        cameraAnswers += 1
        camera = answer === "off" ? "off" : undefined
      })
      .finally(() => {
        cameraAsk = undefined
        draw()
      })
    draw()
    return cameraAsk
  }

  const unsubscribeActions = onAction((actionId) => {
    const index = indexOf()
    switch (actionId) {
      case ACTION_REGISTER:
        if (index === undefined) void openGame(host)
        else void askForCamera().finally(() => signup.register(index))
        return
      case ACTION_TURN_ON_CAMERA:
        void askForCamera()
        return
      case ACTION_OPEN_GAME:
        opening(openGame(host), cardCopy.openFailed("Jollity"))
        return
      case ACTION_TUTORIAL:
        opening(openTutorial(host), cardCopy.openFailed("Jollity"))
        return
      case ACTION_STASH:
        opening(navigate(host, `polkadot://${stashProduct()}/?open=new`, "the New tab of stash", "stash"), cardCopy.openFailed("Stash"))
        return
      case ACTION_USERNAME:
        // The name is claimed on the Humanity card in Pocket, not in the peopl page.
        opening(navigate(host, humanityPocketLink(), "the member name on the Humanity card", "peopl"), cardCopy.openFailed("Peopl"))
        return
    }
  })

  const unsubscribeSignup = signup.subscribe(draw)
  const unsubscribeClaims = claims.subscribe(() => {
    lastSent = ""
    draw()
  })
  const interval = setInterval(() => {
    if (++ticks % CARD_SYNC_TICKS === 0) void sync()
    else draw()
  }, 1000)
  void sync()
  return () => {
    disposed = true
    clearInterval(interval)
    unsubscribeActions()
    unsubscribeSignup()
    unsubscribeClaims()
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const MEMBERSHIP_KEY_PREFIX = "jollity.membership.chat:"
/** How often a drawn Claim username card looks at what the poll learned of the name. */
const MEMBERSHIP_RECHECK_MS = 5_000

/**
 * Humanity's Membership news, said once per episode (membership/chat.ts). The
 * record is written before a line goes out, so a post that fails is not said
 * twice; the person still has the card and the game card to go on.
 */
async function postMembershipNews(host: WorkerHost, address: string, tag: string, nameSet: boolean): Promise<void> {
  const key = `${MEMBERSHIP_KEY_PREFIX}${address}`
  const stored = await readJSON<unknown>(host, key)
  if (stored === undefined) return
  let record = applyMembershipObservation(sanitizeMembershipRecord(stored), {
    standing: standingOf(tag),
    claimable: standingOf(tag) === "member" && !nameSet,
  })
  const owed = planMembershipLines(record)
  for (const { kind } of owed) record = applyMembershipSent(record, kind)
  if (!(await tryWriteJSON(host, key, record))) return
  for (const { line } of owed) {
    await within(host.chat.postMessage(ROOM_ID, MESSAGE_MEMBERSHIP, encPayload(line), line.text)).catch((error: unknown) =>
      console.error(TAG, "a membership line could not be posted", error),
    )
  }
}

function renderMembershipHandler(
  host: WorkerHost,
  req: RenderRequest,
  send: (node: WireNode) => void,
  onAction: (cb: ActionListener) => Unsubscribe,
): Unsubscribe | undefined {
  let line: ReturnType<typeof membershipLineOf> = null
  try {
    line = membershipLineOf(decPayload<unknown>(req.payload))
  } catch {
    line = null
  }
  if (line === null) {
    send({ tag: "Nil" })
    return undefined
  }
  const shown = line
  // The poll learns the name is set; a drawn card greys Claim username then.
  let claimed = latest?.nameSet === true
  const well = artWellFor(host)
  const draw = (): void => send(toWire(membershipTree(shown, claimed, well.current())))
  draw()
  const stopWatchingWell = well.onChange(draw)
  const interval = shown.claim
    ? setInterval(() => {
        if (claimed || latest?.nameSet !== true) return
        claimed = true
        draw()
        clearInterval(interval!)
      }, MEMBERSHIP_RECHECK_MS)
    : null
  const unsubscribe = onAction((actionId) => {
    if (actionId !== ACTION_USERNAME || claimed) return
    void navigate(host, humanityPocketLink(), "the member name on the Humanity card", "peopl")
  })
  return () => {
    if (interval != null) clearInterval(interval)
    stopWatchingWell()
    unsubscribe()
  }
}

/**
 * Post the eight rules, one every INTRO_PAUSE_MS, and remember how far it got,
 * so a restart carries on where it stopped. A room that got the older welcome
 * card gets the rules once too, since the key is new.
 */
export async function deliverIntro(host: WorkerHost, pauseMs = INTRO_PAUSE_MS): Promise<void> {
  const stored = await readJSON<number>(host, INTRO_KEY)
  // Without storage the worker cannot remember the rules, and would post them
  // on every start, so it posts none.
  if (stored === undefined) return
  const sent = stored ?? 0
  for (let index = sent; index < INTRO.length; index++) {
    if (index > sent) await sleep(pauseMs)
    const rule = INTRO[index]!
    try {
      await within(
        rule.image
          ? host.chat.postMessage(ROOM_ID, MESSAGE_INTRO, encPayload({ image: rule.image.path } satisfies IntroData), rule.text)
          : host.chat.postText(ROOM_ID, rule.text),
      )
      chatCount("chat.intro.posted", { index: String(index), ok: "true" }, { key: String(index) })
    } catch (error) {
      chatCount("chat.intro.posted", { index: String(index), ok: "false" }, { key: String(index), detail: { error: describeError(error) } })
      countMalformedFrame(error, rule.image ? MESSAGE_INTRO : "text")
      throw error
    }
    await writeJSON(host, INTRO_KEY, index + 1)
  }
}

let ticking = false
let beat = 0
let gameReadFailing = false
// Polls that failed one after the other, and whether this run of them was reported.
const POLL_FAILURES_REPORTED_AT = 3
const POLL_MEASURE_INITIAL = 3
const POLL_MEASURE_EVERY = 20
let pollFailures = 0
let pollFailureReported = false
let pollsObserved = 0
let firstReadReported = false

/** One poll's end: a failure counts once its third in a row, not on a flaky read. */
function pollOutcome(failed: { stage: string; reason: string; error?: string } | null): void {
  if (!failed) {
    pollFailures = 0
    pollFailureReported = false
    return
  }
  pollFailures++
  if (pollFailures >= POLL_FAILURES_REPORTED_AT && !pollFailureReported) {
    pollFailureReported = true
    chatCount(
      "chat.poll.failed",
      { stage: failed.stage, reason: failed.reason, in_a_row: String(pollFailures) },
      { key: failed.stage, ...(failed.error ? { detail: { error: failed.error } } : {}) },
    )
  }
}

let roomRegistered = false
/** When the game whose card this run docked in the footer of the room starts. */
let dockedGame: number | null = null
/** Whether the footer is empty under the pill of the host though the docked game is still the one the chat is about. */
let dockUnderPill = false
let pillEdge: ReturnType<typeof setTimeout> | undefined
let footerFailures = 0
let footerCardUnsupported = false

// A host that keeps failing the footer gets the live card in the feed, so the
// player still has a Register button. A host that does not answer gets it at
// once, since every try waits out the call deadline.
const FOOTER_FAILURES_BEFORE_FEED = 3

/** Whether the live game card goes in the feed, since the footer of the room cannot hold it. */
const liveCardInFeed = () => !roomRegistered || footerCardUnsupported

/**
 * Posts the card of a game that left the footer, unless the feed has it.
 *
 * Answers the record after it, or undefined when the post failed.
 */
async function postFinishedCard(host: WorkerHost, gamePlayTime: number, announced: number | number[] | null) {
  if (announcedTimes(announced).includes(gamePlayTime)) return announced
  return announce(host, { gamePlayTime }, announced).catch(() => undefined)
}

const gameFooter = (gamePlayTime: number): RoomFooter => ({ card: { messageType: MESSAGE_GAME_CARD, payload: encPayload({ gamePlayTime }) } })

const logFooter = (host: WorkerHost, doing: string, outcome: string) =>
  void workerLog.append(host, outcome === "set" ? "success" : "info", `${doing} answered ${outcome}.`)

/**
 * Keeps the live card of the game the chat is about in the footer of the room alone.
 *
 * The footer empties when no game is left. The game the footer held before is
 * over by then, so its card goes in the feed first, where it draws the
 * results. A card the feed already has stays the only one, out of the footer.
 * A failed post or a refused footer call leaves the footer as it is for the
 * next poll to try again. Answers the announced record after any post.
 */
async function dockGameCard(host: WorkerHost, game: GameCardData | null, announced: number | number[] | null): Promise<number | number[] | null> {
  if (liveCardInFeed()) return announced
  const stored = await readJSON<number>(host, DOCKED_KEY)
  if (stored === undefined) return announced
  const finished = stored ?? dockedGame
  const gamePlayTime = game && !announcedTimes(announced).includes(game.gamePlayTime) ? game.gamePlayTime : null
  const calledOff = latest?.running?.gamePlayTime === finished && latest.running.phase === "cancelled"
  if (gamePlayTime === null && finished !== null && finished > deviceNowSeconds() && !calledOff && !offTheSchedule(finished, latest, readBeforeLatest)) return announced
  if (gamePlayTime === dockedGame && (finished === null || finished === gamePlayTime)) return announced
  const posted = finished !== null && finished !== gamePlayTime ? await postFinishedCard(host, finished, announced) : announced
  if (posted === undefined) return announced
  const outcome: string = await within(host.chat.setRoomFooter(ROOM_ID, gamePlayTime === null ? "Empty" : gameFooter(gamePlayTime))).catch(() => "no-answer")
  if (outcome === "set") {
    dockedGame = gamePlayTime
    dockUnderPill = false
    footerFailures = 0
    await tryWriteJSON(host, DOCKED_KEY, gamePlayTime)
  } else if (gamePlayTime !== null && (outcome === "unsupported" || outcome === "no-answer" || ++footerFailures >= FOOTER_FAILURES_BEFORE_FEED)) {
    footerCardUnsupported = true
    // Nothing in this run reads or writes the record once the card is in the
    // feed, so the post does not wait for this call.
    if (outcome === "no-answer" || dockedGame !== null || finished !== null) {
      void within(host.chat.setRoomFooter(ROOM_ID, "Empty"))
        .then((emptied) => emptied === "set" && tryWriteJSON(host, DOCKED_KEY, null))
        .catch(() => {})
    }
  }
  chatCount("chat.footer.dock", { outcome }, { key: outcome })
  logFooter(host, gamePlayTime === null ? "Emptying the footer" : `Docking the game at ${gamePlayTime}`, outcome)
  return posted
}

const underHostPill = (gamePlayTime: number) => hostRemindedGame === gamePlayTime && hostPillUp(gamePlayTime, deviceNowSeconds())

/**
 * Empties the footer while the pill of the host counts down to the join of the docked game, and docks the card again at the join.
 *
 * The pill is then the one countdown on screen. The game stays the docked
 * one, so it is neither posted to the feed nor recorded as announced, and a
 * refused call leaves the footer for the next poll without moving the card
 * to the feed. Answers whether the footer fits the pill.
 */
async function fitDockToPill(host: WorkerHost): Promise<boolean> {
  const game = dockedGame
  if (game === null || liveCardInFeed()) return false
  const hide = underHostPill(game)
  if (hide === dockUnderPill) return true
  const outcome: string = await within(host.chat.setRoomFooter(ROOM_ID, hide ? "Empty" : gameFooter(game))).catch(() => "no-answer")
  if (outcome === "set" && dockedGame === game) dockUnderPill = hide
  chatCount("chat.footer.pill", { outcome, hide: String(hide) }, { key: outcome })
  logFooter(host, hide ? `Emptying the footer under the pill of the game at ${game}` : `Docking the game at ${game} after its pill`, outcome)
  return outcome === "set"
}

/**
 * Fits the footer again at the next edge of the pill, which falls between two polls.
 *
 * An empty footer waits for the join, even one already past, and a docked
 * card for the start of the pill. A refused fit arms nothing, so a host that
 * keeps refusing is asked once a poll.
 */
function wakeAtPillEdge(host: WorkerHost): void {
  clearTimeout(pillEdge)
  const game = dockedGame
  if (game === null || hostRemindedGame !== game) return
  const joinAtMs = (game - JOIN_LEAD_S) * 1000
  const edgeMs = dockUnderPill ? joinAtMs : joinAtMs - HOST_PILL_LEAD_S * 1000
  if (!dockUnderPill && edgeMs <= Date.now()) return
  pillEdge = setTimeout(() => fitBetweenPolls(host), Math.max(0, edgeMs - Date.now()))
}

function fitBetweenPolls(host: WorkerHost): void {
  if (ticking) pillEdge = setTimeout(() => fitBetweenPolls(host), ANSWER_POLL_MS)
  else void fitDockToPill(host).then((fits) => fits && wakeAtPillEdge(host))
}

/** Empties the footer under the pill once a sign-up from the chat lands, rather than at the next poll. */
async function fitDockAfterSignup(host: WorkerHost, gameIndex: number): Promise<void> {
  const game = latest?.running?.index === gameIndex ? latest.running.gamePlayTime : null
  if (game === null || game !== dockedGame || !(await heldPillUp(host, game))) return
  hostRemindedGame = game
  clearTimeout(pillEdge)
  fitBetweenPolls(host)
}

async function heldPillUp(host: WorkerHost, gamePlayTime: number): Promise<boolean> {
  const reminder = await readJSON<HostReminder>(host, HOST_REMINDER_KEY)
  return reminder?.outcome === "held" && reminder.gamePlayTime === gamePlayTime && hostPillUp(gamePlayTime, deviceNowSeconds())
}

/**
 * The footer a fresh run shows before its first poll, which is the card the last run docked while the feed lacks it.
 *
 * The footer is empty instead while the pill of the host counts down to the join of that game.
 */
async function bootFooter(host: WorkerHost): Promise<string> {
  const stored = await readJSON<number>(host, DOCKED_KEY)
  const announced = typeof stored === "number" ? await readJSON<number | number[]>(host, ANNOUNCED_KEY) : undefined
  if (typeof stored === "number" && announced !== undefined && !announcedTimes(announced).includes(stored)) {
    const hide = await heldPillUp(host, stored)
    const outcome = await host.chat.setRoomFooter(ROOM_ID, hide ? "Empty" : gameFooter(stored))
    logFooter(host, hide ? `Emptying the footer under the pill of the game at ${stored}` : `Docking the game at ${stored}`, outcome)
    if (outcome === "set" && dockedGame === null) {
      dockedGame = stored
      dockUnderPill = hide
      if (hide) {
        hostRemindedGame = stored
        wakeAtPillEdge(host)
      }
    }
    if (dockedGame !== null) return outcome
  }
  const outcome = await host.chat.setRoomFooter(ROOM_ID, "Empty")
  logFooter(host, "setRoomFooter", outcome)
  return outcome
}

function startLoop(host: WorkerHost, dailyDollar: DailyDollar, autoClaim: AutoClaim) {
  void tick(host, autoClaim)
  setInterval(() => void tick(host, autoClaim), POLL_MS)
  // Humanity's Daily Dollar runs beside the game, on its own beat, so a slow
  // registration never holds a game card back.
  void dailyDollar.tick()
  setInterval(() => void dailyDollar.tick(), DAILY_DOLLAR_TICK_MS)
}

/**
 * The game the chat is about now: the one running, unless it is over, else the next on the schedule.
 *
 * A game is over for the chat once its last turn ends on the chain clock,
 * though the chain keeps it running until it settles. Its results then go to
 * the feed, because the results card with its collectibles can be taller than
 * the screen, and docked in the footer it leaves the chat nothing to scroll.
 */
function nextGame(read: ChainRead): GameCardData | null {
  const running = read.running
  const chainNowSeconds = Math.floor((Date.now() + read.clockOffsetMs) / 1000)
  if (isUpcoming(running) && (running.phase !== "reporting" || chainNowSeconds < running.playEnds)) {
    return { gamePlayTime: running.gamePlayTime }
  }
  const upcoming = read.upcoming[0]
  return upcoming ? { gamePlayTime: upcoming.gamePlayTime } : null
}

/** Claims a won prize the chain would pay, from the poll, once per game for this run of the worker. */
export type AutoClaim = (gameIndex: number, drawIndex: number) => void

export async function tick(host: WorkerHost, autoClaim?: AutoClaim): Promise<void> {
  if (ticking) return
  ticking = true
  const finishActivity = beginChatActivity("poll")
  const pollStartedAt = Date.now()
  // what went wrong in this poll, for pollOutcome
  let stage = "connect"
  let failed: { stage: string; reason: string; error?: string } | null = null
  try {
    if (++beat % 4 === 1) void workerLog.append(host, "info", `heartbeat #${beat}`)
    const people = await within(connect(host))
    if (!people) {
      failed = { stage: "connect", reason: "no-client" }
      return
    }
    stage = "address"
    const address = await within(playerAddress(host))
    setChatUser(address)
    stage = "read"
    const read = await within(readGame(host, people, address))
    if (!read) {
      if (!gameReadFailing) console.log(TAG, "the game read failed")
      gameReadFailing = true
      failed = { stage: "read", reason: "no-read" }
      return
    }
    if (!firstReadReported) {
      firstReadReported = true
      chatMeasure("chat.first_read_ms", Date.now() - WORKER_STARTED_AT)
    }
    setChatGame(read.running?.index)
    gameReadFailing = false
    stage = "settle"
    const stale = latest?.member == null || beat % MEMBER_EVERY_TICKS === 1
    const standing = address && stale ? await within(readStanding(people, address)) : (latest?.standing ?? null)
    const member = isMemberStanding(standing?.tag ?? null)
    const nameRead = !latest?.nameSet && member === true && stale ? await readNameSet(host, async () => people) : null
    const nameSet = latest?.nameSet === true || nameRead === true
    // Asked while the name is unclaimed: a new member's key waits in the
    // onboarding queue, and nothing offers the name until the ring holds it.
    const readyRead = address && nameRead === false && latest?.nameReady !== true ? await within(readNameReady(people, address)).catch(() => null) : null
    const nameReady = nameSet || (readyRead ?? latest?.nameReady ?? false)
    readBeforeLatest = latest
    const gamesToMembership = standing ? standing.gamesToMembership : (latest?.gamesToMembership ?? null)
    latest = { ...read, member, nameSet, nameReady, standing, gamesToMembership }
    latestObservation = ++readObservation
    firstPollDone = true

    const next = nextGame(read)
    const stored = next || !liveCardInFeed() ? await readJSON<number | number[]>(host, ANNOUNCED_KEY) : undefined
    if (stored !== undefined) {
      const announced = await dockGameCard(host, next, stored)
      if (next && liveCardInFeed() && !announcedTimes(announced).includes(next.gamePlayTime)) await announce(host, next, announced)
    }

    // The host can hold the reminder call while it asks the player for the
    // alarm and the calendar, so it waits until the card is out.
    // One task, so the gate of a tap or the drop of a lost sign-up never runs
    // between the poll's reminder and its booking.
    await oneAtATime(async () => {
      const current = latest!
      const { view, sentPastItsLifetime } = await signUpView(host, current, joiningGame !== null && current.running?.index === joiningGame)
      const hostReminds = await keepReminder(host, view, false, latestObservation)
      hostRemindedGame = hostReminds ? (view.running?.gamePlayTime ?? null) : null
      await bookReminders(host, view, hostReminds, false, sentPastItsLifetime)
    })
    if (await fitDockToPill(host)) wakeAtPillEdge(host)

    void keepTurnPass(host, latest)
    // the name link runs ahead of Register, whenever there is a game to sign up for
    if (next) nameGateFor(host).request()

    const games = await rememberGame(host, latest)
    if (address) {
      for (const game of games) await settleOutcome(host, people, address, read, game, autoClaim)
      stage = "backfill"
      await backfillPastGames(host, people, address, read)
      // After the game cards, so the news of a game lands under its result.
      // A member whose name could not be read waits for the next read, so the
      // news never offers a claim to someone who already has their name.
      // A new member hears of it with the name to claim, so the news waits for the ring too.
      if (stale && standing !== null && (standingOf(standing.tag) !== "member" || nameSet || (nameRead === false && nameReady))) {
        stage = "membership"
        await postMembershipNews(host, address, standing.tag, nameSet)
      }
    }
  } catch (e) {
    console.error(TAG, "tick failed", e)
    // the reason is a fixed word; the text of the error goes in the detail
    failed = e instanceof CallDeadlineError ? { stage, reason: "deadline" } : { stage, reason: "threw", error: describeError(e) }
  } finally {
    pollsObserved++
    const sample =
      failed && !pollFailureReported && pollFailures + 1 === POLL_FAILURES_REPORTED_AT
        ? "failure"
        : pollsObserved <= POLL_MEASURE_INITIAL
          ? "initial"
          : pollsObserved % POLL_MEASURE_EVERY === 0
            ? "interval"
            : null
    if (sample) chatMeasure("chat.poll.duration_ms", Date.now() - pollStartedAt, { stage, ok: String(failed === null), sample })
    pollOutcome(failed)
    firstPollDone = true
    ticking = false
    finishActivity()
  }
}

// A game the worker was not polling for when it ended still needs its
// outcome, so the last few games stay tracked until they have one. An older
// game stays too while its outcome or its prize draw can still change, up to
// OPEN_GAMES_KEPT in all.
const GAMES_KEPT = 3
const OPEN_GAMES_KEPT = 10

/** Whether a stored outcome can still change, or is missing, so its game stays tracked. */
function stillOpen(outcome: StoredOutcome | null | undefined): boolean {
  if (!outcome) return true
  if (outcome.prizeUnread) return true
  const prize = outcome.results?.prize
  return prize !== undefined && prize !== null && prize.phase !== "over"
}

async function trimGames(host: WorkerHost, games: SeenGame[]): Promise<SeenGame[]> {
  const recent = games.slice(-GAMES_KEPT)
  const older: SeenGame[] = []
  for (const game of games.slice(0, -GAMES_KEPT)) {
    if (stillOpen(await readJSON<StoredOutcome>(host, `${RECAP_KEY}:${game.gamePlayTime}`))) older.push(game)
  }
  return [...older.slice(-(OPEN_GAMES_KEPT - recent.length)), ...recent]
}

/**
 * The games seen running, newest last, with the one running now added and its
 * sign-up kept current, since a player can sign up after its card was posted.
 * A failed read leaves the stored list alone and tracks nothing this poll.
 */
async function rememberGame(host: WorkerHost, read: ChainRead): Promise<SeenGame[]> {
  const stored = await readJSON<SeenGame[]>(host, GAMES_KEY)
  if (stored === undefined) return []
  const games = stored ?? []
  const running = read.running
  if (!running) return games
  const registered = running.registered === true
  const known = games.find((game) => game.index === running.index)
  if (known && (known.registered || !registered)) return games
  const updated = known
    ? games.map((game) => (game === known ? { ...game, registered: true } : game))
    : await trimGames(host, [
        ...games,
        {
          index: running.index,
          gamePlayTime: running.gamePlayTime,
          airdropsScheduled: running.airdropsScheduled,
          endsAt: running.reportingEnds,
          registered,
          memberBefore: read.member,
        },
      ])
  await writeJSON(host, GAMES_KEY, updated)
  return updated
}

/** Keeps that the chain held the report of the player, since its row goes with the settle. */
async function rememberReported(host: WorkerHost, game: SeenGame): Promise<void> {
  const stored = await readJSON<SeenGame[]>(host, GAMES_KEY)
  if (!stored) return
  await writeJSON(host, GAMES_KEY, stored.map((seen) => (seen.index === game.index ? { ...seen, reported: true } : seen)))
}

/**
 * Store how a game ended for the player, as soon as the chain has decided it.
 *
 * The pallet applies a player's attendance the moment the votes still to come
 * can no longer change it (#1096), and writes `Score.Participants` right
 * then, long before the game settles. So while the game is reporting, the
 * player's `Game.Players` row is read on every poll (`readAttendance`), and
 * once the pallet has applied it the outcome is read and stored `early`, from
 * the same score row the settle leaves. Until then the card says the results
 * are pending.
 *
 * An early outcome keeps moving: co-players' reports award collectibles as
 * they come in, so its count is read again on every poll, and once the game
 * settles the outcome is read once more, which drops `early`. The prize draw
 * keeps moving after that too, as it is held, claimed and closed, so a stored
 * prize is read again until its draw is over, and a win the chain would pay is
 * claimed by itself (`autoClaim`) once the game has settled: until then the
 * app's draw screen, which claims at once, has it to itself.
 */
async function settleOutcome(
  host: WorkerHost,
  people: People,
  address: string,
  read: ChainRead,
  game: SeenGame,
  autoClaim?: AutoClaim,
) {
  const key = `${RECAP_KEY}:${game.gamePlayTime}`
  let stored = await readJSON<StoredOutcome>(host, key)
  // A failed read must not look like no outcome, or a stored one is read again
  // from the chain and overwritten.
  if (stored === undefined) return
  const running = read.running?.index === game.index ? read.running : null
  if (stored?.early && !running) {
    const settled = await readOutcomeCounted(people, address, game)
    if (!settled) return
    stored = settledOver(stored, settled)
    await writeJSON(host, key, stored)
    void workerLog.append(host, "success", `Game ${game.index} settled, and its outcome was read again.`)
    if (stored.results || stored.reported) await recordEarned(host, people, address, game.index, key, "settled")
    stored = (await readJSON<StoredOutcome>(host, key)) ?? stored
  }
  if (stored) {
    const results = stored.results
    const refresh = stored.early ? "early" : undefined
    const counted = (refresh && (results || stored.reported)) || needsCount(stored) ? await recordEarned(host, people, address, game.index, key, refresh) : null
    const current = counted ?? stored
    if (!results || !stillOpen(stored)) return
    let reading: Awaited<ReturnType<typeof readPrize>>
    try {
      reading = await within(readPrize(people, address, game, { drawIndex: stored.drawIndex }))
    } catch (error) {
      chatCount("chat.outcome.read_failed", { stage: "prize", "game.index": String(game.index) }, {
        key: `prize:${game.index}`,
        once: true,
        detail: { error: describeError(error) },
      })
      throw error
    }
    if (reading === undefined) {
      chatCount("chat.outcome.read_failed", { stage: "prize", "game.index": String(game.index) }, {
        key: `prize:${game.index}`,
        once: true,
      })
      return
    }
    const { prizeUnread, ...rest } = current
    const fresh = reading?.prize ?? null
    const merged = prizeUnread || !results.prize ? fresh : mergePrize(results.prize, fresh)
    const drawIndex = reading?.drawIndex ?? current.drawIndex
    const prize = merged && drawIndex !== undefined && ticketGone(merged, fresh)
      ? await confirmedClaim(host, people, address, game.index, drawIndex, merged)
      : merged
    // after the settle only: the app's draw screen has the reporting phase to itself
    if (!running && prize?.won && prize.claimable && !prize.claimed && drawIndex !== undefined) autoClaim?.(game.index, drawIndex)
    const updated: StoredOutcome = { ...rest, ...(drawIndex === undefined ? {} : { drawIndex }), results: { ...current.results!, prize } }
    if (JSON.stringify(updated) === JSON.stringify(current)) return
    await writeJSON(host, key, updated)
    return
  }
  let outcome: StoredOutcome | null
  let attendance: Awaited<ReturnType<typeof readAttendance>> | undefined
  if (running?.phase === "cancelled") {
    outcome = {
      cancelled: true,
      results: null,
      gamesToMembership: latest?.gamesToMembership ?? null,
      gameIndex: game.index,
      registered: game.registered,
      memberBefore: game.memberBefore,
    }
  } else if (running) {
    // the verdict before the settle, once the chain has applied it
    if (!game.registered) return
    attendance = await within(readAttendance(people, address, running))
    if (attendance) pendingVotes = { gameIndex: game.index, votes: attendance.votes }
    if (attendance?.reported && !game.reported) await rememberReported(host, game)
    if (!attendance?.final) return
    const early = await readOutcomeCounted(people, address, game)
    // a score row that does not hold the game yet says nothing early: the next poll asks again
    if (!early || (attendance.verdict === "passed" && !early.results)) return
    outcome = { ...early, early: true }
  } else {
    outcome = await readOutcomeCounted(people, address, game)
  }
  if (!outcome) return
  await writeJSON(host, key, { ...outcome, ...(attendance?.reported || game.reported ? { reported: true } : {}) })
  const how = outcome.cancelled ? "cancelled" : outcome.results ? "played" : "missed"
  chatCount("chat.outcome", { outcome: how, "game.index": String(game.index), ...(outcome.early ? { early: "true" } : {}) }, { key: how })
  void workerLog.append(host, "success", `The outcome of game ${game.index} is ${how}${outcome.early ? ", before the settle" : ""}.`)
  if (outcome.early && outcome.results) await recordEarned(host, people, address, game.index, key, "early")
}

/** The outcome as the chain has it, with a failed read counted once per game. Null when the read fails. */
async function readOutcomeCounted(people: People, address: string, game: SeenGame): Promise<StoredOutcome | null> {
  let outcome: StoredOutcome | null
  try {
    outcome = await within(readOutcome(people, address, game))
  } catch (error) {
    chatCount("chat.outcome.read_failed", { stage: "outcome", "game.index": String(game.index) }, {
      key: `outcome:${game.index}`,
      once: true,
      detail: { error: describeError(error) },
    })
    throw error
  }
  if (!outcome) chatCount("chat.outcome.read_failed", { stage: "outcome", "game.index": String(game.index) }, { key: `outcome:${game.index}`, once: true })
  return outcome
}

/**
 * An early outcome after the settle: the verdict and membership as the settle
 * left them, with the collectibles counted so far and the prize as last read,
 * which the poll reads on from there.
 */
export function settledOver(early: StoredOutcome, settled: StoredOutcome): StoredOutcome {
  const kept: StoredOutcome = { ...early }
  delete kept.early
  if (!settled.results || !early.results) return { ...kept, ...settled }
  const prize = early.results.prize ? mergePrize(early.results.prize, settled.results.prize) : settled.results.prize
  return {
    ...kept,
    ...settled,
    ...(early.drawIndex === undefined ? {} : { drawIndex: early.drawIndex }),
    results: {
      ...settled.results,
      ...(early.results.earned === undefined ? {} : { earned: early.results.earned }),
      collectables: early.results.collectables,
      prize,
    },
  }
}

// A chest read is the claims, every approved collection, a preview per claim
// and a manifest per item, which takes longer than one host call.
const CHEST_DEADLINE_MS = 90_000
// Claims reach Asset Hub a block or two after the game, so a chest that cannot
// deal them all yet is read again soon rather than on the booking cadence.
const CHEST_RETRY_MS = 60_000

/** When to read the collectibles of a game again, on the booking cadence after a failure that is logged once, and sooner while the chest cannot deal every claim. */
const earnedRetryAt = new Map<number, number>()
/** The games whose last count or chest read failed: an early refresh waits out their retry too. */
const earnedFailed = new Set<number>()

/** Counts the collectibles of one game outside the poll, for the card that shows them. */
async function countEarned(host: WorkerHost, gameIndex: number, key: string) {
  const [people, address] = await Promise.all([within(connect(host)).catch(() => null), playerAddress(host).catch(() => null)])
  if (people && address) await recordEarned(host, people, address, gameIndex, key)
}

/** Whether the card of these results still has its collectibles to read: the count, then the pictures of a game that earned some. */
function needsEarned(results: GameResults): boolean {
  return results.earned === undefined || (results.earned > 0 && results.collectables === null)
}

/** The same for any outcome, where a miss only counts once a report says the player played. */
function needsCount(outcome: StoredOutcome, seen: Seen = UNSEEN): boolean {
  if (outcome.results) return needsEarned(outcome.results)
  return !outcome.cancelled && outcome.earned === undefined && (seen.report === true || outcome.reported === true)
}

/**
 * Stores how many collectibles a played game earned, then the picture of each,
 * once Asset Hub answers, and resolves the outcome it wrote.
 *
 * Until then the stored results carry no count. A failed read is tried again
 * only once BOOKING_RETRY_MS has passed, from the poll or from a card, so a
 * host without an Asset Hub is not asked on every card sync. A failed chest
 * read waits as long. The pictures are stored only once the chest can deal
 * every claim, and until then they are read again after CHEST_RETRY_MS.
 *
 * `refresh` counts again a game whose credits are still landing: the outcome
 * is early, or the game has just settled. Co-players' reports award credits
 * as they come in, and the settle awards the rest, so the count can grow
 * until then. A grown count reads the chest again; while that cannot deal
 * every claim the pictures already drawn stay, and once the game has settled
 * (`refresh: "settled"`) they are dropped, so the read above draws them later.
 */
async function recordEarned(
  host: WorkerHost,
  people: People,
  address: string,
  gameIndex: number,
  key: string,
  refresh?: "early" | "settled",
): Promise<StoredOutcome | null> {
  if (Date.now() < (earnedRetryAt.get(gameIndex) ?? 0) && !(refresh && !earnedFailed.has(gameIndex))) return null
  const stored = await readJSON<StoredOutcome>(host, key)
  if (!stored) return null
  if (!stored.results) return recordPlayedEarned(host, people, address, gameIndex, key)
  const known = stored.results.earned ?? null
  let earned: number | null = refresh ? null : known
  let collectables = stored.results.collectables
  let failure = "no Asset Hub from the host"
  let chestFailure: string | null = null
  try {
    const hub = await within(connectAssetHub(host))
    if (hub && earned === null) {
      earned = await within(readEarned(people, hub, address, gameIndex))
      if (earned === null) failure = "the claims read failed"
    }
    const grew = earned !== null && known !== null && earned !== known
    if (hub && earned !== null && earned > 0 && (collectables === null || grew)) {
      const read = await within(readCollectables(host, people, hub, address, gameIndex), CHEST_DEADLINE_MS)
      if (read === null) chestFailure = "the chest read failed"
      else if (read.pending === 0) collectables = read.items
      else if (grew && refresh === "settled") collectables = null
    }
  } catch (error) {
    failure = (error as Error)?.message ?? String(error)
    chestFailure = failure
  }
  if (earned === null) {
    countFailed(host, gameIndex, failure)
    return null
  }
  earnedFailed.delete(gameIndex)
  const pictured = earned === 0 || collectables !== null
  if (pictured && !chestFailure) earnedRetryAt.delete(gameIndex)
  else if (chestFailure) {
    chatCount("chat.earned.failed", { stage: "collectables", "game.index": String(gameIndex) }, { key: "collectables", detail: { error: describeError(chestFailure) } })
    if (!earnedRetryAt.has(gameIndex)) void workerLog.append(host, "error", `The collectibles of game ${gameIndex} could not be drawn: ${chestFailure}.`)
    earnedRetryAt.set(gameIndex, Date.now() + BOOKING_RETRY_MS)
    earnedFailed.add(gameIndex)
  } else earnedRetryAt.set(gameIndex, Date.now() + CHEST_RETRY_MS)
  const latest = await readJSON<StoredOutcome>(host, key)
  if (!latest?.results) return null
  const written: StoredOutcome = { ...latest, results: { ...latest.results, earned, collectables } }
  if (JSON.stringify(written) === JSON.stringify(latest)) return latest
  await writeJSON(host, key, written)
  void workerLog.append(
    host,
    "success",
    collectables ? `Game ${gameIndex} earned ${earned} collectibles, ${collectables.length} drawn.` : `Game ${gameIndex} earned ${earned} collectibles.`,
  )
  return written
}

function countFailed(host: WorkerHost, gameIndex: number, failure: string) {
  chatCount("chat.earned.failed", { stage: "count", "game.index": String(gameIndex) }, { key: "count", detail: { error: describeError(failure) } })
  if (!earnedRetryAt.has(gameIndex)) void workerLog.append(host, "error", `The collectibles of game ${gameIndex} could not be counted: ${failure}.`)
  earnedRetryAt.set(gameIndex, Date.now() + BOOKING_RETRY_MS)
  earnedFailed.add(gameIndex)
}

/** The count alone, since the card of a player who did not pass draws no tiles. */
async function recordPlayedEarned(host: WorkerHost, people: People, address: string, gameIndex: number, key: string): Promise<StoredOutcome | null> {
  let earned: number | null = null
  let failure = "no Asset Hub from the host"
  try {
    const hub = await within(connectAssetHub(host))
    if (hub) {
      earned = await within(readEarned(people, hub, address, gameIndex))
      if (earned === null) failure = "the claims read failed"
    }
  } catch (error) {
    failure = (error as Error)?.message ?? String(error)
  }
  if (earned === null) {
    countFailed(host, gameIndex, failure)
    return null
  }
  earnedFailed.delete(gameIndex)
  earnedRetryAt.delete(gameIndex)
  const latest = await readJSON<StoredOutcome>(host, key)
  if (!latest || latest.results) return null
  if (latest.earned === earned) return latest
  const written: StoredOutcome = { ...latest, earned }
  await writeJSON(host, key, written)
  void workerLog.append(host, "success", `Game ${gameIndex} earned ${earned} collectibles.`)
  return written
}

/**
 * A fresh reading of a stored prize, keeping what the chain forgets.
 *
 * The chain removes the winning row once the prize is claimed or the draw is
 * cleared, and then reads the ticket as not won, so a stored win stays a win.
 * A draw whose event is gone reads no amount or time, so those are kept too.
 * The SDK lists every scheduled draw, so a stored prize always has a reading,
 * and the null case only guards a change in that.
 */
export function mergePrize(stored: SlotPrize, fresh: SlotPrize | null): SlotPrize {
  if (!fresh) return { ...stored, phase: "over", claimable: false }
  const eventGone = fresh.amountUsd === 0 && stored.amountUsd > 0
  const reading = eventGone ? { ...fresh, amountUsd: stored.amountUsd, drawAt: stored.drawAt } : fresh
  if (!stored.won) return reading
  const merged: SlotPrize = { ...reading, won: true, ticket: stored.ticket, ...(stored.claimed ? { claimed: true, claimable: false } : {}) }
  // the chain reads a gone ticket as not won, and so judges no claim of it
  if (!fresh.won && stored.membersOnly) merged.membersOnly = true
  return merged
}

/** Whether a stored win has lost its winning ticket on the chain, which a claim does. */
function ticketGone(prize: SlotPrize, fresh: SlotPrize | null): boolean {
  return prize.won && !prize.claimed && fresh !== null && !fresh.won
}

/** The prize with what the chain says about its claim, or as it was when the read fails. */
async function confirmedClaim(
  host: WorkerHost,
  people: People,
  address: string,
  gameIndex: number,
  airdropIndex: number,
  prize: SlotPrize,
): Promise<SlotPrize> {
  const claimed = await within(readClaimed(people, address, gameIndex, airdropIndex)).catch((error: unknown) => {
    chatCount("chat.outcome.read_failed", { stage: "claim", "game.index": String(gameIndex) }, {
      key: `claim:${gameIndex}`,
      once: true,
      detail: { error: describeError(error) },
    })
    return undefined
  })
  if (!claimed) return prize
  void workerLog.append(host, "success", `The prize of game ${gameIndex} was claimed.`)
  return { ...prize, claimed: true, claimable: false }
}

/**
 * Whether a card can no longer change, so it stops reading and drawing.
 *
 * A cancelled game is final, and so are results whose collectibles are read
 * and whose prize draw is over, since nothing refreshes them any more.
 * An early outcome is not: its collectibles land until the game settles.
 * A missed game of a registered player is not either until a report says they
 * played, since the app can write that long after the worker stored the miss,
 * and then not until its collectibles are counted.
 * The collectibles open in the stash, not the chest of the app, so whether the
 * app marked the chest seen does not matter.
 */
export function settledCard(outcome: StoredOutcome | null, seen: Seen): boolean {
  if (!outcome || outcome.early) return false
  if (outcome.cancelled) return true
  if (!outcome.results) return !needsCount(outcome, seen) && (outcome.registered !== true || seen.report === true || outcome.reported === true)
  return !stillOpen(outcome) && !needsEarned(outcome.results)
}

// A read can swing the next game back to an earlier one (a reorg, or a phase
// edge read as over for one poll), so the record keeps the last few.
const ANNOUNCED_KEPT = 5

/** The play times the record holds, from the list or an older worker's bare number. */
function announcedTimes(stored: number | number[] | null): number[] {
  if (typeof stored === "number") return [stored]
  return Array.isArray(stored) ? stored.filter((time) => typeof time === "number") : []
}

// The cards this run posted, which stand in for the record while its writes
// fail: a card a run, rather than one a poll or none at all.
const postedThisRun = new Set<number>()

/** A post made while its claim is held in memory alone, which Sentry counts by the claim tag. */
function countMemoryClaim(what: "card" | "reminder") {
  chatCount("chat.post.memory_claim", { claim: "memory", what }, { key: what })
}

/**
 * Posts the card of a game at most once: the record is claimed first, with a
 * write that reports failure. A claim that failed, or landed after its
 * deadline, still gets the card out, once for this run. A post the host
 * refused promptly gives the claim back, so the next poll posts again. A post
 * that hit its deadline keeps the claim, since the host may have posted.
 */
async function announce(host: WorkerHost, game: GameCardData, previous: number | number[] | null): Promise<number[]> {
  const claim = [...announcedTimes(previous), game.gamePlayTime].slice(-ANNOUNCED_KEPT)
  // Posted already this run, so the record only catches up.
  if (postedThisRun.has(game.gamePlayTime)) {
    await tryWriteJSON(host, ANNOUNCED_KEY, claim)
    return claim
  }
  // Storage is the record and memory the fallback: a claim it refused is held
  // in postedThisRun, and the post says so, so the cards sent that way can be counted.
  if (!(await tryWriteJSON(host, ANNOUNCED_KEY, claim))) countMemoryClaim("card")
  postedThisRun.add(game.gamePlayTime)
  try {
    await postGameCard(host, game)
    chatCount("chat.card.posted", { outcome: "sent" }, { key: "sent" })
  } catch (error) {
    chatCount("chat.card.posted", { outcome: error instanceof CallDeadlineError ? "timed-out" : "failed" }, {
      key: error instanceof CallDeadlineError ? "timed-out" : "failed",
      detail: { error: describeError(error) },
    })
    countMalformedFrame(error, MESSAGE_GAME_CARD)
    if (!(error instanceof CallDeadlineError)) {
      postedThisRun.delete(game.gamePlayTime)
      await tryWriteJSON(host, ANNOUNCED_KEY, previous)
    }
    throw error
  }
  return claim
}

/** Bounds a poll inside its deadlines. The watermark carries the rest to the next poll. */
const BACKFILL_PER_POLL = 3
// The running game, or -1 with none, whose poll found no past card left to post.
let backfillCheckedFor: number | null = null

/**
 * The stored outcome of a game the worker never saw, which draws its card at
 * once. `earned: 0` keeps a played card settled and off Asset Hub, and the
 * chain no longer says how far a past game took the player, so the card asks
 * them to play again.
 */
export function backfillOutcome(index: number, playedAt: number, attended: boolean): StoredOutcome {
  const past = { cancelled: false, gameIndex: index, registered: attended, memberBefore: false, gamesToMembership: null }
  if (!attended) return { ...past, results: null }
  return {
    ...past,
    results: {
      endedAt: playedAt,
      passed: true,
      earned: 0,
      collectables: null,
      prize: null,
      membership: { member: false, justBecameMember: false, gamesToMembership: null },
      seen: UNSEEN,
    },
  }
}

/**
 * The row that hands the newest game the player attended to `settleOutcome`,
 * which reads its real outcome on the next poll.
 *
 * The airdrop count is unreadable once a game ends, so 0 skips the prize read.
 * The membership going in is unknown, and `false` would draw a standing member
 * as a new one.
 */
function backfillRow(index: number, playedAt: number): SeenGame {
  return { index, gamePlayTime: playedAt, airdropsScheduled: 0, endsAt: playedAt, registered: true, memberBefore: null }
}

/**
 * Posts the card of every game since the first game of the player that the
 * chat does not have, oldest first, a few a poll.
 *
 * A game with a recap, a tracked row or an announced play time counts as
 * posted, so a game the worker first saw while it was settling gets no card. A
 * failed storage read stops the poll, since taking it for an empty key would
 * post that card a second time.
 */
async function backfillPastGames(host: WorkerHost, people: People, address: string, read: ChainRead) {
  const running = read.running?.index ?? -1
  if (backfillCheckedFor === running) return
  const watermark = await readJSON<number>(host, BACKFILL_KEY)
  if (watermark === undefined) return
  const past = await within(readPastGames(people, address))
  if (!past) return
  if (past.first === null) {
    backfillCheckedFor = running
    return
  }
  const first = past.first
  const announced = await readJSON<number | number[]>(host, ANNOUNCED_KEY)
  const tracked = await readJSON<SeenGame[]>(host, GAMES_KEY)
  if (announced === undefined || tracked === undefined) return
  const announcedAt = new Set(announcedTimes(announced))
  const trackedIndexes = new Set(tracked?.map((game) => game.index))
  const start = watermark ?? 0
  const nowSeconds = Math.floor((Date.now() + read.clockOffsetMs) / 1000)
  const candidates = [...past.history]
    .filter(([index, playedAt]) => index >= first && index > start && playedAt < nowSeconds && (running === -1 || index < running))
    .sort(([a], [b]) => a - b)
  let done = start
  let posted = 0
  for (const [index, playedAt] of candidates) {
    const stored = await readJSON<StoredOutcome>(host, `${RECAP_KEY}:${playedAt}`)
    if (stored === undefined) return
    if (stored === null && !announcedAt.has(playedAt) && !trackedIndexes.has(index)) {
      if (posted === BACKFILL_PER_POLL) return
      await backfillGame(host, index, playedAt, past, done, tracked ?? [])
      posted++
    }
    done = index
  }
  if (done > start) await tryWriteJSON(host, BACKFILL_KEY, done)
  backfillCheckedFor = running
}

/**
 * Posts one past card, as `announce` posts a live one: claimed first, the claim
 * given back on a prompt refusal, and kept past a deadline, since the host may
 * have posted. The outcome or row stored before the post is the record of a
 * game whose watermark write failed. A refusal clears it with the claim, or the
 * next poll reads it as a card already posted.
 */
async function backfillGame(host: WorkerHost, index: number, playedAt: number, past: PastGames, previous: number, tracked: SeenGame[]) {
  const key = `${RECAP_KEY}:${playedAt}`
  const newest = index === past.lastAttended
  const attended = past.attended.has(index)
  if (!(await tryWriteJSON(host, BACKFILL_KEY, index))) countMemoryClaim("card")
  try {
    const recorded = newest
      ? await tryWriteJSON(host, GAMES_KEY, await trimGames(host, [...tracked, backfillRow(index, playedAt)]))
      : await tryWriteJSON(host, key, backfillOutcome(index, playedAt, attended))
    if (!recorded) throw new Error(`The record of game ${index} was not stored.`)
    await postGameCard(host, { gamePlayTime: playedAt })
    const how = newest ? "pending" : attended ? "played" : "missed"
    chatCount("chat.card.backfilled", { outcome: how }, { key: how })
  } catch (error) {
    const how = error instanceof CallDeadlineError ? "timed-out" : "failed"
    chatCount("chat.card.backfilled", { outcome: how }, { key: how, detail: { error: describeError(error) } })
    countMalformedFrame(error, MESSAGE_GAME_CARD)
    if (how === "failed") {
      await (newest ? tryWriteJSON(host, GAMES_KEY, tracked) : tryWriteJSON(host, key, null))
      await tryWriteJSON(host, BACKFILL_KEY, previous)
    }
    throw error
  }
}

async function postGameCard(host: WorkerHost, game: GameCardData) {
  await within(host.chat.postMessage(ROOM_ID, MESSAGE_GAME_CARD, encPayload(game satisfies GameCardData), cardCopy.GAME_CARD_ALT))
  console.log(TAG, `posted the card for the game at ${game.gamePlayTime}`)
  void workerLog.append(host, "success", `The worker posted the card for the game at ${game.gamePlayTime}.`)
}

async function openGame(host: WorkerHost): Promise<boolean> {
  return navigate(host, SPA_URL, "the game", "app")
}

/**
 * How to play, and How it works on the older welcome card, open /nux. The flag
 * is set first, for the hosts that drop the path and open the product root,
 * where the app routes to /nux when it finds the flag. The write has to land
 * before the app boots, hence the await.
 */
async function openTutorial(host: WorkerHost): Promise<boolean> {
  await writeJSON(host, TUTORIAL_KEY, true)
  return navigate(host, spaPage("/nux"), "the tutorial", "nux")
}

/** Asks the host to open the page and answers whether it did, so the card can say when it did not. */
async function navigate(host: WorkerHost, url: string, what: string, target: string): Promise<boolean> {
  try {
    const ok = await host.navigate(url)
    chatCount("chat.nav", { target, ok: String(ok) }, { key: `${target}:${ok}` })
    if (ok) void workerLog.append(host, "info", `navigated to ${what}`)
    else void workerLog.append(host, "error", `navigateTo rejected (${what})`)
    return ok
  } catch (error) {
    chatCount("chat.nav", { target, ok: "false" }, { key: `${target}:false` })
    chatFailure("host-call-failed", "navigate", { target, error: describeError(error) })
    void workerLog.append(host, "error", "navigateTo unavailable in this host")
    return false
  }
}

/** A native notification has a title and a body, and a product one has one text. */
function notice(title: string, body: string): string {
  return /[.!?]$/.test(title) ? `${title} ${body}` : `${title}. ${body}`
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

export interface Reminder {
  /** Which reminder of the game it is, the same on every poll, so a retry books only the ones missing. */
  moment: string
  /** Device clock, in milliseconds. */
  at: number
  text: string
}

/**
 * The reminders the native app's game notifications give, for the game the chat is
 * about, plus the notification iOS falls back to when it cannot ring an alarm.
 * A registered player is told the game is starting, and anyone else that
 * registration is open or about to close. A host that holds the reminder of
 * the registered player rings it itself, so the chat books none for them.
 * The closing notices come an hour before registration closes and again ten
 * minutes before, each only on a window longer than its lead, since on a
 * shorter one the opening notice stands in for it. Every game on the schedule
 * gets them too, as the native app books its closing notice, so a worker not
 * polling when that registration opens still has them.
 * The chain creates a game, and opens its registration, as soon as the game
 * before it has settled, which is long before the registration start its
 * schedule projects. The opening notice of every game is therefore booked for
 * ten minutes after the game before it starts settling, which lets the player
 * finish the draw and chest of that game, or a few seconds from now when those
 * ten minutes have passed.
 * Every moment carries the play time of its game, so a rescheduled game, or
 * the next one, is a new moment and the old one is cancelled.
 */
export function remindersFor(
  read: ChainRead,
  hostReminds = false,
  previousGameEndsAt?: number,
  now = Date.now(),
): { gamePlayTime: number; registered: boolean; hostReminds: boolean; reminders: Reminder[] } | null {
  const offset = read.clockOffsetMs
  const opening = (gamePlayTime: number, previousEndsAt: number | undefined): Reminder => ({
    moment: `opens:${gamePlayTime}`,
    at: Math.max(previousEndsAt === undefined ? -Infinity : previousEndsAt * 1000 - offset + AFTER_GAME_OPENS_DELAY_MS, now + OPENS_DELAY_MS),
    text: notice("Register for the next game now", "Prizes and other perks await!"),
  })
  const closing = (game: { gamePlayTime: number; registrationStarts: number; registrationEnds: number }): Reminder[] => {
    const closesAt = game.registrationEnds * 1000 - offset
    const windowMs = (game.registrationEnds - game.registrationStarts) * 1000
    const notices: Reminder[] = [
      {
        moment: `close-1h:${game.gamePlayTime}`,
        at: closesAt - 60 * MIN,
        text: notice("Game starts in an hour", "Register now, prizes and collectibles await!"),
      },
      {
        moment: `close-10m:${game.gamePlayTime}`,
        at: closesAt - 10 * MIN,
        text: notice("10 minutes left to register", "Register now, prizes and collectibles await!"),
      },
    ]
    return notices.filter((reminder) => closesAt - reminder.at < windowMs)
  }
  const running = read.running
  // reportingEnds closes the report window and starts settling, which is the
  // previous-game end chosen for this ten-minute quiet period.
  const endBeforeNext = running && running.phase !== "cancelled" ? running.reportingEnds : previousGameEndsAt
  const scheduled = read.upcoming.flatMap((game, i) => [
    opening(game.gamePlayTime, i === 0 ? endBeforeNext : read.upcoming[i - 1]!.reportingEnds),
    ...closing(game),
  ])
  if (running && (running.phase === "registration" || running.phase === "shuffle" || running.phase === "reporting")) {
    const startsAt = running.gamePlayTime * 1000 - offset
    const registered = running.registered === true
    const month = MONTHS[new Date(startsAt).getMonth()]!
    const reminders: Reminder[] = registered
      ? hostReminds
        ? []
        : [
          {
            moment: `start-5m:${running.gamePlayTime}`,
            at: startsAt - 5 * MIN,
            text: notice(`Join the ${month} game`, "The game starts in 5 min! Join for free to win amazing prizes!"),
          },
          {
            moment: `start-1m:${running.gamePlayTime}`,
            at: startsAt - MIN,
            text: notice("Game starting now!", "The game is about to start! Join and get ready for fun and rewards!"),
          },
          { moment: `start-20s:${running.gamePlayTime}`, at: startsAt - 20_000, text: notice("Game Starts in 20 Seconds!", "The game is starting! Jump in!") },
        ]
      : running.phase === "registration"
        ? [opening(running.gamePlayTime, previousGameEndsAt), ...closing(running)]
        : []
    return { gamePlayTime: running.gamePlayTime, registered, hostReminds, reminders: [...reminders, ...scheduled] }
  }
  const upcoming = read.upcoming[0]
  if (!upcoming) return null
  return { gamePlayTime: upcoming.gamePlayTime, registered: false, hostReminds: false, reminders: scheduled }
}

/** The reminders of the registered player alone, which the gate of Register waits for. */
function startReminders(reminders: Reminder[]): Reminder[] {
  return reminders.filter((reminder) => reminder.moment.startsWith("start-"))
}

// The worker's own reminder calls run one at a time: the poll's reminder and
// booking, the gate of Register and the drop of a lost sign-up. Two bookings
// that read the same record would both push every reminder, and a gate that
// reads the record while a cancel is in flight takes a reminder as held that
// the host is dropping.
let reminderQueue: Promise<unknown> = Promise.resolve()
let notificationPermissionState: DevicePermissionOutcome | "not-requested" = "not-requested"
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = reminderQueue.then(task, task)
  reminderQueue = run.catch(() => {})
  return run
}

/**
 * Book the reminders of the game the chat is about, once per game and
 * sign-up. A sign-up changes which ones apply, so it cancels the booked ones
 * first. Reminders already due are skipped rather than fired late.
 */
export function scheduleReminders(host: WorkerHost, read: ChainRead, hostReminds = false, retryNow = false): Promise<void> {
  return oneAtATime(() => bookReminders(host, read, hostReminds, retryNow))
}

/**
 * Whether every reminder of the registered player still to come is with the
 * host, booked or started. A cancel the host refused leaves the booking
 * incomplete but takes nothing from the reminders in place.
 */
function remindersBooked(booked: Scheduled, read: ChainRead): boolean {
  if (!booked.moments) return booked.complete !== false
  const now = Date.now()
  return startReminders(remindersFor(read)?.reminders ?? []).every((reminder) => {
    const moment = booked.moments![reminder.moment]
    return reminder.at <= now || (moment !== undefined && (moment.id !== null || moment.pushing === true))
  })
}

// The booking record the storage refused, which stands in for it until a write
// lands: a booking a run, rather than none at all. Storage stays the primary
// record, and the memory is written back to it as soon as it takes writes.
let memoryBooking: Scheduled | null = null

/** Writes the booking record, or keeps it in memory when the storage refuses it. */
async function claimBooking(host: WorkerHost, value: Scheduled): Promise<boolean> {
  if (await tryWriteJSON(host, NOTIFICATIONS_KEY, value)) {
    memoryBooking = null
    return true
  }
  memoryBooking = value
  return false
}

/** The booking record: the one held in memory (written back now if it can be) over the stored one. */
async function bookingRecord(host: WorkerHost): Promise<Scheduled | null | undefined> {
  const remembered = memoryBooking
  if (remembered) {
    await claimBooking(host, remembered)
    return remembered
  }
  return readJSON<Scheduled>(host, NOTIFICATIONS_KEY)
}

/**
 * The booking itself, at most once per moment. The record is the only memory
 * of what the host holds, so it goes first, as a claim on every moment about
 * to be pushed, with a write that reports failure: without it nothing is
 * pushed. Each id is recorded as it comes back. A push that hit its deadline
 * may still have been booked, so its moment stays claimed with no id and is
 * never pushed again: a missing reminder is better than a doubled one, and
 * the booking stays incomplete. The retry pushes nothing for that moment and
 * reports the booking complete, so the one incomplete count is the only
 * signal of that unconfirmed moment. A push the host refused leaves its moment
 * claimed with no id, for the retry. A cancel the host refused keeps its id,
 * to cancel again on the next booking until its time has passed.
 */
async function bookReminders(host: WorkerHost, read: ChainRead, hostReminds: boolean, retryNow: boolean, sentPastItsLifetime = false) {
  const finishActivity = beginChatActivity("notification-booking")
  try {
    return await bookRemindersUnderActivity(host, read, hostReminds, retryNow, sentPastItsLifetime)
  } finally {
    finishActivity()
  }
}

async function bookRemindersUnderActivity(host: WorkerHost, read: ChainRead, hostReminds: boolean, retryNow: boolean, sentPastItsLifetime: boolean) {
  // A registration the chain could not read is not a sign-out, and booking on
  // it would ring "register now" at a registered player within seconds.
  if (isUpcoming(read.running) && read.running.registered === null) return
  // Taken before the reminders are stamped, so a slow record read cannot put
  // the opening notice of a few seconds in the past.
  const now = Date.now()
  const storedGames = await readJSON<SeenGame[]>(host, GAMES_KEY)
  if (storedGames === undefined) return
  const games = storedGames ?? []
  const target = read.running?.phase === "registration" ? read.running : read.upcoming[0]
  const previousGameEndsAt = target
    ? games
      .filter((game) => (read.running?.phase === "registration" ? game.index < read.running.index : game.gamePlayTime < target.gamePlayTime))
      .sort((a, b) => b.gamePlayTime - a.gamePlayTime)[0]?.endsAt
    : undefined
  const due = remindersFor(read, hostReminds, previousGameEndsAt, now)
  if (!due) return
  const booked = await bookingRecord(host)
  // Without the booking the worker cannot cancel what it booked before, so a
  // failed read books nothing rather than book it all twice.
  if (booked === undefined) return
  // A sign-up on the wire can land well after its record lapses, so its
  // opening notice stays if the host has it and is never pushed again.
  const silenced = sentPastItsLifetime && read.running ? `opens:${read.running.gamePlayTime}` : null
  const started = (held: { id: number | null; pushing?: boolean } | undefined) => held !== undefined && (held.id !== null || held.pushing === true)
  const wanted = due.reminders.filter((reminder) => reminder.at > now && (reminder.moment !== silenced || started(booked?.moments?.[reminder.moment])))
  const names = new Set(wanted.map((reminder) => reminder.moment))
  // A moment the record holds under a wanted name already belongs to the
  // host: the clock offset of a poll moves its time by a block, which is no
  // change. An older record knows its ids but not their moments, so it is
  // replaced whole.
  const held = Object.entries(booked?.moments ?? {})
  const moments: NonNullable<Scheduled["moments"]> = Object.fromEntries(held.filter(([moment]) => names.has(moment)))
  const dropped: { id: number | null; at?: number }[] = booked?.moments
    ? held.filter(([moment]) => !names.has(moment)).map(([, old]) => old)
    : (booked?.ids ?? []).map((id) => ({ id }))
  const ahead = (stale: { at?: number }) => stale.at === undefined || stale.at > now
  const retired = dropped
    .flatMap((old) => (old.id === null ? [] : [{ id: old.id, ...("at" in old ? { at: old.at } : {}) }]))
    .filter(ahead)
  // A cancel the host refused waits for the retry, so it leaves the booking
  // settled and only a moment dropped on this poll is cancelled now.
  const toCancel = [...(booked?.stale ?? []), ...retired].filter(ahead)
  // The moments of a game change while nothing else does: the "opens" of the
  // one scheduled game gives way to its closing notices once its registration
  // is open. A moment the record never claimed is booked whatever the record
  // says, and a moment it holds that is no longer wanted is cancelled.
  const settled =
    booked?.gamePlayTime === due.gamePlayTime &&
    booked.registered === due.registered &&
    (booked.hostReminds ?? false) === due.hostReminds &&
    retired.length === 0 &&
    wanted.every((reminder) => reminder.moment in moments)
  if (settled) {
    if (booked.complete !== false) return
    if (booked.permissionRefused && notificationPermissionState !== "granted") return
    if (!retryNow && booked.retryAt !== undefined && now < booked.retryAt) return
  }

  // A moment claimed but never started (a claim that landed after its
  // deadline, or a worker stopped before it got there) is pushed now. One
  // whose push started may be booked, and is never pushed again.
  const unpushed = (moment: string) => !(moment in moments) || (moments[moment]!.id === null && !moments[moment]!.pushing)
  const pending = wanted
    .filter((reminder) => unpushed(reminder.moment))
    // A refused push keeps its claimed time. A later read can lose the
    // previous-game context, but a retry must never move that notice earlier.
    .map((reminder) => ({ ...reminder, at: Math.max(reminder.at, moments[reminder.moment]?.at ?? -Infinity) }))
  for (const reminder of pending) moments[reminder.moment] = { id: null, at: reminder.at }
  const record = (complete: boolean, stale: { id: number; at?: number }[], permissionRefused = false): Scheduled => ({
    gamePlayTime: due.gamePlayTime,
    registered: due.registered,
    hostReminds: due.hostReminds,
    ids: idsOf(moments),
    moments: { ...moments },
    stale,
    complete,
    ...(complete || permissionRefused ? {} : { retryAt: Date.now() + BOOKING_RETRY_MS }),
    ...(permissionRefused ? { permissionRefused: true } : {}),
  })
  // A claim the storage refuses is kept in memory and the booking goes on.
  const claim = (value: Scheduled) => claimBooking(host, value)
  await claim(record(false, toCancel))

  const stale: { id: number; at?: number }[] = []
  let cancelFailed = 0
  for (const old of toCancel) {
    try {
      await within(host.notifications.cancel(old.id))
      chatCount("chat.notif.cancel", { outcome: "cancelled", permission: notificationPermissionState }, { key: "cancelled" })
    } catch (error) {
      cancelFailed++
      chatCount(
        "chat.notif.cancel",
        { outcome: error instanceof CallDeadlineError ? "timed-out" : "failed", permission: notificationPermissionState },
        { key: error instanceof CallDeadlineError ? "timed-out" : "failed", detail: { error: describeError(error) } },
      )
      // A reminder that already fired is gone, and an id of an older record
      // whose time is unknown is tried once.
      if (old.at !== undefined) stale.push(old)
    }
  }

  let failed = 0
  let timedOut = 0
  let permissionRefused = 0
  let withDeeplink = 0
  let withoutDeeplink = 0
  for (const reminder of pending) {
    const deeplink = `${spaPage(REMINDER_PATH)}&moment=${encodeURIComponent(reminder.moment.split(":", 1)[0]!)}`
    // The mark goes in before the push. Without it the push is left for the
    // retry, since the record would still say the moment was never started.
    moments[reminder.moment] = { id: null, at: reminder.at, pushing: true }
    await claim(record(false, stale))
    if (memoryBooking) countMemoryClaim("reminder")
    try {
      moments[reminder.moment] = { id: await within(host.notifications.push({ text: reminder.text, scheduledAt: reminder.at, deeplink })), at: reminder.at }
      withDeeplink++
    } catch (deeplinkError) {
      const refusedForPermission = /permission.*(?:denied|not granted)|not granted.*permission/i.test(describeError(deeplinkError))
      // A host refusal is fresher than the permission answer cached at boot.
      // Only a later permission request that reads granted may unlock this booking.
      if (refusedForPermission) notificationPermissionState = "not-granted"
      chatCount(
        "chat.notif.push",
        {
          outcome: deeplinkError instanceof CallDeadlineError ? "timed-out" : "failed",
          form: "deeplink",
          permission: notificationPermissionState,
        },
        { key: `deeplink:${deeplinkError instanceof CallDeadlineError ? "timed-out" : "failed"}`, detail: { error: describeError(deeplinkError) } },
      )
      if (deeplinkError instanceof CallDeadlineError) {
        timedOut++
        void workerLog.append(host, "error", `notif push timed out, booked or not: ${deeplinkError.message}`)
        continue
      }
      if (refusedForPermission) {
        permissionRefused++
        moments[reminder.moment] = { id: null, at: reminder.at }
      } else try {
        moments[reminder.moment] = { id: await within(host.notifications.push({ text: reminder.text, scheduledAt: reminder.at })), at: reminder.at }
        withoutDeeplink++
      } catch (fallbackError) {
        chatCount(
          "chat.notif.push",
          {
            outcome: fallbackError instanceof CallDeadlineError ? "timed-out" : "failed",
            form: "plain",
            permission: notificationPermissionState,
          },
          { key: `plain:${fallbackError instanceof CallDeadlineError ? "timed-out" : "failed"}`, detail: { error: describeError(fallbackError) } },
        )
        if (fallbackError instanceof CallDeadlineError) {
          timedOut++
          continue
        }
        // The moment stays claimed with no id, so the record still knows it and
        // the retry, not the next poll, pushes it again.
        failed++
        moments[reminder.moment] = { id: null, at: reminder.at }
        void workerLog.append(
          host,
          "error",
          `notif push failed with and without deeplink: ${(deeplinkError as Error)?.message}; ${(fallbackError as Error)?.message}`,
        )
      }
    }
    await claim(record(false, stale))
  }
  // A refused cancel keeps the booking incomplete too, so the retry cancels it again.
  const pushed = failed === 0 && timedOut === 0 && permissionRefused === 0
  const complete = failed === 0 && timedOut === 0 && permissionRefused === 0 && stale.length === 0
  await claim(record(complete, stale, permissionRefused > 0))
  chatCount(
    "chat.notif.book",
    {
      complete: String(complete),
      failed: String(failed),
      cancelled_failed: String(cancelFailed),
      with_deeplink: String(withDeeplink),
      without_deeplink: String(withoutDeeplink),
      permission: notificationPermissionState,
    },
    { key: complete ? "complete" : "incomplete" },
  )
  const ids = idsOf(moments)
  void workerLog.append(
    host,
    pushed ? "success" : "error",
    `Notification booking for game at ${due.gamePlayTime} (registered ${due.registered}): ${ids.length} of ${Object.keys(moments).length} reminder ids, ${
      pushed ? "complete" : permissionRefused > 0 && failed === 0 && timedOut === 0 ? "permission refused; waiting for permission" : "incomplete; retry scheduled"
    } (${withDeeplink} with deeplink, ${withoutDeeplink} without).`,
  )
}

// The pass lives 30 minutes, so one fetched 15 minutes before the game still
// has the 10 the app keeps in hand when its mesh opens.
const TURN_PASS_LEAD_S = 15 * 60
const TURN_PASS_LOW_MS = 10 * MIN
const TURN_PASS_RETRY_MS = MIN
let turnPassFetching = false
let turnPassFailedAt: number | null = null

/** Whether the player will soon need a pass: registered, and the game starts within 15 minutes or has turns left. */
function turnPassWanted(read: ChainRead, nowMs: number): boolean {
  const running = read.running
  if (!isUpcoming(running) || running.registered !== true) return false
  const chainNowS = (nowMs + read.clockOffsetMs) / 1000
  return chainNowS >= running.gamePlayTime - TURN_PASS_LEAD_S && chainNowS < running.playEnds
}

/** Whether a stored pass needs replacing: missing, or with under 10 minutes left. */
function turnPassStale(stored: unknown, nowMs: number): boolean {
  return !isTurnPass(stored) || turnPassLeftMs(stored, nowMs) < TURN_PASS_LOW_MS
}

/**
 * Fetches a TURN pass into host storage when the player will soon need one
 * and the stored one will not do, one at a time and not within a minute of
 * a failed try. Never throws.
 */
export async function keepTurnPass(host: WorkerHost, read: ChainRead, nowMs = Date.now()): Promise<void> {
  if (turnPassFetching || !turnPassWanted(read, nowMs)) return
  if (turnPassFailedAt !== null && nowMs - turnPassFailedAt < TURN_PASS_RETRY_MS) return
  turnPassFetching = true
  try {
    const issuer = deviceUniquenessBackendUrl()
    const account = await host.productAccount(productAccount(), signupAccountIndex())
    if (!account) return
    const key = turnPassKey(productAccount(), account, [issuer])
    const stored = await readJSON<unknown>(host, key)
    if (stored === undefined || !turnPassStale(stored, nowMs)) return
    const timestamp = Math.floor((nowMs + read.clockOffsetMs) / 1000)
    const outcome = await host.turnPass({ productId: productAccount(), account, issuer, timestamp })
    if ("pass" in outcome) {
      if (!(await tryWriteJSON(host, key, outcome.pass))) {
        turnPassFailedAt = nowMs
        chatFailure("chat-turn-pass-failed", "write-failed", { stage: "store" }, { "turn.stage": "store" })
        return
      }
      turnPassFailedAt = null
      void workerLog.append(host, "info", `TURN pass kept for ${Math.round(turnPassLeftMs(outcome.pass, Date.now()) / MIN)} min`)
      return
    }
    turnPassFailedAt = nowMs
    chatFailure(
      "chat-turn-pass-failed",
      outcome.cause,
      { stage: outcome.stage, reason: outcome.reason },
      { "turn.stage": outcome.stage, ...(outcome.status !== undefined ? { "turn.status": String(outcome.status) } : {}) },
    )
  } catch (error) {
    turnPassFailedAt = nowMs
    chatFailure("chat-turn-pass-failed", "threw", { error: describeError(error) })
  } finally {
    turnPassFetching = false
  }
}

function isUpcoming(game: RunningGame | null): game is RunningGame {
  return game?.phase === "registration" || game?.phase === "shuffle" || game?.phase === "reporting"
}

/** The device clock in seconds, which every countdown reads: the pill of the host and the Humanity card count on it, and the chain clock runs a block or two behind it. */
const deviceNowSeconds = () => Math.floor(Date.now() / 1000)

/** The game the player is registered for and has yet to play, with its start on the device clock. */
export function registeredStart(read: ChainRead): { gamePlayTime: number; startsAt: number } | null {
  const running = read.running
  if (!isUpcoming(running) || running.registered !== true) return null
  return { gamePlayTime: running.gamePlayTime, startsAt: running.gamePlayTime * 1000 - read.clockOffsetMs }
}

/**
 * Keep the reminder of the host on the game the player is registered for:
 * ask for it on a sign-up and when the game moves, and drop it when the
 * player is out or the game is called off. Resolves whether the host holds it.
 */
export function keepHostReminder(host: WorkerHost, read: ChainRead, retryNow = false): Promise<boolean> {
  return oneAtATime(() => keepReminder(host, read, retryNow))
}

type ObservedHostReminder = HostReminder & { outSeenObservation?: number }

async function keepReminder(host: WorkerHost, read: ChainRead, retryNow = false, observation?: number): Promise<boolean> {
  const stored = await readJSON<ObservedHostReminder>(host, HOST_REMINDER_KEY)
  // Without the record the worker would ask the host again on every poll.
  if (stored === undefined) return false
  const running = read.running
  const holds = (gamePlayTime: number) => stored?.outcome === "held" && stored.gamePlayTime === gamePlayTime
  const mayHold = (gamePlayTime: number) => possiblyHeld(stored) && stored!.gamePlayTime === gamePlayTime
  // A registration the chain could not read is not a sign-out, and cancelling
  // on it would delete the alarm and the calendar entry on every flaky read.
  if (isUpcoming(running) && running.registered === null) return holds(running.gamePlayTime)
  // BetweenGames is also an uncertain read while the held game's start is
  // still ahead. Require the same second observation used for explicit false.
  if (
    running === null &&
    stored &&
    possiblyHeld(stored) &&
    (stored.startsAt ?? stored.gamePlayTime * 1000) > Date.now() &&
    (!stored.outSeen || (observation !== undefined && stored.outSeenObservation === observation))
  ) {
    if (!stored.outSeen) {
      await writeJSON(host, HOST_REMINDER_KEY, { ...stored, outSeen: true, ...(observation === undefined ? {} : { outSeenObservation: observation }) } satisfies ObservedHostReminder)
    }
    return holds(stored.gamePlayTime)
  }
  // One read of "not registered" can be a block behind the sign-up, so the
  // reminder goes on the second such read in a row.
  if (
    isUpcoming(running) &&
    running.registered === false &&
    mayHold(running.gamePlayTime) &&
    (!stored!.outSeen || (observation !== undefined && stored!.outSeenObservation === observation))
  ) {
    if (!stored!.outSeen) {
      await writeJSON(host, HOST_REMINDER_KEY, { ...stored!, outSeen: true, ...(observation === undefined ? {} : { outSeenObservation: observation }) } satisfies ObservedHostReminder)
    }
    return holds(running.gamePlayTime)
  }
  const due = registeredStart(read)
  if (!due) return cancelHostReminder(host, stored, running)
  if (stored?.gamePlayTime === due.gamePlayTime) {
    if (stored.outcome === "held") {
      if (stored.outSeen) {
        await writeJSON(host, HOST_REMINDER_KEY, { ...stored, outSeen: false, outSeenObservation: undefined } satisfies ObservedHostReminder)
      }
      return true
    }
    if (stored.outcome === "starts-in-past" || (stored.outcome === "unsupported" && !retryNow)) return false
    if (!retryNow && stored.outcome !== "dropped" && Date.now() < (stored.at ?? 0) + BOOKING_RETRY_MS) return false
  }
  const store: HostReminderStore = {
    read: () => within(host.storage.readJSON<HostReminder>(HOST_REMINDER_KEY)),
    write: (record) => within(host.storage.writeJSON(HOST_REMINDER_KEY, record)),
  }
  let askError: string | undefined
  const ask = (startsAt: number) => {
    const asked = host.game.remindNextGame(startsAt, (text) => (askError = text))
    return within(asked).catch((error) => {
      askError = describeError(error)
      // The host may hold the call while it asks the player, and hold the
      // reminder after the deadline. That answer is recorded when it comes.
      if (error instanceof CallDeadlineError) {
        void asked.then(
          (late) => {
            if (late === "held") void oneAtATime(() => recordLateHold(host, due.gamePlayTime, startsAt))
          },
          () => {},
        )
      }
      return "failed" as const
    })
  }
  // A minute ahead of kickoff, so the host brings the player in for the dial.
  const outcome = await askUnderClaim(ask, store, stored, due.gamePlayTime, joinAtMs(due.gamePlayTime))
  chatCount(
    "chat.reminder.ask",
    { outcome, retry: String(retryNow) },
    { key: outcome, ...(askError ? { detail: { error: askError } } : {}) },
  )
  // The host keeps a reminder it could not replace, which would ring for the old start.
  if (outcome !== "held" && outcome !== "unrecorded" && stored?.outcome === "held") {
    let cancelError: string | undefined
    const cancelled = await within(host.game.cancelNextGame((text) => (cancelError = text))).catch((error) => {
      cancelError = describeError(error)
      return "failed" as const
    })
    if (cancelled !== "dropped" && cancelled !== "unsupported") {
      chatCount("chat.reminder.cancel", { outcome: cancelled, why: "replace" }, { key: "replace", ...(cancelError ? { detail: { error: cancelError } } : {}) })
    }
  }
  void workerLog.append(
    host,
    outcome === "held" ? "success" : outcome === "unsupported" ? "info" : "error",
    `Game reminder for game at ${due.gamePlayTime} answered ${outcome}.`,
  )
  return outcome === "held"
}

/**
 * Whether the host may hold the reminder the record is about. An ask that
 * timed out ("failed") may have been held after its deadline, and one whose
 * answer could not be recorded stays "asking", so both are treated as held
 * when the player is out. A cancel is safe whether the host holds one or not.
 */
function possiblyHeld(record: HostReminder | null | undefined): boolean {
  return record?.outcome === "held" || record?.outcome === "asking" || record?.outcome === "failed"
}

/** Records a held answer that came after its ask was given up on, unless a newer word stands in the record. */
async function recordLateHold(host: WorkerHost, gamePlayTime: number, startsAt: number) {
  const record = await readJSON<HostReminder>(host, HOST_REMINDER_KEY)
  if (!record || record.gamePlayTime !== gamePlayTime || (record.outcome !== "failed" && record.outcome !== "dropped")) return
  await writeJSON(host, HOST_REMINDER_KEY, { gamePlayTime, startsAt: record.startsAt ?? startsAt, outcome: "held", at: Date.now() } satisfies HostReminder)
  chatCount("chat.reminder.ask", { outcome: "held-late", retry: "false" }, { key: "held-late" })
  void workerLog.append(host, "info", `Game reminder for game at ${gamePlayTime} answered held after its deadline.`)
}

/** The read with the player registered for the game it is about, for a sign-up under way. */
function asJoining(read: ChainRead): ChainRead {
  return isUpcoming(read.running) ? { ...read, running: { ...read.running, registered: true } } : read
}

/**
 * The read as the reminders go by it: registered for a sign-up under way in
 * this product or in Humanity, and unknown while the record of this product
 * cannot be read and that of Humanity shows no sign-up.
 *
 * A `registering` record of the chat counts only through `joining`. Outside a
 * sign-up of this worker it was left by a worker that stopped before its `sent`
 * write, and the chain is the answer for it. A `registering` record of
 * Humanity is a signer still open, and its push waits for `sent`. The host
 * lets Humanity cancel none of the pushes of this product, so its sign-ups
 * reach them only here.
 *
 * A `sent` record of this product past its lifetime leaves the chain the
 * answer, but its sign-up may still land, so no opening notice is pushed for
 * it. Only the newest record of this product is stored, so a later `failed`
 * or a newer sign-up replaces it.
 */
async function signUpView(host: WorkerHost, read: ChainRead, joining: boolean): Promise<{ view: ChainRead; sentPastItsLifetime: boolean }> {
  const view = (read: ChainRead) => ({ view: read, sentPastItsLifetime: false })
  if (joining) return view(asJoining(read))
  if (!isUpcoming(read.running) || read.running.registered === true) return view(read)
  const index = read.running.index
  const joins = (record: GameRegistration | null) =>
    record !== null &&
    record.gameIndex === index &&
    record.phase !== "failed" &&
    (record.phase !== "registering" || record.surface === "app")
  const [stored, humanity] = await Promise.all([readJSON<unknown>(host, GAME_REGISTRATION_KEY), humanityRegistration(host)])
  if (joins(humanity)) return view(asJoining(read))
  if (stored === undefined) return view({ ...read, running: { ...read.running, registered: null } })
  if (joins(liveGameRegistration(stored, Date.now()))) return view(asJoining(read))
  const raw = stored as Partial<GameRegistration> | null
  return { view: read, sentPastItsLifetime: raw?.phase === "sent" && raw.gameIndex === index }
}

/**
 * The live record of a sign-up from Humanity, or null.
 *
 * A read Humanity storage refuses leaves the chain the answer, as no record
 * does: unknown would hold every booking of a host that grants no such read.
 */
async function humanityRegistration(host: WorkerHost): Promise<GameRegistration | null> {
  try {
    return await humanityRecords(host).read()
  } catch {
    return null
  }
}

/** The records Humanity keeps in its own storage, which this product may only read. */
function humanityRecords(host: WorkerHost) {
  return gameRegistrationStore(async () => ({
    readJSON: (key) => within(host.storage.readProductJSON<unknown>(personhoodProduct(), key)),
  }))
}

/**
 * The gate of Register from the chat. Null once the reminders of the game are
 * in place, else the notice that says why they are not.
 *
 * The game product registers only once the host holds its reminder, which
 * brings the alarm, the pill and the calendar entry. Every other product gets
 * `unsupported` from truapi, so the notifications the chat books itself stand
 * in for it. A tap takes the answer of an ask still under way, and asks once
 * more when the host refuses, since the host may give up on the call while it
 * asks the player for the alarm. A player who refused the reminders before is
 * asked again.
 */
export function remindersInPlace(
  host: WorkerHost,
  read: ChainRead | null,
  gameProduct = IS_GAME_PRODUCT,
  reportBlocked: (reason: string, needs?: SignupNeed) => void = () => {},
  refreshRead: () => Promise<ChainRead | null> = async () => null,
): Promise<string | null> {
  return oneAtATime(() => reminderGate(host, read, gameProduct, reportBlocked, refreshRead))
}

async function reminderGate(
  host: WorkerHost,
  read: ChainRead | null,
  gameProduct: boolean,
  reportBlocked: (reason: string, needs?: SignupNeed) => void,
  refreshRead: () => Promise<ChainRead | null>,
): Promise<string | null> {
  let retried = false
  // Why Register is held back, so a reminder block can be told from a failed sign-up.
  const blocked = (reason: string, notice: string, needs?: SignupNeed) => {
    reportBlocked(reason, needs)
    chatCount("chat.register.blocked", { reason, retried: String(retried) }, { key: reason })
    return notice
  }
  const needsNotifications = (reason: string) => blocked(reason, cardCopy.NOTIFICATIONS_REQUIRED, "notifications")
  let joining = read && asJoining(read)
  let due = joining && registeredStart(joining)
  if (!joining || !due) {
    const fresh = await refreshRead()
    if (fresh) {
      joining = asJoining(fresh)
      due = registeredStart(joining)
    }
  }
  if (!joining) return blocked("chain-unread", cardCopy.SIGN_UP_FAILED)
  if (!due) return blocked("no-game-to-join", cardCopy.SIGN_UP_FAILED)
  await answerUnderWay(host, due.gamePlayTime)
  if (await keepReminder(host, joining, true)) return null
  let record = await readJSON<HostReminder>(host, HOST_REMINDER_KEY)
  if (record?.gamePlayTime === due.gamePlayTime && (record.outcome === "failed" || record.outcome === "denied" || record.outcome === "dropped")) {
    retried = true
    if (await keepReminder(host, joining, true)) return null
    record = await readJSON<HostReminder>(host, HOST_REMINDER_KEY)
  }
  const otherGame = record && record.gamePlayTime !== due.gamePlayTime
  // The host never answered, or its answer could not be recorded, so the gate asks it again.
  if (!otherGame && (!record || record.outcome === "asking")) {
    if (notificationPermissionState !== "granted") await requestNotificationPermission(host)
    if (notificationPermissionState === "not-granted") return needsNotifications(record ? "ask-asking" : "no-record")
    if (notificationPermissionState !== "granted") return blocked(`permission-${notificationPermissionState}`, cardCopy.SIGN_UP_FAILED)
  }
  if (otherGame || !record || record.outcome === "asking") {
    if (await keepReminder(host, joining, true)) return null
    record = await readJSON<HostReminder>(host, HOST_REMINDER_KEY)
    if (!record || record.outcome === "asking" || record.gamePlayTime !== due.gamePlayTime) return blocked("reminder-unanswered", cardCopy.SIGN_UP_FAILED)
  }
  if (record.outcome === "held" || record.outcome === "starts-in-past") return null
  if (record.outcome === "failed") return needsNotifications("ask-failed")
  if (record.outcome !== "unsupported") return needsNotifications(`reminders-${record.outcome}`)
  if (gameProduct) return blocked("reminders-unsupported", cardCopy.REMINDERS_UNSUPPORTED, "update")
  await requestNotificationPermission(host)
  await bookReminders(host, joining, false, true)
  const booked = await bookingRecord(host)
  const inPlace = booked?.gamePlayTime === due.gamePlayTime && booked.registered && remindersBooked(booked, joining)
  return inPlace ? null : needsNotifications("notifications-not-booked")
}

/**
 * Waits while the record shows an ask for the game under way, from the app or
 * an earlier tap, so the gate takes its answer rather than ask over it.
 *
 * An ask is under way for as long as a host call may take from its claim, and
 * the wait is never longer than that either.
 */
async function answerUnderWay(host: WorkerHost, gamePlayTime: number): Promise<void> {
  const giveUpAt = Date.now() + ASK_UNDER_WAY_MS
  for (;;) {
    const record = await readJSON<HostReminder>(host, HOST_REMINDER_KEY)
    if (!askUnderWay(record, gamePlayTime) || Date.now() >= giveUpAt) return
    await new Promise((resolve) => setTimeout(resolve, ANSWER_POLL_MS))
  }
}

/** Drops the reminder the gate asked for, when the sign-up for that game went nowhere. */
function dropReminderOfLostSignup(host: WorkerHost, gameIndex: number): Promise<void> {
  return oneAtATime(() => dropLostReminder(host, gameIndex))
}

async function dropLostReminder(host: WorkerHost, gameIndex: number) {
  const running = latest?.running
  // Ending a local sign-up is not a second chain observation. Mark an explicit
  // false as the first uncertain read and let a later poll confirm/cancel it;
  // null is never evidence that the player is out.
  if (!running || running.index !== gameIndex || running.registered !== false) return
  const stored = await readJSON<HostReminder>(host, HOST_REMINDER_KEY)
  if (!stored || stored.gamePlayTime !== running.gamePlayTime || !possiblyHeld(stored)) return
  if (!stored.outSeen) {
    await writeJSON(host, HOST_REMINDER_KEY, {
      ...stored,
      outSeen: true,
      ...(latestObservation === undefined ? {} : { outSeenObservation: latestObservation }),
    } satisfies ObservedHostReminder)
  }
}

export type ReminderCancelWhy = "called-off" | "game-over" | "no-game" | "unregistered"

/** Why a held reminder is being cleaned up; a missing read is not game over. */
export function reminderCancelWhy(reminderGamePlayTime: number | undefined, running: RunningGame | null): ReminderCancelWhy {
  if (running === null) return "no-game"
  if (reminderGamePlayTime !== undefined && running.gamePlayTime !== reminderGamePlayTime) return "game-over"
  if (running.phase === "cancelled") return "called-off"
  if (running.phase === "settling") return "game-over"
  return "unregistered"
}

async function cancelHostReminder(
  host: WorkerHost,
  stored: HostReminder | null,
  running: RunningGame | null,
): Promise<boolean> {
  // The app asks on its own sign-up, and its ask can land while this cancel
  // is in flight, so a game called off is cancelled on every poll whatever
  // the record says. The cancel is safe whether the host holds a reminder or
  // not, and the phase lasts a few blocks.
  const calledOff = running?.phase === "cancelled"
  if (!possiblyHeld(stored) && !calledOff) return false
  if (!calledOff && stored?.retryAt !== undefined && Date.now() < stored.retryAt) return false
  const gamePlayTime = possiblyHeld(stored) ? stored!.gamePlayTime : running!.gamePlayTime
  let cancelError: string | undefined
  const outcome = await within(host.game.cancelNextGame((text) => (cancelError = text))).catch((error) => {
    cancelError = describeError(error)
    return "failed" as const
  })
  // A repeat on a game already dropped is quiet.
  if (calledOff && stored?.gamePlayTime === running.gamePlayTime && stored.outcome === "dropped") return false
  chatCount("chat.reminder.cancel", { outcome, why: reminderCancelWhy(stored?.gamePlayTime, running) }, {
    key: outcome,
    ...(cancelError ? { detail: { error: cancelError } } : {}),
  })
  const dropped = outcome === "dropped" || outcome === "unsupported"
  // An ask that landed during the cancel wrote a newer record, which this
  // one must not overwrite.
  const latestRecord = await readJSON<HostReminder>(host, HOST_REMINDER_KEY)
  if (latestRecord !== undefined && JSON.stringify(latestRecord) !== JSON.stringify(stored)) return false
  await writeJSON(host, HOST_REMINDER_KEY, {
    gamePlayTime,
    // The next ask for this game sends the start the host saw first.
    ...(stored?.gamePlayTime === gamePlayTime && stored.startsAt !== undefined ? { startsAt: stored.startsAt } : {}),
    outcome: dropped ? "dropped" : "held",
    at: Date.now(),
    ...(dropped ? {} : { retryAt: Date.now() + BOOKING_RETRY_MS }),
  } satisfies HostReminder)
  void workerLog.append(
    host,
    outcome === "dropped" ? "success" : outcome === "unsupported" ? "info" : "error",
    `Game reminder cancel answered ${outcome}.`,
  )
  return false
}

type DevicePermissionOutcome = "granted" | "not-granted" | "failed" | "timed-out"

function permissionErrorClass(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error && typeof error.name === "string" && error.name) return error.name
  return typeof error
}

type DevicePermissionResult = { outcome: DevicePermissionOutcome; error?: string; errorClass?: string }

/**
 * Asks the host for a device, gives it PERMISSION_WAIT_MS and counts the result as `metric`.
 *
 * `unanswered` is the outcome of an err Result, which holds no answer of the player.
 */
async function askDevice(
  host: WorkerHost,
  device: "Camera" | "Notifications",
  metric: string,
  unanswered: DevicePermissionOutcome,
): Promise<DevicePermissionResult & { answer: Promise<boolean | undefined> }> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  const answer = host.permissions.requestDevice(device)
  const result = await Promise.race<DevicePermissionResult>([
    answer.then(
      (granted) => ({ outcome: granted === undefined ? unanswered : granted ? "granted" : "not-granted" }),
      (error: unknown) => ({ outcome: "failed", error: describeError(error), errorClass: permissionErrorClass(error) }),
    ),
    new Promise<DevicePermissionResult>((resolve) => {
      deadline = setTimeout(() => resolve({ outcome: "timed-out" }), PERMISSION_WAIT_MS)
    }),
  ]).finally(() => {
    if (deadline !== undefined) clearTimeout(deadline)
  })
  chatCount(
    metric,
    { outcome: result.outcome, ...(result.errorClass ? { error_class: result.errorClass } : {}) },
    { key: result.outcome, ...(result.error ? { detail: { error: result.error } } : {}) },
  )
  return { ...result, answer }
}

/** The answer of the player once it is stored for the card, else undefined. */
async function askCamera(host: WorkerHost): Promise<"on" | "off" | undefined> {
  const { outcome, answer } = await askDevice(host, "Camera", "chat.camera.permission", "failed")
  if (outcome === "timed-out") void storeLateCamera(host, answer)
  if (outcome !== "granted" && outcome !== "not-granted") return undefined
  return storeCamera(host, outcome === "granted")
}

async function storeCamera(host: WorkerHost, granted: boolean): Promise<"on" | "off" | undefined> {
  const answer = granted ? "on" : "off"
  return (await tryWriteJSON(host, `${CAMERA_KEY}:${productAccount()}`, answer)) ? answer : undefined
}

/** Keeps an answer that came after the wait, which the card picks up at its next sync. */
async function storeLateCamera(host: WorkerHost, answer: Promise<boolean | undefined>) {
  const granted = await answer.catch(() => undefined)
  if (granted === undefined) return
  chatCount("chat.camera.permission", { outcome: "late" }, { key: "late" })
  await storeCamera(host, granted)
}

async function requestNotificationPermission(host: WorkerHost): Promise<void> {
  const result = await askDevice(host, "Notifications", "chat.notif.permission", "not-granted")
  const { outcome } = result
  notificationPermissionState = outcome
  const message =
    outcome === "granted"
      ? "Notification permission granted."
      : outcome === "not-granted"
        ? "Notification permission not granted."
        : outcome === "failed"
          ? `Notification permission request failed (${result.errorClass ?? "unknown error"}).`
          : `Notification permission request timed out after ${PERMISSION_WAIT_MS / 1000} seconds.`
  void workerLog.append(host, outcome === "granted" ? "success" : outcome === "timed-out" ? "info" : "error", message)
}

/** The name link of this worker (./name-gate.ts), over the account the sign-up uses. */
let nameGate: NameGate | undefined
function nameGateFor(host: WorkerHost): NameGate {
  const log = (kind: "info" | "error", text: string) => void workerLog.append(host, kind, text)
  nameGate ??= createNameGate(
    (trigger, signal) => linkNameFromChat(host, { name: productAccount(), index: signupAccountIndex() }, log, trigger, signal),
    log,
  )
  return nameGate
}

/** The player is back on the card: a username nobody owned is checked again
 *  past the gate's hold, at most once per NAME_UNOWNED_RECHECK_MS (#1115). */
export function recheckUnownedName(host: WorkerHost): void {
  const gate = nameGateFor(host)
  if (gate.unowned()) gate.recheck()
}

/** The sign-up from the chat, over the client and the account the reads use. */
function signupFor(host: WorkerHost): Signup {
  let engine: { people: People; value: SignupEngine } | undefined
  return createSignup({
    host,
    async connect() {
      const [people, address] = await Promise.all([connect(host), playerAddress(host)])
      if (!people || !address) return null
      if (engine?.people !== people) engine = { people, value: signupEngine(people) }
      return { engine: engine.value, address }
    },
    account: { name: productAccount(), index: signupAccountIndex() },
    remindersInPlace: (reportBlocked) =>
      remindersInPlace(host, latest, IS_GAME_PRODUCT, reportBlocked, async () => {
        const [people, address] = await Promise.all([within(connect(host)), within(playerAddress(host))])
        return people ? within(readGame(host, people, address)) : null
      }),
    reportInterrupted: () => reportInterruptedSignup(host),
    openApp: () => openGame(host),
    // the names on the prize-draw wheel (#456): linked ahead of Register,
    // which never signs up without it
    nameInPlace: () => nameGateFor(host).inPlace(),
    nameUnowned: () => nameGateFor(host).unowned(),
    linkName: () => nameGateFor(host).request("register"),
    log: (kind, text) => void workerLog.append(host, kind, text),
  })
}

/** The claim of a won prize from the card, over the client and the account the sign-up uses. */
function claimsFor(host: WorkerHost): Claims {
  let engine: { people: People; value: GameEngine } | undefined
  let reads: People | undefined
  return createClaims({
    host,
    async connect() {
      const [people, address] = await Promise.all([connect(host), playerAddress(host)])
      if (!people || !address) return null
      reads = people
      if (engine?.people !== people) engine = { people, value: signupEngine(people) }
      return { engine: engine.value, address }
    },
    claimed: async (address, gameIndex, airdropIndex) => (reads ? readClaimed(reads, address, gameIndex, airdropIndex) : undefined),
    account: { name: productAccount(), index: signupAccountIndex() },
    log: (kind, text) => void workerLog.append(host, kind, text),
  })
}

/**
 * A won prize claimed by itself, the fallback of the app's draw screen
 * (lib/draw/auto-claim.ts), which claims at once: the poll asks only after the
 * game has settled, and only while the read says the chain would pay it. One
 * try per game for this run of the worker, so a signing the player declined is
 * not asked again on every poll; the card's Claim button is there for another try.
 */
export function autoClaimFor(claims: Pick<Claims, "claim" | "state">): AutoClaim {
  const tried = new Set<number>()
  return (gameIndex, drawIndex) => {
    if (tried.has(gameIndex) || claims.state(gameIndex) !== undefined) return
    tried.add(gameIndex)
    void claims.claim(gameIndex, drawIndex)
  }
}

/** The results of a slot whose prize this run of the worker claimed, before the next poll reads it. */
function claimedSlot(slot: GameSlot, claimed: boolean): GameSlot {
  if (!claimed || slot.kind !== "results" || !slot.results.prize) return slot
  return { ...slot, results: { ...slot.results, prize: { ...slot.results.prize, claimed: true, claimable: false } } }
}

/**
 * chat.start, once per worker start, the denominator of every other chat
 * count: how the room registered, what the footer answered and whether the
 * host gave the worker storage at all. Never throws.
 */
async function reportStart(host: WorkerHost, roomStatus: string, footer: Promise<string>): Promise<void> {
  try {
    // Resolve identity in parallel: a quick answer tags the interrupted
    // journey, while a host that never answers cannot hold recovery back.
    const addressReady = within(Promise.resolve(playerAddress(host))).catch(() => null)
    void addressReady.then(setChatUser)
    await reportInterruptedSignup(host)
    const address = await addressReady
    setChatUser(address)
    await learnUsername(host)
    const storageOk = (await readJSON(host, INTRO_KEY)) !== undefined
    // A host that drops the footer's answer must not hold chat.start back.
    const footerOutcome = await within(footer).catch(() => "no-answer")
    chatCount("chat.start", { room_status: roomStatus, footer: footerOutcome, storage_ok: String(storageOk) })
  } catch {
    /* telemetry never disturbs the worker */
  }
}

export async function main(host: WorkerHost): Promise<void> {
  // This proof must precede room setup, rules, permission prompts and
  // migrations: any of those can take longer than the app's startup grace.
  startWorkerHeartbeat(host)
  installGlobalErrorTelemetry()
  if (host.hostInfo) {
    hostInfoReady = host
      .hostInfo()
      .then(({ info, failed }) => {
        setChatHost(info, failed)
        slideRegister = drawsSlideToConfirm(info)
      })
      .catch(() => setChatHost(null, true))
  } else {
    setChatHost(null, true)
    hostInfoReady = Promise.resolve()
  }
  const signup = signupFor(host)
  const claims = claimsFor(host)
  const autoClaim = autoClaimFor(claims)
  artWellFor(host)
  const dailyDollar = createDailyDollar({ host, connect: () => connect(host), now: () => Math.floor(Date.now() / 1000) })
  const workerScratch = createWorkerScratchCard(host)
  let joined: number | null = null
  signup.subscribe(() => {
    const state = signup.state()
    joiningGame = state.kind === "busy" || state.kind === "sent" ? state.gameIndex : null
    if (state.kind === "sent") void fitDockAfterSignup(host, state.gameIndex)
    // The host was asked before the sign-up, so a sign-up that ends without
    // reaching the wire drops the alarm now rather than two polls later. A
    // hand-off keeps it: the app takes the sign-up over under the same record,
    // and the poll's two-read rule still drops it if the player never signs up.
    const handedOff = state.kind === "idle" && state.handedOff === joined
    if (joined !== null && joiningGame === null && !handedOff) void dropReminderOfLostSignup(host, joined)
    joined = state.kind === "busy" ? state.gameIndex : null
  })
  // The iOS app refuses a bot on both of its chat runtimes, and the room works
  // without one, so a refusal only logs.
  host.chat
    .registerBot(BOT_ID, BOT_NAME, BOT_ICON)
    .then((status) => chatCount("chat.bot.register", { outcome: String(status).toLowerCase() }, { key: "answered" }))
    .catch((e) => {
      console.error(TAG, "registerBot", e)
      // Unsupported is the host's answer on iOS, not a failure.
      const unsupported = /unsupported|not supported/i.test(describeError(e))
      chatCount("chat.bot.register", { outcome: unsupported ? "unsupported" : "failed" }, { key: "rejected", detail: { error: describeError(e) } })
    })

  within(host.chat.registerRoom(ROOM_ID, ROOM_NAME, ROOM_ICON))
    .then(async (status) => {
      void workerLog.clear(host)
      void workerLog.append(host, "info", `The worker is online, and registerRoom answered ${status}.`)
      roomRegistered = true
      // After the log is cleared, so their lines stay, and before the poll, the
      // one reader of what a migration rewrites.
      const migrated = runMigrations(host)
      // The room takes no typed message, since every move is a button on a card.
      const footer = bootFooter(host).catch(() => "failed")
      void reportStart(host, String(status), footer)
      // The first card of a game comes after the rules, as the chat design has it.
      await deliverIntro(host).catch((error) => console.error(TAG, "The rules could not be posted.", error))
      // Only a DD_SCRATCH=worker build posts the scratch card this worker draws; its ticket and claim are stand-ins.
      if (typeof __DD_SCRATCH__ !== "undefined" && __DD_SCRATCH__ === "worker") {
        await workerScratch.post().catch((error) => console.error(TAG, "The Daily Dollar scratch card could not be posted.", error))
      }
      // A prompt nobody answers must not hold back the poll that every card
      // waits for.
      await requestNotificationPermission(host)
      await migrated
      startLoop(host, dailyDollar, autoClaim)
    })
    .catch((e) => {
      console.error(TAG, "registerRoom", e)
      chatFailure("host-call-failed", "registerRoom", { error: describeError(e) })
      void reportStart(host, "failed", Promise.resolve("skipped"))
      void runMigrations(host).finally(() => startLoop(host, dailyDollar, autoClaim))
    })

  host.renderer.onRender((req, send, onAction) => {
    console.log(TAG, `render requested for ${req.messageType} ${req.messageId}`)
    if (req.messageType === MESSAGE_WELCOME) return renderWelcomeCardHandler(host, send, onAction)
    if (req.messageType === MESSAGE_INTRO) return renderIntroHandler(host, req, send)
    if (req.messageType === MESSAGE_GAME_CARD) {
      // a player back in the chat, maybe from setting their username up in
      // Humanity (#1115): an unowned username is checked again at once
      recheckUnownedName(host)
      return renderGameCardHandler(host, signup, claims, req, send, onAction)
    }
    if (req.messageType === MESSAGE_DAILY_DOLLAR) return dailyDollar.render(req.payload, send, onAction)
    if (req.messageType === MESSAGE_DD_SCRATCH) return workerScratch.render(req, send, onAction)
    if (req.messageType === MESSAGE_MEMBERSHIP) return renderMembershipHandler(host, req, send, onAction)
    send({ tag: "Nil" })
    return undefined
  })
}

// Vitest sets process.env.VITEST, and the real QuickJS runtime has no process
// at all, so this boots in production and stays quiet under test.
if (typeof process === "undefined" || !process.env?.VITEST) {
  void main(createWorkerHost())
}

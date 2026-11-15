// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Signs the player up from the chat with the engine the app signs up with, so
 * the sign-up carries a ticket the host signs for every prize draw of the game.
 *
 * A draw takes tickets only inside the sign-up call, and no call enters one
 * afterwards, so registering from the chat means the worker signs up itself.
 * It decides the seat with `seatFor`, the way the home screen of the app does,
 * binds the lite alias first when the free route has no binding yet, and hands
 * the engine what the host does for a sign-up in the product SDK's terms
 * (`GameRegistrationCapabilities`): the signer and the submission, the draw
 * tickets, and the personhood keys for the lite proof and a recognized
 * person's draw proofs, which is the only entry the chain takes from a member.
 * The seat, the bind and the sign-up are @individuality/sign-up's chain side,
 * over the SDK's `registerForGame`. When the draw cannot be entered the
 * sign-up still goes, without the ticket, and the journey says why.
 *
 * The engine comes from `@jollity/game-chain/engine` over the unsafe API of the
 * worker client, which keeps the 865 KB of descriptors the typed API needs out
 * of the QuickJS bundle. Both APIs decode with the metadata of the chain, and
 * the unsafe one only skips the compatibility checks.
 *
 * An unfunded account opens the app, which says how much is missing, and so
 * does a host that hands over no signer.
 *
 * Every step of a sign-up is also kept in host storage under
 * `GAME_REGISTRATION_KEY`, the record of @individuality/shared-records
 * that the home of the app and other products read instead of offering
 * Register (issues 694 and 1316): registering from the tap, sent from the
 * broadcast, registered once the chain holds the player, failed when it ended
 * any other way, and cleared when the app takes the sign-up over or the watch
 * ran out. The transaction is watched for `REGISTRATION_WATCH_MS` from the
 * broadcast, since the readers judge by it how long a sent record counts.
 */
import type { PeopleClient } from "@jollity/game-chain"
import { createChainEngine } from "@jollity/game-chain/engine"
import { cardCopy, type SignupStep } from "./card"
import {
  COMMUNICATION_KEY_KEY,
  gameRegistrationStore,
  parseCommunicationKey,
  REGISTRATION_WATCH_MS,
  registrationInFlight,
  type GameRegistration,
  type GameRegistrationStore,
  type RegistrationPhase,
} from "@individuality/shared-records"
import { COMMUNICATION_ENTROPY_CONTEXT, network, type GameEngine } from "@jollity/protocol"
import {
  BIND_TIMEOUT_MS,
  communicationKeyFrom,
  communicationKeyRecord,
  drawResult,
  reusableCommunicationKey,
  signupFailureReason,
} from "@individuality/sign-up"
import { classifyHostFailure, dispatchErrorName, isNonceRefusal, isTrackingStopped } from "@individuality/people-chain"
import type {
  GameRegistrationCapabilities,
  GameSeat,
  SignUpSubmitResult,
  SubmitSignUp,
} from "@parity/product-sdk-individuality"
import { AccountId } from "polkadot-api"
import type { People } from "./chain"
import type { WorkerHost } from "./host"
import { tryWriteJSON, within } from "./state"
import { chatCount, chatFailure, chatJourney, describeError, describeErrorChain, isExpected, type ChatJourney } from "./telemetry"

/** What the card shows of a sign-up from the chat. */
export type SignupState =
  /**
   * `handedOff` names the game a sign-up went to the app for, which takes it
   * over under the same reminder. `unsettled` names one whose transaction was
   * broadcast but neither settled nor showed on chain in time, left to the poll.
   */
  | { kind: "idle"; handedOff?: number; unsettled?: number }
  /** `step` is the one it is in, which the card shows as how far it got. */
  | { kind: "busy"; gameIndex: number; step: SignupStep }
  /** On the wire, so the card shows the player registered before the chain does. */
  | { kind: "sent"; gameIndex: number }
  /** `needs` names what the player has to allow or set up before a tap can sign up. */
  | { kind: "failed"; gameIndex: number; notice: string; needs?: SignupNeed }

/** What a gate of the sign-up can wait on the player for: the reminders, a
 *  username the People chain knows (set up in Humanity), or a host new
 *  enough to remind. */
export type SignupNeed = "notifications" | "username" | "update"

/** The calls of the engine a sign-up makes: the shared sign-up's chain side. */
export type SignupEngine = Pick<GameEngine, "seat" | "holdsLiteKey" | "bind" | "register">

export interface SignupDependencies {
  host: WorkerHost
  /** The engine and the address the app plays as, or null while the host hands over no chain or account. */
  connect: () => Promise<{ engine: SignupEngine; address: string } | null>
  /** The product account that signs, the one the app plays as. */
  account: { name: string; index: number }
  /** Null once the reminders of the game are in place, else the notice that keeps Register from signing up. */
  remindersInPlace: (blocked: (reason: string, needs?: SignupNeed) => void) => Promise<string | null>
  /** Reports a stopped worker's older attempt before this worker can replace its record. */
  reportInterrupted: () => Promise<boolean>
  /** Opens the app, for a sign-up only the app can make. */
  openApp: () => Promise<unknown>
  /** The name link (./name-gate.ts): `linked` once the player's username is
   *  linked to the account, or `not-linked` when the wait ran out. A sign-up
   *  never goes without it (#456). */
  nameInPlace?: () => Promise<"linked" | "not-linked">
  /** Whether the latest link found that nobody owns the username on the
   *  People chain: the gate then answers `not-linked` at once (#1115). */
  nameUnowned?: () => boolean
  /** Asks for the name link once more after a sign-up from here lands
   *  (./name-link.ts): a no-op once it is linked, which the sign-up waited
   *  for. Never part of the sign-up itself. */
  linkName?: () => void
  log?: (kind: "info" | "error", text: string) => void
}

export interface Signup {
  state(): SignupState
  subscribe(listener: () => void): () => void
  /** Signs up for the game, unless a sign-up is already on its way. */
  register(gameIndex: number): Promise<void>
}

/**
 * The dispatch errors of a sign-up that came after registration closed, by the
 * names of the Game pallet's own errors, which is what `engine.register`
 * reports. The SDK's seat blocker tags (NotInRegistration and the like) never
 * come back from a dispatch.
 */
const CLOSED_CODES: ReadonlySet<string> = new Set(["NoRegistration", "NoGame", "GameOngoing"])

/**
 * How long one host or chain call of a sign-up may take before the sign-up
 * ends failed. product-sdk-host drops its answer for a call truapi rejects,
 * and a call that never answers would hold the sign-up (busy, the card
 * spinning, every later tap dropped) for the life of the worker. The signer
 * gets longer, since the host may ask the player first.
 *
 * `SENT_TTL_MS` in @individuality/shared-records counts on the step deadline
 * for the chain read after the watch of the transaction, so the two move
 * together.
 */
export const SIGNUP_STEP_DEADLINE_MS = 30_000
export const SIGNER_DEADLINE_MS = 60_000
const HANDOFF_MARKER_WAIT_MS = 2_000

/** The key the host derives the communication identifier of every sign-up from. */

/** The engine of the app over the unsafe API of the worker client, as the header says. */
export function signupEngine(people: People): GameEngine {
  return createChainEngine({ client: people.client, api: people.api as unknown as PeopleClient["api"] }, { tld: network().dotnsTLD })
}

/**
 * The sign-up's submission, as the SDK's `registerForGame` hands it over
 * (`SubmitSignUp`): the transaction's own watch, which the worker reads
 * without product-sdk-tx. It settles at the block `waitFor` names, says when
 * the transaction is on the wire, and never throws: a refused signing is
 * `refused`, a watch that lost the transaction is `landingUnknown`, and an
 * abort before the broadcast sends nothing.
 */
export const submitSignUp: SubmitSignUp = (tx, signer, options) =>
  new Promise<SignUpSubmitResult>((resolve) => {
    let settled = false
    let broadcast = false
    // the watch may answer while subscribe is still running, before `sub` is set
    // eslint-disable-next-line prefer-const
    let sub: { unsubscribe(): void } | undefined
    const done = (result: SignUpSubmitResult) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener("abort", onAbort)
      sub?.unsubscribe()
      resolve(result)
    }
    const onAbort = () => {
      if (!broadcast) done({ ok: false, code: "Aborted" })
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })
    sub = tx.createSubmitAndWatch(signer).subscribe({
      next: (event) => {
        if (event.type === "broadcasted") {
          broadcast = true
          options.onBroadcast?.()
        } else if (event.type === "finalized" || (event.type === "inBestBlock" && options.waitFor === "best-block")) {
          done(event.ok ? { ok: true } : { ok: false, code: dispatchErrorName(event.dispatchError) })
        }
      },
      error: (error) => {
        const message = describeError(error)
        done({
          ok: false,
          code: dispatchErrorName(error),
          message,
          cause: error,
          ...(signingRefused(message) ? { refused: true } : {}),
          ...(isTrackingStopped(error) ? { landingUnknown: true } : {}),
        })
      },
      complete: () =>
        done({ ok: false, code: "Dropped", message: "the watch ended before any block held the transaction", landingUnknown: true }),
    })
    if (settled) sub.unsubscribe()
  })

/** A signing the player cancelled, by the words the shared host classifier
 *  reads as a decline (@individuality/people-chain), as the app's flow reads it. */
export const signingRefused = (errorText: string): boolean => classifyHostFailure(errorText) === "declined"

/** A skip reason is free text; the journey keeps it short and readable. */
const maskedReason = (reason: string) => describeError(reason).slice(0, 120)

/** The failures the player's own answer makes expected, as the app's markExpected does. */
const expectedAttrs = (reason: string): Record<string, string> => (isExpected("signup-failed", reason) ? { "journey.expected": "true" } : {})

/** A sign-up that did not land: the failure event carries the same reason as its journey end. */
function reportSignupFailure(reason: string, route: string, error: string): void {
  chatFailure("signup-failed", reason, { route, error })
}

/** What a sign-up learned on its way, for its journey and its failure event. */
interface Trace {
  journey: ChatJourney
  /** Stable identity written after every journey end. */
  attempt: number
  /** the step it is in: the stage a failure is filed under */
  stage: "reminders" | "name" | "signer" | "route" | "bind" | "register"
  route?: string
  /** when the player tapped Register, device clock ms */
  startedAt?: number
  /** the transaction went out, so a failure after it says nothing of whether it landed */
  wired?: boolean
  /** reads the seat again, set once the sign-up has an engine */
  reread?: () => Promise<GameSeat>
}

/**
 * How long a failure after the broadcast waits before the chain is read, about
 * two blocks, as LANDING_WAIT_MS in lib/game-source.ts. A sign-up has landed
 * after the host said "Tracking stopped".
 */
export const LANDING_WAIT_MS = 12_000

/** Where the last run's journey left its mark, so a record is reported once. */
const SIGNUP_REPORTED_KEY = "jollity.signup.reported"

/** The shared store of the record over this worker's host storage, with the deadlines and the telemetry of ./state. */
function registrationStore(host: WorkerHost): GameRegistrationStore {
  return gameRegistrationStore(async () => ({
    readJSON: (key) => within(host.storage.readJSON(key)),
    writeJSON: async (key, value) => void (await tryWriteJSON(host, key, value)),
  }))
}

/**
 * Ends a journey before its durable marker, then retries one failed host write.
 * Every normal and interrupted sign-up end goes through this ordering.
 */
async function endSignupJourney(
  host: WorkerHost,
  journey: ChatJourney,
  identity: number,
  outcome: string,
  attrs?: Record<string, string>,
  ended?: () => void,
): Promise<void> {
  journey.end(outcome, attrs)
  ended?.()
  if (!(await tryWriteJSON(host, SIGNUP_REPORTED_KEY, identity))) {
    await tryWriteJSON(host, SIGNUP_REPORTED_KEY, identity)
  }
}

const interruptedReports = new WeakMap<object, Promise<boolean>>()

/**
 * A sign-up record a stopped worker left in host storage was never ended, and
 * a chat journey is sent only when it ends, so the worker that starts next
 * sends it as interrupted. At most once per host instance, and never throws.
 */
export async function reportInterruptedSignup(host: WorkerHost): Promise<boolean> {
  const active = interruptedReports.get(host)
  if (active) return active
  const reporting = (async () => {
    try {
      const record = await registrationStore(host).read()
      const reported = await within(host.storage.readJSON<number>(SIGNUP_REPORTED_KEY))
      // An ended record was ended by its own run; one the app made is the app's.
      if (!record || !registrationInFlight(record) || record.surface !== "chat") return true
      const identity = record.attempt
      // Never broadcast, so it can never land: end it, or Humanity holds
      // Registering over it until the record times out.
      if (record.phase === "registering") {
        await within(registrationStore(host).write({ ...record, phase: "failed", at: Date.now(), reason: "interrupted" }))
      }
      if (reported === identity) return true
      const journey = chatJourney("game-signup", {
        "signup.game_index": String(record.gameIndex),
        "signup.age_ms": String(Math.max(0, Date.now() - record.at)),
        ...(record.phase === "sent" ? { "signup.broadcast": "true" } : {}),
      })
      journey.markSad("worker-stopped")
      await endSignupJourney(host, journey, identity, "interrupted", {
        "signup.stage": record.phase,
        "journey.interrupted_by": "worker-restart",
      })
      return true
    } catch {
      /* telemetry never disturbs the worker */
      return false
    }
  })()
  interruptedReports.set(host, reporting)
  const recovered = await reporting
  // A clean empty/read result is final for this worker. A failed read is not:
  // the next startup path or tap must be allowed to try the old record again.
  if (!recovered && interruptedReports.get(host) === reporting) interruptedReports.delete(host)
  return recovered
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createSignup(dependencies: SignupDependencies): Signup {
  const { host, account } = dependencies
  const listeners = new Set<() => void>()
  let current: SignupState = { kind: "idle" }
  // Once a bind is refused for good the seat stops counting the person, for
  // the life of the worker, as the app does for the life of its page.
  let liteClosed = false
  // How many sign-ups the player started in this run, for the journey's attempt.
  let attempts = 0
  // A stopped attempt belongs to the previous worker run. Recover it once,
  // before this run can write its first busy record.
  let interruptedRecovery: Promise<boolean> | undefined

  // The store writes one record after the other, so a slow write of the tap never lands after the end.
  const store = registrationStore(host)
  let marked: GameRegistration | null = null
  // Fixed at the tap and carried by every record of the attempt, so the marker of
  // a finished attempt matches whichever phase the storage holds.
  let attemptId = 0
  /** Writes the record of the phase. The steps of a busy sign-up change the card, never the record. */
  const mark = (gameIndex: number, phase: RegistrationPhase, reason?: string) => {
    if (marked?.phase === phase && marked.gameIndex === gameIndex) return
    const record: GameRegistration = { gameIndex, phase, surface: "chat", at: Date.now(), attempt: attemptId, ...(reason ? { reason } : {}) }
    marked = record
    void store.write(record)
  }
  /** Clears the record: the sign-up is nobody's to show any more. */
  const unmark = () => {
    marked = null
    void store.write(null)
  }

  const show = (next: SignupState) => {
    current = next
    for (const listener of listeners) listener()
  }

  const endJourney = <T extends SignupState>(trace: Trace, outcome: string, next: T, attrs?: Record<string, string>, waitMs?: number): Promise<T> => {
    const ended = () => {
      // `sent` on the card is a sign-up the chain holds; on the wire it was `show`n at the broadcast.
      if (next.kind === "sent") mark(next.gameIndex, "registered")
      else if (next.kind === "failed") mark(next.gameIndex, "failed", attrs?.["signup.stage"] ?? outcome)
      // handed to the app, which writes its own, or left to the poll
      else unmark()
      show(next)
    }
    const ending = endSignupJourney(host, trace.journey, trace.attempt, outcome, attrs, ended)
    const waited = waitMs === undefined ? ending : within(ending, waitMs).catch(() => undefined)
    return waited.then(() => next)
  }

  /** After a failure that follows the broadcast: does the chain hold the player after all? */
  const landedAfterFailure = async (trace: Trace, errorText: string): Promise<boolean> => {
    if (!trace.wired || !trace.reread || signupFailureReason(errorText, trace.stage) === "signing-refused") return false
    await new Promise((resolve) => setTimeout(resolve, LANDING_WAIT_MS))
    const now = await within(trace.reread(), SIGNUP_STEP_DEADLINE_MS).catch(() => null)
    return now?.registered === true
  }

  /**
   * Whether this person takes the free route: the SDK's `holdsLiteKey`. A
   * chain whose score context no host mints in is no lite ring, and nobody.
   * A read or a key listing that failed says nothing about the person, and
   * taking them for nobody would sign up on the deposit route, so it fails
   * the sign-up instead.
   */
  const lite = async (engine: SignupEngine, capabilities: GameRegistrationCapabilities): Promise<boolean> =>
    liteClosed ? false : within(engine.holdsLiteKey(capabilities), SIGNUP_STEP_DEADLINE_MS)

  /** The SDK's seat at the best block, told whether this is a lite person. */
  const readSeat = async (engine: SignupEngine, address: string, litePerson: boolean): Promise<GameSeat> =>
    within(engine.seat(address, { litePerson }), SIGNUP_STEP_DEADLINE_MS)

  // The deadline of the app, since a host that drops its answer, as
  // product-sdk-host 0.24 does for a call truapi rejects, leaves the bind
  // settled by nothing. The abort reaches the SDK's reads and its watch,
  // so a bind given up on sends nothing more, and the next tap cannot put a
  // second one in flight beside it.
  const bind = async (engine: SignupEngine, capabilities: GameRegistrationCapabilities): Promise<"bound" | "closed"> => {
    const deadline = new AbortController()
    try {
      const result = await within(engine.bind(capabilities, { signal: deadline.signal }), BIND_TIMEOUT_MS)
      if (result.kind !== "refused") return "bound"
      if (!result.permanent) throw new Error(result.detail)
      liteClosed = true
      dependencies.log?.("info", `The lite route is closed for this account: ${result.detail}`)
      return "closed"
    } catch (error) {
      deadline.abort(error)
      throw error
    }
  }

  /** The sign-up goes to the app: recorded with its why, the biggest blind spot of the chat. */
  const handoff = async (gameIndex: number, trace: Trace, why: string): Promise<SignupState> => {
    // An account that cannot pay is a seat the app answers for: expected, as in the app.
    trace.journey.set({ "signup.handoff_reason": why, ...(why === "unfunded" ? { "journey.expected": "true" } : {}) })
    trace.journey.markSad(`handoff-${why}`)
    const next: SignupState = { kind: "idle", handedOff: gameIndex }
    // Opening the app cannot wait on storage indefinitely. If this cap wins,
    // suspension may leave the marker unfinished and the next worker may
    // conservatively report this handoff again as interrupted.
    await endJourney(trace, "handoff", next, undefined, HANDOFF_MARKER_WAIT_MS)
    await dependencies.openApp()
    return next
  }

  const signUp = async (gameIndex: number, trace: Trace): Promise<SignupState> => {
    const { journey } = trace
    const advance = (step: SignupStep) => {
      trace.stage = step === "draws" || step === "sign" ? "register" : step
      mark(gameIndex, "registering")
      show({ kind: "busy", gameIndex, step })
    }
    let blockedReason = "reminders-blocked"
    let blockedNeed: SignupNeed | undefined
    const blocked = await dependencies.remindersInPlace((reason, needs) => {
      blockedReason = reason
      blockedNeed = needs
    })
    if (blocked) {
      // Not a failure of the sign-up itself: chat.register.blocked says why.
      journey.markSad(blockedReason)
      return endJourney(
        trace,
        "blocked",
        { kind: "failed", gameIndex, notice: blocked, ...(blockedNeed && { needs: blockedNeed }) },
        { "signup.stage": "reminders" },
      )
    }
    if (dependencies.nameInPlace) {
      // the name link, run in the background, is usually done by now; a
      // sign-up never goes without it
      advance("name")
      const waitedFrom = Date.now()
      const name = await dependencies.nameInPlace()
      journey.set({ "signup.name": name, "signup.name_wait_ms": String(Date.now() - waitedFrom) })
      if (name === "not-linked" && dependencies.nameUnowned?.()) {
        dependencies.log?.("error", "Nobody owns the username on the People chain: nothing signed, the link checks again later.")
        journey.markSad("name-unowned")
        return endJourney(trace, "blocked", { kind: "failed", gameIndex, notice: cardCopy.NAME_UNOWNED, needs: "username" }, { "signup.stage": "name" })
      }
      if (name === "not-linked") {
        dependencies.log?.("error", "The name is not linked yet: nothing signed, the link goes on in the background.")
        journey.markSad("name-not-linked")
        return endJourney(trace, "blocked", { kind: "failed", gameIndex, notice: cardCopy.SIGN_UP_FAILED }, { "signup.stage": "name" })
      }
    }
    advance("signer")
    const signer = await within(host.accounts.signer(account.name, account.index), SIGNER_DEADLINE_MS)
    const entropy = signer ? await within(host.entropy(COMMUNICATION_ENTROPY_CONTEXT), SIGNUP_STEP_DEADLINE_MS) : null
    const connected = entropy ? await within(dependencies.connect(), SIGNUP_STEP_DEADLINE_MS) : null
    if (!signer || !entropy || !connected) return handoff(gameIndex, trace, !signer ? "no-signer" : !entropy ? "no-entropy" : "no-chain")
    const { engine, address } = connected
    // The game's key as this product keeps it (@individuality/shared-records,
    // communication-key.ts): the one the app kept for this game if there is
    // one, so the product holds one secret per game whichever surface lands,
    // else one from host entropy and the game (QuickJS has no WebCrypto), which
    // a retry in the same game derives again. It is kept before the sign-up
    // goes out. A write that failed does not hold the chat's sign-up: unlike
    // the app's random key, this one can always be derived again from the
    // host's entropy.
    const kept = await within(host.storage.readJSON(COMMUNICATION_KEY_KEY)).catch(() => null)
    let communicationKey = reusableCommunicationKey(parseCommunicationKey(kept), gameIndex)
    if (!communicationKey) {
      communicationKey = communicationKeyFrom(entropy, gameIndex)
      await tryWriteJSON(host, COMMUNICATION_KEY_KEY, communicationKeyRecord(gameIndex, communicationKey))
    }
    const communicationId = communicationKey.publicKey
    // what the host does for the sign-up, as the SDK's registration takes it
    const capabilities: GameRegistrationCapabilities = {
      account: { address, publicKey: AccountId().enc(address) },
      signer,
      submit: submitSignUp,
      signVrf: host.accounts.signVrf(account.name, account.index),
      personhood: host.accounts.personhood(),
    }
    trace.reread = () => engine.seat(address, { litePerson: false })
    advance("route")
    const person = await lite(engine, capabilities)
    let seat = await readSeat(engine, address, person)
    // The app may have signed this account up already, and a second sign-up
    // would only be refused.
    if (seat.registered) {
      return endJourney(trace, "sent", { kind: "sent", gameIndex }, { "signup.landed_by": "already-registered" })
    }
    journey.set({ "signup.bind": "none" })
    if (seat.path === "free" && !seat.ready && person) {
      advance("bind")
      const bound = await bind(engine, capabilities)
      journey.set({ "signup.bind": bound })
      trace.stage = "route"
      seat = bound === "bound" ? { ...seat, ready: true } : await readSeat(engine, address, false)
    }
    trace.route = seat.path
    journey.set({ "signup.route": seat.path })
    if (seat.path === "unfunded") return handoff(gameIndex, trace, seat.path)
    const route = seat.path
    const submit = async () => {
      trace.wired = false
      advance("draws")
      // The watch on the wire is bounded, from the broadcast on. The signing
      // before it is not: that is the player reading a prompt.
      let watchTimer: ReturnType<typeof setTimeout> | undefined
      let watchOver: () => void = () => {}
      const watched = new Promise<"unsettled">((resolve) => (watchOver = () => resolve("unsettled")))
      let drawSkip: { kind: string; skipped: string } | null = null
      // the SDK reads the route afresh and picks the origin it needs; a
      // member's draws take People-ring proofs, not the account's tickets
      const registering = engine.register(capabilities, communicationId, {
        onDraws: (draws) => {
          advance("sign")
          const { entered, skipped, kind } = draws
          const outcome = drawResult(draws)
          journey.set({
            "signup.draws_entered": String(entered),
            "signup.draws_skipped": skipped ? maskedReason(skipped) : "none",
            "signup.draw.outcome": outcome,
            ...(kind ? { "signup.draw.kind": kind } : {}),
            "signup.draw.scheduled": String(draws.scheduled),
            "signup.draw.waited_ms": String(draws.waitedMs),
            "signup.draw.retries": String(draws.retries),
          })
          if (outcome === "skipped") drawSkip = { kind: kind ?? "unknown", skipped: skipped ?? "" }
          dependencies.log?.("info", skipped ? `The sign-up skips the draws: ${skipped}` : `The sign-up enters ${entered} ${entered === 1 ? "draw" : "draws"}.`)
        },
        onBroadcast: () => {
          // the event follows the sign-up: only one that went out without its ticket counts
          if (drawSkip) chatFailure("draw-skipped", drawSkip.kind, { kind: drawSkip.kind, skipped: drawSkip.skipped })
          drawSkip = null
          trace.wired = true
          journey.set({ "signup.broadcast": "true", ...(trace.startedAt ? { "signup.tap_to_broadcast_ms": String(Date.now() - trace.startedAt) } : {}) })
          mark(gameIndex, "sent")
          show({ kind: "sent", gameIndex })
          watchTimer = setTimeout(watchOver, REGISTRATION_WATCH_MS)
        },
      })
      const settled = await Promise.race([registering, watched]).finally(() => clearTimeout(watchTimer))
      // An abandoned watch that settles later must not reject unheard.
      if (settled === "unsettled") registering.catch(() => {})
      return settled
    }
    const holdsPlayer = async (): Promise<boolean> => {
      const now = await readSeat(engine, address, false).catch(() => null)
      return now?.registered === true
    }
    let resent = false
    for (;;) {
      const result = await submit()
      if (result === "unsettled") {
        if (await holdsPlayer()) {
          dependencies.linkName?.()
          return endJourney(trace, "sent", { kind: "sent", gameIndex }, { "signup.landed_by": "watch-timeout" })
        }
        // The transaction may still be in the pool, so this is no failure: the
        // card goes back to what the chain says, and the poll's two-read rule
        // keeps or drops the reminder.
        return endJourney(trace, "unknown", { kind: "idle", unsettled: gameIndex }, { "signup.stage": "watch-timeout" })
      }
      if (result.ok) {
        dependencies.linkName?.()
        return endJourney(trace, "sent", { kind: "sent", gameIndex })
      }
      if (result.error === "AlreadyRegistered") {
        return endJourney(trace, "sent", { kind: "sent", gameIndex }, { "signup.landed_by": "already-registered" })
      }
      if (await landedAfterFailure(trace, result.error)) {
        dependencies.linkName?.()
        return endJourney(trace, "sent", { kind: "sent", gameIndex }, { "signup.landed_by": "reread" })
      }
      if (!resent && isNonceRefusal(result.code)) {
        resent = true
        if (await holdsPlayer()) {
          dependencies.linkName?.()
          return endJourney(trace, "sent", { kind: "sent", gameIndex }, { "signup.landed_by": "reread" })
        }
        chatCount("chat.signup.resend", { "signup.resend_reason": result.code })
        journey.set({ "signup.resend": result.code })
        continue
      }
      dependencies.log?.("error", `The ${route} sign-up from the chat failed: ${result.error}`)
      const closed = CLOSED_CODES.has(result.code ?? result.error)
      const reason = closed ? "window-closed" : signupFailureReason(result.error, "register")
      reportSignupFailure(reason, route, result.error)
      const notice = closed ? cardCopy.REGISTRATION_CLOSED_NOTICE : cardCopy.SIGN_UP_FAILED
      return endJourney(trace, closed ? "closed" : "failed", { kind: "failed", gameIndex, notice }, { "signup.stage": reason, ...expectedAttrs(reason) })
    }
  }

  return {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async register(gameIndex) {
      const cannotStart = (): boolean => {
        if (current.kind === "busy") {
          // A tap while a sign-up is on its way does nothing, and used to leave no trace.
          chatCount("chat.signup.tap_dropped", { "signup.state": current.kind })
          return true
        }
        return current.kind === "sent" && current.gameIndex === gameIndex
      }
      if (cannotStart()) return
      // Feedback is immediate, but the durable busy record waits until the
      // previous worker's record has been recovered.
      show({ kind: "busy", gameIndex, step: "reminders" })
      interruptedRecovery ??= dependencies.reportInterrupted()
      const recovered = await interruptedRecovery
      if (recovered === false) {
        // The old record was never read, so do not overwrite it. A later tap
        // retries the recovery rather than caching this failure.
        interruptedRecovery = undefined
        show({ kind: "idle" })
        return
      }
      attempts += 1
      const startedAt = Date.now()
      attemptId = startedAt
      const journey = chatJourney("game-signup", { "signup.attempt": String(attempts) })
      const trace: Trace = { journey, attempt: attemptId, stage: "reminders" }
      trace.startedAt = startedAt
      mark(gameIndex, "registering")
      try {
        await signUp(gameIndex, trace)
      } catch (error) {
        const text = describeError(error)
        if (await landedAfterFailure(trace, text)) {
          // this attempt's own sign-up landed after all: its tickets want the name too
          dependencies.linkName?.()
          await endJourney(trace, "sent", { kind: "sent", gameIndex }, { "signup.landed_by": "reread" })
        } else {
          dependencies.log?.("error", `The sign-up from the chat failed: ${messageOf(error)}`)
          const reason = signupFailureReason(text, trace.stage)
          reportSignupFailure(reason, trace.route ?? "unknown", describeErrorChain(error))
          await endJourney(trace, "failed", { kind: "failed", gameIndex, notice: cardCopy.SIGN_UP_FAILED }, { "signup.stage": reason, ...expectedAttrs(reason) })
        }
      }
    },
  }
}

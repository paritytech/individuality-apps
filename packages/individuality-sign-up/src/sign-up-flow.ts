// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE SIGN-UP, ONE FLOW ANY SURFACE CAN RUN: an app's Register button, a chat
 * card's or another product's. One tap, and the flow sees the sign-up through
 * every gate in order:
 *
 *  1. one sign-up at a time per player, and none over a sign-up another
 *     surface has on its way for this game (the game registration record of
 *     @individuality/shared-records, which the flow writes of its own sign-up
 *     too);
 *  2. the game reminder the host holds, when the surface asks for one
 *     (./reminder.ts);
 *  3. registration still open, by the chain's clock;
 *  4. the player not registered already (the chain's own best-block row);
 *  5. the seat: its route (./seat.ts), an account that cannot pay ends it
 *     (`SeatUnfundedError`), the free seat's bind (./free-seat.ts) and the name
 *     link (@individuality/name-link's gate) waited for;
 *  6. the sign-up itself, with its prize draw entries, on the chain side
 *     (./chain), signed by the surface's signer;
 *  7. on the wire it counts as in (`optimistic`), and the chain confirms it
 *     or takes it back; a failure after the broadcast reads the chain again
 *     before the next try, so one tap never files two sign-ups.
 *
 * Everything that goes wrong between the tap and the chain is retried on a
 * backoff until it lands or registration closes (./signup-retry.ts). A lite
 * person's seat is bound in the background as soon as a seat is read
 * (`requestBind`), and the name link with it (`requestName`), so the button is
 * ready when registration opens.
 *
 * What only a surface can reach comes in as options: the chain (./chain's
 * `signUpFlowChain`, or an engine of its own that answers the same calls), the
 * SDK's `GameRegistrationCapabilities` (the game account, its signer, the
 * submission, the ticket signer and the personhood keys), the communication identifier
 * (./communication-key.ts), its telemetry, its log, its page lifecycle. The
 * flow keeps no words of a screen: `phase()` says what the sign-up waits for,
 * and each surface words it.
 *
 * Lifted out of the Jollity app, unchanged in what it does.
 */
import {
  registrationRetryDelay as bindRetryDelay,
  type GameRegistrationCapabilities,
  type PersonhoodProver,
  type Seat,
} from "@parity/product-sdk-individuality"
import { BIND_TIMEOUT_MS } from "./free-seat"
import type { Funds } from "./funds"
import type { NameGate, NameLinkTrigger } from "@individuality/name-link"
import { namedSeat, SeatUnfundedError } from "./seat"
import { drawResult, type DrawSkipKind, type SignUpChain, type SignUpFlowChain } from "./sign-up-types"
import { signupFailureReason } from "./signup-failure"
import type { GameRegistration, RegistrationPhase, RegistrationSurface } from "@individuality/shared-records"
import {
  classifyPermanent,
  classifyRetry,
  signupWithRetry,
  waitsOnBind,
  type AttemptResult,
  type ReminderBlock,
  type RetryReason,
  type SignupPhase,
} from "./signup-retry"

/** how one attempt may take before it is abandoned and the chain is
 *  re-read. `chain.register` settles only on finalization or a subscription
 *  error, so a quiet host channel would otherwise hold it for ever. Before the
 *  wire the limit spans the host's signing and the draw read. */
const PRE_WIRE_TIMEOUT_MS = 90_000
/** from the wire: finalization takes ~2 blocks (12 s) on the People chain */
const WIRE_TIMEOUT_MS = 45_000
/** after an error past the broadcast the outcome is unknown: wait about two
 *  blocks and ask the chain before filing again */
const LANDING_WAIT_MS = 12_000
/** a bind that has failed this many times in a row is reported, and the
 *  next attempt opens a fresh person journey */
const PERSON_FAILS_BEFORE_REPORT = 3
/** A sign-up must never wait indefinitely for the read that checks whether its
 * registration window is still open. This is shorter than a general 10 s
 * game-read bound because it blocks an active retry loop and must leave room
 * for the retry's own backoff before the registration deadline. */
const SIGNUP_WINDOW_READ_TIMEOUT_MS = 5_000
/** One host answer that is dropped must not hold a sign-up (#578): product-sdk
 *  -host drops its answer to a call truapi rejects. The lite person's reads
 *  (the chain's proof inputs, the host's listRingVrfKeys) get
 *  this long to answer (the lookup itself goes on, see resolveLite), and
 *  everything that decides the route gets ROUTE_STEP_TIMEOUT_MS. */
const LITE_LOOKUP_TIMEOUT_MS = 10_000
/** a lite lookup unanswered for this long is given up and asked afresh */
const LITE_LOOKUP_STALE_MS = 45_000
const ROUTE_STEP_TIMEOUT_MS = 30_000

/** the attributes a journey, a step, an event or a metric carries */
export type SignUpAttrs = Record<string, string | number>

export interface SignUpStep {
  end(attrs?: SignUpAttrs): void
}

/** One sign-up's record in the surface's telemetry: the steps it went
 *  through, the attributes it learned, and how it ended. */
export interface SignUpJourney {
  set(attrs: SignUpAttrs): void
  step(name: string, attrs?: SignUpAttrs, options?: { startedAt?: number }): SignUpStep
  markSad(reason: string): void
  end(outcome: string, attrs?: SignUpAttrs): void
}

/** Where the flow reports, in the surface's own telemetry: journeys
 *  `game-signup` and `person`, events `signup-failed`, `draw-skipped` and
 *  `person-bind-failed`, the same names from every surface. */
export interface SignUpTelemetry {
  journey(name: "game-signup" | "person", attrs?: SignUpAttrs, options?: { startedAt?: number }): SignUpJourney
  failure(
    kind: "signup-failed" | "draw-skipped" | "person-bind-failed",
    details: { reason: string; context?: Record<string, string> },
    journey?: SignUpJourney,
  ): void
  count(name: string, value: number, attrs: Record<string, string>): void
  distribution(name: string, value: number, unit: "millisecond", attrs: Record<string, string>): void
  /** the sign-up went on the wire */
  broadcast?(player: string, attempt: number, route: string, gameIndex: number | null): void
  /** what the sign-up carried for the prize draw */
  draws?(entered: number, skipped?: string): void
  /** the game this sign-up is for */
  gameIndex?(index: number): void
  /** text safe to put on a tag */
  mask?(text: string): string
}

/** the telemetry of a surface that keeps none */
const NO_STEP: SignUpStep = { end() {} }
const NO_JOURNEY: SignUpJourney = { set() {}, step: () => NO_STEP, markSad() {}, end() {} }
const NO_TELEMETRY: SignUpTelemetry = { journey: () => NO_JOURNEY, failure() {}, count() {}, distribution() {} }

/** The game open for sign-up, as the surface last read it. */
export interface RegistrationWindow {
  index: number
  registrationEnds: number
  gamePlayTime: number
}

/** A read or a transaction the surface may run again, as its host needs (a
 *  host that answered "block not pinned", say). */
export interface SignUpRetryOptions<T> {
  operation: "signup-route" | "signup-seat" | "signup-tx" | "person-bind"
  run: () => Promise<T>
  /** the failed operation's error, or null when the value succeeded */
  errorOf?: (value: T) => unknown | null
  /** a transaction may only be rebuilt before its broadcast */
  retryIf?: () => boolean
  signal?: AbortSignal
}

export interface SignUpFlowOptions {
  chain: SignUpFlowChain
  /** the account that plays (SS58) when there are no capabilities to sign
   *  with: a read-only source. None, and no capabilities: no seat, no sign-up */
  player?: string
  /** What a host does for a sign-up, in the SDK's terms: the game account
   *  (which is the player), its signer and the submission, the ticket signer
   *  and the personhood keys (`hostGameRegistrationCapabilities` of the SDK's
   *  `/host` entry builds them). None: a read-only source. */
  capabilities?: GameRegistrationCapabilities
  /** the communication identifier this sign-up registers for the game, the
   *  slot's as last read (./communication-key.ts) */
  communicationIdentifier: (gameIndex: number | undefined) => Promise<Uint8Array>
  /** the name link the sign-up waits for; none: no name gate */
  nameGate?: NameGate | null
  /** the game reminder gate: null lets the sign-up go; none: no reminder gate.
   *  `window` is the game open for sign-up as last read, if one was */
  reminders?: (window: RegistrationWindow | undefined) => Promise<ReminderBlock | null>
  /** the chain's clock, in seconds */
  nowSeconds: () => number
  /** looks at the host's chain once a sign-up is slow (./signup-retry.ts) */
  probeHostChain?: () => Promise<"lost" | "healthy" | "timeout" | "unknown">
  /** runs a read or a transaction, again where the host needs it; default once */
  retry?: <T>(options: SignUpRetryOptions<T>) => Promise<T>
  /** the page lifecycle, where there is one: a phone that locks freezes timers */
  page?: { hidden(): boolean; watch(onChange: (hidden: boolean) => void): () => void }
  /** the game registration record (@individuality/shared-records) this surface
   *  keeps of its own sign-ups, as `surface`: `write` stores it, or clears it
   *  with null, and logs its own failures. None: the flow writes no record */
  registrationRecord?: { surface: RegistrationSurface; write(record: GameRegistration | null): Promise<void> | void }
  /** after a sign-up landed: check the draw tickets, ask for the game reminder */
  confirmDrawTickets?: (player: string, missKind: DrawSkipKind | null) => void
  remindOfGame?: () => void
  /** where the flow reports; none: it reports nowhere */
  telemetry?: SignUpTelemetry
  /** the flow's own log; none: it logs nowhere */
  log?: (tag: string, message: string, data?: unknown, level?: "info" | "warn" | "error") => void
  /** a read that failed and was taken as unknown; default the log */
  warn?: (message: string, error: unknown) => void
  /** an error in words; default its message */
  describe?: (error: unknown) => string
  /** what the surface adds to the route's log line: the product and the
   *  account index it signs as */
  logFacts?: Record<string, unknown>
}

/** What the flow gives a surface. */
export interface SignUpFlow {
  /** the tap: resolves once the sign-up is on the wire, or once the reminder
   *  gate holds it back; rejects on the player's own refusal or a seat the
   *  account cannot take. Absent without a player and a signer. */
  register?: () => Promise<void>
  /** the page left: stop trying. A sign-up already on the wire stands. */
  cancelRegister(): void
  /** the seat, for a screen: its route, its funds, and whether it would be
   *  ready with the name linked (`bindReady`) */
  readSeat(): Promise<{ seat: Seat; funds: Funds; bindReady: boolean }>
  /** bind the lite person's free seat in the background (a no-op while one runs) */
  requestBind(): void
  /** ask for the name link in the background (a no-op while one runs) */
  requestName(trigger?: NameLinkTrigger): void
  /** what the sign-up under way waits for */
  phase(): SignupPhase
  /** while the seat is getting ready: whether it waits on the name link or
   *  on the free seat's bind */
  waitingOn(): "name" | "bind" | null
  /** a sign-up is under way */
  signingUp(): boolean
  /** the sign-up is on the wire or landed, for `game` */
  optimistic(): { registered: boolean; game: number | undefined }
  /** the game registration record (@individuality/shared-records), as the
   *  surface last read it: its own sign-up's, or another surface's */
  registration(): GameRegistration | null
  setRegistration(record: GameRegistration | null): void
  /** the game slot moved: `window` while it is open for sign-up */
  setSlot(index: number | undefined, window: RegistrationWindow | undefined): void
  /** a new game slot: the optimism and a closed phase of the last one go */
  newSlot(index: number | undefined): void
  /** the chain's own row says the player is registered: the optimism has done its work */
  confirmRegistered(): void
  /** the phase, the optimism or the other surface's record moved */
  onChange(listener: () => void): () => void
  /** a seat input moved: the bind landed or failed, or the name link did */
  onSeatInput(listener: () => void): () => void
}

/** what one tap's attempts share: when the page leaves, and whether the draw's
 *  missing tickets were already reported */
interface RunState {
  stop: () => Promise<void>
  /** the draw-skipped event went out for this tap: once per sign-up, though
   *  a retry decides the draw again */
  drawSkipReported?: boolean
  /** the tap's registration window and the last reason it went again, for the
   *  window check an attempt makes when the page returns */
  window?: { current: { index: number; registrationEnds: number } | undefined }
  lastReason?: () => RetryReason | undefined
  /** the attempt whose broadcast put the optimistic flag up, once one of this
   *  tap's attempts went out: the loop's end takes the flag down through it */
  wireOwner?: object
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A promise with a deadline: its value, or null once `ms` have passed. */
async function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** THE LITE PERSON on this device: the capabilities whose personhood keys
 *  hold their lite key (the SDK's `holdsLiteKey`). Null for everyone else —
 *  nobody the host holds a lite key for, a chain whose score context no host
 *  can mint in. */
interface LiteContext {
  capabilities: GameRegistrationCapabilities
}

/** How this player gets a seat, and what the deposit route costs — the SDK's
 *  seat at the best block (`readGameSeat`), told whether this is a lite person
 *  and whether the flow's own bind landed, with the name link on top.
 *  `bindReady` says whether the seat would be ready with the name linked:
 *  what a seat that is not ready waits on. */
async function readSeat(
  chain: Pick<SignUpChain, "seat">,
  address: string,
  lite: LiteContext | null,
  bound: boolean,
  named: boolean,
): Promise<{ seat: Seat; funds: Funds; bindReady: boolean }> {
  const read = await chain.seat(address, { litePerson: lite !== null, bound })
  const funds: Funds = {
    free: read.funds.free,
    deposit: read.funds.deposit,
    required: read.required,
    decimals: read.funds.decimals ?? 0,
    symbol: read.funds.symbol ?? "UNIT",
  }
  const seat = { path: read.path, ready: read.ready }
  return { seat: namedSeat(seat, named), funds, bindReady: seat.ready }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Builds the sign-up flow a surface runs on a Register tap: every gate in the module header, the sign-up itself and its record. */
export function createSignUpFlow(options: SignUpFlowOptions): SignUpFlow {
  const { chain, capabilities, communicationIdentifier, nowSeconds } = options
  const player = capabilities?.account.address ?? options.player
  const telemetry = options.telemetry ?? NO_TELEMETRY
  const log = options.log ?? (() => {})
  const page = options.page ?? { hidden: () => false, watch: () => () => {} }
  const retry = options.retry ?? (<T>(run: SignUpRetryOptions<T>) => run.run())
  const describe = options.describe ?? messageOf
  const warn = options.warn ?? ((message: string, error: unknown) => log("signup", message, { detail: describe(error) }, "warn"))
  const mask = telemetry.mask ?? ((text: string) => text)

  // OPTIMISTIC REGISTRATION. `chain.register` resolves only on finalization, so
  // the Register button would spin ~2 blocks after the host already broadcast
  // the tx. We flip the UI to "you're in" the moment the tx is on the wire and
  // let the chain confirm it (watchPlayer makes it real, or a dispatch failure
  // rolls it back). Read by `watchStatus` (OR'd into `registered`).
  let optimisticRegistered = false
  // The game the optimism belongs to. Every status subscriber starts without a
  // slot, so "a new slot" alone cannot tell a home that mounts again from a game
  // that changed (#250).
  let optimisticGame: number | undefined
  /** the sign-up call whose broadcast put the flag up: its own outcome takes
   *  it down again, even after its attempt was given up on (#580) */
  let optimisticOwner: object | undefined
  let latestSlotIndex: number | undefined
  let latestRegistrationWindow: { index: number; registrationEnds: number; gamePlayTime: number } | undefined
  const optimisticListeners = new Set<() => void>()
  /** what the sign-up under way is waiting for, for the status (the sign-up
   *  button reads it). Every status subscriber re-emits when it moves. */
  let signupPhase: SignupPhase = "idle"
  const setSignupPhase = (phase: SignupPhase) => {
    if (signupPhase === phase) return
    signupPhase = phase
    optimisticListeners.forEach((notify) => notify())
  }
  const setOptimisticRegistered = (value: boolean) => {
    if (optimisticRegistered === value) return
    optimisticRegistered = value
    optimisticListeners.forEach((notify) => notify())
  }
  /** takes the optimistic flag down, when the call that put it up still owns
   *  it: a later chain confirmation (`optimisticOwner` cleared) or a newer
   *  slot's flag is not this call's to touch */
  const clearOptimistic = (owner: object) => {
    if (optimisticOwner !== owner) return
    optimisticOwner = undefined
    setOptimisticRegistered(false)
  }
  /** the game registration record (@individuality/shared-records), as the
   *  surface last read it. This flow writes it for its own sign-up too; what
   *  counts here is one another surface has on its way: the status shows it,
   *  and `register` starts none over one still registering */
  let registration: GameRegistration | null = null
  const setRegistration = (next: GameRegistration | null) => {
    if (
      next?.gameIndex === registration?.gameIndex &&
      next?.phase === registration?.phase &&
      next?.surface === registration?.surface &&
      next?.attempt === registration?.attempt
    )
      return
    registration = next
    log("status", next ? `sign-up from the ${next.surface} ${next.phase}` : "no sign-up record", { game: next?.gameIndex })
    optimisticListeners.forEach((notify) => notify())
  }
  /** what this surface writes of its own sign-ups; none: no record */
  const ownRecord = options.registrationRecord
  // the product's write logs its own failures; a record nobody could write
  // leaves the chain the answer, and never holds the sign-up
  const writeRegistration = (record: GameRegistration | null) => {
    if (!ownRecord) return
    void Promise.resolve()
      .then(() => ownRecord.write(record))
      .catch(() => {})
  }

  // THE LITE PERSON: the chain's proof inputs through the engine, the host's
  // key through the doorway. Read only where a seat is read (a player with a
  // signer). ONLY A PERSON IS REMEMBERED. "Not a lite person" is re-resolved
  // on the next seat read: the key listing can fail, the key can be
  // registered later (by hand on a local host, by the phone's peopl app
  // when it gets to it), and the engine's inputs can be a read that failed
  // — none of which should cost a reload. The outcome is logged when it
  // CHANGES, not on every read.
  let liteContext: Promise<LiteContext | null> | undefined
  let liteLogged: string | undefined
  const logLite = (outcome: string, data?: unknown, level: "info" | "warn" = "info") => {
    if (liteLogged === outcome) return
    liteLogged = outcome
    log("bind", outcome, data, level)
  }
  // A LOOKUP THE HOST IS SLOW TO ANSWER (#578). The caller waits
  // LITE_LOOKUP_TIMEOUT_MS; past that it is NOT "not a lite person" (that would
  // decide the route, a deposit sign-up or "unfunded", on a lookup that said
  // nothing) but a rejection, and the sign-up goes again ("timeout"). The
  // lookup itself LIVES ON: the next caller waits on the same one, and a late
  // answer still fills the cache, so a host slower than the wait signs up on
  // the next attempt. Only a lookup unanswered for LITE_LOOKUP_STALE_MS is
  // given up for a fresh one, and even its late person is kept.
  // A lookup that FAILS (the engine has no lite ring, listRingVrfKeys throws)
  // is "not a lite person" for now, as before: the next read asks again.
  const liteTimedOut = () => {
    logLite("lite key lookup timed out", { ms: LITE_LOOKUP_TIMEOUT_MS }, "warn")
    return new Error(`the lite key lookup timed out after ${LITE_LOOKUP_TIMEOUT_MS / 1000}s`)
  }
  let liteLookupStartedAt = 0
  /** the cached lookup has not answered yet */
  let liteLookupPending = false
  const lookupLite = (): Promise<LiteContext | null> => {
    if (liteContext) return liteContext
    const attempt = (async (): Promise<LiteContext | null> => {
      // a surface that hands no personhood keys has no lite person to look up
      if (!capabilities?.personhood) return null
      let holds: boolean
      try {
        holds = await chain.holdsLiteKey(capabilities)
      } catch (error) {
        logLite("lite key lookup failed", { detail: describe(error) }, "warn")
        return null
      }
      if (!holds) {
        logLite("not a lite person")
        return null
      }
      logLite("lite person: key found")
      return { capabilities }
    })()
    liteContext = attempt
    liteLookupStartedAt = performance.now()
    liteLookupPending = true
    attempt.then(
      (found) => {
        if (found) {
          // a person is kept for good, even from a lookup given up for a
          // fresh one that has not answered yet
          if (liteContext === attempt || !liteContext || liteLookupPending) {
            liteContext = attempt
            liteLookupPending = false
          }
          return
        }
        // forget a null so the next read asks again
        if (liteContext === attempt) {
          liteContext = undefined
          liteLookupPending = false
        }
      },
      () => {
        if (liteContext === attempt) {
          liteContext = undefined
          liteLookupPending = false
        }
      },
    )
    return attempt
  }
  const resolveLite = async (): Promise<LiteContext | null> => {
    // a found person answers at once; only a pending lookup is waited on
    // a lookup unanswered for this long is given up for a fresh one
    if (liteContext && liteLookupPending && performance.now() - liteLookupStartedAt >= LITE_LOOKUP_STALE_MS) {
      liteContext = undefined
      liteLookupPending = false
    }
    // boxed: the lookup's own null ("not a lite person") is not the timeout's
    const answer = await withTimeout(lookupLite().then((found) => ({ found })), LITE_LOOKUP_TIMEOUT_MS)
    if (answer === null) throw liteTimedOut()
    return answer.found
  }

  // THE BACKGROUND BIND (leg 1 of the free route). A lite person whose play
  // account the chain holds no binding for gets one without pressing
  // anything, as soon as a game exists — so the button is ready when
  // registration opens. Once, source-wide: the binding IS the replay
  // protection, so two in flight is the one thing to never do. `bound` marks
  // the bind in a BEST block; a seat read that started before it landed
  // still says "not bound", and `readSeat` takes the flag over it. Every
  // attempt has a deadline (`BIND_TIMEOUT_MS`): a host channel that dies under the watch
  // would otherwise leave the seat "preparing" for ever. A failure is
  // classified by ./free-seat.ts: a transient one retries on the
  // ladder, silently, and the seat stays "preparing" meanwhile; a permanent
  // one — the person's free seat is on another account, a refusal the chain
  // will repeat — CLOSES the lite route for the session, and the seat falls
  // to the deposit route like anyone else's who is not usably a lite person.
  let bindState: "idle" | "pending" | "bound" = "idle"
  let bindFailures = 0
  let bindRetry: ReturnType<typeof setTimeout> | undefined
  /** set once a bind was refused for good: the seat then ignores the person */
  let liteClosed: string | undefined
  const bindListeners = new Set<() => void>()
  const notifyBind = () => bindListeners.forEach((notify) => notify())
  /** the person journey of the bind under way, across its retries */
  let personJourney: SignUpJourney | null = null
  let personFailures = 0
  const failPerson = (journey: SignUpJourney, stage: string, error: unknown) => {
    const detail = describe(error)
    telemetry.failure("person-bind-failed", { reason: stage, context: { error: detail } }, journey)
    journey.end("failed", { "person.stage": stage, "person.error": mask(detail) })
    personJourney = null
  }
  const requestBind = () => {
    if (!player || liteClosed || bindState !== "idle" || bindRetry) return
    bindState = "pending"
    void (async () => {
      const lookupAt = Date.now()
      // bounded (#578): a lookup the host never answers must not leave the
      // bind "pending" before its own deadline exists
      const lite = await resolveLite().catch(() => null)
      if (!lite) {
        bindState = "idle"
        return
      }
      if (!personJourney) {
        personJourney = telemetry.journey("person", {}, { startedAt: lookupAt })
        personJourney.step("key.find", {}, { startedAt: lookupAt }).end()
        personFailures = 0
      }
      const journey = personJourney
      // the steps the code can see: the proof the host is asked for, then
      // the wait for the best block (the SDK's bind has no broadcast callback)
      let stage: "proof" | "bind.broadcast" = "proof"
      let broadcast: SignUpStep | null = null
      const keys = lite.capabilities.personhood!
      const prover: PersonhoodProver = {
        holds: (ring) => keys.holds(ring),
        prove: async (ring, context, message) => {
          const proofStep = journey.step("proof")
          try {
            const proof = await keys.prove(ring, context, message)
            proofStep.end()
            stage = "bind.broadcast"
            broadcast = journey.step("bind.broadcast")
            return proof
          } catch (error) {
            proofStep.end({ "person.result": "failed" })
            throw error
          }
        },
      }
      const startedAt = performance.now()
      const deadline = new AbortController()
      const timer = setTimeout(
        () => deadline.abort(new Error(`bind timed out after ${BIND_TIMEOUT_MS / 1000}s`)),
        BIND_TIMEOUT_MS,
      )
      /** a bind that did not land: refused for good closes the lite route, anything else goes again */
      const failed = (failure: { permanent: boolean; detail: string; account?: string }) => {
        bindState = "idle"
        ;(broadcast as SignUpStep | null)?.end({ "person.result": "failed" })
        const after = `${performance.now() - startedAt}ms`
        if (failure.permanent) {
          liteClosed = failure.detail
          failPerson(journey, stage, failure.detail)
          log(
            "bind",
            failure.account
              ? `the person's free seat is on ${failure.account} — lite route closed, seat falls back`
              : "bind refused for good — lite route closed, seat falls back",
            { detail: failure.detail, after, account: failure.account },
          )
          return
        }
        bindFailures += 1
        personFailures += 1
        journey.markSad("bind-retry")
        // A failed bind goes again on the ladder; a lone failure is usually a
        // transient refusal (a stale nonce, a host hiccup) the next attempt gets
        // past. Only the bind that keeps failing is an error, at the same count
        // the person journey reports it.
        const persistent = personFailures >= PERSON_FAILS_BEFORE_REPORT
        if (persistent) failPerson(journey, stage, failure.detail)
        const delay = bindRetryDelay(bindFailures)
        log(
          "bind",
          `bind failed, retrying in ${delay / 1000}s`,
          { detail: failure.detail, after, failures: bindFailures },
          persistent ? "error" : "warn",
        )
        bindRetry = setTimeout(() => {
          bindRetry = undefined
          // the re-read decides whether a bind is still wanted, and asks again
          notifyBind()
        }, delay)
      }
      try {
        log("bind", `binding ${player} as the person's lite alias`, { attempt: bindFailures + 1 })
        const result = await retry({
          operation: "person-bind",
          signal: deadline.signal,
          run: () => chain.bind({ ...lite.capabilities, personhood: prover }, { signal: deadline.signal }),
        })
        if (result.kind === "refused") {
          failed({ permanent: result.permanent, detail: result.detail, account: result.account })
        } else {
          ;(broadcast as SignUpStep | null)?.end()
          bindState = "bound"
          bindFailures = 0
          journey.end(result.kind)
          personJourney = null
          log("bind", `bind in a best block after ${performance.now() - startedAt}ms`, { outcome: result.kind })
        }
      } catch (error) {
        failed({ permanent: false, detail: describe(error) })
      } finally {
        clearTimeout(timer)
      }
      // AFTER the state moved: the read this triggers sees `bound`
      notifyBind()
    })().catch((error: unknown) => {
      // a throw outside the bind's own try (the product's telemetry, the
      // host's prover) must not leave it "pending" for good: it goes again on the ladder
      if (bindState === "pending") bindState = "idle"
      log("bind", "the bind stopped on an error of its own", { detail: describe(error) }, "error")
      if (bindState !== "idle" || bindRetry) return
      bindFailures += 1
      bindRetry = setTimeout(() => {
        bindRetry = undefined
        notifyBind()
      }, bindRetryDelay(bindFailures))
    })
  }
  /** the person the seat is decided for: none once the lite route is closed */
  const seatLite = async (): Promise<LiteContext | null> => (liteClosed ? null : resolveLite())

  // THE NAME LINK (#456), in the background like the bind: the player's
  // username linked to this account, so the prize draw's wheel can name their
  // tickets. A SIGN-UP NEVER GOES WITHOUT IT. Asked for wherever a seat is read
  // (a game open or scheduled), and again on the ladder after any link that
  // did not end linked; a Register tap that waits on it asks at once, past
  // the ladder. `named` is the link's own word, read at the best block
  // (`linked`, `already-linked`). Until then the seat is "Getting your seat
  // ready…" (`seatFor`'s `named`), and the sign-up loop waits, until
  // registration closes. The gate is the surface's own (@individuality/name-link), so
  // the link it runs in the background is the one a sign-up waits on.
  const nameGate = options.nameGate ?? null
  /** whether Register may go: the name is linked (or this source links none) */
  const nameReady = (): boolean => !nameGate || nameGate.ready()
  const requestName = (trigger: NameLinkTrigger = "background") => {
    if (!player || !nameGate) return
    nameGate.request(trigger)
  }

  /** Register taps since the last sign-up that ended for good (landed or
   *  failed). A tap that only asks for the bind ends its journey "unbound" and
   *  still counts toward the next one, so the landed journey says how many
   *  taps the player needed. */
  const taps = (() => {
    let count = 0
    return { tap: () => ++count, reset: () => void (count = 0) }
  })()
  /** a sign-up that did not land: the event first (it sets journey.expected),
   *  then the journey's end */
  const failSignup = (journey: SignUpJourney, stage: string, errorText: string, route: string) => {
    taps.reset()
    const reason = signupFailureReason(errorText, stage)
    telemetry.failure("signup-failed", { reason, context: { route, error: errorText } }, journey)
    journey.end("failed", { "signup.stage": reason })
  }
  /** a sign-up the seat does not allow: expected, and no transaction */
  const notEligible = (journey: SignUpJourney, why: "unfunded") => {
    taps.reset()
    telemetry.failure("signup-failed", { reason: "not-eligible", context: { route: why } }, journey)
    journey.end("not-eligible", { "signup.reason": why })
  }
  /** The chain already has the player, found by a read and not by this
   *  sign-up's own watch: the journey lands, the home shows it, the reminder
   *  is asked. One body for an attempt's re-read and the loop's (#582). */
  const landedByReread = (journey: SignUpJourney) => {
    taps.reset()
    journey.end("landed", { "signup.landed_by": "reread" })
    options.remindOfGame?.()
    optimisticGame = latestSlotIndex
    optimisticOwner = undefined // the chain's word: no call's refusal takes it down
    setOptimisticRegistered(true)
  }
  /** The chain's own best-block word on whether the player is registered.
   *  A failed read resolves to why it failed, never to absent: only a
   *  definitive absent row may let an attempt describe the player as unbound. */
  const registeredReads = new Map<string, Promise<boolean | RetryReason>>()
  const registeredOnChain = (address: string): Promise<boolean | RetryReason> => {
    // one read at a time per account: a page that is shown again and again
    // must not stack reads, and a host still asleep must not hold one for ever
    const reading = registeredReads.get(address)
    if (reading) return reading
    const read = (async () => {
      try {
        const row = await withTimeout(
          retry({
            operation: "signup-route",
            run: () => chain.player(address),
          }).then((player) => ({ registered: player?.registered === true })),
          SIGNUP_WINDOW_READ_TIMEOUT_MS,
        )
        if (row === null) {
          log("signup", "player reconciliation timed out", undefined, "warn")
          return "timeout"
        }
        return row.registered
      } catch (error) {
        log("signup", "player reconciliation failed", { detail: describe(error) }, "warn")
        return classifyRetry(describe(error))
      }
    })()
    registeredReads.set(address, read)
    // dropped once it settles, even when it settled before it was kept here
    // (a chain read that throws at once)
    const forget = () => {
      if (registeredReads.get(address) === read) registeredReads.delete(address)
    }
    void read.then(forget, forget)
    return read
  }
  /** ONE ATTEMPT at the sign-up (the loop is signupWithRetry, ./signup-retry.ts).
   *  Resolves with how it ended; `onWire` is called when the sign-up is out. A
   *  throw is a refusal the player must hear about: their own (the signing
   *  they cancelled) or a seat the account cannot
   *  take. Everything else is a retry, never a failure. */
  const attemptSignUp =
    capabilities && player
      ? async (tapCount: number, attemptNo: number, onWire: () => void, run: RunState): Promise<AttemptResult> => {
          const journey = telemetry.journey("game-signup")
          // the taps the player made, not the attempts the app made for them
          journey.set({ "signup.taps": String(tapCount), "signup.attempt": String(attemptNo) })
          // A binding wait is genuinely unbound. Every other attempt that goes
          // again ends "retrying" with its reason, so dashboards do not call a
          // bound player unbound.
          // A failed attempt keeps its signup-failed event, with the stage, tagged
          // as one that goes again, so the dashboards and alerts built on
          // that event keep their signal.
          const retryAfter = (reason: RetryReason, sad = reason as string, failure?: { stage: string; error: string; route: string }): AttemptResult => {
            journey.set({ "signup.retry_reason": reason })
            if (failure) {
              journey.set({ "signup.retrying": "true" })
              telemetry.failure(
                "signup-failed",
                { reason: signupFailureReason(failure.error, failure.stage), context: { route: failure.route, error: failure.error, retrying: "true" } },
                journey,
              )
            }
            journey.markSad(sad)
            journey.end(waitsOnBind(reason) ? "unbound" : "retrying")
            return { kind: "retry", reason }
          }
          const reconciled = (): AttemptResult => {
            landedByReread(journey)
            onWire()
            return { kind: "registered" }
          }
          // The authoritative player row comes before every route/seat
          // decision, including attempt one. A landed transaction must never
          // be filed as unbound because an AliasNotBound seat read trails
          // the best block that already contains Game.Players.
          const beforeRoute = await registeredOnChain(player)
          if (beforeRoute === true) return reconciled()
          // a read that answers "not registered" takes the optimistic flag of a
          // sign-up an earlier attempt of this tap put on the wire down
          if (beforeRoute === false && run.wireOwner) clearOptimistic(run.wireOwner)
          if (typeof beforeRoute === "string") return retryAfter(beforeRoute)
          const routeStep = journey.step("route")
          // the route step covers everything that decides the route, the
          // identifier and the lite person included: a throw in any of them
          // is a read that failed, and the attempt goes again
          // the HOST signs (product-sdk) — the app never holds a key
          const readRoute = async () => {
            const commId = await communicationIdentifier(latestSlotIndex)
            const lite = await retry({ operation: "signup-route", run: seatLite })
            const seat = await retry({
              operation: "signup-seat",
              run: () => readSeat(chain, player, lite, bindState === "bound", nameReady()),
            })
            return { commId, lite, ...seat }
          }
          let routed: Awaited<ReturnType<typeof readRoute>>
          try {
            // BOUNDED (#578): a host answer dropped anywhere in here would
            // otherwise hold the attempt, the loop and its window check for
            // ever. Out of time is a "timeout" retry; the page leaving ends it.
            const raced = await Promise.race([
              withTimeout(readRoute(), ROUTE_STEP_TIMEOUT_MS),
              run.stop().then(() => "stopped" as const),
            ])
            if (raced === "stopped") {
              routeStep.end()
              return retryAfter("other")
            }
            if (raced === null) throw new Error(`the route read timed out after ${ROUTE_STEP_TIMEOUT_MS / 1000}s`)
            routed = raced
          } catch (error) {
            routeStep.end()
            log("signup", "the route could not be read, trying again", { detail: describe(error) }, "warn")
            return retryAfter(classifyRetry(describe(error)), undefined, { stage: "route", error: describe(error), route: "unknown" })
          }
          const { commId, seat, funds, bindReady } = routed
          routeStep.end({ "signup.route": seat.path })
          // amendment A8: the game this sign-up is for goes on the `game.index`
          // tag now, so the sign-up's own events carry it (the join sets it
          // again later)
          let signupGameIndex: number | null = null
          void chain
            .game()
            .then((game) => {
              if (game) {
                signupGameIndex = game.index
                telemetry.gameIndex?.(game.index)
              }
            })
            .catch((error: unknown) => {
              log("signup", "game read for the sign-up tag failed", { detail: describe(error) }, "warn")
            })
          // the product and the index decide which account signs. The deployed
          // name is not always the product name (a build can be served under
          // another name than the account it plays as), so the sheet has to
          // say which one this was
          log("signup", `route: ${seat.path}`, {
            ...options.logFacts,
            player,
            ready: seat.ready,
            free: funds.free.toString(),
            required: funds.required.toString(),
          })
          // the page left while the route was being read: file nothing
          if (stopSignup) return retryAfter("other")
          if (seat.path === "unfunded") {
            notEligible(journey, "unfunded")
            throw new SeatUnfundedError(funds.required, funds.free)
          }
          if (!seat.ready) {
            // The route read can trail the best Players row by a block. Check
            // once more immediately before bind-pending becomes an "unbound"
            // journey; only a definitive absent player may take that path.
            const afterSeat = await registeredOnChain(player)
            if (afterSeat === true) return reconciled()
            if (typeof afterSeat === "string") return retryAfter(afterSeat)
            // the name link runs beside the bind; neither is a failure
            requestName("register")
            if (!bindReady) {
              // the free seat waits on the bind (journey.person): recovered, not failed
              // the first tap counts: the loop waits for the bind and files again
              requestBind()
              return retryAfter("bind-pending", "seat-preparing")
            }
            // the seat waits on the name link alone (journey.name-link)
            if (nameGate?.unowned()) return retryAfter("name-unowned")
            return retryAfter("name-pending", "name-preparing")
          }
          const route = seat.path // "returning" | "deposit" | "free"
          // why this sign-up went without its draw ticket, when it did
          let missKind: DrawSkipKind | null = null
          // Go OPTIMISTIC on broadcast (`onWire`: the tap resolves, the status
          // says "you're in"), then let the submission settle to confirm or
          // roll back. One that never made it onto the wire (invalid tx) is a
          // retry; the player's own refusal of the signing rejects the tap.
          // how long the attempt took, and whether it ever reached the wire:
          // a refusal at 80ms never left the device, a dispatch failure takes
          // two blocks. The log could not tell those apart.
          const startedAt = performance.now()
          const since = () => `${performance.now() - startedAt}ms`
          const buildStep: SignUpStep = journey.step("tx.build")
          let broadcastStep: SignUpStep | null = null
          let landedStep: SignUpStep | null = null
          return new Promise<AttemptResult>((resolveAttempt, rejectAttempt) => {
            let wired = false
            // an attempt that was given up on (deadline, page left) answers
            // nothing more: its late results must not touch the next one
            let abandoned = false
            /** this call, as the owner of the optimistic flag */
            const owner = {}
            // Given up on, the engine call is ABORTED too (#577): it sends
            // nothing it has not sent yet. Before this a timed-out call lived
            // on and could file a second sign-up.
            const abort = new AbortController()
            const abandon = () => {
              abandoned = true
              abort.abort(new Error("the sign-up attempt was given up on"))
            }
            // An abandoned call's late result touches nothing of the next
            // attempt, with one exception: a refusal of the sign-up it
            // broadcast takes down the flag it put up, unless the chain has
            // the player anyway (another sign-up, or the result is wrong
            // about this one). Nothing else would: the player read only ever
            // raises it, and a new slot only clears another game's (#580).
            const rollBackAbandoned = async (error: string) => {
              if (!wired || optimisticOwner !== owner) return
              if (classifyPermanent(error) === "registered") return
              // one Players read first, as settle() does before it ends closed
              if ((await registeredOnChain(player)) === true) return
              if (optimisticOwner !== owner) return
              optimisticOwner = undefined
              log("signup", `${route} sign-up refused after the page let it go: ${error}`, undefined, "warn")
              setOptimisticRegistered(false)
            }
            let over = false
            let deadline: ReturnType<typeof setTimeout> | undefined
            // The page asleep (#521): a phone that locks freezes this deadline,
            // so it may be long past when the page is shown again. The wall
            // clock says so; the re-read on return decides the rest.
            let deadlineAt = 0
            let armedMs = 0
            // an attempt that starts while the page is hidden counts from now
            let hiddenAt: number | undefined = page.hidden() ? Date.now() : undefined
            let hiddenTotalMs = 0
            let unwatchPage = () => {}
            const resolve = (result: AttemptResult) => {
              if (over) return
              over = true
              unwatchPage()
              clearTimeout(deadline)
              resolveAttempt(result)
            }
            const reject = (error: unknown) => {
              if (over) return
              over = true
              unwatchPage()
              clearTimeout(deadline)
              rejectAttempt(error)
            }
            const arm = (ms: number) => {
              clearTimeout(deadline)
              deadlineAt = Date.now() + ms
              armedMs = ms
              deadline = setTimeout(timedOut, ms)
            }
            const timedOut = () => {
              // given up on already: its settle is under way (an overdue
              // timer, then the page's return, must not start a second)
              if (over || abandoned) return
              abandon()
              log("signup", `${route} sign-up gave no answer in ${armedMs / 1000}s`, undefined, "error")
              void settle({ error: "the attempt timed out", landingUnknown: true })
            }
            arm(PRE_WIRE_TIMEOUT_MS)
            // the central tracker: it also reports a silent freeze (iOS), which
            // fires no visibility event at all
            unwatchPage = page.watch((hidden) => {
              if (hidden) {
                hiddenAt ??= Date.now()
                return
              }
              if (over || hiddenAt === undefined) return
              hiddenTotalMs += Date.now() - hiddenAt
              hiddenAt = undefined
              journey.set({ "signup.hidden_ms": String(hiddenTotalMs) })
              void onPageReturn()
            })
            void run.stop().then(() => {
              if (over) return
              abandon()
              resolve(retryAfter("other"))
            })
            /** what the draw decision of THIS attempt left out, until its sign-up goes out */
            let drawSkip: { kind: string; skipped: string } | null = null
            const markWire = () => {
              if (wired) return
              wired = true
              // THE EVENT FOLLOWS THE SIGN-UP: only an attempt that went out
              // without its tickets counts, once per tap (a refused or retried
              // attempt that skipped is no sign-up without a ticket)
              if (drawSkip && !run.drawSkipReported) {
                run.drawSkipReported = true
                telemetry.failure("draw-skipped", { reason: drawSkip.kind, context: { kind: drawSkip.kind, skipped: drawSkip.skipped } }, journey)
              }
              arm(WIRE_TIMEOUT_MS)
              onWire()
            }
            const stage = () => (wired ? "tx.landed" : broadcastStep ? "tx.broadcast" : "tx.build")
            const landed = (attrs?: Record<string, string>) => {
              // a late settle (an overdue timer, then the page's return) must
              // not end the journey, or ask for tickets and a reminder, twice
              if (over) return
              taps.reset()
              landedStep?.end()
              journey.end("landed", attrs)
              log("signup", `${route} sign-up landed for ${player}${attrs ? " (found by re-reading the chain)" : ""}`)
              options.confirmDrawTickets?.(player, missKind)
              options.remindOfGame?.()
              // the tickets this sign-up entered are recorded under this
              // account, a member's People-ring proofs included (the alias is
              // registered with an `Account` origin), and the
              // account carries the player's name: the sign-up waited for it
              // the landing is the chain's word, so the home shows it now. A
              // landing the re-read found never had a broadcast to set the
              // flag (#579), and a host that lost that event delivers no
              // block tick to reconcile the status either.
              optimisticGame = signupGameIndex ?? latestSlotIndex
              optimisticOwner = undefined // the chain's word: no call's refusal takes it down
              setOptimisticRegistered(true)
              markWire()
              resolve({ kind: "landed" })
            }
            // The page is back in front with this attempt still open. Ask the
            // chain once: the sign-up may have landed while nothing ran. Not
            // registered with the window shut ends it as "page-asleep"; not
            // registered with the window open goes again only if the frozen
            // deadline has passed, else the timers run on as they were.
            const onPageReturn = async () => {
              const registered = await registeredOnChain(player)
              if (over) return
              if (registered === true) {
                abandon()
                return landed({ "signup.landed_by": "reread", "signup.on_return": "true" })
              }
              // a failed read is unknown: treat the window as open
              const open = typeof registered !== "boolean" || (await registrationOpen(run.window ?? { current: undefined }, run.lastReason?.()))
              if (over) return
              if (!open) {
                abandon()
                setOptimisticRegistered(false)
                log("signup", `${route} sign-up: the page was asleep and registration closed`, undefined, "error")
                telemetry.failure("signup-failed", { reason: "window-closed", context: { route, error: "page-asleep" } }, journey)
                journey.set({ "signup.retry_reason": "page-asleep", "signup.on_return": "asleep" })
                journey.end("closed", { "signup.stage": stage() })
                return resolve({ kind: "closed" })
              }
              // judged after the awaits: a broadcast that landed meanwhile
              // re-armed the deadline, and stands
              if (Date.now() < deadlineAt) return
              journey.set({ "signup.on_return": "expired" })
              // the frozen timer's own path, wait and re-read included
              clearTimeout(deadline)
              timedOut()
            }
            // The sign-up did not land. What the chain says for good ends it
            // (classifyPermanent); the player's own refusals reject the tap;
            // everything else goes again. Past the broadcast EVERY error is
            // "landing unknown", not only the engine's flag: a retry filed
            // while the first is still in the pool would be a second sign-up,
            // so wait about two blocks and re-read Game.Players first. (The
            // pallet is the last guard: a second sign-up is refused with
            // AlreadyRegistered, and the seat read's AlreadyPlaying blocker
            // keeps the free route from signing twice.) A sign-up has been
            // registered nearly three minutes after "Tracking stopped".
            const settle = async (failure: { error: string; landingUnknown?: true; thrown?: unknown }) => {
              const permanent = failure.thrown ? null : classifyPermanent(failure.error)
              if (permanent === "registered") return landed({ "signup.landed_by": "reread" })
              // past the broadcast the outcome is unknown until a chain read
              // answers: a failed read is "still confirming", never a failure
              // that takes the optimistic "you're in" down (#1355)
              let reRead: boolean | RetryReason = false
              if (!permanent && (wired || failure.landingUnknown)) {
                if (wired) await Promise.race([new Promise((r) => setTimeout(r, LANDING_WAIT_MS)), run.stop()])
                if (over) return
                reRead = await registeredOnChain(player)
                if (reRead === true) return landed({ "signup.landed_by": "reread" })
              }
              // the window shut, but an earlier sign-up of this player may
              // have landed meanwhile: that is no missed window (#582). Asked
              // before the flag goes down, so "you're in" does not flicker.
              if (permanent === "closed" && (await registeredOnChain(player)) === true) return landed({ "signup.landed_by": "reread" })
              // ended while this waited (the page's return found it landed):
              // nothing of the attempt is this settle's any more
              if (over) return
              // a re-read that failed says nothing: the broadcast may have
              // landed all the same, so the flag stays up until a chain read
              // that answers says the player is not in
              if (wired && typeof reRead === "string") {
                log("signup", `${route} sign-up still confirming: the landing re-read failed (${reRead})`, { detail: failure.error }, "warn")
                return resolve(retryAfter(classifyRetry(failure.error), undefined, { stage: stage(), error: failure.error, route }))
              }
              // a later read that answered says the player is not in: the flag
              // this tap put up comes down
              if (wired && reRead === false) clearOptimistic(owner)
              setOptimisticRegistered(false)
              const refused = signupFailureReason(failure.error, stage()) === "signing-refused"
              if (refused) {
                failSignup(journey, stage(), failure.error, route)
                return reject(failure.thrown ?? new Error(failure.error))
              }
              if (permanent === "closed") {
                telemetry.failure("signup-failed", { reason: "window-closed", context: { route, error: failure.error } }, journey)
                journey.end("closed", { "signup.stage": stage() })
                return resolve({ kind: "closed" })
              }
              if (permanent === "refused") {
                telemetry.failure("signup-failed", { reason: "refused", context: { route, error: failure.error } }, journey)
                journey.end("failed", { "signup.stage": "refused" })
                return resolve({ kind: "refused", reason: failure.error })
              }
              resolve(retryAfter(classifyRetry(failure.error), undefined, { stage: stage(), error: failure.error, route }))
            }
            retry({
              operation: "signup-tx",
              signal: abort.signal,
              errorOf: (result) => result.ok ? null : result.error,
              // Rebuild only while the first call is still local. Once the
              // host says it broadcast, settle() waits two blocks and asks
              // Game.Players instead: never prompt or charge twice.
              retryIf: () => !wired,
              // THE SIGN-UP and its PRIZE DRAW entries, by the SDK: the route
              // it reads afresh, one ticket or proof per draw the game
              // schedules, and the draws never fail the sign-up. This only
              // records what it decided.
              run: () => chain.register(capabilities, commId, {
                // given up on, the call is aborted: it sends nothing more
                signal: abort.signal,
                onDraws: (draws) => {
                  // a call given up on says nothing of the draw (#577)
                  if (abandoned) return
                  // THE SIGN-UP ALWAYS GOES (#607), so this is the one place
                  // a missing ticket is recorded, with its why
                  const { entered, skipped, kind } = draws
                  const outcome = drawResult(draws)
                  missKind = kind ?? null
                  log(
                    "signup",
                    skipped ? `draws skipped: ${skipped}` : `entered ${entered} prize draw${entered === 1 ? "" : "s"}`,
                    { ...draws },
                    outcome === "skipped" ? "error" : "info",
                  )
                  buildStep.end()
                  journey.set({
                    "draw.entered": String(entered),
                    ...(skipped ? { "draw.skipped": skipped } : {}),
                    "signup.draw.outcome": outcome,
                    ...(kind ? { "signup.draw.kind": kind } : {}),
                    "signup.draw.scheduled": draws.scheduled,
                    "signup.draw.waited_ms": draws.waitedMs,
                    "signup.draw.retries": draws.retries,
                  })
                  telemetry.draws?.(entered, skipped)
                  // reported once this attempt's sign-up is really out (markWire)
                  drawSkip = outcome === "skipped" ? { kind: kind ?? "unknown", skipped: skipped ?? "" } : null
                  broadcastStep = journey.step("tx.broadcast")
                },
                onBroadcast: () => {
                  // Some host implementations may repeat a progress callback;
                  // the marker and optimistic transition describe the broadcast,
                  // not callback deliveries. A call given up on is no longer
                  // this attempt's (#577): an engine that broadcasts anyway
                  // moves nothing here.
                  if (wired || abandoned) return
                  buildStep.end()
                  broadcastStep?.end()
                  landedStep = journey.step("tx.landed")
                  optimisticGame = signupGameIndex ?? latestSlotIndex
                  optimisticOwner = owner
                  run.wireOwner = owner
                  setOptimisticRegistered(true)
                  // Let the sign-up's own game read settle first when it is
                  // already available. A slow read stays unknown rather than
                  // borrowing a stale game from the telemetry scope.
                  void Promise.resolve().then(() => telemetry.broadcast?.(player, attemptNo, route, signupGameIndex))
                  log("signup", `${route} sign-up broadcast for ${player}`)
                  markWire()
                },
              }),
            })
              .then((result) => {
                if (abandoned) {
                  if (!result.ok) void rollBackAbandoned(result.error)
                  return
                }
                if (result.ok) return landed()
                // a dispatch failure after broadcast (a race: game full,
                // registration just closed) undoes the optimistic "in"
                log(
                  "signup",
                  `${route} sign-up ${wired ? "dispatch failed" : "never reached the wire"}`,
                  { detail: result.error, after: since() },
                  "error",
                )
                return settle(result)
              })
              .catch((error: unknown) => {
                if (abandoned) {
                  void rollBackAbandoned(describe(error))
                  return
                }
                log("signup", `${route} sign-up never reached the wire`, { detail: describe(error), after: since() }, "error")
                return settle({ error: describe(error), thrown: error })
              })
          })
        }
      : undefined

  /** the wait the loop asks for: on the bind (reset first when the chain said
   *  there was none: the next read prepares the seat again) or a plain pause */
  const waitFor = async (reason: RetryReason, ms: number) => {
    if (reason === "name-pending" || reason === "name-unowned") return waitForName(ms)
    if (!waitsOnBind(reason)) return new Promise<void>((resolve) => setTimeout(resolve, ms))
    if (reason === "no-alias" && bindState === "bound") {
      bindState = "idle"
      notifyBind()
    }
    let check!: () => void
    const landed = new Promise<void>((resolve) => {
      check = () => {
        if (bindState === "bound" || liteClosed !== undefined) resolve()
      }
    })
    bindListeners.add(check)
    try {
      requestBind() // a no-op while one is under way
      check()
      await withTimeout(landed, ms)
    } finally {
      bindListeners.delete(check)
    }
  }
  /** Wait for the one in-flight name-link request to settle before the next
   * chain reconciliation. The gate's NAME_LINK_TIMEOUT_MS remains the bound;
   * the retry ladder must not poll player/seat rows while that work is live. */
  const waitForName = async (ms: number) => {
    let check!: () => void
    const settled = new Promise<void>((resolve) => {
      check = () => {
        if (nameReady() || !nameGate?.pending()) resolve()
      }
    })
    const stopWatching = nameGate?.subscribe(check)
    try {
      requestName("register") // a no-op while one is under way
      check()
      await settled
      if (!nameReady()) {
        // While Register owns the retry loop, its ladder owns the pause too.
        // Do not let the background name timer add an extra attempt between
        // ladder steps, and do not turn a fast failure/no-op into a spin.
        nameGate?.clearRetry()
        await new Promise<void>((resolve) => setTimeout(resolve, ms))
      }
    } finally {
      stopWatching?.()
    }
  }
  /** Registration is open while the game is in Registration and before its
   * end, on the chain clock. The tap captures the status window it offered;
   * reads can only advance that window to a newer Registration game. */
  const registrationOpen = async (
    window: { current: { index: number; registrationEnds: number } | undefined },
    retryReason: RetryReason | undefined,
  ): Promise<boolean> => {
    const now = nowSeconds()
    const registrationEnds = window.current?.registrationEnds
    if (registrationEnds !== undefined && now >= registrationEnds) return false
    try {
      const game = await withTimeout(chain.game(), SIGNUP_WINDOW_READ_TIMEOUT_MS)
      if (game === null) {
        warn(
          "registration window read timed out, treated as open",
          new Error(`no answer in ${SIGNUP_WINDOW_READ_TIMEOUT_MS} ms`),
        )
        telemetry.count("signup.window_check_timeout", 1, {
          "signup.retry_reason": retryReason ?? "none",
        })
        return registrationEnds === undefined || nowSeconds() < registrationEnds
      }
      const current = window.current
      // A lagging finalized read cannot move an already-observed window back.
      if (game && current && game.index < current.index) return nowSeconds() < current.registrationEnds
      if (game?.state.type !== "Registration") return false
      const readOpen = nowSeconds() < game.registration_ends
      if (!current || game.index > current.index) {
        window.current = { index: game.index, registrationEnds: game.registration_ends }
      }
      return readOpen
    } catch (error) {
      warn("registration window read failed, treated as open", error)
      return window.current === undefined || nowSeconds() < window.current.registrationEnds
    }
  }

  /** The sign-up as the register button sees it: ONE TAP, and the source sees
   *  it through. A seat still being prepared, a chain that has not caught up,
   *  a host that dropped: all retried on a backoff until it lands or
   *  registration closes, with the phase on the status (`signup`) saying what
   *  the player is waiting for. A tap while one is under way does nothing: one
   *  loop per player. Resolves once the sign-up is on the wire, as before, or
   *  once the reminder gate holds it back (`reminderBlock`). */
  let signingUp: Promise<void> | undefined
  let stopSignup = false
  let stopWaiter = deferred<void>()
  const register =
    capabilities && player
      ? (): Promise<void> => {
          if (signingUp) {
            // coming back while it waits: the sign-up goes on, and this tap is it
            if (stopSignup) {
              stopSignup = false
              stopWaiter = deferred<void>()
            }
            return signingUp
          }
          // another surface is signing this player up for this game, and a second
          // sign-up would only collide with it
          if (
            registration?.phase === "registering" &&
            registration.surface !== ownRecord?.surface &&
            registration.gameIndex === latestSlotIndex
          )
            return Promise.resolve()
          const tapCount = taps.tap()
          // The record of this sign-up for the other surfaces and products
          // (@individuality/shared-records): one attempt per tap, in the phases
          // of its end. A tap with no game on the slot writes none. Every
          // attempt that reaches the wire writes sent again, so the record's
          // lifetime runs from the latest broadcast.
          const recordGame = latestSlotIndex
          const recordAttempt = Date.now()
          let recordedPhase: RegistrationPhase | undefined
          const record = (phase: RegistrationPhase, reason?: string) => {
            if (!ownRecord || recordGame === undefined) return
            recordedPhase = phase
            writeRegistration({
              gameIndex: recordGame,
              phase,
              surface: ownRecord.surface,
              at: Date.now(),
              attempt: recordAttempt,
              ...(reason ? { reason } : {}),
            })
          }
          stopSignup = false
          stopWaiter = deferred<void>()
          const outer = deferred<void>()
          let lastReason: RetryReason | undefined
          const registrationWindow = {
            current: latestRegistrationWindow ? { ...latestRegistrationWindow } : undefined,
          }
          const run: RunState = { stop: () => stopWaiter.promise, window: registrationWindow, lastReason: () => lastReason }
          let chainClosed = false
          /** the Players read before the window-closed end failed */
          let closedUnverified = false
          let attemptsMade = 0
          signingUp = outer.promise
          const signUp = () => {
            record("registering")
            void signupWithRetry({
              attempt: async (attemptNo, onWire) => {
                attemptsMade = attemptNo
                const result = await attemptSignUp!(tapCount, attemptNo, onWire, run)
                if (result.kind === "retry") {
                  lastReason = result.reason
                }
                if (result.kind === "closed") chainClosed = true
                return result
              },
              // a window that shut is asked one more question: is the player
              // in already (another surface's sign-up, or this run's own landing
              // late)? Then it ends as theirs, not as a missed window (#582)
              windowOpen: async () => {
                if (await registrationOpen(registrationWindow, lastReason)) return true
                const isIn = await registeredOnChain(player)
                if (isIn === true) {
                  landedByReread(telemetry.journey("game-signup", { "signup.taps": String(tapCount), "signup.attempt": String(attemptsMade) }))
                  return "registered"
                }
                closedUnverified = typeof isIn !== "boolean"
                return false
              },
              wait: waitFor,
              now: () => performance.now(),
              stopped: () => stopSignup,
              startTimer: (ms, fn) => {
                const timer = setTimeout(fn, ms)
                return () => clearTimeout(timer)
              },
              onPhase: setSignupPhase,
              // a hung attempt returns no CannotGetCurrentBlock for classifyRetry to
              // see, so the host's chain is looked at once the sign-up is slow (#507):
              // two probes in a row that get no answer count as lost too
              probeHostChain: options.probeHostChain,
              onRetry: ({ attempt, reason, waitMs }) => {
                log("signup", `sign-up goes again (attempt ${attempt}): ${reason}, after ${waitMs} ms`)
                telemetry.count("signup.retries", 1, { "signup.retry_reason": reason })
              },
              onErrorSurfaced: (reason) => {
                telemetry.count("signup.error_surfaced", 1, { "signup.retry_reason": reason })
              },
              onWire: () => {
                record("sent")
                outer.resolve()
              },
            })
              .then(({ end, attempts, elapsedMs }) => {
                // a loop that ends closed, refused or stopped takes the
                // optimistic flag of a sign-up that went out down with it:
                // the chain never confirmed it, and nothing of this tap
                // leaves "you're in" standing
                if ((end === "closed" || end === "refused" || end === "stopped") && run.wireOwner) clearOptimistic(run.wireOwner)
                if (end === "closed" && !chainClosed) {
                  // the window shut between attempts: the one end the player must hear of
                  const journey = telemetry.journey("game-signup", { "signup.taps": String(tapCount), "signup.attempt": String(attempts) })
                  telemetry.failure("signup-failed", { reason: "window-closed", context: { route: "unknown", error: lastReason ?? "none" } }, journey)
                  journey.end("closed", {
                    ...(lastReason ? { "signup.retry_reason": lastReason } : {}),
                    ...(closedUnverified ? { "signup.closed_unverified": "true" } : {}),
                  })
                }
                if (end === "closed" || end === "refused") taps.reset()
                if (end === "landed" || end === "registered") {
                  telemetry.distribution("signup.landed_ms", elapsedMs, "millisecond", { "signup.attempt": String(attempts) })
                  record("registered")
                } else if (end === "closed") record("failed", "window-closed")
                else if (end === "refused") record("failed", "refused")
                // a loop the page stopped is not a success for the tap. One
                // nothing went out of takes its record with it; one on the wire
                // stands, and its sent record with it, until the chain or the
                // record's lifetime says
                else if (end === "stopped") {
                  if (recordedPhase === "registering") writeRegistration(null)
                  outer.reject(new Error("the sign-up was cancelled"))
                }
                if (end !== "stopped") outer.resolve() // a no-op once wired
              })
              .catch((error: unknown) => {
                record("failed", "refused")
                setSignupPhase("idle")
                outer.reject(error)
              })
              .finally(() => {
                signingUp = undefined
                // a surface that watches the sign-up to its end hears it ended
                optimisticListeners.forEach((notify) => notify())
              })
          }
          setSignupPhase("reminders")
          void reminderBlock()
            .catch(() => null)
            .then((block) => {
              if (!block) return signUp()
              // the sign-up is over before the phase tells it, so a listener
              // the phase wakes reads it over
              signingUp = undefined
              setSignupPhase(block)
              outer.resolve()
            })
          return outer.promise
        }
      : undefined
  /** the page left: stop trying. A sign-up already on the wire still stands
   *  (it may land all the same), but the optimistic flag of this tap comes
   *  down with the loop: nothing of this tap will confirm it any more. */
  const cancelRegister = () => {
    stopSignup = true
    stopWaiter.resolve() // an attempt still waiting on the host ends too
  }

  /**
   * THE ALARM FIRST: a sign-up goes out once the host holds the game reminder,
   * where the surface asks for one. Null lets it go, else the phase that says
   * why it did not.
   */
  const reminderBlock = async (): Promise<ReminderBlock | null> =>
    options.reminders ? options.reminders(latestRegistrationWindow) : null

  return {
    register,
    cancelRegister,
    async readSeat() {
      if (!player) throw new Error("no player to read the seat of")
      const lite = await seatLite()
      // a zero communication key gives the same fee estimate as the real one
      return retry({
        operation: "signup-seat",
        run: () => readSeat(chain, player, lite, bindState === "bound", nameReady()),
      })
    },
    requestBind,
    requestName,
    phase: () => signupPhase,
    waitingOn: () => (signupPhase !== "waiting-seat" && signupPhase !== "name-unowned" ? null : nameReady() ? "bind" : "name"),
    signingUp: () => signingUp !== undefined,
    optimistic: () => ({ registered: optimisticRegistered, game: optimisticGame }),
    registration: () => registration,
    setRegistration,
    setSlot(index, window) {
      latestSlotIndex = index
      latestRegistrationWindow = window
    },
    newSlot(index) {
      if (index !== optimisticGame) setOptimisticRegistered(false)
      if (!signingUp) setSignupPhase("idle") // a "closed" belongs to the game that closed
    },
    confirmRegistered: () => setOptimisticRegistered(false),
    onChange(listener) {
      optimisticListeners.add(listener)
      return () => {
        optimisticListeners.delete(listener)
      }
    },
    onSeatInput(listener) {
      bindListeners.add(listener)
      const stopName = nameGate?.subscribe(listener)
      return () => {
        bindListeners.delete(listener)
        stopName?.()
      }
    },
  }
}

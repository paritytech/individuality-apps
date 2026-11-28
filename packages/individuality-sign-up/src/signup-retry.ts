// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The sign-up's RETRY POLICY, apart from the doorway. The player cannot fix
 * anything that goes wrong between the tap and the chain (the bind has not
 * landed, the lite ring moved, the host dropped, the landing watch stopped),
 * so the sign-up does not give up on any of it: it tries again, on a backoff,
 * until it lands or the registration window closes, and says "taking longer"
 * once it has been at it a while.
 *
 * The sign-up flow (./sign-up-flow.ts) hands this the attempt, the clock and the waits, and
 * this decides the order, the pace and what the screen is told. It has no
 * timers and no chain in it, so it is tested by injecting both.
 *
 * WHAT ENDS IT (the only things the player must hear about or has decided):
 *  - it landed, or the chain already has the player registered
 *  - registration closed: no retry can change that (unless the chain already
 *    has the player, which is the first end above)
 *  - the player's own refusal (cancelled the signing, declined the draw
 *    question) or a seat the account cannot take (unfunded, a person's route
 *    that is not supported): the attempt THROWS, and the caller reports it
 * Everything else is a retry, including errors nobody has classified: a
 * sign-up that cannot land is bounded by the window, not by a guess.
 *
 * Custom(172) and Custom(175) are not the Game pallet's codes (140-151) but
 * the free route's transaction extension (PeopleLiteAuth; product-sdk
 * packages/individuality/src/as-lite-alias-signer.ts):
 *  - Custom(175) NoAliasBinding: no binding for the account yet (the bind has
 *    not landed, or a reorg took it) -> run the bind again, then retry
 *  - Custom(172) StaleAlias: the binding is from an older lite-ring revision;
 *    the ring moves every 20-35 minutes and the engine's read lags it by a few
 *    blocks -> the next attempt reads the moved ring and takes the revised leg
 * Both mean the chain is not caught up with the sign-up yet.
 */

import { chainVerdict, classifyHostFailure } from "@individuality/people-chain"

/** what the screen shows of a sign-up under way */
export type ActionableRetryReason = "host-chain" | "network" | "name-unowned"
/** Why the reminder gate held a sign-up back, which the next tap asks the host again about. */
export type ReminderBlock = "alarm-required" | "reminders-off"
/**
 * `chat` is a sign-up the chat card has on its way, which the app only shows.
 *
 * `reminders` is the ask for the game reminder that a sign-up waits on before it goes out.
 */
export type SignupPhase = "idle" | "reminders" | ReminderBlock | "waiting-seat" | "sending" | "slow" | ActionableRetryReason | "closed" | "refused" | "chat"

/** why an attempt is going again, in words safe to put on a telemetry tag */
export type RetryReason =
  | "bind-pending"
  /** the name link (#456) is still on its way: the seat is getting ready */
  | "name-pending"
  /** the name link found that nobody owns the username, and goes again */
  | "name-unowned"
  | "stale-alias"
  | "no-alias"
  | "tracking-lost"
  | "timeout"
  | "host-chain"
  | "host-interrupted"
  | "network"
  /** this tap's earlier sign-up is still on the wire, not yet included or
   *  dropped: wait for it to land or be dropped, never sign a second one (#82) */
  | "wire-pending"
  | "other"

/** how long the sign-up has to take before the screen says so */
export const SLOW_AFTER_MS = 20_000
/** how long one actionable failure must persist before the player is asked to act */
export const SURFACE_AFTER_MS = 60_000

/** how often the host's chain is looked at again while a sign-up stays slow */
export const HOST_PROBE_EVERY_MS = 15_000
/** consecutive probes with no verdict after which a shown host-chain notice clears */
export const HOST_NOTICE_UNKNOWN_LIMIT = 3

/** the wait after the n-th attempt (1-based) that did not land: 2, 4, 8 s,
 *  then every 15 s */
const BACKOFF_MS = [2_000, 4_000, 8_000, 15_000] as const
export const backoffMs = (attempt: number): number =>
  BACKOFF_MS[Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1]!

export function classifyRetry(error: string): RetryReason {
  if (/AliasNotBound|Custom\(175\)|NoAliasBinding/.test(error)) return "no-alias"
  if (/StaleAlias|Custom\(172\)/.test(error)) return "stale-alias"
  if (/Tracking stopped/i.test(error)) return "tracking-lost"
  if (/time(d)? ?out/i.test(error)) return "timeout"
  const failure = classifyHostFailure(error)
  if (failure === "host-interrupted") return "host-interrupted"
  if (/createTransaction failed/i.test(error) || chainVerdict(failure) === "lost") return "host-chain"
  if (failure === "network") return "network"
  return "other"
}

/** a wait on the seat's binding, as opposed to a plain pause */
export const waitsOnBind = (reason: RetryReason): boolean => reason === "bind-pending" || reason === "no-alias"
/** a wait on the seat getting ready, the binding or the name link: the
 *  screen shows "waiting-seat" for both */
export const waitsOnSeat = (reason: RetryReason): boolean => waitsOnBind(reason) || reason === "name-pending" || reason === "name-unowned"
export const isActionableRetry = (reason: RetryReason): reason is ActionableRetryReason =>
  reason === "host-chain" || reason === "network" || reason === "name-unowned"

/**
 * THE PALLET'S PERMANENT SIGN-UP ERRORS (Game pallet, from the descriptors'
 * error enum), which no retry changes. What stays a retry: the lite extension's
 * Custom(172)/(175), anything the host or network says, and the draw errors
 * (InvalidAirdropVrf*, NotEligibleForAirdrop), because the engine decides the
 * draws afresh on every attempt.
 *  - the player is already in: AlreadyRegistered
 *  - the game cannot take a sign-up any more: NoRegistration (the window
 *    closed: what the pallet refuses a late sign-up with), GameOngoing, NoGame,
 *    InvalidGameState, InvalidState
 *  - this account cannot sign up for it: NoInvites, AlreadyInvited,
 *    UseInviteButAlreadyPlaying, AnotherAccountInvited, NotAccountPlayer,
 *    StatementAccountAlreadyInUse, InvalidStatementAccountSignature,
 *    InvalidPlayDeposit, CreditCapacityExhausted, and the extension's own
 *    BadOrigin / Payment (the fee cannot be paid)
 */
export type Permanent = "registered" | "closed" | "refused"
export function classifyPermanent(error: string): Permanent | null {
  if (/AlreadyRegistered/.test(error)) return "registered"
  if (/\b(NoRegistration|GameOngoing|NoGame|InvalidGameState|InvalidState|RegistrationClosed)\b/.test(error)) return "closed"
  if (
    /NoInvites|AlreadyInvited|UseInviteButAlreadyPlaying|AnotherAccountInvited|NotAccountPlayer|StatementAccountAlreadyInUse|InvalidStatementAccountSignature|InvalidPlayDeposit|CreditCapacityExhausted|BadOrigin|Invalid\.Payment|\bPayment\b/.test(
      error,
    )
  )
    return "refused"
  return null
}

/** how one attempt ended */
export type AttemptResult =
  | { kind: "landed" }
  /** a refusal no retry changes (the chain's word) */
  | { kind: "closed" }
  | { kind: "refused"; reason: string }
  /** the chain already has the player (an earlier attempt landed late) */
  | { kind: "registered" }
  | { kind: "retry"; reason: RetryReason }

export type SignupEnd = "landed" | "registered" | "closed" | "refused" | "stopped"

/**
 * The retry loop's pure transactional core. I/O results carry the generation
 * of the command that requested them, so a duplicate or late completion cannot
 * start another sign-up attempt after the loop has moved on.
 */
type SignupRetryMachinePhase = "checking-window" | "attempting" | "waiting" | "finished"

export interface SignupRetryState {
  phase: SignupRetryMachinePhase
  generation: number
  attempts: number
  lastReason?: RetryReason
  end?: SignupEnd
}

export type SignupRetryEvent =
  | {
      kind: "window-result"
      generation: number
      result: boolean | "registered"
    }
  | { kind: "attempt-result"; generation: number; result: AttemptResult }
  | { kind: "wait-finished"; generation: number }
  | { kind: "stopped" }

export type SignupRetryCommand =
  | { kind: "check-window"; generation: number }
  | { kind: "attempt"; generation: number; attempt: number }
  | {
      kind: "wait"
      generation: number
      attempt: number
      reason: RetryReason
      waitMs: number
    }
  | { kind: "finish"; end: SignupEnd; attempts: number }

export interface SignupRetryStep {
  state: SignupRetryState
  commands: SignupRetryCommand[]
}

export function startSignupRetry(): SignupRetryStep {
  const state: SignupRetryState = {
    phase: "checking-window",
    generation: 1,
    attempts: 0,
  }
  return {
    state,
    commands: [{ kind: "check-window", generation: state.generation }],
  }
}

/** Pure retry policy: side effects leave as commands; late completions are no-ops. */
export function stepSignupRetry(before: SignupRetryState, event: SignupRetryEvent): SignupRetryStep {
  if (before.phase === "finished") return { state: before, commands: [] }

  const finish = (end: SignupEnd): SignupRetryStep => {
    const state: SignupRetryState = {
      ...before,
      phase: "finished",
      generation: before.generation + 1,
      end,
    }
    return {
      state,
      commands: [{ kind: "finish", end, attempts: state.attempts }],
    }
  }

  if (event.kind === "stopped") return finish("stopped")
  if (event.generation !== before.generation) return { state: before, commands: [] }

  if (before.phase === "checking-window" && event.kind === "window-result") {
    if (event.result === "registered") return finish("registered")
    if (!event.result) return finish("closed")
    const state: SignupRetryState = {
      ...before,
      phase: "attempting",
      generation: before.generation + 1,
      attempts: before.attempts + 1,
    }
    return {
      state,
      commands: [
        {
          kind: "attempt",
          generation: state.generation,
          attempt: state.attempts,
        },
      ],
    }
  }

  if (before.phase === "attempting" && event.kind === "attempt-result") {
    if (event.result.kind !== "retry") return finish(event.result.kind)
    const state: SignupRetryState = {
      ...before,
      phase: "waiting",
      generation: before.generation + 1,
      lastReason: event.result.reason,
    }
    return {
      state,
      commands: [
        {
          kind: "wait",
          generation: state.generation,
          attempt: state.attempts,
          reason: event.result.reason,
          waitMs: backoffMs(state.attempts),
        },
      ],
    }
  }

  if (before.phase === "waiting" && event.kind === "wait-finished") {
    const state: SignupRetryState = {
      ...before,
      phase: "checking-window",
      generation: before.generation + 1,
    }
    return {
      state,
      commands: [{ kind: "check-window", generation: state.generation }],
    }
  }

  return { state: before, commands: [] }
}

export interface SignupRetryDeps {
  /** one attempt. It calls `onWire` once the sign-up is out. A throw is a final refusal. */
  attempt: (attemptNo: number, onWire: () => void) => Promise<AttemptResult>
  /** false once registration is closed (chain clock, `source.nowSeconds()`).
   *  "registered": it closed, but the chain already has the player (#582),
   *  so the sign-up ends as theirs and not as a missed window. */
  windowOpen: () => Promise<boolean | "registered">
  /** wait `ms` for the reason (the bind, or just a pause) */
  wait: (reason: RetryReason, ms: number) => Promise<void>
  /** milliseconds on any steady clock */
  now: () => number
  /** the caller stopped it (page left, source gone) */
  stopped: () => boolean
  /** run `fn` after `ms`; returns the cancel. Drives "taking longer" while an
   *  attempt is in flight, which no loop turn would announce. */
  startTimer: (ms: number, fn: () => void) => () => void
  onPhase: (phase: SignupPhase) => void
  /** an attempt is going again: its number, why, and how long before it */
  onRetry: (retry: { attempt: number; reason: RetryReason; waitMs: number; elapsedMs: number }) => void
  /** one actionable reason has persisted long enough for the player to see it */
  onErrorSurfaced?: (reason: ActionableRetryReason) => void
  /**
   * Looks at the host's chain once ("lost": the host shows chain loss;
   * "timeout": it did not answer, which counts as lost only on a second one in
   * a row; "healthy"; "unknown": no verdict). Asked from the
   * slow threshold on, because a HUNG attempt never returns the error that
   * classifyRetry would map to "host-chain". The caller de-duplicates it.
   */
  probeHostChain?: () => Promise<"lost" | "healthy" | "timeout" | "unknown">
  onWire: () => void
}

export async function signupWithRetry(deps: SignupRetryDeps): Promise<{ end: SignupEnd; attempts: number; elapsedMs: number }> {
  const startedAt = deps.now()
  const elapsed = () => deps.now() - startedAt
  let finished = false
  let cancelSlow = () => {}
  let cancelProbe = () => {}
  /** the host's chain looked lost on the latest probe: say so in place of "slow" */
  let hostLost = false
  let surfaced: ActionableRetryReason | undefined
  const slowPhase = (): SignupPhase => surfaced ?? (hostLost ? "host-chain" : "slow")
  const armProbe = (delayMs: number) => {
    cancelProbe = deps.startTimer(delayMs, () => {
      if (finished) return
      if (deps.stopped()) {
        armProbe(1_000)
        return
      }
      void probe()
    })
  }
  let timeouts = 0
  let noVerdicts = 0
  const probe = async () => {
    let raw: "lost" | "healthy" | "timeout" | "unknown" = "unknown"
    try {
      raw = (await deps.probeHostChain?.()) ?? "unknown"
    } catch {
      // a probe that throws gives no verdict
    }
    if (finished) return
    if (deps.stopped()) {
      // paused while the probe ran: look again once resumed, apply nothing now
      armProbe(1_000)
      return
    }
    timeouts = raw === "timeout" ? timeouts + 1 : 0
    const verdict = raw === "timeout" ? (timeouts >= 2 ? "lost" : "unknown") : raw
    noVerdicts = verdict === "unknown" ? noVerdicts + 1 : 0
    const next = verdict === "lost" ? true : verdict === "healthy" || noVerdicts >= HOST_NOTICE_UNKNOWN_LIMIT ? false : hostLost
    if (next !== hostLost) {
      hostLost = next
      if (!surfaced) deps.onPhase(hostLost ? "host-chain" : "slow")
      if (hostLost && surfaced !== "host-chain") deps.onErrorSurfaced?.("host-chain")
    }
    // ONE RULE FOR THE NOTICE, WHICHEVER PATH RAISED IT (#585): a healthy
    // probe clears "host-chain", the probe's own "lost" and 60 s of
    // "host-chain" retries alike, so a host that recovered is never still
    // called lost. The next "host-chain" retry arms the 60 s again. A
    // "network" notice is not the host's chain and stays.
    if (verdict === "healthy" && surfaced === "host-chain") {
      clearActionable()
      deps.onPhase("slow")
    }
    armProbe(HOST_PROBE_EVERY_MS)
  }
  const armSlow = (delayMs: number) => {
    cancelSlow = deps.startTimer(delayMs, () => {
      if (finished) return
      if (deps.stopped()) {
        armSlow(1_000)
        return
      }
      deps.onPhase(slowPhase())
      if (deps.probeHostChain) void probe()
    })
  }
  armSlow(SLOW_AFTER_MS)
  let attempts = 0
  let lastReason: RetryReason | undefined
  let actionable: ActionableRetryReason | undefined
  let cancelSurface = () => {}
  const clearActionable = () => {
    cancelSurface()
    cancelSurface = () => {}
    actionable = undefined
    surfaced = undefined
  }
  const armSurface = (reason: ActionableRetryReason, delayMs: number) => {
    cancelSurface = deps.startTimer(delayMs, () => {
      if (finished || actionable !== reason) return
      // CancelRegister pauses an in-flight loop and a later tap resumes the
      // same promise. Do not consume its one actionable notice while paused.
      if (deps.stopped()) {
        armSurface(reason, 1_000)
        return
      }
      surfaced = reason
      deps.onPhase(reason)
      deps.onErrorSurfaced?.(reason)
    })
  }
  const trackActionable = (reason: RetryReason) => {
    if (!isActionableRetry(reason)) {
      clearActionable()
      return
    }
    if (actionable === reason) return
    clearActionable()
    actionable = reason
    // the chain already said why, so the player hears it at once
    armSurface(reason, reason === "name-unowned" ? 0 : SURFACE_AFTER_MS)
  }
  const done = (end: SignupEnd, phase: SignupPhase) => {
    finished = true
    deps.onPhase(phase)
    return { end, attempts, elapsedMs: elapsed() }
  }
  try {
    let { state, commands } = startSignupRetry()
    for (;;) {
      const command = commands[0]
      if (!command) throw new Error("sign-up retry machine produced no command before finishing")
      if (command.kind === "finish") {
        attempts = command.attempts
        return done(command.end, command.end === "closed" ? "closed" : command.end === "refused" ? "refused" : "idle")
      }

      let event: SignupRetryEvent
      // Match the original doorway's ordering exactly: a stop is observed at
      // the loop top, before the window check, but an open result already in
      // flight still gets its attempt. The post-attempt check below then wins.
      if (command.kind === "check-window" && deps.stopped()) {
        event = { kind: "stopped" }
      } else if (command.kind === "check-window") {
        event = {
          kind: "window-result",
          generation: command.generation,
          result: await deps.windowOpen(),
        }
      } else if (command.kind === "attempt") {
        attempts = command.attempt
        // after a seat wait the phase stays "waiting-seat" until the attempt says otherwise
        if (attempts === 1) deps.onPhase("sending")
        else if (surfaced) deps.onPhase(surfaced)
        else if (elapsed() >= SLOW_AFTER_MS) deps.onPhase(slowPhase())
        else if (lastReason && !waitsOnSeat(lastReason)) deps.onPhase("sending")
        const result = await deps.attempt(attempts, deps.onWire)
        event = deps.stopped() ? { kind: "stopped" } : { kind: "attempt-result", generation: command.generation, result }
      } else {
        trackActionable(command.reason)
        lastReason = command.reason
        deps.onRetry({
          attempt: command.attempt,
          reason: command.reason,
          waitMs: command.waitMs,
          elapsedMs: elapsed(),
        })
        deps.onPhase(elapsed() >= SLOW_AFTER_MS ? slowPhase() : (surfaced ?? (waitsOnSeat(command.reason) ? "waiting-seat" : "sending")))
        await deps.wait(command.reason, command.waitMs)
        event = { kind: "wait-finished", generation: command.generation }
      }
      ;({ state, commands } = stepSignupRetry(state, event))
    }
  } finally {
    finished = true
    cancelSlow()
    cancelProbe()
    cancelSurface()
  }
}

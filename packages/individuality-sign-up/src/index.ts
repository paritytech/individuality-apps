// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Signing a player up, the same from every surface: the Jollity app's
 * sign-up, lifted out of it, for an app, a chat or another product to run.
 * It sits on the product SDK's game registration
 * (`@parity/product-sdk-individuality`): the seat, the bind and the sign-up
 * with its draw entries are the SDK's, and this package adds what a product
 * does around them.
 *
 *  - the seat: the name link on top of the SDK's (./seat.ts), what the
 *    deposit route is short of (./funds.ts), and the flow's own bind policy
 *    (./free-seat.ts);
 *  - the gates before the sign-up goes: the game reminder (./reminder.ts), a
 *    sign-up another surface has on its way (the game registration record of
 *    @individuality/shared-records), and who a draw ticket is for
 *    (./draw-ticket.ts);
 *  - the retry policy and the words of its failures (./signup-retry.ts,
 *    ./signup-failure.ts);
 *  - what the flow asks of the chain, and Jollity's draw rule
 *    (./sign-up-types.ts), and the communication identifier it registers
 *    (./communication-key.ts);
 *  - the sign-up itself, one flow every surface runs through those gates
 *    (./sign-up-flow.ts).
 *
 * The sign-up on the chain is ./chain, a subpath of its own.
 */
export {
  drawResult,
  type BindResult,
  type DrawResult,
  type DrawSkipKind,
  type RegisterOptions,
  type RegisterResult,
  type SignUpChain,
  type SignUpDraws,
  type SignUpFlowChain,
} from "./sign-up-types"
export {
  communicationKeyFrom,
  communicationKeyRecord,
  freshCommunicationKey,
  keptCommunicationIdentifier,
  reusableCommunicationKey,
  soundCommunicationKey,
  type CommunicationKeyPair,
} from "./communication-key"
export { namedSeat, SeatUnfundedError } from "./seat"
export { formatAmount, shortfall, type Funds } from "./funds"
export { BIND_TIMEOUT_MS, readSequence, type ReadSequence } from "./free-seat"
export {
  ASK_UNDER_WAY_MS,
  JOIN_LEAD_S,
  joinAtMs,
  askUnderClaim,
  askUnderWay,
  cancelNextGame,
  remindNextGame,
  type GameReminderClient,
  type GameReminderOutcome,
  type HostReminder,
  type HostReminderStore,
  type ReminderErrorListener,
} from "./reminder"
export { drawTicketCanPay, gamesToMembership, type ScoreStanding } from "./draw-ticket"
// the retry policy, and its machine for a surface that models or tests it
export {
  backoffMs,
  classifyPermanent,
  classifyRetry,
  HOST_NOTICE_UNKNOWN_LIMIT,
  HOST_PROBE_EVERY_MS,
  isActionableRetry,
  signupWithRetry,
  SLOW_AFTER_MS,
  startSignupRetry,
  stepSignupRetry,
  SURFACE_AFTER_MS,
  waitsOnBind,
  waitsOnSeat,
  type ActionableRetryReason,
  type AttemptResult,
  type Permanent,
  type ReminderBlock,
  type RetryReason,
  type SignupEnd,
  type SignupPhase,
  type SignupRetryCommand,
  type SignupRetryDeps,
  type SignupRetryEvent,
  type SignupRetryState,
  type SignupRetryStep,
} from "./signup-retry"
export { signupFailureReason } from "./signup-failure"
export {
  createSignUpFlow,
  type RegistrationWindow,
  type SignUpAttrs,
  type SignUpFlow,
  type SignUpFlowOptions,
  type SignUpJourney,
  type SignUpRetryOptions,
  type SignUpStep,
  type SignUpTelemetry,
} from "./sign-up-flow"

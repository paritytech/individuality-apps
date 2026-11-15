// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * When the home may send `Score.register` on its own, and how often.
 *
 * Pure policy over the card state and the per-person registration record
 * (`personhood-registration-store.ts`); the hook that sends lives in
 * `use-auto-register-personhood.ts`. Nothing is ever sent twice blindly: a
 * record that says a registration is on its way blocks every resend until
 * it is old enough that the transaction has either landed or been dropped,
 * and even then the chain is asked again first.
 */
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";

/** Why the last attempt stopped, kept for the debug panel and the log. */
export type RegistrationStopKind = "unsupported-host" | "refused" | "failed";

export type PersonhoodRegistrationRecord =
  /** Handed to the chain (or about to be): blocks resends. */
  | { status: "sending"; candidate: string; at: number }
  | { status: "sent"; candidate: string; at: number; txHash: string }
  | {
      status: "stopped";
      candidate: string | null;
      at: number;
      kind: RegistrationStopKind;
      /** Consecutive stops, which sets the backoff before the next try. */
      attempts: number;
    };

/** A sent registration that the card has still not caught up with after
 *  this long has either landed unseen or been dropped: the chain decides. */
export const SENT_SETTLE_MS = 10 * 60_000;

/** Wait after the n-th consecutive stop (1-based), capped at the last: a
 *  stop is retried for as long as the app is open, so a dropped host or RPC
 *  connection heals by itself. */
const STOP_BACKOFF_MS = [10_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000];

export function stopBackoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), STOP_BACKOFF_MS.length) - 1;
  return STOP_BACKOFF_MS[index] ?? STOP_BACKOFF_MS[STOP_BACKOFF_MS.length - 1]!;
}

/**
 * When `record` next allows an attempt: `sending`/`sent` once old enough to
 * have settled, `stopped` after its backoff. The attempt re-reads the chain
 * before it sends anything.
 */
export function nextAttemptAt(record: PersonhoodRegistrationRecord | null): number {
  if (record == null) return 0;
  return record.status === "stopped"
    ? record.at + stopBackoffMs(record.attempts)
    : record.at + SENT_SETTLE_MS;
}

/**
 * The card has cleared the threshold but is not a member yet: the same rule
 * as the SDK's `readyToRegister`, read off the card — `membership-ready`
 * (the chain's own flag) or a candidate whose score is at the threshold.
 */
export function readyToFinishMembership(state: HumanityCardState): boolean {
  return (
    state.kind === "membership-ready" ||
    (state.kind === "candidate" && state.score >= state.personhoodThreshold)
  );
}

/**
 * Why the automatic registration did or did not fire, with every input that
 * decided it spelled out — the line the debug panel shows and the log
 * records once per change.
 */
export type RegistrationGate =
  | { kind: "not-live"; detail: string }
  | { kind: "no-card"; detail: string }
  | { kind: "not-ready"; detail: string }
  | { kind: "in-flight"; detail: string }
  | { kind: "paused"; detail: string }
  | { kind: "holding"; detail: string }
  | { kind: "firing"; detail: string };

export interface RegistrationGateInput {
  live: boolean;
  /** Card state, `account-unavailable`, or undefined while it has not read. */
  card:
    | { kind: "card"; owner: string; state: HumanityCardState; playAccount: string }
    | { kind: "account-unavailable" }
    | undefined;
  busy: boolean;
  /** In-memory hold for this launch, from outcomes the record does not
   *  keep: a chain that says not ready yet, or a preview deploy (forever). */
  pausedUntil: number;
  record: PersonhoodRegistrationRecord | null;
  now: number;
}

function describeState(state: HumanityCardState): string {
  return state.kind === "candidate"
    ? `candidate, score ${state.score}/${state.personhoodThreshold}`
    : state.kind;
}

export function registrationGate(input: RegistrationGateInput): RegistrationGate {
  const { card } = input;
  if (!input.live) return { kind: "not-live", detail: "not the live card (demo or fixture page)" };
  if (card == null) return { kind: "no-card", detail: "the card has not read yet" };
  if (card.kind === "account-unavailable") {
    return { kind: "no-card", detail: "the card read found no account" };
  }
  const who = `owner ${card.owner}, card plays as ${card.playAccount}`;
  if (!readyToFinishMembership(card.state)) {
    return { kind: "not-ready", detail: `card is ${describeState(card.state)}; ${who}` };
  }
  if (input.busy) return { kind: "in-flight", detail: `a registration is already running; ${who}` };
  const { record } = input;
  if (record != null && input.now < nextAttemptAt(record)) {
    const why = record.status === "stopped" ? `stopped (${record.kind}, ${record.attempts}x)` : record.status;
    return {
      kind: "holding",
      detail:
        `last attempt ${why} at ${new Date(record.at).toISOString()}; ` +
        `next try after ${new Date(nextAttemptAt(record)).toISOString()}; ${who}`,
    };
  }
  if (input.now < input.pausedUntil) {
    const until = Number.isFinite(input.pausedUntil)
      ? `until ${new Date(input.pausedUntil).toISOString()}`
      : "for this launch";
    return { kind: "paused", detail: `paused ${until}; ${who}` };
  }
  return { kind: "firing", detail: `card is ${describeState(card.state)}; ${who}` };
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What the mutation triggers attempted and how each attempt ended.
 *
 * Not reconstructable from anything else in the panel. The panel's own
 * refusals — an unparseable draw reference, a draw absent from the standing —
 * never reach the logger at all, and every one of these is transient React
 * state that the next attempt overwrites. A report that says "claim failed"
 * without saying which draw, or that the panel refused to submit at all, sends
 * the reader looking for a chain bug that never happened.
 *
 * One production hook writes here deliberately: `useBindGameSeat` journals
 * every `PeopleLite.set_alias_account` attempt with its decoded failure
 * detail. Seat reservation is the one flow whose failure is reported by
 * people who cannot read a console, and 50 mutation records outlive the
 * 200-record log buffer, so the detail is still in the snapshot they paste
 * after the log line that carried it has rolled off. Other production hooks
 * log a failure *code* and nothing else, and stay out of the journal.
 *
 * A journal rather than last-error-wins: three attempts on one draw and one
 * attempt each on three draws are different bugs.
 *
 * React-free so the shaping stays unit-testable; the panel reads it on demand,
 * so there is nothing to subscribe to.
 */

/** Small: an operator clicks these by hand, and only a recent run is relevant. */
export const MUTATION_CAPACITY = 50;

export type MutationOutcome =
  /** The panel refused to submit — nothing reached the chain. */
  | "rejected"
  /**
   * Handed to the chain layer. Recorded once per click, which is what keeps the
   * attempt count honest: a settle is observed through React state, so two
   * identical consecutive failures coalesce into one settle record, while their
   * two submissions still show as two.
   */
  | "submitted"
  /** Submitted and failed. */
  | "failed"
  /** Submitted and settled: finalized, or for claims included in a best block. */
  | "finalized"
  /** Submitted, settlement unobserved (broadcast seen, inclusion/finality not). */
  | "unknown";

export interface MutationRecord {
  readonly id: number;
  /** Epoch ms. */
  readonly at: number;
  /** The extrinsic the trigger targets, e.g. `PeopleAirdrops.register`. */
  readonly mutation: string;
  readonly outcome: MutationOutcome;
  /** Operator-visible detail: the refusal reason, the error text, or a txHash. */
  readonly detail: string;
}

let records: readonly MutationRecord[] = [];
let nextId = 1;

export function mutationJournal(): readonly MutationRecord[] {
  return records;
}

export function clearMutationJournal(): void {
  records = [];
}

export function recordMutation(
  mutation: string,
  outcome: MutationOutcome,
  detail: string,
): void {
  const record: MutationRecord = { id: nextId, at: Date.now(), mutation, outcome, detail };
  nextId += 1;
  records =
    records.length < MUTATION_CAPACITY
      ? [...records, record]
      : [...records.slice(records.length - MUTATION_CAPACITY + 1), record];
}

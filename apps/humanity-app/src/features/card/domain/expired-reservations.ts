// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Which entries of a full name's People reservation queue Humanity removes
 * for a person waiting in it.
 *
 * `Resources.register_person(Reservation)` only accepts the front of
 * `UsernameReservationQueue[name]`, and the runtime never drops an expired
 * entry by itself: it stays until someone submits
 * `Resources.remove_expired_username_reservation(name, account)`, one entry
 * per call. Anyone may submit it once `now > joined_at + duration` — the
 * runtime's own check (`validate_reservation_expiry`), mirrored here with
 * `now` and `joined_at` in seconds and `duration` from
 * `Resources.UsernameReservationDuration`.
 *
 * Humanity is stricter than the runtime in one way: it never removes an entry
 * younger than `RESERVATION_FLOOR_SECS`, whatever the People duration says.
 * That duration is unset on Paseo People Next today, which makes every
 * entry removable the moment it is made; following it alone would let the
 * second person in a queue strip the first of a name reserved an hour ago.
 * The floor is the one-month reservation the product promises, and the
 * duration dotNS's `DotnsPopController` is deployed with.
 *
 * Only entries ahead of the person's own are picked: those are the ones that
 * block the claim. The person's own entry is never picked, nor anything
 * behind it, and a person not in the queue gets nothing — Humanity does not
 * clear reservations on names its user never reserved.
 */

/** 30 days: the shortest a reservation Humanity removes may have stood. */
export const RESERVATION_FLOOR_SECS = 30n * 86_400n;

export interface ReservationQueueEntry {
  readonly account: string;
  /** Seconds since the epoch, as the runtime stamps it. */
  readonly joined_at: bigint;
}

export function expiredEntriesAhead(
  queue: readonly ReservationQueueEntry[],
  claimant: string,
  nowSecs: bigint,
  durationSecs: bigint,
): string[] {
  const position = queue.findIndex((entry) => entry.account === claimant);
  if (position <= 0) return [];
  const lifetime = durationSecs > RESERVATION_FLOOR_SECS ? durationSecs : RESERVATION_FLOOR_SECS;
  return queue
    .slice(0, position)
    .filter((entry) => nowSecs > entry.joined_at + lifetime)
    .map((entry) => entry.account);
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The per-person record of the automatic `Score.register`, in
 *  `localStorage` like the other per-device flags: it must be readable
 *  synchronously on the render that decides whether to send, so a reload
 *  while a registration is in flight never sends a second one. Keyed by the
 *  username owner (one candidate account per owner on a device); the record
 *  names the candidate it was for. Keyed on the network alone, so a query
 *  cache schema bump does not forget a registration on its way. */
import type { PersonhoodRegistrationRecord } from "@features/card/domain/personhood-registration.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { NETWORK_SCOPE } from "@shared/chain/query-persistence.ts";

const PREFIX = `humanity-prizes:personhood-registration:${NETWORK_SCOPE}:`;
const VERSION = 1;

const logger = loggerFor("card", "personhood-registration-store");

const STATUSES: Record<PersonhoodRegistrationRecord["status"], true> = {
  sending: true,
  sent: true,
  stopped: true,
};

export function readPersonhoodRegistration(owner: string): PersonhoodRegistrationRecord | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + owner);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      record?: { status?: unknown; at?: unknown };
    } | null;
    const record = parsed?.record;
    if (
      parsed?.version !== VERSION ||
      record == null ||
      typeof record.at !== "number" ||
      typeof record.status !== "string" ||
      !(record.status in STATUSES)
    ) {
      return null;
    }
    return record as PersonhoodRegistrationRecord;
  } catch {
    return null;
  }
}

export function writePersonhoodRegistration(
  owner: string,
  record: PersonhoodRegistrationRecord,
): void {
  try {
    window.localStorage.setItem(PREFIX + owner, JSON.stringify({ version: VERSION, record }));
  } catch (error: unknown) {
    logger.warning("could not remember the registration: {error}", { error });
  }
}

export function clearPersonhoodRegistration(owner: string): void {
  try {
    window.localStorage.removeItem(PREFIX + owner);
  } catch (error: unknown) {
    logger.warning("could not forget the registration: {error}", { error });
  }
}

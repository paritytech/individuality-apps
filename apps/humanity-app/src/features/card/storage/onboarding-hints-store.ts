// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Which onboarding hints this device has been shown and when. The record
 * lives in `localStorage` like the last-card snapshot: it has to be
 * readable synchronously on first render so a returning visit never sees a
 * hint flash, and host KV is async.
 *
 * A visit is one page load. Each is told apart by `CURRENT_VISIT`, so a tip
 * that was on screen when the app closed counts as seen on the next visit
 * without anything having to run on the way out (a closed webview runs
 * nothing). The key carries the network alone, not the query cache's schema
 * scope: the record has its own version, and a cache bump must not show
 * every tip again.
 */
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { NETWORK_SCOPE } from "@shared/chain/query-persistence.ts";
import { settleEarlierVisit } from "@features/card/domain/onboarding-hints.ts";

export type OnboardingHintId = "card" | "register" | "stripe";

export const ONBOARDING_HINT_IDS: readonly OnboardingHintId[] = ["card", "register", "stripe"];

export interface OnboardingHintRecord {
  version: 2;
  /** Hints that have done their job, by when they retired. */
  retired: Partial<Record<OnboardingHintId, number>>;
  /** The last hint shown, when, and on which visit. */
  lastShown: { id: OnboardingHintId; at: number; visit: string } | null;
  /** The visit that showed the first tip ever: the one whose tips run one
   *  after another. Null until a tip has shown. */
  firstVisit: string | null;
}

const KEY = `humanity-prizes:hints:${NETWORK_SCOPE}`;
const VERSION = 2;

const logger = loggerFor("card", "onboarding-hints-store");

function newVisitId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/** This page load. */
export let CURRENT_VISIT = newVisitId();

let cached: OnboardingHintRecord | undefined;

export const emptyHintRecord = (): OnboardingHintRecord => ({
  version: 2,
  retired: {},
  lastShown: null,
  firstVisit: null,
});

function isHintId(value: unknown): value is OnboardingHintId {
  return typeof value === "string" && (ONBOARDING_HINT_IDS as readonly string[]).includes(value);
}

function parse(raw: string | null): OnboardingHintRecord {
  if (raw == null) return emptyHintRecord();
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) return emptyHintRecord();
  const record = value as { version?: unknown; retired?: unknown; lastShown?: unknown; firstVisit?: unknown };
  if (record.version !== VERSION) return emptyHintRecord();
  const retired: OnboardingHintRecord["retired"] = {};
  if (typeof record.retired === "object" && record.retired !== null) {
    for (const [id, at] of Object.entries(record.retired as Record<string, unknown>)) {
      if (isHintId(id) && typeof at === "number") retired[id] = at;
    }
  }
  const last = record.lastShown as { id?: unknown; at?: unknown; visit?: unknown } | null | undefined;
  const lastShown =
    last != null && isHintId(last.id) && typeof last.at === "number" && typeof last.visit === "string"
      ? { id: last.id, at: last.at, visit: last.visit }
      : null;
  const firstVisit = typeof record.firstVisit === "string" ? record.firstVisit : null;
  return { version: 2, retired, lastShown, firstVisit };
}

/** The record as this visit sees it: a tip left on screen by an earlier
 *  visit is retired here, once, and written back. */
export function readOnboardingHints(): OnboardingHintRecord {
  if (cached !== undefined) return cached;
  let stored: OnboardingHintRecord;
  try {
    stored = parse(window.localStorage.getItem(KEY));
  } catch {
    // Blocked or unreadable storage: every hint shows, and writes fail the
    // same quiet way.
    stored = emptyHintRecord();
  }
  const settled = settleEarlierVisit(stored, CURRENT_VISIT);
  if (settled !== stored) write(settled);
  else cached = stored;
  return cached!;
}

function write(next: OnboardingHintRecord): void {
  cached = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch (error: unknown) {
    logger.warning("could not remember the onboarding hints: {error}", { error });
  }
}

/** The person acted on the hint, or waved it away. */
export function retireOnboardingHint(id: OnboardingHintId, now = Date.now()): void {
  const current = readOnboardingHints();
  if (current.retired[id] != null) return;
  write({ ...current, retired: { ...current.retired, [id]: now } });
}

/** A hint went on screen during this visit. */
export function markOnboardingHintShown(id: OnboardingHintId, now = Date.now()): void {
  const current = readOnboardingHints();
  write(withShown(current, id, now, CURRENT_VISIT));
}

/** `record` with `id` shown at `now` on `visit`; the first tip ever shown
 *  names the first visit. */
export function withShown(
  record: OnboardingHintRecord,
  id: OnboardingHintId,
  now: number,
  visit: string,
): OnboardingHintRecord {
  return {
    ...record,
    lastShown: { id, at: now, visit },
    firstVisit: record.firstVisit ?? (record.lastShown == null ? visit : null),
  };
}

/** Drops the cached record between isolated test runs. */
export function resetOnboardingHintsStoreForTests(): void {
  cached = undefined;
}

/** A reload, for tests: the next read is a new visit. */
export function startNewVisitForTests(): void {
  cached = undefined;
  CURRENT_VISIT = newVisitId();
}

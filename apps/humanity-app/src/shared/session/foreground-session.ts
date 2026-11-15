// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The foreground session: one stretch of Humanity being in front of the
 * person.
 *
 * The host keeps the page alive between opens and only hides it, so a mount
 * never marks a visit. A session begins when the page loads and again every
 * time it comes back into view — `visibilitychange`, which the Android host
 * fires on every open and every return from the background (`focus` never
 * arrives there) — or is restored from the back-forward cache. Anything that
 * must hold "for this open" keys on the session: a chain read is fresh for
 * it only when it landed after the session began, so a card hydrated from
 * the persisted cache or read before the person left never passes for the
 * current one.
 */
import { useSyncExternalStore } from "react";

export interface ForegroundSession {
  /** Counts the sessions since the page loaded; the load itself is 1. */
  readonly id: number;
  /** `Date.now()` when the session began. */
  readonly startedAt: number;
}

let session: ForegroundSession = { id: 1, startedAt: Date.now() };
const listeners = new Set<() => void>();

function begin(): void {
  session = { id: session.id + 1, startedAt: Date.now() };
  for (const listener of listeners) listener();
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") begin();
}

/** The first load's own `pageshow` is not a return: that session is 1. */
function onPageShow(event: PageTransitionEvent): void {
  if (event.persisted) begin();
}

let listening = false;

function listen(): void {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pageshow", onPageShow);
}

function subscribe(listener: () => void): () => void {
  listen();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getForegroundSession(): ForegroundSession {
  return session;
}

/** The current foreground session; re-renders when a new one begins. */
export function useForegroundSession(): ForegroundSession {
  return useSyncExternalStore(subscribe, getForegroundSession, getForegroundSession);
}

export type Freshness = "fresh" | "failed" | "checking";

/** The two timestamps TanStack keeps on every query's state. */
export interface QueryTimestamps {
  dataUpdatedAt: number;
  errorUpdatedAt: number;
}

/**
 * Where a query stands for `session`: `fresh` when its data landed since the
 * session began, `failed` when only an error did, `checking` when neither —
 * which is what hydrated or retained data is until a read of this session
 * replaces it.
 */
export function freshness(
  state: QueryTimestamps,
  session: ForegroundSession,
): Freshness {
  if (state.dataUpdatedAt >= session.startedAt) return "fresh";
  if (state.errorUpdatedAt >= session.startedAt) return "failed";
  return "checking";
}

/** Tests only: a session begun now, as the page load would have. */
export function resetForegroundSessionForTests(): void {
  session = { id: 1, startedAt: Date.now() };
  for (const listener of listeners) listener();
}

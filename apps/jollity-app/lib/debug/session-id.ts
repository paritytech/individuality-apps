// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * One id per page load. Its own module so lib/telemetry (Sentry's session.id
 * tag) can read it without importing the local debug log, which imports
 * lib/telemetry back.
 */
export const SESSION_ID: string =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/** A fresh 32-hex-char id (the shape of a Sentry event id). `crypto.randomUUID`
 *  is missing in older webviews, so this falls back to Math.random. */
export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID().replace(/-/g, "")
  let id = ""
  while (id.length < 32) id += Math.floor(Math.random() * 16).toString(16)
  return id
}

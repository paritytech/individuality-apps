// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A Sentry organization's server-side scrubbing rules can blank the WHOLE
 * value of any attribute or tag that contains auth, secret, credential or
 * password. A host error such as "Unauthorized" or "no credentials" would then
 * arrive empty, so free text headed for an
 * attribute or a tag goes through `maskSafe` first: the third letter of each
 * such word becomes "*" ("Unauthorized" -> "Unau*horized"), still readable.
 */
const MASKED_WORDS = /auth|secret|credential|password/gi

export function maskSafe(text: string): string {
  return text.replace(MASKED_WORDS, (word) => `${word.slice(0, 2)}*${word.slice(3)}`)
}

/** the same, over the values of a record of text */
export function maskSafeValues(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, maskSafe(value)]))
}

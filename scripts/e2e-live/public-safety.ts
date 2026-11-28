// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { wordlist as english } from "@scure/bip39/wordlists/english"

const SECRET_KEYS = new Set([
  "mnemonic",
  "seed",
  "secret",
  "privatekey",
  "apikey",
  "accesskey",
  "clientsecret",
  "authorization",
  "cookie",
  "token",
  "password",
  "dsn",
  "sentrydsn",
  "credential",
  "credentials",
  "turnusername",
  "turncredential",
])

/** Lowercase technical identifiers that resemble secret names but are public telemetry schema. */
const PUBLIC_TECHNICAL_IDENTIFIERS = ["rtc.turn_ttl_left_s"] as const
const bip39Words = new Set(english)

const normalizedKey = (key: string): string => key.toLowerCase().replaceAll(/[^a-z0-9]/g, "")

const mnemonicShaped = (value: string): boolean => {
  let consecutive = 0
  for (const word of value.toLowerCase().match(/[a-z]+/g) ?? []) {
    consecutive = bip39Words.has(word) ? consecutive + 1 : 0
    if (consecutive >= 12) return true
  }
  return false
}

const safeText = (value: string): string => {
  const normalized = value.replaceAll(/\p{Cf}/gu, "").normalize("NFKC").replaceAll("\\_", "_")
  return PUBLIC_TECHNICAL_IDENTIFIERS.reduce((text, identifier) => text.replaceAll(identifier, ""), normalized)
}

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`)
}

export function assertPublicSafe(where: string, value: unknown): void {
  if (typeof value === "string") {
    const normalized = safeText(value)
    if (/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/i.test(normalized)) fail(where, "private key material is forbidden")
    if (/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(normalized)) fail(where, "authorization secret is forbidden")
    if (/(?:dim2|e2e|sentry|turn)_[a-z0-9_]+/i.test(normalized) || /[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/.test(normalized)) fail(where, "environment variable or secret name is forbidden")
    if (mnemonicShaped(normalized)) fail(where, "mnemonic-shaped text is forbidden")
    if (/(?:^|[^A-Fa-f0-9])[A-Fa-f0-9]{64,}(?=$|[^A-Fa-f0-9])/.test(normalized)) fail(where, "hex seed material is forbidden")
    if (/(?:^|[="'`(:\[]\s*)\/\/[A-Z][A-Za-z0-9_-]*(?:(?:\/\/|\/)[A-Za-z0-9_-]+)*(?=$|[\s"'`;)\]},])/u.test(normalized)) fail(where, "development signer URI is forbidden")
    if (/\b[a-z][a-z0-9+.-]*:(?:\/\/)?[^\s/:@]*:[^\s@]+@/i.test(normalized) || /(?:^|[\s"'(=:\[,])\/\/[^\s/:@]*:[^\s@]+@/i.test(normalized) || /(?:^|[\s"'(=,\[])[^\s/:@]+:[^\s@]+@/i.test(normalized) || /\b(?:https?|wss?|turns?):\/\/[^/\s@]+@/i.test(normalized)) fail(where, "credential-bearing URL or DSN is forbidden")
    if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(normalized)) fail(where, "GitHub token is forbidden")
    if (/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/.test(normalized)) fail(where, "JWT is forbidden")
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPublicSafe(`${where}[${index}]`, entry))
    return
  }
  if (typeof value !== "object" || value === null) return
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEYS.has(normalizedKey(key))) fail(`${where}.${key}`, "secret-like field name is forbidden")
    assertPublicSafe(`${where}.${key}`, entry)
  }
}

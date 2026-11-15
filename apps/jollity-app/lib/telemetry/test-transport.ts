// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * TEST HELPER: a Sentry transport that records what would actually be sent,
 * so a test asserts on the real envelope, not on a
 * mocked call. Imported by tests only.
 */
import type { Envelope, TelemetryConfig, TransportFactory } from "./init"

export interface SentItem {
  type: string
  header: Record<string, unknown>
  // envelope payloads are loosely shaped JSON; tests read into them
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>
}

export function recordingTransport(statusCode = 200) {
  const envelopes: Envelope[] = []
  const factory: TransportFactory = () => ({
    send: async (envelope) => {
      envelopes.push(envelope)
      return { statusCode }
    },
    flush: async () => true,
  })
  const items = (type?: string): SentItem[] =>
    envelopes
      .flatMap(([, list]) => list as unknown as Array<[Record<string, unknown>, unknown]>)
      .map(([header, payload]) => ({
        type: String(header.type),
        header,
        // through JSON, as on the wire: an undefined field is not sent
        payload:
          payload instanceof Uint8Array
            ? { text: new TextDecoder().decode(payload) }
            : typeof payload === "string"
              ? { text: payload }
              : (JSON.parse(JSON.stringify(payload)) as Record<string, unknown>),
      }))
      .filter((item) => type === undefined || item.type === type)
  return { factory, envelopes, items }
}

export function testConfig(over: Partial<TelemetryConfig> = {}): TelemetryConfig {
  return {
    dsn: "https://key@o1.ingest.de.sentry.io/42",
    release: "jollity@test",
    product: "dim2.testnet",
    testTag: "",
    hostname: "dim2-pr126-sandbox00.paseo",
    protocol: "https:",
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv)",
    inContainer: true,
    maxTouchPoints: 5,
    viewport: "390x844",
    language: "en-GB",
    sessionId: "session-1",
    bare: true,
    ...over,
  }
}

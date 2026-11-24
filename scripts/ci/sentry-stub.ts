// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// A stand-in Sentry for the tests of sentry-checkin.mjs and sentry-grants.mjs,
// so no test reaches the real one.
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"

export type SeenRequest = { method?: string; url?: string; auth?: string; type?: string; body: string }

/** A local server that answers every request with `status` and records what it got, and a DSN for it. */
export async function stubSentry(status: number) {
  const seen: SeenRequest[] = []
  const server = createServer((req: IncomingMessage, res) => {
    let body = ""
    req.on("data", (d) => (body += d))
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers["x-sentry-auth"] as string, type: req.headers["content-type"], body })
      res.writeHead(status).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return { dsn: `http://pubkey@127.0.0.1:${port}/42`, seen, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** The lines of an envelope, parsed. */
export const envelopeLines = (body: string) => body.trimEnd().split("\n").map((line) => JSON.parse(line))

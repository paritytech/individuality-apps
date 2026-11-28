// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A `truapi-host` from Node: spawn a headless signing host for a slot and
 * connect `@parity/product-sdk-host` to it over the CLI's frame WebSocket.
 *
 * The SDK expects a browser: it binds to `window.__HOST_API_PORT__` (the
 * MessagePort a webview host injects) at import time. The bridge the CLI
 * serves to browsers (`bootstrap.js`) is a WebSocket↔MessagePort pump, so the
 * same pump here, with `window` pointed at `globalThis`, makes the SDK see a
 * host. Import-time binding also means ONE host per process — a script that
 * needs two people spawns two processes.
 *
 * Ported from dim2-spa-fable's scripts/lib/hostSession.mjs.
 */
import { spawn, type ChildProcess } from "node:child_process"

export type HostSdk = typeof import("@parity/product-sdk-host")

export interface SigningHostOptions {
  network: string
  basePath: string
  session: string
  productId: string
  port: number
  /** where the CLI's own lines go (default: this process's stderr) */
  log?: (line: string) => void
  /** how long to wait for "Signing host ready" */
  readyTimeoutMs?: number
}

export interface SigningHost {
  frameWs: string
  child: ChildProcess
  stop: () => void
}

/**
 * `truapi-host signing-host --serve --auto-accept` for one slot + session,
 * as product `productId`. Resolves once the signer is ready. A session can be
 * served by several hosts at once (measured: the game host and a personhood
 * host on the same session both pair), which is what lets a second PRODUCT act
 * for the same PERSON on the desk.
 */
export function spawnSigningHost(options: SigningHostOptions): Promise<SigningHost> {
  const { network, basePath, session, productId, port, readyTimeoutMs = 120_000 } = options
  const log = options.log ?? ((line: string) => process.stderr.write(`  [truapi-host] ${line}\n`))
  const frameWs = `ws://127.0.0.1:${port}`
  const child = spawn(
    "truapi-host",
    [
      "signing-host",
      "--network", network,
      "--base-path", basePath,
      "--session", session,
      "--product-id", productId,
      "--frame-listen", `127.0.0.1:${port}`,
      "--serve",
      "--auto-accept",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      // The CLI checks for a newer release on every run and re-points
      // `~/.local/share/truapi-host/current` at it (it did so between two
      // test runs on 2026-09-16). The wire codec moves with the version and
      // the app is pinned to one (the lockfile's @parity/truapi; app, desk
      // CLI and phone move together), so a host our scripts start must stay at the
      // version that is installed. The user's own shell should export the
      // same variable.
      env: { ...process.env, TRUAPI_HOST_NO_UPDATE: "1" },
    },
  )
  const stop = () => {
    if (!child.killed) child.kill("SIGTERM")
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop()
      reject(new Error(`truapi-host did not report "Signing host ready" within ${readyTimeoutMs / 1000}s`))
    }, readyTimeoutMs)
    const onLine = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) continue
        log(line)
        if (line.includes("Signing host ready")) {
          clearTimeout(timer)
          resolve({ frameWs, child, stop })
        }
      }
    }
    child.stdout?.on("data", onLine)
    child.stderr?.on("data", onLine)
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error("truapi-host not found on PATH — see ONBOARDING.md §3d to install it")
          : error,
      )
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`truapi-host exited with ${code} before it was ready`))
    })
  })
}

/**
 * Point `@parity/product-sdk-host` at a host's frame WebSocket and return the
 * SDK module. Call ONCE per process, before anything else imports the SDK.
 */
export async function connectProductSdk(frameWs: string): Promise<HostSdk> {
  // the CLI prints "Signing host ready" a moment before its frame server
  // listens, so the first connection attempt can land on a closed port
  const socket = await openSocket(frameWs, 20, 250)
  const { port1, port2 } = new MessageChannel()
  port2.onmessage = (event) => socket.send(event.data as ArrayBuffer)
  port2.start()
  // the SDK's provider only accepts Uint8Array, never a bare ArrayBuffer
  socket.onmessage = (event) => port2.postMessage(new Uint8Array(event.data as ArrayBuffer))
  // a host stopped on purpose closes this socket too; only say so
  socket.onerror = () => console.warn(`[host-session] lost ${frameWs}`)
  const g = globalThis as unknown as Record<string, unknown>
  g.window = globalThis
  g.top = globalThis
  g.__HOST_API_PORT__ = port1
  g.__HOST_WEBVIEW_MARK__ = true
  return import("@parity/product-sdk-host")
}

/** An OPEN WebSocket to `url`, retrying a refused connection `attempts` times. */
function openSocket(url: string, attempts: number, delayMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const attempt = (left: number) => {
      const socket = new WebSocket(url)
      socket.binaryType = "arraybuffer"
      socket.onopen = () => resolve(socket)
      socket.onerror = () => {
        if (left > 0) setTimeout(() => attempt(left - 1), delayMs)
        else reject(new Error(`cannot reach ${url} after ${attempts} attempts — is the host running?`))
      }
    }
    attempt(attempts)
  })
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

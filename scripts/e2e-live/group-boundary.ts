// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

type Env = Record<string, string | undefined>

export interface GroupReadyMessage {
  type: "e2e-group-ready"
  slot: number
  releaseByMs: number | null
}

export interface GroupExpiredMessage {
  type: "e2e-group-expired"
  slot: number
  reason: string
}

export type GroupChildMessage = GroupReadyMessage | GroupExpiredMessage

export type GroupSupervisorMessage =
  | { type: "e2e-group-release"; slot: number }
  | { type: "e2e-group-abort"; slot: number; reason: string }

export interface BoundaryOptions {
  send?: (message: GroupChildMessage) => void
  listen?: (handler: (message: unknown) => void) => () => void
  timeoutMs?: number
  now?: () => number
}

/** A shared child reports readiness over its private parent IPC channel and
 * waits for its own release. No sibling can observe or consume that message. */
export async function awaitSharedNetwork(env: Env, options: BoundaryOptions = {}): Promise<boolean> {
  if (env.E2E_SHARED_NETWORK !== "1") return false
  const slot = Number(env.E2E_SLOT)
  if (!Number.isInteger(slot) || slot < 1) throw new Error("E2E_SHARED_NETWORK needs a positive E2E_SLOT")
  const releaseByMs = Number(env.E2E_GROUP_RELEASE_BY_MS)
  const releaseBy = Number.isFinite(releaseByMs) ? releaseByMs : null
  const send = options.send ?? ((message) => {
    if (!process.send) throw new Error("shared network child has no supervisor IPC channel")
    process.send(message)
  })
  const listen = options.listen ?? ((handler) => {
    process.on("message", handler)
    return () => process.off("message", handler)
  })
  const now = options.now ?? Date.now
  const deadline = Math.min(now() + (options.timeoutMs ?? 600_000), releaseBy ?? Infinity)
  return new Promise<boolean>((resolve, reject) => {
    let settled = false
    let unlisten: () => void = () => undefined
    const deadlineError = () => new Error("shared network supervisor did not release the bot before its registration budget expired")
    const finish = (error?: Error, expired = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unlisten()
      if (expired) {
        try {
          send({ type: "e2e-group-expired", slot, reason: error?.message ?? "registration budget expired" })
        } catch {
          // The original deadline failure remains authoritative when IPC is gone.
        }
      }
      if (error) reject(error)
      else resolve(true)
    }
    const timer = setTimeout(() => finish(deadlineError(), true), Math.max(0, deadline - now()))
    unlisten = listen((raw) => {
      const message = raw as Partial<GroupSupervisorMessage> | null
      if (!message || message.slot !== slot) return
      if (message.type === "e2e-group-release") {
        if (now() >= deadline) finish(deadlineError(), true)
        else finish()
      }
      else if (message.type === "e2e-group-abort") finish(new Error(`shared network supervisor aborted: ${message.reason ?? "unknown reason"}`))
    })
    try {
      send({ type: "e2e-group-ready", slot, releaseByMs: releaseBy })
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

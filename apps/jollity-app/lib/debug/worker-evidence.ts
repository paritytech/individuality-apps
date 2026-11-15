// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The bounded evidence the chat worker leaves in this product's host storage.
 *
 * The app and worker share the product-scoped namespace, but not a runtime or
 * clock. Keep this evidence beside the app entries rather than pretending the
 * worker lines belong to an app session. Notification ids stay on the device:
 * the export needs their count, never the opaque values.
 */
import { tryReadStoredString } from "../host/storage"
import { scrubMnemonic } from "./scrub"

const WORKER_LOG_KEY = "jollity.wg.workerLog"
export const WORKER_NOTIFICATIONS_KEY = "jollity.wg.notifs"

const LOG_KEEP = 100
const TEXT_CHARS = 1_024
const KINDS = new Set(["info", "success", "error"] as const)

export interface WorkerEvidence {
  log: WorkerLogEvidence[]
  notifications: WorkerNotificationEvidence | null
}

interface WorkerLogEvidence {
  time: number
  kind: "info" | "success" | "error"
  text: string
}

interface WorkerNotificationEvidence {
  gamePlayTime: number
  registered: boolean
  idCount: number
  complete: boolean
  retryAt: number | null
}

type StoredRead = Awaited<ReturnType<typeof tryReadStoredString>>

function parsed(read: StoredRead): unknown {
  if (!read.ok || read.value === null) return null
  try {
    return JSON.parse(read.value) as unknown
  } catch {
    return null
  }
}

function logEvidence(raw: unknown): WorkerLogEvidence[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(-LOG_KEEP).flatMap((item) => {
    const value = item as { time?: unknown; kind?: unknown; text?: unknown } | null
    if (!Number.isFinite(value?.time) || typeof value?.kind !== "string" || !KINDS.has(value.kind as WorkerLogEvidence["kind"])) return []
    if (typeof value.text !== "string") return []
    return [
      {
        time: value.time as number,
        kind: value.kind as WorkerLogEvidence["kind"],
        text: scrubMnemonic(value.text).slice(0, TEXT_CHARS),
      },
    ]
  })
}

function notificationEvidence(raw: unknown): WorkerNotificationEvidence | null {
  const value = raw as
    | { gamePlayTime?: unknown; registered?: unknown; ids?: unknown; complete?: unknown; retryAt?: unknown }
    | null
  if (!Number.isFinite(value?.gamePlayTime) || typeof value?.registered !== "boolean" || !Array.isArray(value.ids)) return null
  if (value.complete !== undefined && typeof value.complete !== "boolean") return null
  if (value.retryAt !== undefined && !Number.isFinite(value.retryAt)) return null
  return {
    gamePlayTime: value.gamePlayTime as number,
    registered: value.registered,
    idCount: value.ids.filter((id) => typeof id === "number" && Number.isFinite(id)).length,
    complete: value.complete !== false,
    retryAt: value.retryAt === undefined ? null : (value.retryAt as number),
  }
}

/** Null means neither worker key could be read; absent or old values normalize safely. */
export async function readWorkerEvidence(): Promise<WorkerEvidence | null> {
  const [log, notifications] = await Promise.all([
    tryReadStoredString(WORKER_LOG_KEY),
    tryReadStoredString(WORKER_NOTIFICATIONS_KEY),
  ])
  if (!log.ok && !notifications.ok) return null
  return {
    log: log.ok ? logEvidence(parsed(log)) : [],
    notifications: notifications.ok ? notificationEvidence(parsed(notifications)) : null,
  }
}

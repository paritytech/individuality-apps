// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * One-off rewrites of the state the worker keeps in host storage, each run once per phone at boot.
 *
 * A migration is a file `NNN-<name>.ts`, numbered in order and appended to
 * MIGRATIONS. A shipped one is never renumbered or removed, since the number
 * is all a phone remembers of it. A migration rewrites stored records only and
 * never calls the chain, the chat or the notifications: the poll acts on what
 * it leaves. A change a reader can tolerate, such as an optional field or an
 * older shape, still belongs in the reader.
 *
 * The number is written before the migration runs, so a migration runs at
 * most once even when it fails or the worker stops halfway. One that must not
 * be lost claims its own work inside the record it rewrites.
 */
import { MIGRATIONS_KEY, readJSON, tryWriteJSON, within, workerLog, type StorageHost } from "../state"
import { chatCount, describeError } from "../telemetry"
import openingNoticeAgain from "./001-opening-notice-again"

export type Migration = {
  number: number
  name: string
  run(host: StorageHost): Promise<void>
}

export const MIGRATIONS: Migration[] = [openingNoticeAgain]

/**
 * Runs every migration above the number the phone has stored, in order.
 *
 * A failed read runs none, since the worker cannot tell what already ran and a
 * repeat could send a notice twice. A refused claim stops the run until the
 * next boot. A migration that outlasts the call deadline counts as failed, so
 * it never holds back the poll, and its late write may still land.
 */
export async function runMigrations(host: StorageHost, migrations: Migration[] = MIGRATIONS): Promise<void> {
  const applied = await readJSON<number>(host, MIGRATIONS_KEY)
  if (applied === undefined) return
  for (const migration of migrations) {
    if (migration.number <= (applied ?? 0)) continue
    if (!(await tryWriteJSON(host, MIGRATIONS_KEY, migration.number))) return
    const label = `${migration.number} ${migration.name}`
    try {
      await within(migration.run(host))
      chatCount("chat.migration", { migration: label, outcome: "applied" }, { key: `${label}:applied` })
      void workerLog.append(host, "success", `Migration ${label} applied.`)
    } catch (error) {
      chatCount("chat.migration", { migration: label, outcome: "failed" }, { key: `${label}:failed`, detail: { error: describeError(error) } })
      void workerLog.append(host, "error", `Migration ${label} failed: ${describeError(error)}`)
    }
  }
}

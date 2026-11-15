// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE PENDING REPORT FAILURE, kept past the page (#600).
 *
 * A terminal submit failure ("Couldn't send") is not yet a miss: only the
 * chain says so, once it has left Reporting with no report from this player
 * (lib/report-missed.ts). The game page sends `report-failed` when its
 * handover poll sees that. A page that is gone before then (the app closed,
 * Android back) would lose the event, so the failure is parked here at the
 * moment it happens, and the next open settles it against the chain:
 *
 * - the chain shows the miss: send `report-failed` once;
 * - the report landed after all, or the chain keeps nothing that says: drop it
 *   and claim nothing;
 * - the chain may still take it, or a read failed: keep it for the next open.
 *
 * At most once: the record is cleared BEFORE the event goes out, by the page's
 * own send and by this settle alike, so a crash in between loses the event
 * rather than doubling it. One record at a time (the last failure wins); the
 * chain holds one game at a time.
 */
import { devLog } from "./debug/log-store"
import { readStoredJSON, writeStoredJSON } from "./host/storage"
import { reportMissed, type ReportStatus } from "./report-missed"

const KEY = "jollity.report-failure-pending"

type ReportFailureReason = "refused" | "timeout"

export interface PendingReportFailure {
  gameIndex: number
  /** the player's account: a record is settled only against its own player */
  account: string
  reason: ReportFailureReason
  detail: string
}

export interface ReportFailureSource {
  player?: string
  reportStatus: (gameIndex: number) => Promise<Pick<ReportStatus, "closed" | "report">>
}

function parse(raw: unknown): PendingReportFailure | null {
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.gameIndex !== "number" || typeof r.account !== "string" || typeof r.detail !== "string") return null
  if (r.reason !== "refused" && r.reason !== "timeout") return null
  return { gameIndex: r.gameIndex, account: r.account, reason: r.reason, detail: r.detail }
}

/** the parking write in flight: a clear or a settle waits for it, so a record
 *  cannot land after the clear that was meant to remove it */
let parking: Promise<void> = Promise.resolve()

/** Park a terminal submit failure. Never throws. */
export function recordPendingReportFailure(failure: PendingReportFailure): Promise<void> {
  const write = parking.then(() => writeStoredJSON(KEY, failure)).catch(() => undefined)
  parking = write
  return write
}

/** Remove the record and CONFIRM it is gone by reading it back (a host write
 *  that fails is swallowed and falls back to localStorage, while a container
 *  reads host storage, so the record could stay readable). True only when the
 *  record is absent afterwards. A caller sends only on true: a possible miss
 *  is accepted, a double send is not. */
async function removeRecord(): Promise<boolean> {
  try {
    await writeStoredJSON(KEY, null)
    return parse(await readStoredJSON(KEY)) === null
  } catch {
    return false
  }
}

/** Drop the record of game `gameIndex` (and `account`, when given) before the
 *  page sends it itself. True when the page may send: the record is not there
 *  or is confirmed gone. Another game's or account's record stays. Never throws. */
export async function clearPendingReportFailure(gameIndex: number, account?: string): Promise<boolean> {
  try {
    await parking
    const held = parse(await readStoredJSON(KEY))
    if (!held || held.gameIndex !== gameIndex || (account !== undefined && held.account !== account)) return true
    return await removeRecord()
  } catch {
    return false
  }
}

let settling: Promise<void> = Promise.resolve()

/** On open: send the parked failure if the chain now confirms the miss. Calls
 *  run one after the other, so two opens cannot both send it. Never throws. */
export function settlePendingReportFailure(
  source: ReportFailureSource,
  send: (failure: Pick<PendingReportFailure, "gameIndex" | "reason" | "detail">) => void,
): Promise<void> {
  const run = settling.then(() => settleOnce(source, send))
  settling = run.catch(() => undefined)
  return run.catch(() => undefined)
}

async function settleOnce(source: ReportFailureSource, send: Parameters<typeof settlePendingReportFailure>[1]): Promise<void> {
  await parking
  const held = parse(await readStoredJSON(KEY))
  if (!held || !source.player || held.account !== source.player) return
  const status = await source.reportStatus(held.gameIndex).catch(() => null)
  if (!status) return
  if (reportMissed(status)) {
    if (!(await removeRecord())) return // not confirmed gone: keep it, never double-send
    devLog("report", "sending the report failure the last page could not", { gameIndex: held.gameIndex })
    send({ gameIndex: held.gameIndex, reason: held.reason, detail: held.detail })
  } else if (status.report === "sent" || (status.closed && status.report === "gone")) {
    if (await removeRecord()) devLog("report", "dropped a parked report failure, the chain says otherwise", { gameIndex: held.gameIndex, report: status.report })
  }
}

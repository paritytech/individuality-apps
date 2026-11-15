// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The airdrops section of the debug panel.
 *
 * The whole point of this section is the row the panel would otherwise skip:
 * when `AirdropStanding.contextMatches` is `false`, every slot the SPA derived
 * is for the wrong context and the runtime rejects `register`/`claim` with
 * `BadOrigin`. Without this row that condition looks identical to "no draws
 * scheduled" — the exact confusion this panel exists to prevent. The section
 * therefore always renders, even with no standing, even while pending or
 * errored. Per-draw standing is a table, newest-first and capped so an
 * unbounded pallet store cannot blow the panel into scrolling.
 */
import type {
  AirdropDraw,
  AirdropParticipation,
  AirdropStanding,
} from "@individuality/daily-dollar";

import {
  duration,
  hex32Short,
  MISSING,
  queryStatus,
  utcShort,
  type DebugRow,
  type DebugTable,
} from "./debug-format.ts";

/** Enough draws to make a busy schedule legible without scrolling the panel. */
const MAX_DRAW_ROWS = 20;

/**
 * The contextual-alias row. A product account holds exactly one contextual
 * alias, and `register`/`claim` dispatch through `AsPersonalAliasWithAccount`.
 * When that alias carries a context other than the airdrops context, the
 * runtime answers `BadOrigin` for every transaction the SPA builds. Naming
 * both contexts keeps "no draws open" and "this account can never
 * participate" distinguishable on the panel.
 */
function contextRow(standing: AirdropStanding | undefined): DebugRow {
  if (standing == null) {
    return { label: "context", value: "no standing" };
  }
  if (standing.contextMatches) return { label: "context", value: "ok" };
  if (standing.alias == null) {
    return {
      label: "context",
      value: `unbound: registration will bind ${hex32Short(standing.airdropsContext)}`,
    };
  }
  const heldContext = standing.aliasContext;
  if (heldContext == null) {
    return {
      label: "context",
      value: `mismatch: alias ${hex32Short(standing.alias)} has no context, airdrops need ${hex32Short(standing.airdropsContext)}`,
    };
  }
  return {
    label: "context",
    value: `mismatch: alias holds ${hex32Short(heldContext)}, airdrops need ${hex32Short(standing.airdropsContext)}`,
  };
}

/** `draws` row: total, plus the standing counts that drive the panel's meaning. */
function drawsRow(
  standing: AirdropStanding | undefined,
  nowSeconds: number,
): DebugRow {
  if (standing == null) return { label: "draws", value: MISSING };
  const participations = standing.participations;
  let registered = 0;
  let won = 0;
  let claimable = 0;
  for (const entry of participations) {
    if (entry.registered === true) registered += 1;
    if (entry.winner === true || entry.claimed === true) won += 1;
    if (
      entry.winner === true &&
      entry.draw.status === "Claiming" &&
      nowSeconds < entry.draw.endTimeSeconds
    ) {
      claimable += 1;
    }
  }
  return {
    label: "draws",
    value: `${participations.length} · registered ${registered} · won ${won} · claimable ${claimable}`,
  };
}

/** Deadline the row should anchor on: `drawTime` while the draw is open, `endTime`
 *  once it is drawing or claiming. `null` for phases without an actionable clock. */
function deadlineSeconds(draw: AirdropDraw): number | null {
  switch (draw.status) {
    case "Scheduled":
    case "Registering":
      return draw.drawTimeSeconds;
    case "AwaitingEntropy":
    case "DrawWinners":
    case "Claiming":
    case "ClearingRegistrations":
    case "ClearingWinners":
    case "Finalizing":
      return draw.endTimeSeconds;
  }
}

/** Pallet status refined by the clock: `register_slot` rejects past
 *  `drawTime` and `do_claim` past `endTime` regardless of the stored status,
 *  which only advances when the offchain worker runs. */
function statusCell(draw: AirdropDraw, nowSeconds: number): string {
  switch (draw.status) {
    case "Scheduled":
      return "scheduled";
    case "Registering":
      return nowSeconds < draw.drawTimeSeconds ? "open" : "registration closed";
    case "Claiming":
      return nowSeconds < draw.endTimeSeconds ? "claiming" : "claim window closed";
    default:
      return draw.status;
  }
}

/** The person's own standing. `claimed` is checked before `winner`: a
 *  successful claim removes the runtime winner entry, so `winner: false`
 *  after a session-observed claim is not a loss. */
function standingCell(entry: AirdropParticipation, nowSeconds: number): string {
  const draw = entry.draw;
  switch (draw.status) {
    case "Scheduled":
      return MISSING;
    case "Registering":
      if (entry.registered === null) return "registration unknown";
      return entry.registered ? "registered" : "not registered";
    case "Claiming":
      if (entry.claimed === true) return "won · claimed";
      if (entry.winner === true) {
        return nowSeconds < draw.endTimeSeconds ? "won · claimable" : "won · window closed";
      }
      return entry.winner === null ? "winner unknown" : "did not win";
    default:
      if (entry.registered === null) return MISSING;
      return entry.registered ? "registered" : "not registered";
  }
}

function countsCell(draw: AirdropDraw): string {
  const counts = [draw.totalParticipants, draw.effectiveWinners, draw.claimed];
  if (counts.every((count) => count == null)) return MISSING;
  return counts.map((count) => (count == null ? MISSING : String(count))).join(" / ");
}

/** The claim window relative to now: it opens at `drawTime` and closes at
 *  `endTime` by the clock, whatever the stored status says. */
function claimWindowCell(draw: AirdropDraw, nowSeconds: number): string {
  if (nowSeconds < draw.drawTimeSeconds) {
    return `opens in ${duration(draw.drawTimeSeconds - nowSeconds)}`;
  }
  if (nowSeconds < draw.endTimeSeconds) {
    return `open · closes in ${duration(draw.endTimeSeconds - nowSeconds)}`;
  }
  return `closed ${duration(nowSeconds - draw.endTimeSeconds)} ago`;
}

/** One row per people-airdrops draw, newest-first and capped, or `undefined`
 *  when there is nothing to tabulate. */
export function airdropDrawsTable(
  standing: AirdropStanding | undefined,
  nowSeconds: number,
): DebugTable | undefined {
  const participations = standing?.participations ?? [];
  if (participations.length === 0) return undefined;
  const sorted = [...participations].sort((a, b) =>
    a.draw.drawIndex < b.draw.drawIndex ? 1 : a.draw.drawIndex > b.draw.drawIndex ? -1 : 0,
  );
  const rows = sorted.slice(0, MAX_DRAW_ROWS).map((entry) => [
    `#${entry.draw.drawIndex.toString()}`,
    statusCell(entry.draw, nowSeconds),
    standingCell(entry, nowSeconds),
    countsCell(entry.draw),
    utcShort(deadlineSeconds(entry.draw)),
    claimWindowCell(entry.draw, nowSeconds),
  ]);
  if (sorted.length > MAX_DRAW_ROWS) {
    rows.push([`… ${sorted.length - MAX_DRAW_ROWS} more`, `capped at ${MAX_DRAW_ROWS}`, "", "", "", ""]);
  }
  return { columns: ["#", "status", "you", "in / won / claimed", "deadline", "claim window"], rows };
}

/**
 * The airdrops section header rows.
 *
 * They always render — even on a pending, errored, or empty query — so a
 * missing-context failure shows up as itself rather than as a missing
 * section. Per-draw standing lives in {@link airdropDrawsTable}.
 */
export function airdropRows(
  standing: AirdropStanding | undefined,
  pending: boolean,
  error: unknown,
  nowSeconds: number,
): DebugRow[] {
  return [
    { label: "query", value: queryStatus(pending, error, standing) },
    {
      label: "airdrop account",
      value: standing?.accountAddress ?? MISSING,
    },
    {
      label: "alias",
      value: standing?.alias == null ? MISSING : hex32Short(standing.alias),
    },
    contextRow(standing),
    drawsRow(standing, nowSeconds),
  ];
}

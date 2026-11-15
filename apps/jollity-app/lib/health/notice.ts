// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { LadderVerdict } from "@jollity/statement-core"

export type HealthNoticeVariant = "connection" | "host-reconnecting" | "host-stuck"

/** A whole-player network loss can make the chain probe fail too. In that
 * overlap, the all-peers verdict is the more specific diagnosis: restarting
 * the host app cannot restore this player's cut network. A stuck host reads
 * "Reconnecting…" for its first minute (#1107), then the restart advice. */
export function healthNoticeVariant(
  hostStuck: boolean,
  playerNetworkIsolated: boolean,
  reconnecting = false,
): HealthNoticeVariant {
  if (!hostStuck || playerNetworkIsolated) return "connection"
  return reconnecting ? "host-reconnecting" : "host-stuck"
}

/** TURN absence is actionable network blame only after the signer answers and
 * ICE itself proves that no public or relay path exists. */
export function noticeBlame(
  verdict: LadderVerdict | null,
  hostAnswering: boolean,
  noUsablePath: boolean,
) {
  const blame = verdict?.blame ?? null
  return blame?.layer === "turn-credentials" && (!hostAnswering || !noUsablePath) ? null : blame
}

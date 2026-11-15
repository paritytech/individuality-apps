// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { HumanityUserId } from "@humanity/shared/identity/humanity-user-id.ts";

/** The host may cache the lite name for an entire session. A finalized
 * Consumers record for that name's owner is authoritative about its upgrade.
 * This changes card display/claim eligibility, never the host session. */
export function linkedCardIdentity(
  hostIdentity: HumanityUserId,
  fullUsername: Uint8Array | undefined,
): HumanityUserId {
  if (fullUsername == null) return hostIdentity;
  const name = new TextDecoder().decode(fullUsername);
  if (!/^[a-z]{6,32}$/.test(name)) return hostIdentity;
  const suffix =
    /\.(?:dot|paseo|test|testnet)$/i.exec(hostIdentity.primaryUsername)?.[0] ??
    "";
  return { primaryUsername: name + suffix, username: name, isUpgraded: true };
}

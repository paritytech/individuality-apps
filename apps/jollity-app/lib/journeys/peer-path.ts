// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The path a peer connected over, from the selected candidate pair the mesh
 * reports (`PeerReport.pair` is `<local type>/<remote type>`, lib/webrtc/mesh.ts).
 * A relay on either side is TURN; a server-reflexive or peer-reflexive one
 * is STUN; two host candidates are a direct LAN link. Pure.
 */
export type RtcPath = "direct" | "stun" | "relay" | "unknown"

export function rtcPath(pair: string | undefined): RtcPath {
  if (!pair) return "unknown"
  const types = pair.split("/")
  if (types.includes("relay")) return "relay"
  if (types.includes("srflx") || types.includes("prflx")) return "stun"
  if (types.length === 2 && types.every((type) => type === "host")) return "direct"
  return "unknown"
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Privacy-safe TURN evidence at the browser boundary.
 *
 * Backend issuance is intentionally not an input: it is server-side evidence
 * and must never be promoted into any of these client observations. Each
 * client stage is derived only from evidence at that stage.
 */

export function iceServerCounts(configuration: RTCConfiguration): {
  total: number
  turn: number
} {
  const servers = configuration.iceServers ?? []
  const isTurn = (server: RTCIceServer) => {
    const urls = typeof server.urls === "string" ? [server.urls] : server.urls
    return urls.some((url) => /^turns?:/i.test(url))
  }
  return { total: servers.length, turn: servers.filter(isTurn).length }
}

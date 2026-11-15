// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The ONE place a player-facing sentence about connection health is written.
 *
 * The in-game notice and /connection-help render the same component off this
 * map, so the two surfaces can never disagree; the map still has to exist
 * because they show different amounts of it.
 *
 * Two rules:
 *
 *  1. NEVER blame the internet for a publish failure. "Move closer to your
 *     router" is the right advice for `ice`, and actively misleading for
 *     `store-write`, whatever had actually broken.
 *  2. SAY ONLY WHAT WE CAN DO. A fix list that promises an action the app
 *     cannot perform is worse than no list: it sends the player to look for a
 *     button that isn't there. Where nothing helps, `fixes` is empty and the
 *     headline says so plainly.
 */
import type { Layer, LayerStatus } from "@jollity/statement-core"
import { connectionSnapshot } from "../telemetry/device"

function turnCredentialsCopy(connectionType = connectionSnapshot()?.type): LayerCopy {
  const androidWifi = connectionType === "wifi"
  return {
    name: "Video relay",
    headline: androidWifi
      ? "Your Wi-Fi is blocking the game. Switch to mobile data."
      : "Your network is blocking the game. If you're on Wi-Fi, switch to mobile data.",
    fixes: androidWifi
      ? ["Switch to mobile data.", "Keep the game open after switching — it will reconnect automatically."]
      : ["If you're on Wi-Fi, switch to mobile data.", "Keep the game open after switching — it will reconnect automatically."],
  }
}

export interface LayerCopy {
  /** what a player calls this layer — never the internal rung name */
  name: string
  /** one sentence: what is wrong, from their side, when this rung is to blame */
  headline: string
  /** what they can actually do. Empty means nothing they do will help. */
  fixes: string[]
}

export const LAYER_COPY: Record<Layer, LayerCopy> = {
  internet: {
    name: "Your internet",
    headline: "You're not online.",
    fixes: [
      "Open any website — if it won't load, the game can't either.",
      "Toggle Wi-Fi or mobile data off and on.",
    ],
  },
  "turn-credentials": turnCredentialsCopy(),
  "store-write": {
    name: "Sending your moves",
    // NOT "check your connection": the store refusing our writes says nothing
    // about this player's internet, and blaming it sends them to fix the one
    // thing that isn't broken.
    headline: "The other players can't see you — your moves aren't being published.",
    fixes: ["Leave and rejoin the game."],
  },
  "store-read": {
    name: "Receiving moves",
    headline: "Can't hear the other players.",
    fixes: ["Leave and rejoin the game."],
  },
  signalling: {
    name: "Finding the others",
    headline: "Nobody else has turned up yet.",
    fixes: ["Give it a few more seconds.", "If the game has already started, leave and rejoin."],
  },
  ice: {
    name: "Connecting to players",
    headline: "We couldn't connect you to anyone.",
    // network advice, shown only to the players it actually applies to
    fixes: [
      "Check your internet — open any website to be sure.",
      "Try a different network. Office, hotel and public Wi-Fi often block game connections; a phone hotspot almost always works.",
      "Move closer to your router — one bar usually isn't enough for live video.",
      "Then come back. Rejoining puts you straight back in if the game is still running.",
    ],
  },
  media: {
    name: "Video",
    headline: "You're connected, but no video is coming through.",
    fixes: ["Leave and rejoin the game."],
  },
  camera: {
    name: "Your camera",
    headline: "Your camera has stopped sending.",
    fixes: [
      "Close any other app using the camera.",
      "Leave and rejoin the game.",
    ],
  },
  device: {
    name: "Your phone",
    // every face is there, and every one is choppy: the common factor is this
    // phone, so it is said once here instead of on each tile
    headline: "Your phone is struggling with video.",
    fixes: [
      "Close other apps running in the background.",
      "Turn off low-power mode if it is on.",
      "If your phone is hot, give it a moment to cool down.",
    ],
  },
}

/** Player copy for a rung. Chromium exposes Wi-Fi vs cellular; iOS does not,
 * so the unknown form stays conditional rather than claiming the player is
 * on Wi-Fi. */
export function layerCopy(
  layer: Layer,
  connectionType = connectionSnapshot()?.type,
): LayerCopy {
  return layer === "turn-credentials" ? turnCredentialsCopy(connectionType) : LAYER_COPY[layer]
}

/** What the notice says when a rung is to blame. */
export function noticeHeadline(layer: Layer, connectionType?: string): string {
  return layerCopy(layer, connectionType).headline
}

/** Glyph for a rung's own status in the details list. `unknown` is a dash on
 *  purpose — it is "we couldn't tell", which is not a pass and not a failure,
 *  and drawing it as either would be a claim we cannot make. */
export const STATUS_GLYPH: Record<LayerStatus, string> = {
  ok: "✓",
  warn: "!",
  fail: "✕",
  unknown: "–",
}

export const STATUS_LABEL: Record<LayerStatus, string> = {
  ok: "Working",
  warn: "Partly working",
  fail: "Not working",
  unknown: "Not checked",
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * URL parameters for developers, read only in a development build.
 *
 * `process.env.NODE_ENV` is inlined at build time, so a production build
 * reads none of these and the branch folds away. They are:
 *  - `?player=<ss58>` on /prize-draw and /collectables: show that account's draw or
 *    collectables screen instead of the player's (never claims; lib/draw/draw-screen.ts D15);
 *  - `?sendRung=<full|lean|low|minimum|survival>`: cap outgoing video at one
 *    rung of the upload ladder (lib/webrtc/send-rung-override.ts);
 *  - `?tutorial=1`: open the how-to-play carousel in a plain browser, which has
 *    no host storage for the chat card's request (lib/worker-bridge.ts).
 *
 * The parameters real navigation uses stay live in every build and are read
 * where they are used: `?game=<index>` on the post-game screens, which the app
 * itself puts on the links it builds (lib/post-game.ts), and `?lowpower=1`, a
 * player-facing way to start in low power mode (lib/low-power.ts).
 */
const DEV_URL_OVERRIDES = process.env.NODE_ENV !== "production"

/** `name`'s value in this page's URL, in a development build only; undefined
 *  in production, without a window, or when the URL has none. */
export function devUrlParam(name: string, search?: string): string | undefined {
  if (!DEV_URL_OVERRIDES) return undefined
  const query = search ?? (typeof window === "undefined" ? "" : window.location.search)
  return new URLSearchParams(query).get(name) ?? undefined
}

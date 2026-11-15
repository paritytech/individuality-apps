// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Where the game hands the player over — their Humanity card in Pocket, or
 * the Humanity product itself — on whatever network this build is on. The
 * target is `peopl.<tld>` for the TLD this page is served under:
 *
 *   <name>.paseo → peopl.paseo
 *   <name>.test  → peopl.test
 *   <name>.dot   → peopl.dot
 *
 * The TLD is derived from the hostname we are SERVED from, so a build cannot
 * hand off to the wrong network: a DotNS deploy answers on `<name>.<tld>`,
 * and the gateways map to a known tld each.
 */
import { openLink } from "../host/navigate"
import { humanityRequested } from "../journeys/game-trace"
import { leavingForProduct, stayedInProduct } from "../start-over"
import { parseUserAgent } from "../telemetry/device"

const LABEL = "peopl"
/** the card the Polkadot app (Android and iOS) pins to every Pocket: card
 *  `humanity` of the personhood product */
const HUMANITY_CARD = "humanity"
const FALLBACK_TLD = "paseo"

/** gateway host → the tld its apps live under */
const GATEWAY_TLD: Record<string, string> = {
  "dotapps.io": "dot",
  "paseo.dotapps.io": "paseo",
}

function currentTld(host: string = typeof location === "undefined" ? "" : location.hostname): string {
  const bare = host.replace(/:\d+$/, "")
  for (const [gateway, tld] of Object.entries(GATEWAY_TLD)) {
    if (bare === gateway || bare.endsWith(`.${gateway}`)) return tld
  }
  const parts = bare.split(".")
  const last = parts[parts.length - 1]
  // localhost and bare IPs have no meaningful tld — fall back
  return last && parts.length > 1 && !/^\d+$/.test(last) ? last : FALLBACK_TLD
}

function humanityTarget(host?: string): string {
  return `${LABEL}.${currentTld(host)}`
}

/** The Humanity card, opened in Pocket: the app's own Pocket route, which a
 *  product may hand to `navigateTo` with no grant. The host takes it to the
 *  Pocket with that card open, the game left behind it, on Android and iOS
 *  alike. A `/-/pocket` path under a product's name is not this route: it
 *  opens the product's page. */
export function humanityCardLink(host?: string): string {
  return `polkadotapp://pocket/open?product=${humanityTarget(host)}&card=${HUMANITY_CARD}`
}

/** WHERE this device's hand-off goes. A phone goes to the card; a host with
 *  no Pocket (a desktop, a plain browser) to the Humanity product itself. */
export function humanityHandOff(userAgent: string, maxTouchPoints = 0, host?: string): string {
  const os = parseUserAgent(userAgent, maxTouchPoints).os
  return os === "android" || os === "ios" ? humanityCardLink(host) : `https://${humanityTarget(host)}`
}

/** Leave the game for the player's Humanity card. WHERE is computed here; HOW
 *  to get there belongs to the host (lib/host/navigate). */
export async function openHumanity(): Promise<void> {
  const device = typeof navigator === "undefined" ? undefined : navigator
  const link = humanityHandOff(device?.userAgent ?? "", device?.maxTouchPoints ?? 0)
  const target = link.startsWith("https://") ? "product" : "card"
  // A successful host hand-off can tear down this page before openLink settles,
  // and its browser fallback cannot report whether the destination loaded. The
  // tap is the last reliable fact, so record it before starting navigation.
  humanityRequested({ target })
  // the game is over for this tab: coming back starts over at the home (#465)
  leavingForProduct()
  try {
    await openLink(link)
  } catch (error) {
    stayedInProduct()
    throw error
  }
}

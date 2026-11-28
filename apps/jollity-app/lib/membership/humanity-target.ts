// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Where the game hands the player over — their Humanity card in Pocket, or
 * the Humanity product itself — on the network this BUILD targets:
 * `personhoodProduct()` of @jollity/protocol, `peopl.<tld>` for the build's
 * `NEXT_PUBLIC_NETWORK_NAME` (`peopl.paseo` on paseo, `peopl.testnet` on
 * previewnet). The same source the storage read of Humanity's sign-ups uses
 * (lib/host/game-registration.ts), so every `peopl.<tld>` the app names is
 * one name.
 *
 * NOT the hostname the page is served from: the dot.li web gateway serves a
 * build as `<name>.app.<tld>.li` (issue #56), and its last label is `li`,
 * which would hand off to `peopl.li` — a name that does not exist.
 */
import { personhoodProduct } from "@jollity/protocol"
import { openLink } from "../host/navigate"
import { humanityRequested } from "../journeys/game-trace"
import { leavingForProduct, stayedInProduct } from "../start-over"
import { parseUserAgent } from "../telemetry/device"

/** the card the Polkadot app (Android and iOS) pins to every Pocket: card
 *  `humanity` of the personhood product */
const HUMANITY_CARD = "humanity"

/** The Humanity card, opened in Pocket: the app's own Pocket route, which a
 *  product may hand to `navigateTo` with no grant. The host takes it to the
 *  Pocket with that card open, the game left behind it, on Android and iOS
 *  alike. A `/-/pocket` path under a product's name is not this route: it
 *  opens the product's page. */
export function humanityCardLink(): string {
  return `polkadotapp://pocket/open?product=${personhoodProduct()}&card=${HUMANITY_CARD}`
}

/** WHERE this device's hand-off goes. A phone goes to the card; a host with
 *  no Pocket (a desktop, a plain browser) to the Humanity product itself. */
export function humanityHandOff(userAgent: string, maxTouchPoints = 0): string {
  const os = parseUserAgent(userAgent, maxTouchPoints).os
  return os === "android" || os === "ios" ? humanityCardLink() : `https://${personhoodProduct()}`
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

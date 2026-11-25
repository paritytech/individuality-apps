// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Where the game hands the player over — their Humanity card in Pocket, or
 * the Humanity product itself — on the network this build is for: the
 * personhood product `peopl.<tld>` of @jollity/protocol, as every other read
 * of Humanity's name does. The page's hostname says nothing reliable about
 * the network: a web host serves the game under a domain of its own
 * (`dim2.app.paseo.li`), whose last label is not a DotNS TLD.
 */
import { personhoodProduct } from "@jollity/protocol"
import { readHostInfo } from "../host/host-info"
import { openLink } from "../host/navigate"
import { humanityRequested } from "../journeys/game-trace"
import { leavingForProduct, stayedInProduct } from "../start-over"
import { parseUserAgent } from "../telemetry/device"

/** the card the Polkadot app (Android and iOS) pins to every Pocket: card
 *  `humanity` of the personhood product */
const HUMANITY_CARD = "humanity"
/** what the web host (dot.li) names itself in `system.info()`, on a phone
 *  too: it opens products by their link, and has no Pocket to open a card in */
const WEB_HOST = "Polkadot Web"

/** The Humanity card, opened in Pocket: the app's own Pocket route, which a
 *  product may hand to `navigateTo` with no grant. The host takes it to the
 *  Pocket with that card open, the game left behind it, on Android and iOS
 *  alike. A `/-/pocket` path under a product's name is not this route: it
 *  opens the product's page. */
export function humanityCardLink(): string {
  return `polkadotapp://pocket/open?product=${personhoodProduct()}&card=${HUMANITY_CARD}`
}

/** WHERE this device's hand-off goes. A phone goes to the card; the web host,
 *  and a host with no Pocket (a desktop, a plain browser), to the Humanity
 *  product itself. `hostName` is the host's own name, when it gave one. */
export function humanityHandOff(userAgent: string, maxTouchPoints = 0, hostName?: string): string {
  const product = `https://${personhoodProduct()}`
  if (hostName === WEB_HOST) return product
  const os = parseUserAgent(userAgent, maxTouchPoints).os
  return os === "android" || os === "ios" ? humanityCardLink() : product
}

/** Leave the game for the player's Humanity card. WHERE is computed here; HOW
 *  to get there belongs to the host (lib/host/navigate). */
export async function openHumanity(): Promise<void> {
  const device = typeof navigator === "undefined" ? undefined : navigator
  const host = await readHostInfo()
  const link = humanityHandOff(device?.userAgent ?? "", device?.maxTouchPoints ?? 0, host?.name)
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

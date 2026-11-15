// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The product's Pocket card, by name and by link.
 *
 * Shared because more than the worker that draws the card sends people to it:
 * the chat's Scratch button opens it, and so does every daily-dollar push,
 * which the app schedules on its own as well as the worker.
 */
import { productDomain } from "@humanity/shared/identity/product-domain.ts";

/** The card this product publishes, as named in the worker manifest. */
export const POCKET_CARD_ID = "humanity";

/**
 * The host deeplink that expands this card into its extended view: the app's
 * own `polkadotapp://pocket` route. The older
 * `https://<product>/-/pocket/open` form is now read as a route inside the
 * SPA, which has none there and draws a blank page. Throws when the product
 * domain is unknown, as {@link productDomain} does.
 */
export function pocketCardDeeplink(): string {
  const query = new URLSearchParams({ product: productDomain(), card: POCKET_CARD_ID });
  return `polkadotapp://pocket/open?${query.toString()}`;
}

/** The parameter, and its value, that asks the app to open the scratch card on load. */
export const OPEN_PARAM = "open";
export const OPEN_SCRATCH = "scratch";

/**
 * The card's link with the scratch opened: {@link pocketCardDeeplink} plus
 * `open=scratch`, which the app reads on load. A host that does not pass the
 * extra parameter on to the card's page (trinity-user-agents#1670) opens the
 * card at its root instead.
 */
export function pocketScratchDeeplink(): string {
  return `${pocketCardDeeplink()}&${new URLSearchParams({ [OPEN_PARAM]: OPEN_SCRATCH }).toString()}`;
}

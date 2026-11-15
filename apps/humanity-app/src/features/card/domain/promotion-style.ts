// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The ways the promotion can be staged, for comparing them on a device.
 *  A host with a Pocket opens the app in a sheet under its own card, a much
 *  shorter viewport than the full phone screen the first one was drawn for:
 *  - `current`: the first design, the card flipping in a full-screen column.
 *  - `fit`: the same flip, sized from the viewport so nothing is clipped.
 *  - `sweep`: a compact card that rises, flips and catches a silver sweep.
 *  - `card-less`: no card of its own, since the host's sits above the sheet;
 *    a silver medallion carries the moment instead.
 *  The debug panel picks one; every other build stages the default. */
export const PROMOTION_STYLES = [
  { id: "current", label: "Current" },
  { id: "fit", label: "Fit" },
  { id: "sweep", label: "Sweep" },
  { id: "card-less", label: "Card-less" },
] as const;

export type PromotionStyle = (typeof PROMOTION_STYLES)[number]["id"];

export const DEFAULT_PROMOTION_STYLE: PromotionStyle = "card-less";

export function isPromotionStyle(value: unknown): value is PromotionStyle {
  return PROMOTION_STYLES.some(({ id }) => id === value);
}

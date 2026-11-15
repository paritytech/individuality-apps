// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The fair scheduler: of the enabled labels, take the one
 * enabled longest that is not a fault, and `clock:next` only when nothing else
 * is enabled, so every owned wait settles before time moves. The unowned-wait
 * check, the L1 liveness drain and the confirm pipeline's drive all use it.
 *
 * `enabledSince` maps a label to the step since which it has been enabled
 * without a break (the caller drops a label that left the enabled set, so a
 * recurring label such as `pc:a/1:sld:resolve` is new again). A label missing
 * from the map counts as the newest. Ties go to the earlier label in
 * `enabled`'s own fixed order.
 */
import { isFault, type Label } from "../core/labels"

export function fairPick(enabled: readonly Label[], enabledSince: ReadonlyMap<Label, number>): Label {
  const fair = enabled.filter((label) => label !== "clock:next" && !isFault(label))
  if (fair.length === 0) {
    if (enabled.includes("clock:next")) return "clock:next"
    throw new Error(`fairPick: no fair label is enabled (${enabled.join(" ") || "nothing"})`)
  }
  const since = (label: Label) => enabledSince.get(label) ?? Number.POSITIVE_INFINITY
  let oldest = fair[0]!
  for (const label of fair) if (since(label) < since(oldest)) oldest = label
  return oldest
}

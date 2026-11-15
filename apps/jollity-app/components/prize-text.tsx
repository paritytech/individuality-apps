// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { PRIZE_UNIT, splitPrizeUnit } from "@/lib/draw/prize-unit"

/**
 * The design system's CASH wordmark (app/fonts/cash-logo-regular.otf): one
 * character draws the whole word. A lower-case letter draws it in small caps
 * at x-height, for a lockup or a title ("$30 ᴄᴀꜱʜ"); a capital draws it with
 * a capital C at the figures' height, for body copy ("$30 Cᴀꜱʜ").
 */
const WORDMARK = { title: "c", body: "C" } as const

/**
 * A line of copy with the prize in it ("Claim $10 CASH"): the unit is drawn
 * as the CASH wordmark (`.prize-unit`), the rest as the text around it, and
 * a screen reader still hears the word. A build that names the prize anything
 * else shows its word as plain text, since the wordmark only spells CASH.
 * One span around it all, so a flex parent (a button's gap) lays the line out
 * as one run of text rather than spacing the unit off as an item of its own.
 */
export function PrizeText({ text, as = "body" }: { text: string; as?: keyof typeof WORDMARK }) {
  return (
    <span>
      {splitPrizeUnit(text).map((part, i) =>
        !part.unit || PRIZE_UNIT !== "CASH" ? (
          part.text
        ) : (
          <span key={i}>
            <span aria-hidden className="prize-unit">
              {WORDMARK[as]}
            </span>
            <span className="sr-only">{part.text}</span>
          </span>
        ),
      )}
    </span>
  )
}

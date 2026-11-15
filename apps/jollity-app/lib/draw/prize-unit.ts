// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE PRIZE'S UNIT, AS THE PLAYER READS IT — "$10 CASH" on the draw's chip,
 * in its result line, and on the recap's claim; "CASH" alone under the amount
 * on the draw's coin.
 *
 * A deployer's word, not the chain's: the prize asset's own symbol (`pUSD` on
 * paseo) is a ledger name, and a product may want to call the prize anything.
 * `NEXT_PUBLIC_PRIZE_UNIT` sets it; unset, it is `CASH`. NEXT_PUBLIC_ vars are
 * inlined at build time, so this is per build. The asset's symbol stays on the
 * draw (`PrizeDrawView.prizeSymbol`) for anything that needs the real one.
 *
 * On screen a CASH unit is drawn as the design system's CASH wordmark
 * (components/prize-text.tsx, `.prize-unit` in globals.css).
 */
export const PRIZE_UNIT = process.env.NEXT_PUBLIC_PRIZE_UNIT?.trim() || "CASH"

/** the prize's figure: dollars, whole when whole and to the cent when not */
export function prizeAmount(usd: number): string {
  return `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`
}

/** the figure as the prize's coin is engraved with it: no "$", whole when
 *  whole, else to the cent without trailing zeros ("10", "1.5"). The stage,
 *  its preload and the coin's bake (scripts/bake-draw-coin.mjs) all use it,
 *  so a baked coin's key matches the one the stage builds */
export function coinAmount(usd: number): string {
  return Number.isInteger(usd) ? String(usd) : usd.toFixed(2).replace(/\.?0+$/, "")
}

/** the figure and the unit, as one run of text: "$10 CASH" */
export function prizeLabel(usd: number): string {
  return `${prizeAmount(usd)} ${PRIZE_UNIT}`
}

const WORD_CHAR = /[\p{L}\p{N}]/u

/** `text` cut where the unit stands alone ("Claim $10 CASH" → "Claim $10 ",
 *  CASH), so the unit can be set apart; a word that only contains it stays
 *  whole, as the host's own ticker styling does */
export function splitPrizeUnit(text: string, unit = PRIZE_UNIT): { text: string; unit: boolean }[] {
  const parts: { text: string; unit: boolean }[] = []
  let from = 0
  for (let at = unit ? text.indexOf(unit) : -1; at >= 0; at = text.indexOf(unit, at + unit.length)) {
    const end = at + unit.length
    if (WORD_CHAR.test(text[at - 1] ?? "") || WORD_CHAR.test(text[end] ?? "")) continue
    if (at > from) parts.push({ text: text.slice(from, at), unit: false })
    parts.push({ text: unit, unit: true })
    from = end
  }
  if (from < text.length) parts.push({ text: text.slice(from), unit: false })
  return parts
}

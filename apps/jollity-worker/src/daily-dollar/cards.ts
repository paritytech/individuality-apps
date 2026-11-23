// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * How the Daily Dollar lines are drawn: Humanity's chat cards in the shape of
 * the intro rules, a picture of the ticket on top, the line under it, then
 * the button. The picture tells the story: a ticket to scratch, a winner, or
 * not today.
 *
 * A ticket's button becomes a grey "Scratched" pill once the person has
 * scratched it, or "Expired" once its claim window has shut; a posted message
 * cannot be edited, so the card works that out each time it is drawn.
 */
import { DARK_THEME_ART_WELL, artCard, button, doneButton, spacer, type ColorToken, type RenderNode } from "../card"
import type { ChatButton, ChatLine, DailyDollarCard } from "./registry"

const GAP = 12

/** The ticket pictures, one per kind of line. */
export const DAILY_DOLLAR_ART: Record<DailyDollarCard["kind"], string> = {
  ticket: "chat-card/dd-scratch.png",
  won: "chat-card/dd-won.png",
  miss: "chat-card/dd-miss.png",
}

/** Why a ticket's button is greyed out. */
export type TicketClosed = "scratched" | "expired"

const TICKET_CLOSED_LABEL: Record<TicketClosed, string> = { scratched: "Scratched", expired: "Expired" }

function buttons(list: readonly ChatButton[] | undefined, closed: TicketClosed | null): RenderNode[] {
  return (list ?? []).flatMap(({ actionId, title }) => [
    spacer(GAP),
    closed ? doneButton(TICKET_CLOSED_LABEL[closed]) : button(title, actionId),
  ])
}

/** The tree for one posted line; `closed` greys a ticket's button. A line
 *  from before the cards is drawn as a card of its words and buttons. */
export function dailyDollarTree(line: ChatLine, closed: TicketClosed | null = null, well: ColorToken = DARK_THEME_ART_WELL): RenderNode {
  const card: DailyDollarCard | undefined = line.card
  return artCard(card == null ? null : DAILY_DOLLAR_ART[card.kind], line.text, buttons(line.buttons, closed), well)
}

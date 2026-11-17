// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { gameSlot, payoff, type GameResults } from "./game-slot"
import { galleryLayout, gameCardNode, IDLE_UI, resultsCard } from "./game-card"
import { formatGameDate, formatGameTime } from "./format"
import { openFailed } from "./copy"
import {
  ACTION_OPEN_GAME,
  ACTION_REGISTER,
  ACTION_STASH,
  ACTION_TURN_ON_CAMERA,
  ACTION_USERNAME,
} from "./actions"
import * as cardCopy from "./copy"
import { background, column, fill, height, pad, spacer, text, width, type RenderNode } from "./render-node"

const base: GameResults = {
  endedAt: 1_000_000,
  passed: true,
  collectables: [
    { name: "Takahe", rarity: "common", image: "bafk-takahe" },
    { name: "Blanket Octopus", rarity: "rare", image: "bafk-octopus" },
  ],
  prize: { amountUsd: 200, ticket: "ab".repeat(32), drawAt: 1_003_600, phase: "waiting", won: false, claimable: false },
  membership: { member: false, justBecameMember: false, gamesToMembership: 2 },
  seen: { chest: false, draw: false },
}
const resultsWith = (overrides: Partial<GameResults>): GameResults => ({ ...base, ...overrides })
const prize = (overrides: Partial<NonNullable<GameResults["prize"]>>) => ({ ...base.prize!, ...overrides })
const seen = (chest: boolean, draw: boolean) => ({ chest, draw })

/** Every String the card would draw, in the order a player reads them. */
function strings(node: RenderNode): string[] {
  if (node.tag === "String") return [node.value]
  if (node.tag === "Nil") return []
  if (node.tag === "Button" && !node.value.props.text.trim()) return []
  if (node.tag === "Button") return [`[${node.value.props.text}${node.value.props.enabled ? "" : " (disabled)"}]`]
  return node.value.children.flatMap(strings)
}
/** Every Image node, in the order a player sees them. */
function images(node: RenderNode): Extract<RenderNode, { tag: "Image" }>[] {
  if (node.tag === "Image") return [node]
  if (node.tag === "String" || node.tag === "Nil") return []
  return node.value.children.flatMap(images)
}
/** The innermost Row that draws `line`, whose children a host lays out side by side. */
function rowDrawing(node: RenderNode, line: string): Extract<RenderNode, { tag: "Row" }> | undefined {
  if (node.tag === "String" || node.tag === "Nil") return undefined
  const inner = node.value.children.map((child) => rowDrawing(child, line)).find(Boolean)
  if (inner) return inner
  return node.tag === "Row" && strings(node).includes(line) ? node : undefined
}
/** Every node at or under `node` that takes the full width it is offered. */
function filled(node: RenderNode): RenderNode[] {
  if (node.tag === "String" || node.tag === "Nil") return []
  const own = node.value.modifiers.some((modifier) => modifier.tag === "fillWidth") ? [node] : []
  return [...own, ...node.value.children.flatMap(filled)]
}
/** The actions of the ENABLED buttons, in order. */
function actions(node: RenderNode): string[] {
  if (node.tag === "String" || node.tag === "Nil") return []
  if (node.tag === "Button") return node.value.props.enabled && node.value.props.clickAction ? [node.value.props.clickAction] : []
  return node.value.children.flatMap(actions)
}
function buttons(node: RenderNode): Extract<RenderNode, { tag: "Button" }>["value"]["props"][] {
  if (node.tag === "String" || node.tag === "Nil") return []
  if (node.tag === "Button") return [node.value.props]
  return node.value.children.flatMap(buttons)
}
function propsOf(node: RenderNode, line: string): unknown {
  if (node.tag === "String" || node.tag === "Nil") return undefined
  if (node.tag === "Text" && strings(node)[0] === line) return node.value.props
  return node.value.children.map((child) => propsOf(child, line)).find((found) => found !== undefined)
}
/** The size a host draws a node at, its declared width and height with its padding around them. */
function outerSize(node: RenderNode): { width: number; height: number } {
  if (node.tag === "String" || node.tag === "Nil") return { width: 0, height: 0 }
  const declared = (tag: "width" | "height") => (node.value.modifiers.find((modifier) => modifier.tag === tag)?.value as number | undefined) ?? 0
  const padding = node.value.modifiers.find((modifier) => modifier.tag === "padding")
  const [top, end, bottom, start] = padding?.tag === "padding" ? padding.value : [0, 0, 0, 0]
  return { width: declared("width") + end + (start ?? end), height: declared("height") + top + (bottom ?? top) }
}
/** The card as read once the people ring holds the member's key, so a new member is offered the name. */
const ready = (results: GameResults) => resultsCard(results, undefined, false, true)
const read = (results: GameResults) => strings(ready(results)).join(" | ")

describe("payoff works", () => {
  it("walks the draw: pending, ready, revealed", () => {
    // Given
    const ahead = base
    const drawn = resultsWith({ prize: prize({ phase: "drawn" }) })
    const watched = resultsWith({ prize: prize({ phase: "drawn" }), seen: seen(false, true) })
    const over = resultsWith({ prize: prize({ phase: "over" }) })
    const withoutTicket = resultsWith({ prize: null })

    // When
    const aheadPayoff = payoff(ahead)
    const drawnPayoff = payoff(drawn)
    const watchedPayoff = payoff(watched)
    const overPayoff = payoff(over)
    const withoutTicketPayoff = payoff(withoutTicket)

    // Then
    expect(aheadPayoff.draw).toBe("pending")
    expect(drawnPayoff.draw).toBe("ready")
    expect(watchedPayoff.draw).toBe("revealed")
    expect(overPayoff.draw).toBe("revealed")
    expect(withoutTicketPayoff.draw).toBe("none")
  })

  it("surfaces a claimable win at once, watched or not", () => {
    // Given
    const claimable = resultsWith({ prize: prize({ phase: "drawn", won: true, claimable: true }) })
    const watchedUnclaimable = resultsWith({ prize: prize({ phase: "drawn", won: true, claimable: false }), seen: seen(true, true) })

    // When
    const claimablePayoff = payoff(claimable)
    const watchedUnclaimablePayoff = payoff(watchedUnclaimable)

    // Then
    expect(claimablePayoff.draw).toBe("claim")
    expect(watchedUnclaimablePayoff.draw).toBe("revealed")
  })

  it("surfaces a win the chain will not pay a non-member at once, until the window closes or it is claimed", () => {
    // Given
    const membersOnly = resultsWith({ prize: prize({ phase: "drawn", won: true, claimable: false, membersOnly: true }) })
    const ahead = resultsWith({ prize: prize({ phase: "waiting", membersOnly: true }) })

    // When
    const membersOnlyPayoff = payoff(membersOnly)
    const aheadPayoff = payoff(ahead)

    // Then
    expect(membersOnlyPayoff.draw).toBe("members-only")
    expect(aheadPayoff.draw).toBe("pending")
  })

  it("keeps a claimed win as claimed, watched or not", () => {
    // Given
    const claimed = resultsWith({ prize: prize({ phase: "drawn", won: true, claimable: false, claimed: true }) })

    // When
    const claimedPayoff = payoff(claimed)

    // Then
    expect(claimedPayoff.draw).toBe("claimed")
  })
})

describe("results card works", () => {
  it("drops the gap under a results card the host docks in the footer, for a new member too", () => {
    // Given
    const newMember = resultsWith({ membership: { member: true, justBecameMember: true, gamesToMembership: 0 } })
    const modifiersOf = (card: RenderNode) => (card.tag === "Column" ? card.value.modifiers : [])

    // When
    const cards = [base, newMember].map((results) => ({
      inFeed: gameCardNode({ kind: "results", results }, IDLE_UI, base.endedAt),
      docked: gameCardNode({ kind: "results", results }, IDLE_UI, base.endedAt, { docked: true }),
    }))

    // Then
    for (const { inFeed, docked } of cards) {
      expect(modifiersOf(inFeed)).toEqual([fill, { tag: "padding", value: [0, 0, 24, 0] }])
      expect(modifiersOf(docked)).toEqual([fill])
    }
  })

  it("leads with the verdict in the grey box, and a non-member who did not pass reads the lines of the missed card", () => {
    // Given
    const passed = base
    const failed = resultsWith({ passed: false, collectables: [], prize: null })
    const styleOf = (node: RenderNode, line: string): string | undefined => {
      if (node.tag === "String" || node.tag === "Nil") return undefined
      if (node.tag === "Text" && strings(node)[0] === line) return node.value.props.style
      return node.value.children.map((child) => styleOf(child, line)).find((found) => found !== undefined)
    }

    // When
    const passedCard = resultsCard(passed)
    const failedCard = resultsCard(failed)

    // Then
    expect(strings(passedCard).slice(0, 3)).toEqual(["Game succeeded.", expect.any(String), "2 more games to become a Polkadot Member."])
    expect(styleOf(passedCard, "Game succeeded.")).toBe("body.medium.regular")
    expect(styleOf(passedCard, "2 more games to become a Polkadot Member.")).toBe("body.medium.regular")
    expect(strings(failedCard)).toEqual(["Game ended", expect.any(String), "You played but didn't pass.", "Play 2 more games to get your Membership."])
  })

  it("draws the verdict of a passed non-member in the grey box of the missed card, the step under it in grey, the boxes 4 apart, and the card 24 off the bottom", () => {
    // Given
    const verdictBox = column(
      [
        column(
          [
            text("Game succeeded.", { style: "body.medium.regular", color: "fg.primary" }),
            spacer(2),
            text(formatGameDate(base.endedAt), { style: "title.medium.regular", color: "fg.primary" }),
          ],
          [],
          { horizontalAlignment: "center" },
        ),
      ],
      [fill, pad(20), background("bg.surface.container", 24)],
      { horizontalAlignment: "center" },
    )
    const step = text("2 more games to become a Polkadot Member.", { style: "body.medium.regular", color: "fg.secondary" })
    const withoutDraw = resultsWith({ prize: null })
    const withWin = resultsWith({ prize: prize({ phase: "drawn", won: true, claimable: true }) })
    const childrenOf = (node: RenderNode): RenderNode[] => (node.tag === "String" || node.tag === "Nil" ? [] : node.value.children)

    // When
    const card = resultsCard(base)
    const drawn = childrenOf(card)
    const undrawn = childrenOf(resultsCard(withoutDraw))
    const won = childrenOf(resultsCard(withWin))

    // Then
    expect(drawn).toEqual([verdictBox, spacer(4), step, spacer(8), expect.anything()])
    expect(strings(drawn[4]!)[0]).toBe("You've earned 2 collectibles.")
    expect(undrawn).toEqual([verdictBox, spacer(4), step, spacer(8), expect.anything()])
    expect(strings(undrawn[4]!)[0]).toBe("You've earned 2 collectibles.")
    expect(won.slice(5, 6)).toEqual([spacer(4)])
    expect(strings(won[6]!)).toEqual(["Prize draw", "$200", "You won the prize"])
    expect(won).toHaveLength(7)
    expect(card).toMatchObject({
      tag: "Column",
      value: { modifiers: [fill, { tag: "padding", value: [0, 0, 24, 0] }], props: { horizontalAlignment: "center", verticalArrangement: "spaceBetween" } },
    })
  })

  it("tells a standing member of the membership when they passed, that this one got away when not, and greets a new one", () => {
    // Given
    const member = { member: true, justBecameMember: false, gamesToMembership: 0 }
    const renewed = resultsWith({ membership: member, prize: null })
    const failed = resultsWith({ membership: member, passed: false, collectables: [], prize: null })
    const newMember = resultsWith({ membership: { ...member, justBecameMember: true } })

    // When
    const renewedCard = resultsCard(renewed)
    const failedCard = resultsCard(failed)
    const newMemberText = read(newMember)

    // Then
    expect(strings(renewedCard).slice(0, 3)).toEqual(["Game succeeded.", expect.any(String), "You got Membership!"])
    expect(strings(renewedCard).slice(3, 4)).toEqual(["You've earned 2 collectibles."])
    expect(strings(failedCard)).toEqual(["Game ended", expect.any(String), "This one got away.", "Your next chance awaits."])
    expect(newMemberText).toContain("Game succeeded. | You got Membership! | [Set up your member name] | You're a Polkadot Member!")
  })

  it("trades Set up your member name for the note of an upgraded username once the full username is set", () => {
    // Given
    const game = { id: "7", status: "finished" as const, startAt: 0 }
    const newMember = resultsWith({ membership: { member: true, justBecameMember: true, gamesToMembership: 0 }, prize: null })
    const slot = gameSlot({ game, registered: true, results: newMember, nowSeconds: 200 })

    // When
    const named = gameCardNode(slot, IDLE_UI, 200, { nameSet: true })
    const unnamed = gameCardNode(slot, IDLE_UI, 200, { nameSet: false, nameReady: true })

    // Then
    expect(actions(named)).not.toContain(ACTION_USERNAME)
    expect(strings(named)).not.toContain(`[${cardCopy.MEMBER_NAME}]`)
    expect(strings(named)).toContain(cardCopy.NAME_UPGRADED)
    expect(actions(unnamed)).toContain(ACTION_USERNAME)
    expect(strings(unnamed)).not.toContain(cardCopy.NAME_UPGRADED)
    expect(strings(unnamed)).not.toContain(cardCopy.NAME_PENDING)
  })

  it("holds Set up your member name until the people ring holds the new member's key", () => {
    // Given
    const game = { id: "7", status: "finished" as const, startAt: 0 }
    const newMember = resultsWith({ membership: { member: true, justBecameMember: true, gamesToMembership: 0 }, prize: null })
    const slot = gameSlot({ game, registered: true, results: newMember, nowSeconds: 200 })

    // When
    const queued = gameCardNode(slot, IDLE_UI, 200, { nameSet: false, nameReady: false })
    const unknown = gameCardNode(slot, IDLE_UI, 200)

    // Then
    for (const card of [queued, unknown]) {
      expect(actions(card)).not.toContain(ACTION_USERNAME)
      expect(strings(card)).toContain(cardCopy.NAME_PENDING)
    }
  })

  it("puts the collectibles of a new member in a box under the status line, opening the stash, with the count when the card has it", () => {
    // Given
    const newMember = { member: true, justBecameMember: true, gamesToMembership: 0 }
    const counted = resultsWith({ membership: newMember, prize: null })
    const uncounted = resultsWith({ membership: newMember, prize: null, collectables: null })

    // When
    const countedCard = ready(counted)
    const countedText = read(counted)
    const uncountedText = read(uncounted)

    // Then
    expect(countedCard.tag === "Column" ? countedCard.value.children : []).toHaveLength(5)
    expect(countedText).toContain("You're a Polkadot Member! | You've earned 2 collectibles. | Takahe | Blanket Octopus | [Open Collectibles]")
    expect(uncountedText).toContain("You've earned collectibles. | [Open Collectibles]")
    expect(actions(countedCard)).toEqual(["jollity.username", "jollity.stash"])
  })

  it("puts the won ticket of a new member under the collectibles", () => {
    // Given
    const newMember = { member: true, justBecameMember: true, gamesToMembership: 0 }
    const withWin = resultsWith({ membership: newMember, prize: prize({ phase: "drawn", won: true }), seen: seen(true, true) })

    // When
    const card = ready(withWin)

    // Then
    expect(strings(card).slice(-4)).toEqual(["[Open Collectibles]", "Prize draw", "$200", "You won the prize"])
    expect(actions(card)).toEqual(["jollity.username", "jollity.stash"])
  })

  it("puts the won ticket of a standing member under the collectibles", () => {
    // Given
    const standing = { member: true, justBecameMember: false, gamesToMembership: 0 }
    const withWin = resultsWith({ membership: standing, prize: prize({ phase: "drawn", won: true }), seen: seen(true, true) })

    // When
    const card = resultsCard(withWin)

    // Then
    expect(strings(card).slice(-4)).toEqual(["[Open Collectibles]", "Prize draw", "$200", "You won the prize"])
    expect(actions(card)).toEqual([ACTION_STASH])
  })

  it("says No rewards for this game in that box when the game earned no collectibles, with nothing to open", () => {
    // Given
    const newMember = { member: true, justBecameMember: true, gamesToMembership: 0 }
    const empty = resultsWith({ membership: newMember, prize: null, collectables: null, earned: 0 })

    // When
    const text = read(empty)

    // Then
    expect(text).toContain("You're a Polkadot Member! | No rewards for this game")
    expect(actions(ready(empty))).toEqual(["jollity.username"])
  })

  it("nudges without a number when it cannot count", () => {
    // Given
    const unknown = { member: false, justBecameMember: false, gamesToMembership: null }
    const passedWithoutCount = [unknown, { ...unknown, gamesToMembership: 0 }].map((membership) => resultsWith({ membership }))
    const failedWithoutCount = resultsWith({ membership: unknown, passed: false, collectables: [], prize: null })

    // When
    const passedTexts = passedWithoutCount.map(read)
    const failedText = read(failedWithoutCount)

    // Then
    for (const text of passedTexts) {
      expect(text).not.toContain("more game")
      expect(text).toContain("Play again to get your Membership.")
    }
    expect(failedText).not.toContain("more game")
    expect(failedText).toContain("Play again to get your Membership.")
  })

  it("shows every collectible as a tile, its picture over its name, under the count and over Open Collectibles", () => {
    // Given
    const played = base

    // When
    const card = resultsCard(played)

    // Then
    expect(read(played)).toContain("You've earned 2 collectibles. | Takahe | Blanket Octopus | [Open Collectibles]")
    expect(images(card).map((node) => node.value.props.source).filter((source) => source.tag === "bulletin")).toEqual([
      { tag: "bulletin", value: "bafk-takahe" },
      { tag: "bulletin", value: "bafk-octopus" },
    ])
    expect(actions(card)).toContain(ACTION_STASH)
  })

  it.each([
    [1, [1], [true]],
    [2, [2], [true]],
    [3, [3], [false]],
    [4, [2, 2], [true, true]],
    [5, [3, 2], [false, true]],
    [6, [3, 3], [false, false]],
    [7, [3, 2, 2], [false, true, true]],
    [8, [3, 3, 2], [false, false, true]],
    [9, [3, 3, 3], [false, false, false]],
    [10, [3, 3, 2, 2], [false, false, true, true]],
  ])("lays %i collectibles out in rows of %j, never ending on a lone tile after three", (count, sizes, large) => {
    // When
    const rows = galleryLayout(count)

    // Then
    expect(rows.map((row) => row.count)).toEqual(sizes)
    expect(rows.map((row) => row.large)).toEqual(large)
  })

  it("draws every row the same width, so the tiles line up whatever the row holds", () => {
    // Given
    const five = resultsWith({ collectables: Array.from({ length: 5 }, (_, i) => ({ name: `Piece ${i}`, rarity: "common" as const })) })
    const widthOf = (node: RenderNode): number =>
      node.tag === "String" || node.tag === "Nil"
        ? 0
        : (node.value.modifiers.find((modifier) => modifier.tag === "width")?.value as number | undefined) ?? 0
    const rowsOf = (node: RenderNode): Extract<RenderNode, { tag: "Row" }>[] => {
      if (node.tag === "String" || node.tag === "Nil") return []
      const own = node.tag === "Row" && node.value.modifiers.some((modifier) => modifier.tag === "width") ? [node] : []
      return [...own, ...node.value.children.flatMap(rowsOf)]
    }

    // When
    const rows = rowsOf(resultsCard(five))
    const widths = rows.map((row) => row.value.children.reduce((sum, child) => sum + outerSize(child).width, 0))
    const tiles = rows.flatMap((row) => row.value.children.filter((child) => child.tag === "Column"))

    // Then
    expect(widths).toEqual([304, 304])
    expect(rows.map(widthOf)).toEqual([304, 304])
    expect(tiles.map((tile) => widthOf(tile) < outerSize(tile).width)).toEqual([true, true, true, true, true])
  })

  it("centres a lone collectible in its row and spreads the tiles of a fuller one", () => {
    // Given
    const one = resultsWith({ collectables: [{ name: "Takahe", rarity: "common" }] })
    const two = base
    const rowsOf = (node: RenderNode): Extract<RenderNode, { tag: "Row" }>[] => {
      if (node.tag === "String" || node.tag === "Nil") return []
      const own = node.tag === "Row" && node.value.modifiers.some((modifier) => modifier.tag === "width") ? [node] : []
      return [...own, ...node.value.children.flatMap(rowsOf)]
    }

    // When
    const lone = rowsOf(resultsCard(one)).map((row) => row.value.props.horizontalArrangement)
    const pair = rowsOf(resultsCard(two)).map((row) => row.value.props.horizontalArrangement)

    // Then
    expect(lone).toEqual(["center"])
    expect(pair).toEqual(["spaceBetween"])
  })

  it("names a rare collectible in amber and a common one in grey", () => {
    // Given
    const card = resultsCard(base)
    const colourOf = (name: string): string | undefined => {
      const find = (node: RenderNode): string | undefined => {
        if (node.tag === "String" || node.tag === "Nil") return undefined
        if (node.tag === "Text" && strings(node)[0] === name) return node.value.props.color
        return node.value.children.map(find).find((found) => found !== undefined)
      }
      return find(card)
    }

    // When
    const common = colourOf("Takahe")
    const rare = colourOf("Blanket Octopus")

    // Then
    expect(common).toBe("fg.secondary")
    expect(rare).toBe("fg.warning")
  })

  it("lays the amber glow and the star of the design over a rare tile, and nothing over a common one", () => {
    // Given
    const card = resultsCard(base)
    const tiles: RenderNode[] = []
    const collect = (node: RenderNode) => {
      if (node.tag === "String" || node.tag === "Nil") return
      const isTile = [142, 196].includes(outerSize(node).height)
      if (isTile && (node.tag === "Box" || node.tag === "Column")) return void tiles.push(node)
      node.value.children.forEach(collect)
    }
    collect(card)

    // When
    const pictures = tiles.map((tile) => images(tile).map((node) => node.value.props.source.value))
    const rare = tiles.find((tile) => tile.tag === "Box")
    const rareLayers = rare && rare.tag === "Box" ? rare.value.children : []

    // Then
    expect(tiles.map((tile) => tile.tag)).toEqual(["Column", "Box"])
    expect(rareLayers.map(outerSize)).toEqual([{ width: 148, height: 196 }, { width: 148, height: 196 }, { width: 148, height: 196 }])
    expect(pictures).toEqual([["bafk-takahe"], ["chat-card/rare-glow-large.png", "bafk-octopus", "chat-card/rare-badge.png"]])
  })

  it("draws a tile without its picture when the art could not be read, and the count before any tile is read", () => {
    // Given
    const unpictured = resultsWith({ collectables: [{ name: "Takahe", rarity: "common" }] })
    const uncounted = resultsWith({ collectables: null, earned: 3 })

    // When
    const unpicturedCard = resultsCard(unpictured)
    const uncountedText = read(uncounted)

    // Then
    expect(images(unpicturedCard)).toEqual([])
    expect(strings(unpicturedCard)).toContain("Takahe")
    expect(uncountedText).toContain("You've earned 3 collectibles. | [Open Collectibles]")
  })

  it("leaves the box out while nothing is counted, and for a game that earned nothing", () => {
    // Given
    const uncounted = resultsWith({ collectables: null })
    const empty = resultsWith({ collectables: [], earned: 0 })

    // When
    const uncountedText = read(uncounted)
    const emptyText = read(empty)

    // Then
    expect(uncountedText).not.toContain("collectible")
    expect(emptyText).not.toContain("collectible")
    expect(emptyText).not.toContain("No rewards")
  })

  it("shows nothing for a draw still ahead, nor for a held one until watched, and never a button", () => {
    // Given
    const ahead = base
    const held = resultsWith({ prize: prize({ phase: "drawn" }), seen: seen(true, false) })
    const wonUnwatched = resultsWith({ prize: prize({ phase: "drawn", won: true, claimable: false }) })

    // When
    const aheadText = read(ahead)
    const heldText = read(held)
    const wonUnwatchedText = read(wonUnwatched)

    // Then
    expect(aheadText).not.toContain("Prize draw")
    expect(aheadText).not.toContain("Draw")
    expect(heldText).not.toContain("Prize draw")
    expect(heldText).not.toContain("Drawn")
    expect(heldText).not.toContain("Claim")
    expect(wonUnwatchedText).not.toContain("Prize draw")
    expect(wonUnwatchedText).not.toContain("Claim")
  })

  it("shows a win the same way whether or not it is claimable", () => {
    // Given
    const claimable = resultsWith({ prize: prize({ phase: "drawn", won: true, claimable: true }) })
    const watched = resultsWith({ prize: prize({ phase: "drawn", won: true }), seen: seen(true, true) })

    // When
    const claimableText = read(claimable)
    const watchedText = read(watched)
    const watchedCard = resultsCard(watched)
    const pictures = images(watchedCard)

    // Then
    expect(claimableText).toContain("Prize draw | $200 | You won the prize")
    expect(claimableText).not.toContain("ticket")
    expect(claimableText).not.toContain("laim")
    expect(watchedText).toContain("Prize draw | $200 | You won the prize")
    expect(pictures.at(-2)).toMatchObject({
      value: {
        modifiers: [fill, height(136)],
        props: { source: { tag: "archive", value: "chat-card/prize-ticket.png" }, fit: "fill" },
      },
    })
    // the unit is the CASH wordmark beside the amount, as the app draws it (#431)
    expect(pictures.at(-1)).toMatchObject({
      value: {
        modifiers: [width(43), height(32)],
        props: { source: { tag: "archive", value: "chat-card/cash-wordmark.png" }, fit: "fill" },
      },
    })
    expect(propsOf(watchedCard, "Prize draw")).toEqual({ style: "body.medium.regular", color: "bg.surface.main" })
    expect(propsOf(watchedCard, "$200")).toEqual({ style: "headline.large", color: "bg.surface.main" })
    expect(propsOf(watchedCard, "You won the prize")).toEqual({ style: "title.medium.regular", color: "bg.surface.main" })
  })

  it("says nothing at all about a lost draw", () => {
    // Given
    const lost = resultsWith({ prize: prize({ phase: "drawn" }), seen: seen(true, true) })

    // When
    const text = read(lost)

    // Then
    expect(text).not.toContain("Prize draw")
    expect(text).not.toContain("No win")
  })

  it("has Open Collectibles as the only button, whatever the draw is up to", () => {
    // Given
    const unopened = base
    const unopenedWithWin = resultsWith({ prize: prize({ phase: "drawn", won: true, claimable: true }) })
    const unwatchedDraw = resultsWith({ prize: prize({ phase: "drawn" }), seen: seen(true, false) })
    const unclaimedWin = resultsWith({ prize: prize({ phase: "drawn", won: true, claimable: true }), seen: seen(true, true) })

    // When
    const cards = [unopened, unopenedWithWin, unwatchedDraw, unclaimedWin].map((results) => resultsCard(results))

    // Then
    for (const card of cards) expect(actions(card)).toEqual([ACTION_STASH])
  })

  it("has no Claim button for a win the chain would pay, and says when the claim is under way", () => {
    // Given
    const unclaimedWin = resultsWith({ prize: prize({ phase: "drawn", won: true, claimable: true }), seen: seen(true, true) })

    // When
    const waiting = resultsCard(unclaimedWin, { busy: false, failure: null })
    const claiming = resultsCard(unclaimedWin, { busy: true, failure: null })

    // Then
    expect(actions(waiting)).toEqual([ACTION_STASH])
    expect(strings(waiting).at(-1)).toBe(cardCopy.YOU_WON)
    expect(actions(claiming)).toEqual([ACTION_STASH])
    expect(strings(claiming).slice(-2)).toEqual([cardCopy.YOU_WON, cardCopy.CLAIMING])
  })

  it("keeps a claimed win on the card, watched or not", () => {
    // Given
    const claimed = resultsWith({ prize: prize({ phase: "drawn", won: true, claimable: false, claimed: true }), seen: seen(true, false) })

    // When
    const card = resultsCard(claimed)

    // Then
    expect(strings(card).slice(-2)).toEqual([cardCopy.YOU_WON, cardCopy.CLAIMED])
  })

  it("tells a winner who is not a member they are not eligible, without saying they won", () => {
    // Given
    const membersOnly = resultsWith({ prize: prize({ phase: "drawn", won: true, claimable: false, membersOnly: true }) })

    // When
    const card = resultsCard(membersOnly, { busy: false, failure: null })

    // Then
    expect(actions(card)).toEqual([ACTION_STASH])
    expect(strings(card)).not.toContain(cardCopy.YOU_WON)
    expect(strings(card).slice(-2)).toEqual([cardCopy.NOT_ELIGIBLE, cardCopy.MEMBERS_ONLY])
  })

  it("says why a claim did not land, and where else it can be claimed unless the chain refused it", () => {
    // Given
    const unclaimedWin = resultsWith({ prize: prize({ phase: "drawn", won: true, claimable: true }), seen: seen(true, true) })

    // When
    const cancelled = resultsCard(unclaimedWin, { busy: false, failure: "cancelled" })
    const refused = resultsCard(unclaimedWin, { busy: false, failure: "refused", refusal: "NoSuchWinner" })
    const failed = resultsCard(unclaimedWin, { busy: false, failure: "failed" })

    // Then
    expect(strings(cancelled).slice(-2)).toEqual([cardCopy.CLAIM_CANCELLED, cardCopy.CLAIM_IN_APP])
    expect(strings(refused).at(-1)).toBe("This ticket didn't win this draw.")
    expect(strings(failed).slice(-2)).toEqual([cardCopy.CLAIM_FAILED, cardCopy.CLAIM_IN_APP])
    for (const card of [cancelled, refused, failed]) expect(actions(card)).toEqual([ACTION_STASH])
  })

  it("keeps only Open Collectibles once the draw is done", () => {
    // Given
    const settled = resultsWith({ seen: seen(true, true), prize: prize({ phase: "drawn" }) })

    // When
    const card = resultsCard(settled)

    // Then
    expect(strings(card).filter((text) => text.startsWith("["))).toEqual(["[Open Collectibles]"])
  })

  it("has an honest game slot for the finished states", () => {
    // Given
    const game = { id: "7", status: "finished" as const, startAt: 0 }
    const played = { game, registered: true, results: base, nowSeconds: 200 }
    const noShow = { game, registered: true, results: null, nowSeconds: 200 }

    // When
    const playedSlot = gameSlot(played)
    const noShowSlot = gameSlot(noShow)

    // Then
    expect(playedSlot.kind).toBe("results")
    expect(noShowSlot.kind).toBe("missed")
  })
})

describe("game slot before the game works", () => {
  const START = 2_000_000
  const game = { id: "7", status: "scheduled" as const, startAt: START }
  const window = { opensAt: START - 7200, closesAt: START - 120 }
  const at = (now: number, registered = false) => gameSlot({ game, registered, results: null, nowSeconds: now, window })

  it("follows the window of the chain rather than the guess", () => {
    // Given
    const beforeOpening = START - 9000
    const beforeGuessedOpening = START - 5000
    const afterGuessedClosing = START - 200
    const afterClosing = START - 100

    // When
    const beforeOpeningSlot = at(beforeOpening)
    const beforeGuessedOpeningSlot = at(beforeGuessedOpening)
    const afterGuessedClosingSlot = at(afterGuessedClosing)
    const afterClosingSlot = at(afterClosing)

    // Then
    expect(beforeOpeningSlot).toEqual({ kind: "next", startAt: START, opensAt: START - 7200 })
    expect(beforeGuessedOpeningSlot).toEqual({ kind: "register", startAt: START, closesAt: START - 120 })
    expect(afterGuessedClosingSlot.kind).toBe("register")
    expect(afterClosingSlot).toEqual({ kind: "closed", startAt: START })
  })

  it("counts a registered player down over the last five minutes", () => {
    // Given
    const registered = true
    const early = START - 5000
    const lastFiveMinutes = START - 200

    // When
    const earlySlot = at(early, registered)
    const lastFiveMinutesSlot = at(lastFiveMinutes, registered)

    // Then
    expect(earlySlot).toEqual({ kind: "registered", startAt: START })
    expect(lastFiveMinutesSlot).toEqual({ kind: "starting", startAt: START })
  })

  it("falls back to the guess without a window", () => {
    // Given
    const beforeGuessedOpening = { game, registered: false, results: null, nowSeconds: START - 3700 }
    const afterGuessedOpening = { game, registered: false, results: null, nowSeconds: START - 3500 }

    // When
    const beforeGuessedOpeningSlot = gameSlot(beforeGuessedOpening)
    const afterGuessedOpeningSlot = gameSlot(afterGuessedOpening)

    // Then
    expect(beforeGuessedOpeningSlot.kind).toBe("next")
    expect(afterGuessedOpeningSlot.kind).toBe("register")
  })

  it("keeps the way in for a registered player once the game has started", () => {
    // Given
    const active = { ...game, status: "active" as const }
    const registeredPlayer = { game: active, registered: true, results: null, nowSeconds: START + 30 }
    const unregisteredPlayer = { game: active, registered: false, results: null, nowSeconds: START + 30 }

    // When
    const registeredSlot = gameSlot(registeredPlayer)
    const unregisteredSlot = gameSlot(unregisteredPlayer)

    // Then
    expect(registeredSlot.kind).toBe("starting")
    expect(unregisteredSlot.kind).toBe("closed")
  })

  it("says a cancelled game is cancelled, whatever else is true", () => {
    // Given
    const registeredButCancelled = { game, registered: true, results: null, nowSeconds: START - 5000, cancelled: true }

    // When
    const slot = gameSlot(registeredButCancelled)

    // Then
    expect(slot).toEqual({ kind: "cancelled", startAt: START })
  })

  it("takes the count of a missed game from the source when there are no results", () => {
    // Given
    const finished = { ...game, status: "finished" as const }
    const missedGame = { game: finished, registered: false, results: null, nowSeconds: START + 900, gamesToMembership: 2 }

    // When
    const slot = gameSlot(missedGame)

    // Then
    expect(slot).toMatchObject({ kind: "missed", gamesToMembership: 2 })
  })
})

describe("game card before the game works", () => {
  const START = 2_000_000
  const card = (slot: Parameters<typeof gameCardNode>[0], hostPill?: boolean) =>
    gameCardNode(slot, IDLE_UI, START - 200, { hostPill })

  it("draws nothing before the first game", () => {
    // Given
    const none = { kind: "none" as const }

    // When
    const drawn = gameCardNode(none, IDLE_UI, START)

    // Then
    expect(drawn.tag).toBe("Nil")
  })

  it("draws I'll be there as the orange pill of the design with dark text, under a clear button as wide as it that takes the tap", () => {
    // Given
    const register = { kind: "register" as const, startAt: START, closesAt: START - 90 }
    const nodes = (node: RenderNode): RenderNode[] =>
      node.tag === "String" || node.tag === "Nil" ? [node] : [node, ...node.value.children.flatMap(nodes)]

    // When
    const box = nodes(card(register)).find((node) => node.tag === "Box")!
    const [pill, tap] = box.tag === "Box" ? box.value.children : []
    const label = nodes(pill!).find((node) => node.tag === "Text")!

    // Then
    expect(pill!.tag === "Column" && pill!.value.modifiers).toContainEqual(background("fg.warning", 24))
    expect(label.tag === "Text" && label.value.props.color).toBe("bg.surface.main")
    expect(strings(label)).toEqual(["I'll be there"])
    expect(tap!.tag === "Button" && tap!.value.props).toMatchObject({ variant: "text", clickAction: ACTION_REGISTER })
    expect(tap!.tag === "Button" && tap!.value.props.text.length).toBeGreaterThan("I'll be there".length)
    expect(tap!.tag === "Button" && tap!.value.modifiers).toContainEqual({ tag: "fillWidth", value: true })
    expect(pill!.tag === "Column" && pill!.value.modifiers).toContainEqual({ tag: "fillWidth", value: true })
  })

  it("puts the label 2 over the big line, with the host spacing between them turned off", () => {
    // Given
    const register = { kind: "register" as const, startAt: START, closesAt: START - 90 }
    const registered = { kind: "registered" as const, startAt: START }
    const columns = (node: RenderNode): Extract<RenderNode, { tag: "Column" }>[] =>
      node.tag === "String" || node.tag === "Nil"
        ? []
        : [...(node.tag === "Column" ? [node] : []), ...node.value.children.flatMap(columns)]
    const slab = (node: RenderNode) => columns(node).find((column) => column.value.modifiers.some((modifier) => modifier.tag === "background" && modifier.value.color === "bg.surface.nested"))!

    // When
    const registerSlab = slab(card(register))
    const registeredSlab = slab(card(registered))

    // Then
    for (const column of [registerSlab, registeredSlab]) {
      expect(column.value.props.verticalArrangement).toBe("spaceBetween")
      expect(column.value.children[1]).toMatchObject({ tag: "Spacer", value: { modifiers: [{ tag: "height", value: 2 }] } })
      expect(column.value.children[2]).toMatchObject({ tag: "Text", value: { props: { style: "title.medium.regular" } } })
    }
    expect(strings(registeredSlab.value.children[0]!)).toEqual(["You're in"])
    expect(propsOf(registeredSlab, "You're in")).toEqual({ style: "body.large.regular", color: "fg.success" })
  })

  it("draws a circle for each game a candidate has left, with the count in words, and none for a member", () => {
    // Given
    const register = { kind: "register" as const, startAt: START, closesAt: START - 90 }
    const circlesOf = (node: RenderNode) =>
      JSON.stringify(node).split('"tag":"padding","value":[2,2,2,2]').length - 1

    const captionOf = (node: RenderNode): RenderNode | undefined => {
      if (node.tag === "String" || node.tag === "Nil") return undefined
      if (node.tag === "Column" && node.value.children[0]?.tag === "Text" && strings(node)[0]?.endsWith("to Membership")) return node
      return node.value.children.map(captionOf).find(Boolean)
    }

    // When
    const candidate = card({ ...register, gamesToMembership: 3 })
    const lastGame = card({ ...register, gamesToMembership: 1 })
    const farOff = card({ ...register, gamesToMembership: 12 })
    const closed = card({ kind: "closed", startAt: START, gamesToMembership: 3 })
    const member = card(register)

    // Then
    expect(circlesOf(candidate)).toBe(3)
    expect(strings(candidate)[0]).toBe("3 games to Membership")
    expect(strings(lastGame)[0]).toBe("1 game to Membership")
    expect(circlesOf(farOff)).toBe(6)
    expect(strings(farOff)[0]).toBe("12 games to Membership")
    expect(propsOf(closed, "3 games to Membership")).toEqual({ style: "body.small.regular", color: "fg.tertiary" })
    const caption = captionOf(candidate)
    expect(caption?.tag === "Column" && caption.value.modifiers).toContainEqual(width(168))
    expect(caption?.tag === "Column" && caption.value.props.horizontalAlignment).toBe("end")
    expect(circlesOf(member)).toBe(0)
    expect(strings(member)[0]).toBe("Next game")
  })

  it("draws the circles of a candidate on every face that carries the count, with the words on all but pending", () => {
    // Given
    const progress = { gamesToMembership: 3 }
    const faces: Parameters<typeof gameCardNode>[0][] = [
      { kind: "next", startAt: START, opensAt: START - 3600, ...progress },
      { kind: "register", startAt: START, closesAt: START - 90, ...progress },
      { kind: "registered", startAt: START, ...progress },
      { kind: "starting", startAt: START, ...progress },
      { kind: "closed", startAt: START, ...progress },
      { kind: "pending", endedAt: START, resultsAt: START + 600, ...progress },
      { kind: "cancelled", startAt: START, ...progress },
    ]

    // When
    const drawn = faces.map((slot) => [slot.kind, JSON.stringify(card(slot))] as const)

    // Then
    for (const [kind, json] of drawn) {
      expect({ kind, circles: json.split('"tag":"padding","value":[2,2,2,2]').length - 1 }).toEqual({ kind, circles: 3 })
      expect({ kind, caption: json.includes("3 games to Membership") }).toEqual({ kind, caption: kind !== "pending" })
    }
  })

  it("says Opening soon where I'll be there will be, with nothing to tap, until registration opens", () => {
    // Given
    const next = { kind: "next" as const, startAt: START, opensAt: START - 3600 }

    // When
    const nextCard = card(next)

    // Then
    expect(strings(nextCard)).toContain("Opening soon")
    expect(actions(nextCard)).toEqual([])
  })

  it("draws the pill across the slab edge to edge, and lays the clear button over all of it, on every face that has one", () => {
    // Given
    const register = { kind: "register" as const, startAt: START, closesAt: START - 90 }
    const faces = [
      card({ kind: "next", startAt: START, opensAt: START - 3600 }),
      card(register),
      gameCardNode(register, { busy: true, notice: null }, START - 200),
      gameCardNode(register, { busy: true, notice: null, progress: 0.5 }, START - 200),
      gameCardNode({ kind: "starting", startAt: START }, IDLE_UI, START + 5),
    ]
    const fills = (node: RenderNode) => node.tag !== "String" && node.tag !== "Nil" && node.value.modifiers.some((modifier) => modifier.tag === "fillWidth")
    const declaresWidth = (node: RenderNode) => node.tag !== "String" && node.tag !== "Nil" && node.value.modifiers.some((modifier) => modifier.tag === "width")
    const pills = (node: RenderNode): RenderNode[] => {
      if (node.tag === "String" || node.tag === "Nil") return []
      const label = node.value.children[0]
      const isPill = node.tag === "Column" && label?.tag === "Text" && label.value.props.style === "title.medium.regular" && node.value.modifiers.some((modifier) => modifier.tag === "background")
      return [...(isPill ? [node] : []), ...node.value.children.flatMap(pills)]
    }
    const tapsOf = (node: RenderNode): Extract<RenderNode, { tag: "Button" }>[] => {
      if (node.tag === "String" || node.tag === "Nil") return []
      if (node.tag === "Button") return [node]
      return node.value.children.flatMap(tapsOf)
    }

    // When
    const drawn = faces.map((face) => ({
      pills: pills(face).map((pill) => ({ fills: fills(pill), declaresWidth: declaresWidth(pill) })),
      taps: tapsOf(face).map((tap) => ({ fills: fills(tap), declaresWidth: declaresWidth(tap), blank: tap.value.props.text.trim() === "" && tap.value.props.text.length >= 60 })),
    }))

    // Then
    const pill = { fills: true, declaresWidth: false }
    const tap = { fills: true, declaresWidth: false, blank: true }
    expect(drawn).toEqual([
      { pills: [pill], taps: [] },
      { pills: [pill], taps: [tap] },
      { pills: [pill], taps: [tap] },
      { pills: [pill], taps: [] },
      { pills: [pill], taps: [tap] },
    ])
  })

  it("keeps the label of the pill, and the ring of a running sign-up, in the middle of the slab", () => {
    // Given
    const register = { kind: "register" as const, startAt: START, closesAt: START - 90 }
    const faces = [card(register), gameCardNode(register, { busy: true, notice: null, progress: 0.5 }, START - 200)]
    const boxes = (node: RenderNode): Extract<RenderNode, { tag: "Box" }>[] =>
      node.tag === "String" || node.tag === "Nil" ? [] : [...(node.tag === "Box" ? [node] : []), ...node.value.children.flatMap(boxes)]
    const centredColumns = (node: RenderNode): boolean =>
      node.tag !== "String" && node.tag !== "Nil" && (node.tag !== "Column" || node.value.props.horizontalAlignment === "center")

    // When
    const drawn = faces.map((face) => boxes(face).map((box) => ({ alignment: box.value.props.contentAlignment, fills: box.value.modifiers.some((modifier) => modifier.tag === "fillWidth"), centred: box.value.children.every(centredColumns) })))

    // Then
    expect(drawn).toEqual([
      [{ alignment: "center", fills: true, centred: true }],
      [{ alignment: "center", fills: true, centred: true }],
    ])
  })

  it("counts down the time left to join, a minute ahead of the start, with no button, as the native card does, unless the host docks a pill", () => {
    // Given
    const starting = { kind: "starting" as const, startAt: START }

    // When
    const own = card(starting)
    const docked = card(starting, true)

    // Then
    expect(strings(own)).toEqual(["Left to join", "2:20"])
    expect(actions(own)).toEqual([])
    expect(strings(docked)).toEqual(["You're in", "Game starting soon"])
    expect(propsOf(docked, "You're in")).toEqual({ style: "body.large.regular", color: "fg.success" })
    expect(actions(docked)).toEqual([])
  })

  it("says Game starting soon for the whole five minutes the pill of the host counts, and the date before them", () => {
    // Given: the pill comes up five minutes before the join, a minute before the card turns to starting
    const registered = { kind: "registered" as const, startAt: START }
    const pillUp = START - 60 - 300
    const face = (nowSeconds: number, hostPill: boolean) => strings(gameCardNode(registered, IDLE_UI, nowSeconds, { hostPill })).at(-1)

    // Then
    expect(face(pillUp, true)).toBe("Game starting soon")
    expect(face(pillUp - 1, true)).not.toBe("Game starting soon")
    expect(face(pillUp, false)).not.toBe("Game starting soon")
  })

  it("brings Start playing back under the pill of the host once the game starts, since the host drops its pill then", () => {
    // Given
    const starting = { kind: "starting" as const, startAt: START }

    // When
    const started = gameCardNode(starting, IDLE_UI, START + 5, { hostPill: true })

    // Then
    expect(strings(started)).toContain("Start playing")
    expect(actions(started)).toEqual([ACTION_OPEN_GAME])
  })

  it("says under Start playing when the host did not open the running game", () => {
    // Given
    const starting = { kind: "starting" as const, startAt: START }
    const refused = { busy: false, notice: { text: openFailed("Jollity"), tone: "fg.error" as const } }

    // When
    const withNotice = gameCardNode(starting, refused, START + 30)

    // Then
    expect(strings(withNotice)).toEqual(expect.arrayContaining(["Start playing", "The Polkadot app couldn't open Jollity. Update it to the latest version."]))
  })

  it("spins I'll be there while a sign-up of no known step is on its way", () => {
    // Given
    const register = { kind: "register" as const, startAt: START, closesAt: START - 300 }

    // When
    const busy = gameCardNode(register, { busy: true, notice: null }, START - 1200)

    // Then
    expect(strings(busy)).toEqual(["Next game", formatGameTime(START), "I'll be there"])
    expect(buttons(busy)).toEqual([expect.objectContaining({ clickAction: ACTION_REGISTER, loading: true, enabled: false })])
    expect(propsOf(busy, "I'll be there")).toEqual({ style: "title.medium.regular", color: "fg.warning" })
    expect(images(busy)).toEqual([])
  })

  it("fills a ring in the middle of I'll be there as the sign-up goes, short of full, with nothing to tap", () => {
    // Given
    const register = { kind: "register" as const, startAt: START, closesAt: START - 300 }
    const at = (progress: number) => gameCardNode(register, { busy: true, notice: null, progress }, START - 1200)

    // When
    const rings = [0, 0.25, 0.6, 0.8, 1].map((progress) => images(at(progress)).map((node) => node.value.props.source.value))

    // Then
    expect(rings).toEqual([
      ["chat-card/signup-ring-10.png"],
      ["chat-card/signup-ring-20.png"],
      ["chat-card/signup-ring-60.png"],
      ["chat-card/signup-ring-80.png"],
      ["chat-card/signup-ring-90.png"],
    ])
    expect(propsOf(at(0.6), "I'll be there")).toEqual({ style: "title.medium.regular", color: "fg.warning" })
    expect(actions(at(0.6))).toEqual([])
  })

  it("shrinks to a pill with the seconds left over the last minute before the join", () => {
    // Given
    const starting = { kind: "starting" as const, startAt: START }

    // When
    const lastMinute = gameCardNode(starting, IDLE_UI, START - 60 - 13)
    const beforeIt = gameCardNode(starting, IDLE_UI, START - 60 - 61)

    // Then
    expect(strings(lastMinute)).toEqual(["Game starts in", "13"])
    expect(propsOf(lastMinute, "13")).toEqual({ style: "headline.large", color: "bg.surface.main" })
    expect(actions(lastMinute)).toEqual([])
    expect(strings(beforeIt)).toEqual(["Left to join", "1:01"])
  })

  it("says Live now over its start once the game has started, with the way in", () => {
    // Given
    const starting = { kind: "starting" as const, startAt: START }
    const afterStart = START + 30

    // When
    const live = gameCardNode(starting, IDLE_UI, afterStart)

    // Then
    expect(strings(live)).toEqual(["Live now", formatGameTime(START), "Start playing"])
    expect(propsOf(live, formatGameTime(START))).toEqual({ style: "title.medium.regular", color: "fg.warning" })
    expect(actions(live)).toEqual([ACTION_OPEN_GAME])
  })

  it("spins I'll be there while a sign-up is on its way, and says under it when one failed", () => {
    // Given
    const register = { kind: "register" as const, startAt: START, closesAt: START - 90 }

    // When
    const busy = gameCardNode(register, { busy: true, notice: null }, START - 200)
    const failed = gameCardNode(register, { busy: false, notice: { text: "Couldn't sign you up.", tone: "fg.error" } }, START - 200)

    // Then
    expect(strings(busy)).toContain("I'll be there")
    expect(actions(busy)).toEqual([])
    expect(strings(failed)).toEqual(expect.arrayContaining(["I'll be there", "Couldn't sign you up."]))
    expect(propsOf(failed, "Couldn't sign you up.")).toEqual({ style: "body.medium.regular", color: "fg.error" })
    expect(actions(failed)).toEqual([ACTION_REGISTER])
  })

  it("says Not registered in the warning colour where Next game was, with I'll be there live and the notifications line in the foot", () => {
    // Given
    const register = { kind: "register" as const, startAt: START, closesAt: START - 90 }
    const notice = "Enable notifications to register."

    // When
    const blocked = gameCardNode(register, { busy: false, notice: { text: notice, status: "Not registered", tone: "fg.error" } }, START - 200)

    // Then
    expect(strings(blocked)).toEqual(["Not registered", formatGameTime(START), "I'll be there", notice])
    expect(propsOf(blocked, "Not registered")).toEqual({ style: "body.large.regular", color: "fg.warning" })
    expect(propsOf(blocked, notice)).toEqual({ style: "body.small.regular", color: "fg.secondary" })
    expect(propsOf(blocked, "I'll be there")).toEqual({ style: "title.medium.regular", color: "bg.surface.main" })
    expect(actions(blocked)).toEqual([ACTION_REGISTER])
    expect(JSON.stringify(blocked)).toContain("chat-card/bell-off.png")
    expect(blocked.tag === "Column" && blocked.value.modifiers).toContainEqual(expect.objectContaining({ value: expect.objectContaining({ color: "bg.surface.container" }) }))
  })

  it("greys I'll be there out and turns it off under the notice of an unowned username", () => {
    // Given
    const register = { kind: "register" as const, startAt: START, closesAt: START - 90 }
    const notice = { text: cardCopy.NAME_UNOWNED, tone: "fg.error" as const, registerOff: true }

    // When
    const card = gameCardNode(register, { busy: false, notice }, START - 200)

    // Then
    expect(strings(card)).toEqual(["Next game", formatGameTime(START), "I'll be there", cardCopy.NAME_UNOWNED])
    expect(actions(card)).toEqual([])
    expect(propsOf(card, "I'll be there")).toEqual({ style: "title.medium.regular", color: "fg.tertiary" })
    expect(propsOf(card, cardCopy.NAME_UNOWNED)).toEqual({ style: "body.medium.regular", color: "fg.error" })
    expect(JSON.stringify(card)).not.toContain("chat-card/bell-off.png")
  })

  it("greys Turn on out and turns it off while the card is busy", () => {
    // Given
    const registered = { kind: "registered" as const, startAt: START }

    // When
    const idle = gameCardNode(registered, { busy: false, notice: null, camera: "off" }, START - 200)
    const asking = gameCardNode(registered, { busy: true, notice: null, camera: "off" }, START - 200)

    // Then
    expect(propsOf(idle, "Turn on")).toEqual({ style: "body.large.regular", color: "fg.warning" })
    expect(actions(idle)).toContain(ACTION_TURN_ON_CAMERA)
    expect(strings(asking)).toContain("Turn on")
    expect(propsOf(asking, "Turn on")).toEqual({ style: "body.large.regular", color: "fg.tertiary" })
    expect(actions(asking)).not.toContain(ACTION_TURN_ON_CAMERA)
  })

  const notifications = { text: cardCopy.NOTIFICATIONS_REQUIRED, status: cardCopy.NOT_REGISTERED, tone: "fg.error" as const }
  const footRows = {
    "Turn on on the Register face": {
      label: "Turn on",
      card: () => gameCardNode({ kind: "register", startAt: START, closesAt: START - 90 }, { busy: false, notice: notifications, camera: "off" }, START - 200),
    },
    "Turn on on the registered face": {
      label: "Turn on",
      card: () => gameCardNode({ kind: "registered", startAt: START }, { busy: false, notice: null, camera: "off" }, START - 200),
    },
  }

  it.each(Object.keys(footRows) as (keyof typeof footRows)[])("leaves room for %s on Android, with nothing filled before it", (name) => {
    // Given
    const { label, card } = footRows[name]

    // When
    const children = rowDrawing(card(), label)!.value.children
    const beforeButton = children.slice(0, -1)

    // Then
    expect(strings(children.at(-1)!)).toEqual([label])
    expect(beforeButton.flatMap(filled)).toEqual([])
  })

  it.each(Object.keys(footRows) as (keyof typeof footRows)[])("keeps the icon and the line together at the left and %s at the right edge", (name) => {
    // Given
    const { label, card } = footRows[name]

    // When
    const row = rowDrawing(card(), label)!

    // Then
    expect(row.value.props.horizontalArrangement).toBe("start")
    expect(row.value.children.at(-2)).toEqual({ tag: "Spacer", value: { modifiers: [], props: undefined, children: [] } })
    expect(row.value.children.at(-3)).toMatchObject({ tag: "Column", value: { modifiers: [{ tag: "width", value: 192 }] } })
  })

  it.each([cardCopy.SIGN_UP_FAILED, cardCopy.REGISTRATION_CLOSED_NOTICE])("draws the notice of a late tap on the closed face, as %s", (line) => {
    // Given
    const closed = { kind: "closed" as const, startAt: START }

    // When
    const card = gameCardNode(closed, { busy: false, notice: { text: line, tone: "fg.error" } }, START - 60)

    // Then
    expect(strings(card)).toEqual(["Next game", "Registration closed", line])
  })

  it("keeps Next game over a plain failure notice, which has no status", () => {
    // Given
    const register = { kind: "register" as const, startAt: START, closesAt: START - 90 }

    // When
    const failed = gameCardNode(register, { busy: false, notice: { text: "Couldn't sign you up.", tone: "fg.error" } }, START - 200)

    // Then
    expect(strings(failed)).toEqual(["Next game", formatGameTime(START), "I'll be there", "Couldn't sign you up."])
    expect(propsOf(failed, "Next game")).toEqual({ style: "body.large.regular", color: "fg.secondary" })
  })

  it("adds the camera line under the notifications line of Not registered when the camera is off", () => {
    // Given
    const register = { kind: "register" as const, startAt: START, closesAt: START - 90 }
    const notice = { text: "Enable notifications to register.", status: "Not registered", tone: "fg.error" as const }

    // When
    const blocked = gameCardNode(register, { busy: false, notice, camera: "off" }, START - 200)

    // Then
    expect(strings(blocked)).toEqual([
      "Not registered",
      formatGameTime(START),
      "I'll be there",
      "Enable notifications to register.",
      "Camera is off. Turn it on to play.",
      "Turn on",
    ])
    expect(actions(blocked)).toEqual([ACTION_REGISTER, ACTION_TURN_ON_CAMERA])
    expect(images(blocked).map((image) => image.value.props.source.value)).toEqual(["chat-card/bell-off.png", "chat-card/camera-off.png"])
  })

  it("draws the camera line alone under a registered card, in the sizes of the notifications line", () => {
    // Given
    const registered = { kind: "registered" as const, startAt: START }

    // When
    const off = gameCardNode(registered, { busy: false, notice: null, camera: "off" }, START - 200)

    // Then
    expect(strings(off)).toEqual(["You're in", formatGameTime(START), "Camera is off. Turn it on to play.", "Turn on"])
    expect(propsOf(off, "Camera is off. Turn it on to play.")).toEqual({ style: "body.small.regular", color: "fg.secondary" })
    expect(propsOf(off, "Turn on")).toEqual({ style: "body.large.regular", color: "fg.warning" })
    expect(actions(off)).toEqual([ACTION_TURN_ON_CAMERA])
    expect(images(off)).toHaveLength(1)
    expect(outerSize(images(off)[0]!)).toEqual({ width: 16, height: 16 })
  })

  it("draws no camera line while the camera is not known to be off", () => {
    // Given
    const registered = { kind: "registered" as const, startAt: START }

    // When
    const unknown = gameCardNode(registered, IDLE_UI, START - 200)

    // Then
    expect(JSON.stringify(unknown)).not.toContain("Camera is off")
  })

  it("keeps the camera line off the Register card of a player no reminder refused", () => {
    // Given
    const register = { kind: "register" as const, startAt: START, closesAt: START - 90 }

    // When
    const idle = gameCardNode(register, { busy: false, notice: null, camera: "off" }, START - 200)
    const failed = gameCardNode(register, { busy: false, notice: { text: "Couldn't sign you up.", tone: "fg.error" }, camera: "off" }, START - 200)

    // Then
    expect(strings(idle)).toEqual(["Next game", formatGameTime(START), "I'll be there"])
    expect(strings(failed)).toEqual(["Next game", formatGameTime(START), "I'll be there", "Couldn't sign you up."])
  })

  it("says a cancelled game did not go ahead over its date, with no button, no line under it and its circles greyed out", () => {
    // Given
    const cancelled = { kind: "cancelled" as const, startAt: START, gamesToMembership: 2 }

    // When
    const card = gameCardNode(cancelled, IDLE_UI, START + 60)

    // Then
    expect(strings(card)).toEqual(["2 games to Membership", "Game cancelled", formatGameTime(START)])
    expect(propsOf(card, "2 games to Membership")).toEqual({ style: "body.small.regular", color: "fg.tertiary" })
    expect(actions(card)).toEqual([])
  })

  it("keeps the gap under a cancelled card in the feed that every finished game card keeps", () => {
    // Given
    const cancelled = { kind: "cancelled" as const, startAt: START }

    // When
    const inFeed = gameCardNode(cancelled, IDLE_UI, START + 60)
    const docked = gameCardNode(cancelled, IDLE_UI, START + 60, { docked: true })

    // Then
    const modifiersOf = (card: RenderNode) => (card.tag === "Column" ? card.value.modifiers : [])
    expect(modifiersOf(inFeed)).toEqual([fill, { tag: "padding", value: [0, 0, 24, 0] }])
    expect(modifiersOf(docked)).toEqual([fill])
  })
})

describe("missed card works", () => {
  it("keeps only the ended label and the date in the grey box of a missed game, with every line under it", () => {
    // Given
    const finished = { id: "7", status: "finished" as const, startAt: 2_000_000 }
    const missed = gameSlot({ game: finished, registered: true, results: null, nowSeconds: 2_000_900, gamesToMembership: 2 })

    // When
    const card = gameCardNode(missed, IDLE_UI, 2_000_900)

    // Then
    const [box, , verdict, nextStep] = card.tag === "Column" ? card.value.children : []
    expect(strings(box!)).toEqual(["Game ended", expect.any(String)])
    expect(strings(verdict!)).toEqual(["You missed the game or didn't pass."])
    expect(strings(nextStep!)).toEqual(["Play 2 more games to get your Membership."])
  })

  it("drops the gap under a card the host docks in the footer, since the footer pads the card itself", () => {
    // Given
    const finished = { id: "7", status: "finished" as const, startAt: 2_000_000 }
    const missed = gameSlot({ game: finished, registered: false, results: null, nowSeconds: 2_000_900 })

    // When
    const inFeed = gameCardNode(missed, IDLE_UI, 2_000_900)
    const docked = gameCardNode(missed, IDLE_UI, 2_000_900, { docked: true })

    // Then
    const modifiersOf = (card: typeof inFeed) => (card.tag === "Column" ? card.value.modifiers : [])
    expect(modifiersOf(inFeed)).toEqual([{ tag: "fillWidth", value: true }, { tag: "padding", value: [0, 0, 24, 0] }])
    expect(modifiersOf(docked)).toEqual([{ tag: "fillWidth", value: true }])
  })

  it("tells a player whose report landed that they played but did not pass", () => {
    // Given
    const finished = { id: "7", status: "finished" as const, startAt: 2_000_000 }
    const reported = gameSlot({ game: finished, registered: true, results: null, nowSeconds: 2_000_900, gamesToMembership: 2, reported: true })
    const unreported = gameSlot({ game: finished, registered: true, results: null, nowSeconds: 2_000_900, gamesToMembership: 2 })
    const reportedMember = gameSlot({ game: finished, registered: true, results: null, nowSeconds: 2_000_900, member: true, missesLeft: 3, reported: true })
    const reportedPaused = gameSlot({ game: finished, registered: true, results: null, nowSeconds: 2_000_900, member: true, paused: true, reported: true })

    // When
    const reportedText = strings(gameCardNode(reported, IDLE_UI, 2_000_900))
    const unreportedText = strings(gameCardNode(unreported, IDLE_UI, 2_000_900))
    const memberText = strings(gameCardNode(reportedMember, IDLE_UI, 2_000_900))
    const pausedText = strings(gameCardNode(reportedPaused, IDLE_UI, 2_000_900))

    // Then
    expect(reported).toMatchObject({ kind: "missed", reason: "not-passed" })
    expect(reportedText.slice(2)).toEqual(["You played but didn't pass.", "Play 2 more games to get your Membership."])
    expect(unreportedText.slice(2)).toEqual(["You missed the game or didn't pass.", "Play 2 more games to get your Membership."])
    expect(memberText.slice(2)).toEqual(["You played but didn't pass."])
    expect(pausedText.slice(2)).toEqual(["You played but didn't pass.", "Your Membership is on pause until you pass a game."])
  })

  it("tells a player who played but did not pass what they earned, over the play-more line, with the way to the stash", () => {
    // Given
    const finished = { id: "7", status: "finished" as const, startAt: 2_000_000 }
    const played = { game: finished, registered: true, results: null, nowSeconds: 2_000_900, gamesToMembership: 2, reported: true }

    // When
    const two = gameCardNode(gameSlot({ ...played, earned: 2 }), IDLE_UI, 2_000_900)
    const one = gameCardNode(gameSlot({ ...played, earned: 1 }), IDLE_UI, 2_000_900)

    // Then
    expect(strings(two).slice(2)).toEqual([
      "You played but didn't pass.",
      "You earned 2 collectibles.",
      "Open your Stash to claim them.",
      "[Open Stash]",
      "Play 2 more games to get your Membership.",
    ])
    expect(strings(one).slice(3, 5)).toEqual(["You earned 1 collectible.", "Open your Stash to claim it."])
    expect(actions(two)).toEqual([ACTION_STASH])
  })

  it("draws the card it always did with nothing earned, a count not read, or a player who never played", () => {
    // Given
    const finished = { id: "7", status: "finished" as const, startAt: 2_000_000 }
    const played = { game: finished, registered: true, results: null, nowSeconds: 2_000_900, gamesToMembership: 2, reported: true }
    const card = (input: Parameters<typeof gameSlot>[0]) => gameCardNode(gameSlot(input), IDLE_UI, 2_000_900)

    // When
    const nothing = card({ ...played, earned: 0 })
    const unread = card(played)
    const noShow = card({ ...played, reported: false, earned: 2 })

    // Then
    expect(strings(nothing).slice(2)).toEqual(["You played but didn't pass.", "Play 2 more games to get your Membership."])
    expect(strings(unread)).toEqual(strings(nothing))
    expect(strings(noShow).slice(2)).toEqual(["You missed the game or didn't pass.", "Play 2 more games to get your Membership."])
    expect([nothing, unread, noShow].flatMap(actions)).toEqual([])
  })

  it("trusts a landed report over a sign-up the worker never saw", () => {
    // Given
    const finished = { id: "7", status: "finished" as const, startAt: 2_000_000 }

    // When
    const face = gameSlot({ game: finished, registered: false, results: null, nowSeconds: 2_000_900, reported: true })

    // Then
    expect(face).toMatchObject({ kind: "missed", reason: "not-passed" })
  })

  it("names the games left only when the source can count them", () => {
    // Given
    const finished = { id: "7", status: "finished" as const, startAt: 2_000_000 }
    const uncounted = gameSlot({ game: finished, registered: true, results: null, nowSeconds: 2_000_900 })
    const counted = gameSlot({ game: finished, registered: true, results: null, nowSeconds: 2_000_900, gamesToMembership: 2 })
    const none = gameSlot({ game: finished, registered: true, results: null, nowSeconds: 2_000_900, gamesToMembership: 0 })

    // When
    const uncountedText = strings(gameCardNode(uncounted, IDLE_UI, 2_000_900)).join(" | ")
    const countedText = strings(gameCardNode(counted, IDLE_UI, 2_000_900)).join(" | ")
    const noneText = strings(gameCardNode(none, IDLE_UI, 2_000_900)).join(" | ")

    // Then
    expect(uncounted).toMatchObject({ kind: "missed", gamesToMembership: null })
    expect(uncountedText).toContain("You missed the game or didn't pass. | Play again to get your Membership.")
    expect(uncountedText).not.toContain("more game")
    expect(countedText).toContain("Play 2 more games to get your Membership.")
    expect(noneText).not.toContain("more game")
  })
})

describe("pending card works", () => {
  it("counts down to the end of the reports, says there is nothing to do, and marks the game on its circle", () => {
    // Given
    const endedAt = 2_000_150
    const pending = { kind: "pending" as const, endedAt, resultsAt: endedAt + 754, gamesToMembership: 2 }

    // When
    const card = gameCardNode(pending, IDLE_UI, endedAt + 4)

    // Then
    expect(strings(card)).toEqual(["Results in 12:30", "Nothing to do. Your results will show here."])
    expect(propsOf(card, "Results in 12:30")).toEqual({ style: "title.medium.regular", color: "fg.primary" })
    expect(images(card).map((node) => node.value.props.source)).toEqual([{ tag: "archive", value: "chat-card/pending-clock.png" }])
    expect(JSON.stringify(card).split('"color":"fg.warning"').length - 1).toBe(2)
    const rows = (node: RenderNode): Extract<RenderNode, { tag: "Row" }>[] =>
      node.tag === "String" || node.tag === "Nil" ? [] : [...(node.tag === "Row" ? [node] : []), ...node.value.children.flatMap(rows)]
    const circles = rows(card)[0]?.value.children[0]
    const [first, , second] = circles && circles.tag === "Row" ? circles.value.children : []
    expect(JSON.stringify(first)).toContain('"color":"fg.warning"')
    expect(JSON.stringify(second)).not.toContain('"color":"fg.warning"')
    expect(actions(card)).toEqual([])
  })

  it("says the results are pending once the reports have closed, or when the chain gives no time", () => {
    // Given
    const endedAt = 2_000_150
    const closed = { kind: "pending" as const, endedAt, resultsAt: endedAt + 600 }
    const untimed = { kind: "pending" as const, endedAt }

    // When
    const afterClosing = gameCardNode(closed, IDLE_UI, endedAt + 600)
    const withoutTime = gameCardNode(untimed, IDLE_UI, endedAt + 60)

    // Then
    expect(strings(afterClosing)[0]).toBe("Game Results Pending")
    expect(strings(withoutTime)[0]).toBe("Game Results Pending")
  })
})

describe("prize unit works", () => {
  it("names the prize in the unit the build sets, and in CASH without one", async () => {
    // Given
    const { formatPrize } = await import("./format")

    // When
    const plain = formatPrize(200)
    vi.stubEnv("NEXT_PUBLIC_PRIZE_UNIT", "pUSD")
    const set = formatPrize(200)
    vi.unstubAllEnvs()

    // Then
    expect(plain).toBe("$200 CASH")
    expect(set).toBe("$200 pUSD")
  })
})

describe("a game the player never signed up for", () => {
  const finished = { id: "7", status: "finished" as const, startAt: 2_000_000 }

  it("tells a non-member in the feed only that they missed the game, says nothing under the docked card, and pauses only a member the chain suspended", () => {
    // Given
    const input = { game: finished, registered: false, results: null, nowSeconds: 2_000_900 }
    const newcomer = gameSlot({ ...input, gamesToMembership: 2 })
    const unread = gameSlot({ ...input, member: true })
    const inGrace = gameSlot({ ...input, member: true, missesLeft: 3 })
    const lastChance = gameSlot({ ...input, member: true, missesLeft: 0 })
    const suspended = gameSlot({ ...input, member: true, paused: true, missesLeft: 0 })
    const lines = (slot: ReturnType<typeof gameSlot>) => strings(gameCardNode(slot, IDLE_UI, 2_000_900)).slice(2)

    // When
    const newcomerText = strings(gameCardNode(newcomer, IDLE_UI, 2_000_900))

    // Then
    expect(newcomerText).toEqual(["Game ended", expect.any(String), "You missed the game."])
    expect(strings(gameCardNode(newcomer, IDLE_UI, 2_000_900, { docked: true }))).toEqual(["Game ended", expect.any(String)])
    expect(lines(unread)).toEqual(["You missed the game."])
    expect(lines(inGrace)).toEqual(["You missed the game."])
    expect(lines(lastChance)).toEqual(["You missed the game.", "Miss the next game and your Membership pauses."])
    expect(lines(suspended)).toEqual(["You missed the game.", "Your Membership is on pause until you play again."])
  })
})

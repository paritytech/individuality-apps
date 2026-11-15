// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE GRID'S LAYOUT: which seat each tile of the game grid shows, in reading
 * order. Pure seat arithmetic: its one import is game-chain's pure subpath,
 * so it pulls in no chain client.
 */
import { hostSeat } from "@jollity/game-chain/game"

/**
 * THE ROUND'S LAYOUT (#546): the group's seats in seat order with YOU second,
 * the grid's top-right corner. It is where the round starts: `turnLayout`
 * brings each turn's host to the top-left from here. Empty until the round
 * has seated you.
 */
export function roundLayout(seats: number, you: number): number[] {
  if (you < 0 || you >= seats) return []
  const others = Array.from({ length: seats }, (_, seat) => seat).filter((seat) => seat !== you)
  return [...others.slice(0, 1), you, ...others.slice(1)]
}

/**
 * THE GRID FOR ONE TURN: the turn's host in the top-left, you in the
 * top-right. `seats` are the seats a player holds, one tile each: a chair
 * nobody holds gets no tile (#1347). A round has `turns` turns, the game's
 * group cap, and a group smaller than it wraps its hosts around its own seats
 * (game-chain `hostSeat`): a group of 4 in a game of six hosts A B C D A B. A
 * turn change moves as few tiles as it can: the new host trades places with
 * the old one, so two tiles move and the rest hold still for the whole round
 * (#546). Your own turn takes you from the top-right to the top-left, and the
 * turn after it puts you back: the next host to the top-left, and the host
 * before you into that host's old slot, three tiles. It folds the turns from
 * the round's layout (`roundLayout`) up to `turn`, so a page opened mid-round
 * draws what one that watched every turn draws. A group of one hosts the
 * empty chairs after its first turn, and they have no tile to bring up.
 * Empty until the round has seated you.
 */
export function turnLayout(seats: number, you: number, turn: number, turns = seats): number[] {
  const layout = roundLayout(seats, you)
  const last = Math.min(Math.max(turn, 0), turns - 1)
  for (let t = 0; t <= last && layout.length > 0; t++) {
    const host = hostSeat(t, seats)
    if (layout[0] === host) continue
    const at = layout.indexOf(host)
    if (at < 0) continue
    // the host before trades places with this one, unless that was you:
    // then you go back to your corner, and its holder to this host's slot
    layout[at] = layout[0] === you ? layout[1] : layout[0]
    if (layout[0] === you) layout[1] = you
    layout[0] = host
  }
  return layout
}

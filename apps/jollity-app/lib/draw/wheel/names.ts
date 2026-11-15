// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHO'S PLAYING, AS A REAL DRAW NAMES IT. The row along the top of the draw
 * (./proto's legend, the JOLLITY `chainDraw.nameOf` patch) shows every
 * ticket's holder, so every ticket's name is read when the stage mounts: they
 * arrive while the coin is flipped and the wheel turns, before the row comes
 * on. A name that lands after the row is built is put in (`onName`).
 *
 * The names are the chain's (lib/draw/draw-name-lookup.ts, DotNS), one read
 * per ticket for the page's life. A ticket nobody has named shows a short
 * code of its slot, so it reads as a ticket, never as a made-up person.
 */

/** the name on a ticket (its slot, hex), null for none */
export type NameOf = (ticket: string) => Promise<string | null>

/** at most this many name reads in flight: a big draw must not fire one per ticket at once */
export const NAME_READS_AT_ONCE = 6

/** One read per ticket for the page's life, shared by every caller; a read that failed or found no name is asked again next time. */
export function nameCache(lookup: NameOf | undefined): NameOf {
  const names = new Map<string, Promise<string | null>>()
  return (ticket) => {
    if (!lookup) return Promise.resolve(null)
    let found = names.get(ticket)
    if (!found) {
      found = lookup(ticket).catch(() => null)
      names.set(ticket, found)
      void found.then((name) => {
        if (name === null) names.delete(ticket)
      })
    }
    return found
  }
}

/** the row writes its handles in capitals (as proto/'s names.js deals them: REDHERRING.07) */
export const rowName = (name: string): string => name.trim().toUpperCase()

/** a ticket nobody has named (yet): the start of its slot, as a code */
export const unnamedLabel = (slot: string): string => `#${slot.replace(/^0x/i, "").slice(0, 4).toUpperCase()}`

export interface RowLabels {
  /** the label of the ticket at `index` in `slots`: its holder's name once read, its code until then */
  labelOf(index: number): string
  /** the page is going: names that land after this are dropped */
  stop(): void
}

/**
 * Read every ticket's name, `first` (indices into `slots`: you and the
 * winners) ahead of the rest, NAME_READS_AT_ONCE at a time, and tell `onName`
 * each time one lands.
 */
export function rowLabels(slots: readonly string[], nameOf: NameOf, onName: () => void, first: readonly number[] = []): RowLabels {
  const known = new Map<number, string>()
  let live = true
  const order = [...new Set([...first, ...slots.keys()])].filter((index) => !!slots[index])
  let next = 0
  const pump = (): void => {
    if (!live || next >= order.length) return
    const index = order[next++]!
    void nameOf(slots[index]!)
      .catch(() => null)
      .then((name) => {
        if (live && name?.trim()) {
          known.set(index, rowName(name))
          onName()
        }
        pump()
      })
  }
  for (let i = 0; i < NAME_READS_AT_ONCE; i++) pump()
  return {
    labelOf: (index) => known.get(index) ?? unnamedLabel(slots[index] ?? ""),
    stop: () => {
      live = false
    },
  }
}

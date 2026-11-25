// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHO'S PLAYING, EVERY ONE OF THEM: a strip of every name in the draw, in the
 * order their tickets go round the wheel, in who's playing's own look (the
 * scene's `.slit-legend-item`, on its line: stage.css `#jollity-ticker`). One
 * name every `pitch` nominal px, centred in its slot, so a strip of a thousand
 * names needs no measuring; a name too long for its slot is cut short.
 *
 * Before the spin the stage runs it over the player's friends (the JOLLITY
 * friends edits under ./proto, friendsRow "ticker"): it
 * stops on you, then scrolls fast through everyone in between to each friend
 * in turn, so the strip shows how many play. The scene says where the strip
 * is and what each name looks like, every frame; this only draws it.
 *
 * Only the names on the stage are in the page, from a small pool of elements,
 * each written only when it changes. Framework-free (architecture rule 6).
 */

export interface TickerName {
  name: string
  /** a friend's colour (the row's own white, or yours, without one) */
  colour?: string | null
  you?: boolean
}

export interface TickerFrame {
  /** the strip's offset, nominal px: slot j spans [j·pitch + x, (j+1)·pitch + x) */
  x: number
  /** stage px per nominal px */
  scale: number
  /** the stage's width, nominal px */
  width: number
  /** how much of the strip shows (0: none, and nothing is written) */
  alpha: number
  /** how many names round the wheel: slot j is name j mod count */
  count: number
  /** the name in slot j (any j: it wraps) */
  nameAt: (j: number) => TickerName
  /** how much of the name in slot j shows, 0..1 */
  shownAt: (j: number) => number
}

export interface NameTicker {
  frame(frame: TickerFrame): void
  /** the name in slot j as drawn last frame: its left edge and width, nominal px on the stage (null: not on the stage) */
  boxAt(j: number): [number, number] | null
  readonly pitch: number
  destroy(): void
}

const mod = (j: number, n: number) => ((j % n) + n) % n

export function createNameTicker(app: HTMLElement, pitch = 96): NameTicker {
  const root = document.createElement("div")
  root.id = "jollity-ticker"
  root.setAttribute("aria-hidden", "true")
  const row = document.createElement("div")
  row.className = "slit-legend-row"
  root.append(row)
  app.append(root)
  root.style.setProperty("--pitch", String(pitch))

  interface Item {
    el: HTMLSpanElement
    j: number
    text: string
    colour: string
    you: boolean
    opacity: string
    x: string
  }
  const pool: Item[] = []
  let shown = false
  let scale = 1
  const take = (i: number): Item => {
    let item = pool[i]
    if (!item) {
      const el = document.createElement("span")
      el.className = "slit-legend-item"
      el.style.setProperty("--in", "1")
      row.append(el)
      item = { el, j: NaN, text: "", colour: "", you: false, opacity: "", x: "" }
      pool[i] = item
    }
    return item
  }

  return {
    pitch,
    frame(f) {
      const on = f.alpha > 0.002 && f.count > 0
      if (!on) {
        if (shown) {
          root.style.opacity = "0"
          shown = false
        }
        return
      }
      shown = true
      scale = f.scale
      root.style.opacity = f.alpha.toFixed(3)
      // the slots on the stage, and one either side
      const first = Math.floor(-f.x / pitch) - 1
      const last = Math.ceil((f.width - f.x) / pitch)
      let used = 0
      for (let j = first; j <= last; j++) {
        const item = take(used++)
        const who = f.nameAt(mod(j, f.count))
        item.j = j
        if (item.text !== who.name) {
          item.text = who.name
          item.el.textContent = who.name
        }
        const colour = who.colour ?? ""
        if (item.colour !== colour) {
          item.colour = colour
          item.el.style.color = colour
        }
        const you = !!who.you
        if (item.you !== you) {
          item.you = you
          item.el.classList.toggle("is-you", you)
        }
        const opacity = Math.max(0, Math.min(1, f.shownAt(j))).toFixed(2)
        if (item.opacity !== opacity) {
          item.opacity = opacity
          item.el.style.opacity = opacity
        }
        // the slot's middle: the name is centred on it (stage.css)
        const x = `${((j * pitch + pitch / 2 + f.x) * f.scale).toFixed(1)}px`
        if (item.x !== x) {
          item.x = x
          item.el.style.setProperty("--x", x)
        }
        if (item.el.hidden) item.el.hidden = false
      }
      for (let i = used; i < pool.length; i++) {
        const item = pool[i]!
        item.j = NaN
        if (!item.el.hidden) item.el.hidden = true
      }
    },
    boxAt(j) {
      const item = pool.find((it) => it.j === j)
      if (!item || item.el.hidden) return null
      const w = item.el.offsetWidth / scale
      const mid = parseFloat(item.x) / scale
      return [mid - w / 2, w]
    },
    destroy() {
      root.remove()
    },
  }
}

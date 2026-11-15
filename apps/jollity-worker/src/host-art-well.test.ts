// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { INTRO, artWellOf, introRuleNode, type HostTheme, type RenderNode } from "./card"
import { artWellFor } from "./host-art-well"
import type { WorkerHost } from "./host"

function backgrounds(node: RenderNode): string[] {
  if (node.tag === "String" || node.tag === "Nil") return []
  const own = node.value.modifiers.flatMap((modifier) => (modifier.tag === "background" ? [modifier.value.color] : []))
  return [...own, ...node.value.children.flatMap(backgrounds)]
}

function hostWithTheme() {
  const listeners: ((theme: HostTheme) => void)[] = []
  const subscribe = vi.fn((listener: (theme: HostTheme) => void) => {
    listeners.push(listener)
    return () => {}
  })
  const host = { theme: { subscribe } } as unknown as WorkerHost
  return { host, subscribe, say: (theme: HostTheme) => listeners.forEach((listener) => listener(theme)) }
}

describe("artWellOf", () => {
  it("keeps the nested surface on a dark theme and before the host names one", () => {
    expect(artWellOf({ name: "berlinNight", light: false })).toBe("bg.surface.nested")
    expect(artWellOf(null)).toBe("bg.surface.nested")
  })

  it("wells Berlin Day in the soft ink and the tinted light themes in their ink", () => {
    expect(artWellOf({ name: "berlinDay", light: true })).toBe("fg.secondary")
    expect(artWellOf({ name: "lisbon", light: true })).toBe("fg.primary")
    expect(artWellOf({ name: null, light: true })).toBe("fg.primary")
  })
})

describe("artWellFor", () => {
  it("redraws a card when the theme moves it to another well, and only then", () => {
    const { host, say } = hostWithTheme()
    const well = artWellFor(host)
    const redraw = vi.fn()
    const stop = well.onChange(redraw)

    expect(well.current()).toBe("bg.surface.nested")
    say({ name: "berlinNight", light: false })
    expect(redraw).not.toHaveBeenCalled()

    say({ name: "lisbon", light: true })
    expect(well.current()).toBe("fg.primary")
    expect(redraw).toHaveBeenCalledTimes(1)

    stop()
    say({ name: "berlinDay", light: true })
    expect(well.current()).toBe("fg.secondary")
    expect(redraw).toHaveBeenCalledTimes(1)
  })

  it("subscribes to the theme of a host once, however many cards ask", () => {
    const { host, subscribe } = hostWithTheme()
    expect(artWellFor(host)).toBe(artWellFor(host))
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it("stays on the nested surface for a host with no theme", () => {
    expect(artWellFor({} as unknown as WorkerHost).current()).toBe("bg.surface.nested")
  })
})

describe("the picture of a card", () => {
  it("sits on the well it is given", () => {
    const rule = INTRO.find((candidate) => candidate.image)!
    const node = introRuleNode({ text: rule.text, image: rule.image! }, "fg.secondary")
    expect(backgrounds(node)).toContain("fg.secondary")
    expect(backgrounds(node)).not.toContain("bg.surface.nested")
  })
})

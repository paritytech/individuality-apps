// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Tests `toWire` and the payload codec, which are both pure.
 *
 * The cards are written in the dotted vocabulary of src/card, and a
 * wrong mapping onto the PascalCase shape of truapi would hide here until a
 * card rendered wrong on a phone.
 */
import { RendererNode as RendererNodeCodec, type RendererNode } from "@parity/truapi"
import { describe, expect, it } from "vitest"
import { background, border, box, button, card, column, image, pad, row, slideToConfirm, spacer, text, type RenderNode } from "./card"
import { decPayload, drawsSlideToConfirm, encPayload, SLIDE_TO_CONFIRM_SINCE, toWire, type GameCardData, type WelcomeData } from "./renderer"

type WireButton = { value: { props: { variant?: string } } }

describe("payload codec works", () => {
  it("round-trips a GameCardData payload through bytes", () => {
    // Given
    const data: GameCardData = { gamePlayTime: 1_700_000_000 }

    // When
    const bytes = encPayload(data)
    const decoded = decPayload<GameCardData>(bytes)

    // Then
    expect(decoded).toEqual(data)
  })

  it("round-trips a WelcomeData payload through bytes", () => {
    const data: WelcomeData = { v: 1 }
    expect(decPayload<WelcomeData>(encPayload(data))).toEqual(data)
  })

  it("encodes one byte per character, ASCII JSON with no UTF-8 sequences", () => {
    // Given
    const payload = { gameKey: "abc" }
    const json = JSON.stringify(payload)

    // When
    const bytes = encPayload(payload)

    // Then
    expect(bytes.length).toBe(json.length)
  })
})

describe("toWire works", () => {
  it("maps the color and typography tokens of a Text, and wraps its String", () => {
    // Given
    const node = text("hi", { style: "body.small.regular", color: "fg.warning" })

    // When
    const wire = toWire(node)

    // Then
    expect(wire).toEqual({
      tag: "Text",
      value: {
        modifiers: [],
        props: { style: "BodySmallRegular", color: "FgWarning" },
        children: [{ tag: "String", value: { text: "hi" } }],
      },
    })
  })

  it("maps a Box to the Box of truapi with its alignment, keeping its children in order", () => {
    // Given
    const node = box([text("under"), text("over")], [pad(4)], "centerStart")

    // When
    const wire = toWire(node) as { tag: string; value: { props: unknown; children: { tag: string }[] } }

    // Then
    expect(wire.tag).toBe("Box")
    expect(wire.value.props).toEqual({ contentAlignment: "CenterStart" })
    expect(wire.value.children.map((child) => child.tag)).toEqual(["Text", "Text"])
  })

  it("names an archive Image by its path, and maps its fit", () => {
    // Given
    const node = image("chat-intro/no-bots.png", [{ tag: "height", value: 212 }], "cover")

    // When
    const wire = toWire(node)

    // Then
    expect(wire).toEqual({
      tag: "Image",
      value: {
        modifiers: [{ tag: "Height", value: 212 }],
        props: { source: { tag: "Archive", value: "chat-intro/no-bots.png" }, fit: "Cover" },
      },
    })
  })

  it("keeps a Spacer to its modifiers", () => {
    // Given
    const node = spacer(6)

    // When
    const wire = toWire(node)

    // Then
    expect(wire).toEqual({ tag: "Spacer", value: { modifiers: [{ tag: "Height", value: 6 }] } })
  })

  it("sends a secondary button as Primary, since iOS draws Secondary white on white", () => {
    // Given
    const primary = button("Register", "jollity.register", "primary")
    const secondary = button("Register", "jollity.register", "secondary")
    const textButton = button("Register", "jollity.register", "text")

    // When
    const primaryWire = toWire(primary) as WireButton
    const secondaryWire = toWire(secondary) as WireButton
    const textWire = toWire(textButton) as WireButton

    // Then
    expect(primaryWire.value.props.variant).toBe("Primary")
    expect(secondaryWire.value.props.variant).toBe("Primary")
    expect(textWire.value.props.variant).toBe("Text")
  })

  it("carries the properties of a button and gives it no children", () => {
    // Given
    const node = button("Register", "jollity.register", "primary", { loading: true, enabled: false })

    // When
    const wire = toWire(node)

    // Then
    expect(wire).toEqual({
      tag: "Button",
      value: {
        modifiers: [{ tag: "FillWidth", value: true }],
        props: { text: "Register", variant: "Primary", enabled: false, loading: true, clickAction: "jollity.register" },
        children: [],
      },
    })
  })

  it("turns the padding tuple into the Dimensions struct, and the shapes into truapi shapes", () => {
    // Given
    const node: RenderNode = column([], [
      pad(20),
      background("bg.surface.container", 16),
      border(2, "fg.tertiary", 16),
      { tag: "background", value: { color: "fg.success", shape: { tag: "Circle", value: undefined } } },
    ])

    // When
    const wire = toWire(node) as { value: { modifiers: unknown[] } }

    // Then
    expect(wire.value.modifiers).toEqual([
      { tag: "Padding", value: { top: 20, end: 20, bottom: 20, start: 20 } },
      { tag: "Background", value: { color: "BgSurfaceContainer", shape: { tag: "Rounded", value: 16 } } },
      { tag: "Border", value: { width: 2, color: "FgTertiary", shape: { tag: "Rounded", value: 16 } } },
      { tag: "Background", value: { color: "FgSuccess", shape: { tag: "Circle" } } },
    ])
  })

  it("maps the arrangement and alignment of rows and columns", () => {
    // Given
    const emptyRow = row([])
    const emptyColumn = column([])

    // When
    const rowWire = toWire(emptyRow)
    const columnWire = toWire(emptyColumn)

    // Then
    expect(rowWire).toMatchObject({ value: { props: { horizontalArrangement: "SpaceBetween" } } })
    expect(columnWire).toMatchObject({ value: { props: { horizontalAlignment: "Center" } } })
  })

  it("maps a whole card, children included", () => {
    // Given
    const node = card([text("x")], true)

    // When
    const wire = toWire(node) as { tag: string; value: { children: { tag: string }[] } }

    // Then
    expect(wire.tag).toBe("Column")
    expect(wire.value.children.map((child) => child.tag)).toEqual(["Text"])
  })
})

describe("the slide to confirm goes out only where a host draws it", () => {
  it("maps a slide onto the SlideToConfirm of the renderer protocol, with no children", () => {
    // Given
    const node = slideToConfirm("Slide to register", "register", {
      secondaryText: "Oct 7 at 4:00 PM",
      confirmedText: "Registered",
      variant: "reveal",
      accent: "fg.warning",
    })

    // When
    const wire = toWire(node) as unknown

    // Then
    expect(wire).toEqual({
      tag: "SlideToConfirm",
      value: {
        modifiers: [{ tag: "FillWidth", value: true }],
        props: {
          text: "Slide to register",
          secondaryText: "Oct 7 at 4:00 PM",
          confirmedText: "Registered",
          variant: "Reveal",
          accent: "FgWarning",
          enabled: true,
          loading: false,
          confirmed: false,
          confirmAction: "register",
        },
      },
    })
  })

  // The truapi this worker is built with predates the node, and no release
  // carries it yet, so today every host gets the Register button.
  it("lists no host yet, so every host gets the Register button", () => {
    expect(SLIDE_TO_CONFIRM_SINCE).toEqual({})
    expect(drawsSlideToConfirm({ name: "Polkadot", version: "2.0.0", platform: "Android", truapiVersion: "9.0.0" })).toBe(false)
  })

  it("admits a host on a listed platform whose truapi carries the node, and only while the worker can write it", () => {
    // Given
    const since = { Android: "0.32.0" }
    const writes = () => true
    const android = (truapiVersion: string) => ({ name: "Polkadot", version: "2.0.0", platform: "Android", truapiVersion })

    // When / Then
    expect(drawsSlideToConfirm(android("0.32.0"), since, writes)).toBe(true)
    expect(drawsSlideToConfirm(android("0.33.1"), since, writes)).toBe(true)
    expect(drawsSlideToConfirm(android("1.0.0"), since, writes)).toBe(true)
    expect(drawsSlideToConfirm(android("0.32.1-rc.1"), since, writes)).toBe(true)
    expect(drawsSlideToConfirm(android("0.32.0"), since, () => false)).toBe(false)
  })

  it("falls back to the button for an older, unknown or other host", () => {
    // Given
    const since = { Android: "0.32.0" }
    const writes = () => true

    // When / Then
    expect(drawsSlideToConfirm(null, since, writes)).toBe(false)
    expect(drawsSlideToConfirm({ name: "", version: "older than truapi 0.27" }, since, writes)).toBe(false)
    expect(drawsSlideToConfirm({ name: "Polkadot", version: "2.0.0", platform: "Android", truapiVersion: "0.31.9" }, since, writes)).toBe(false)
    expect(drawsSlideToConfirm({ name: "Polkadot", version: "2.0.0", platform: "Android", truapiVersion: "" }, since, writes)).toBe(false)
    expect(drawsSlideToConfirm({ name: "Polkadot", version: "2.0.0", platform: "Android", truapiVersion: "next" }, since, writes)).toBe(false)
    // A prerelease of the first release may predate the node.
    expect(drawsSlideToConfirm({ name: "Polkadot", version: "2.0.0", platform: "Android", truapiVersion: "0.32.0-rc.1" }, since, writes)).toBe(false)
    expect(drawsSlideToConfirm({ name: "Polkadot", version: "2.0.0", platform: "Ios", truapiVersion: "0.40.0" }, since, writes)).toBe(false)
    expect(drawsSlideToConfirm({ name: "Polkadot", version: "2.0.0", platform: "toString", truapiVersion: "0.40.0" }, since, writes)).toBe(false)
  })

  // The worker's own codec is the last guard: a node it cannot write would
  // fail the whole card, not just the slide. truapi 0.27.0 cannot; a truapi
  // that carries the node writes it as renderer variant 12.
  it("admits the slide only where the truapi codec the worker is built with writes the node", () => {
    // Given
    const probe = { tag: "SlideToConfirm", value: { modifiers: [], props: { text: "" } } }
    let writes: boolean
    try {
      writes = RendererNodeCodec.enc(probe as unknown as RendererNode)[0] === 12
    } catch {
      writes = false
    }

    // When
    const admitted = drawsSlideToConfirm({ name: "Polkadot", version: "2.0.0", platform: "Android", truapiVersion: "0.32.0" }, { Android: "0.32.0" })

    // Then
    expect(admitted).toBe(writes)
  })
})

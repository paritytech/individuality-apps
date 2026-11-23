// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The wire end of the cards: the node tree of src/card turned into the
 * `RendererNode` of truapi, and the codec of the Custom message payload.
 *
 * The cards are built in the vocabulary of `render-node.ts` in
 * src/card. That vocabulary is dotted and
 * lowercase, the shape of the older `@novasamatech` host stack, and `toWire` maps it onto
 * the PascalCase tags and props of truapi. Both chat runtimes of the iOS app
 * take the truapi shape, since the native one is reached through the adapter
 * of product-sdk-host.
 *
 * The payload is opaque bytes that only this worker writes and reads, so it
 * stays a small ASCII-JSON codec rather than SCALE.
 */
import { RendererNode as RendererNodeCodec } from "@parity/truapi"
import type {
  Arrangement as WireArrangement,
  ButtonVariant as WireButtonVariant,
  ColorToken as WireColorToken,
  ContentAlignment as WireContentAlignment,
  HorizontalAlignment as WireHorizontal,
  ImageFit as WireImageFit,
  Modifier as WireModifier,
  RendererNode,
  Shape as WireShape,
  TypographyStyle as WireTypography,
  VerticalAlignment as WireVertical,
} from "@parity/truapi"
import type {
  Arrangement,
  ButtonVariant,
  ColorToken,
  ContentAlignment,
  HorizontalAlignment,
  ImageFit,
  Modifier,
  RenderNode,
  Shape,
  SliderProps,
  Typography,
  VerticalAlignment,
} from "./card"
import type { WorkerHostInfo } from "./host"

const COLOR: Record<ColorToken, WireColorToken> = {
  "fg.primary": "FgPrimary",
  "fg.secondary": "FgSecondary",
  "fg.tertiary": "FgTertiary",
  "bg.surface.main": "BgSurfaceMain",
  "bg.surface.container": "BgSurfaceContainer",
  "bg.surface.nested": "BgSurfaceNested",
  "fg.success": "FgSuccess",
  "fg.error": "FgError",
  "fg.warning": "FgWarning",
}

const TYPOGRAPHY: Record<Typography, WireTypography> = {
  "headline.large": "HeadlineLarge",
  "title.medium.regular": "TitleMediumRegular",
  "body.large.regular": "BodyLargeRegular",
  "body.medium.regular": "BodyMediumRegular",
  "body.small.regular": "BodySmallRegular",
}

// iOS draws a Secondary button white on white on a card surface, which made
// How it works invisible on a device. Every button goes out Primary until
// that changes, and the variant stays in the tree.
const VARIANT: Record<ButtonVariant, WireButtonVariant> = {
  primary: "Primary",
  secondary: "Primary",
  text: "Text",
}

const HORIZONTAL: Record<HorizontalAlignment, WireHorizontal> = { start: "Start", center: "Center", end: "End" }
const CONTENT: Record<ContentAlignment, WireContentAlignment> = {
  center: "Center",
  centerStart: "CenterStart",
  centerEnd: "CenterEnd",
}
const VERTICAL: Record<VerticalAlignment, WireVertical> = { top: "Top", center: "Center", bottom: "Bottom" }
const ARRANGEMENT: Record<Arrangement, WireArrangement> = {
  start: "Start",
  end: "End",
  center: "Center",
  spaceBetween: "SpaceBetween",
  spaceAround: "SpaceAround",
  spaceEvenly: "SpaceEvenly",
}

const FIT: Record<ImageFit, WireImageFit> = {
  none: "None",
  fill: "Fill",
  cover: "Cover",
  contain: "Contain",
  scaleDown: "ScaleDown",
}

function shape(value: Shape | undefined): WireShape | undefined {
  if (!value) return undefined
  return value.tag === "Circle" ? { tag: "Circle" } : { tag: "Rounded", value: value.value }
}

function toWireModifier(modifier: Modifier): WireModifier {
  switch (modifier.tag) {
    case "width":
      return { tag: "Width", value: modifier.value }
    case "height":
      return { tag: "Height", value: modifier.value }
    case "fillWidth":
      return { tag: "FillWidth", value: modifier.value }
    case "padding": {
      const [top, end, bottom, start] = modifier.value
      return { tag: "Padding", value: { top, end, bottom, start } }
    }
    case "background":
      return { tag: "Background", value: { color: COLOR[modifier.value.color], shape: shape(modifier.value.shape) } }
    case "border":
      return {
        tag: "Border",
        value: { width: modifier.value.width, color: COLOR[modifier.value.color], shape: shape(modifier.value.shape) },
      }
  }
}

/**
 * "1.2.3" against "1.2.0", by number, and `undefined` for anything that is not
 * three whole numbers. A prerelease ("0.32.0-rc.1") is below its release, since
 * it may predate what the release carries.
 */
function atLeast(version: string, since: string): boolean | undefined {
  const parse = (value: string) => {
    const parts = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
    return parts ? { core: [Number(parts[1]), Number(parts[2]), Number(parts[3])], pre: parts[4] !== undefined } : undefined
  }
  const have = parse(version)
  const need = parse(since)
  if (!have || !need) return undefined
  for (let i = 0; i < 3; i++) if (have.core[i] !== need.core[i]) return have.core[i]! > need.core[i]!
  return !have.pre || need.pre
}

/**
 * Whether the host carries a node: only where the codec of the worker writes
 * it, the host says which platform and truapi it runs, and that truapi carries
 * the node on a platform listed in `since`. Anything unknown is no, since a
 * host that cannot decode a node shows no card at all.
 */
function hostCarries(
  info: WorkerHostInfo | null,
  since: Readonly<Partial<Record<string, string>>>,
  writes: () => boolean,
): boolean {
  if (!info?.platform || !info.truapiVersion) return false
  const first = Object.hasOwn(since, info.platform) ? since[info.platform] : undefined
  if (!first || atLeast(info.truapiVersion, first) !== true) return false
  return writes()
}

/**
 * The hosts that draw the generic Gesture node, by the platform they report,
 * each with the first truapi release whose runtime carries it with the
 * styling the worker slider uses (font, fill, shadow, shimmer, fade with the
 * pan, spin and the gesture's feel). No truapi release carries them yet, so
 * no host is listed and every host keeps the Register button.
 */
export const GESTURE_SINCE: Readonly<Partial<Record<string, string>>> = {}

let gestureEncodes: boolean | undefined

/** Whether the truapi codec this worker is built with can write a Gesture node at all. */
function codecWritesGesture(): boolean {
  if (gestureEncodes === undefined) {
    const probe = {
      tag: "Gesture",
      value: { modifiers: [], props: { pan: { axis: "Horizontal", startAction: "", endAction: "" } }, children: [] },
    }
    try {
      RendererNodeCodec.enc(probe as unknown as RendererNode)
      gestureEncodes = true
    } catch {
      gestureEncodes = false
    }
  }
  return gestureEncodes
}

/**
 * Whether this host draws the worker's own slider on its Gesture node: only
 * where the worker's codec writes the node and the host's platform and truapi
 * are listed in `since`.
 */
export function drawsGestureSlider(
  info: WorkerHostInfo | null,
  since: Readonly<Partial<Record<string, string>>> = GESTURE_SINCE,
  writes: () => boolean = codecWritesGesture,
): boolean {
  return hostCarries(info, since, writes)
}

/** Draws a `Slider` of the card vocabulary on the host's own nodes, inside its frame's modifiers. */
export type DrawSlider = (props: SliderProps, frame: WireModifier[]) => RendererNode

/** A card in the vocabulary of src/card, as the host takes it. */
export function toWire(node: RenderNode, drawSlider?: DrawSlider): RendererNode {
  const child = (node: RenderNode) => toWire(node, drawSlider)
  switch (node.tag) {
    case "Nil":
      return { tag: "Nil" }
    case "String":
      return { tag: "String", value: { text: node.value } }
    case "Spacer":
      return { tag: "Spacer", value: { modifiers: node.value.modifiers.map(toWireModifier) } }
    case "Column": {
      const { horizontalAlignment, verticalArrangement } = node.value.props
      return {
        tag: "Column",
        value: {
          modifiers: node.value.modifiers.map(toWireModifier),
          props: {
            horizontalAlignment: horizontalAlignment && HORIZONTAL[horizontalAlignment],
            verticalArrangement: verticalArrangement && ARRANGEMENT[verticalArrangement],
          },
          children: node.value.children.map(child),
        },
      }
    }
    case "Row": {
      const { verticalAlignment, horizontalArrangement } = node.value.props
      return {
        tag: "Row",
        value: {
          modifiers: node.value.modifiers.map(toWireModifier),
          props: {
            verticalAlignment: verticalAlignment && VERTICAL[verticalAlignment],
            horizontalArrangement: horizontalArrangement && ARRANGEMENT[horizontalArrangement],
          },
          children: node.value.children.map(child),
        },
      }
    }
    case "Box":
      return {
        tag: "Box",
        value: {
          modifiers: node.value.modifiers.map(toWireModifier),
          props: { contentAlignment: node.value.props.contentAlignment && CONTENT[node.value.props.contentAlignment] },
          children: node.value.children.map(child),
        },
      }
    case "Text": {
      const { style, color } = node.value.props
      return {
        tag: "Text",
        value: {
          modifiers: node.value.modifiers.map(toWireModifier),
          props: { style: style && TYPOGRAPHY[style], color: color && COLOR[color] },
          children: node.value.children.map(child),
        },
      }
    }
    case "Button": {
      const { text, variant, enabled, loading, clickAction } = node.value.props
      return {
        tag: "Button",
        value: {
          modifiers: node.value.modifiers.map(toWireModifier),
          props: { text, variant: variant && VARIANT[variant], enabled, loading, clickAction },
          children: [],
        },
      }
    }
    case "Slider":
      // A card holds one only for a host `drawsGestureSlider` admits, drawn with that host's nodes.
      if (!drawSlider) throw new Error("a Slider is drawn only with the host's Gesture node")
      return drawSlider(node.value.props, node.value.modifiers.map(toWireModifier))
    case "Image": {
      const { source, fit } = node.value.props
      return {
        tag: "Image",
        value: {
          modifiers: node.value.modifiers.map(toWireModifier),
          props: {
            source: source.tag === "archive" ? { tag: "Archive", value: source.value } : { tag: "Bulletin", value: source.value },
            fit: fit && FIT[fit],
          },
        },
      }
    }
  }
}

/**
 * The game a card belongs to, by its play time in Unix seconds of the chain.
 *
 * The play time names a game before the chain gives it an index, since the
 * schedule admits one game per time. Cards posted before the worker read the
 * chain carry `{ state, deadlineSec, gameKey }` instead and render as ended.
 */
export type GameCardData = { gamePlayTime: number }
export type WelcomeData = { v: number }

/**
 * A rule of the intro with a picture, by the archive path of its picture.
 *
 * The path stays with its rule when INTRO is reordered, where a position would
 * draw an already posted message as another rule.
 */
export type IntroData = { image: string }

export function encPayload(obj: unknown): Uint8Array {
  const s = JSON.stringify(obj)
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff
  return bytes
}

export function decPayload<T>(bytes: Uint8Array): T {
  let s = ""
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return JSON.parse(s) as T
}

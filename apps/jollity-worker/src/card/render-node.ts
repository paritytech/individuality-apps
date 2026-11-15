// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The node tree a custom chat message is drawn from, and the builders the
 * worker writes it with.
 *
 * The host renders a custom bubble from this tree with a fixed palette of nine
 * color tokens and five typography styles, with no raw hex, no gradients and
 * no icons. An image names a file and never carries a URL, and the host fetches
 * it. Whatever a card needs to say, it says with these.
 *
 * The worker builds trees and hands them to the host, and `toWire` in
 * apps/jollity-worker/src/renderer.ts maps them onto the shape of truapi.
 *
 * The shape is the `CustomRendererNode` of @novasamatech/host-api 0.9, dotted
 * and lowercase, where a `String` node is `{ tag: "String", value: string }`.
 * The truapi codec spells it `{ tag: "String", value: { text } }` in
 * PascalCase, and `toWire` converts one into the other.
 */

export type ColorToken =
  | "fg.primary"
  | "fg.secondary"
  | "fg.tertiary"
  | "bg.surface.main"
  | "bg.surface.container"
  | "bg.surface.nested"
  | "fg.success"
  | "fg.error"
  | "fg.warning"

export type Typography =
  | "headline.large"
  | "title.medium.regular"
  | "body.large.regular"
  | "body.medium.regular"
  | "body.small.regular"

export type Shape = { tag: "Rounded"; value: number } | { tag: "Circle"; value: undefined }

/** A padding is top, end, bottom and start, where a missing bottom or start mirrors top or end, as the host reads it. */
export type Modifier =
  | { tag: "width"; value: number }
  | { tag: "height"; value: number }
  | { tag: "fillWidth"; value: boolean }
  | { tag: "padding"; value: [number, number, number | undefined, number | undefined] }
  | { tag: "background"; value: { color: ColorToken; shape: Shape | undefined } }
  | { tag: "border"; value: { width: number; color: ColorToken; shape: Shape | undefined } }

export type HorizontalAlignment = "start" | "center" | "end"
export type VerticalAlignment = "top" | "center" | "bottom"
export type ContentAlignment = "center" | "centerStart" | "centerEnd"
export type Arrangement = "start" | "end" | "center" | "spaceBetween" | "spaceAround" | "spaceEvenly"
export type ButtonVariant = "primary" | "secondary" | "text"
/** A thumb that travels along a track, or a face the slide peels away. */
export type SlideVariant = "thumb" | "reveal"
export type ImageFit = "none" | "fill" | "cover" | "contain" | "scaleDown"

/**
 * Where the host reads the bytes of an image.
 *
 * An `archive` path is relative to the root of the worker archive, which is
 * apps/jollity-worker/dist. A `bulletin` value is the CID of a Bulletin blob.
 */
export type ImageSource = { tag: "archive"; value: string } | { tag: "bulletin"; value: string }

export type RenderNode =
  /** Draws nothing, for a message that must stay posted with nothing to show. */
  | { tag: "Nil"; value: undefined }
  | { tag: "String"; value: string }
  | { tag: "Spacer"; value: { modifiers: Modifier[]; props: undefined; children: RenderNode[] } }
  | {
      tag: "Column"
      value: {
        modifiers: Modifier[]
        props: { horizontalAlignment: HorizontalAlignment | undefined; verticalArrangement: Arrangement | undefined }
        children: RenderNode[]
      }
    }
  | {
      tag: "Row"
      value: {
        modifiers: Modifier[]
        props: { verticalAlignment: VerticalAlignment | undefined; horizontalArrangement: Arrangement | undefined }
        children: RenderNode[]
      }
    }
  /** Children drawn over each other, the last on top. */
  | {
      tag: "Box"
      value: {
        modifiers: Modifier[]
        props: { contentAlignment: ContentAlignment | undefined }
        children: RenderNode[]
      }
    }
  | {
      tag: "Text"
      value: {
        modifiers: Modifier[]
        props: { style: Typography | undefined; color: ColorToken | undefined }
        children: RenderNode[]
      }
    }
  | {
      tag: "Button"
      value: {
        modifiers: Modifier[]
        props: {
          text: string
          variant: ButtonVariant | undefined
          enabled: boolean
          loading: boolean
          clickAction: string | undefined
        }
        children: RenderNode[]
      }
    }
  | {
      tag: "Image"
      value: { modifiers: Modifier[]; props: { source: ImageSource; fit: ImageFit | undefined }; children: RenderNode[] }
    }
  /**
   * A control the player slides to confirm, which the host draws and drags
   * itself and reports as one action when the slide completes, like a press
   * of a Button. A host that predates it cannot decode a tree that holds one,
   * so the worker sends one only to a host it knows draws it (`toWire`).
   */
  | {
      tag: "SlideToConfirm"
      value: {
        modifiers: Modifier[]
        props: {
          text: string
          secondaryText: string | undefined
          /** What the control reads once slid. Absent keeps `text`. */
          confirmedText: string | undefined
          variant: SlideVariant | undefined
          accent: ColorToken | undefined
          enabled: boolean
          loading: boolean
          /** Drawn as already slid, taking no slide. */
          confirmed: boolean
          confirmAction: string | undefined
        }
        children: RenderNode[]
      }
    }

export const pad = (value: number): Modifier => ({ tag: "padding", value: [value, value, value, value] })
export const width = (value: number): Modifier => ({ tag: "width", value })
export const height = (value: number): Modifier => ({ tag: "height", value })
export const background = (color: ColorToken, radius = 16): Modifier => ({
  tag: "background",
  value: { color, shape: { tag: "Rounded", value: radius } },
})
export const border = (width: number, color: ColorToken, radius = 16): Modifier => ({
  tag: "border",
  value: { width, color, shape: { tag: "Rounded", value: radius } },
})
export const fill: Modifier = { tag: "fillWidth", value: true }

/**
 * Renders nothing.
 *
 * A posted message cannot be removed, so a card that must go quiet for a while
 * renders this and comes back on its next render. Whether a host draws chrome
 * around it is still open on a device.
 */
export function nil(): RenderNode {
  return { tag: "Nil", value: undefined }
}

export function text(value: string, options: { style?: Typography; color?: ColorToken } = {}): RenderNode {
  return {
    tag: "Text",
    value: {
      modifiers: [],
      props: { style: options.style ?? "body.medium.regular", color: options.color ?? "fg.primary" },
      children: [{ tag: "String", value }],
    },
  }
}

export function spacer(size: number): RenderNode {
  return {
    tag: "Spacer",
    value: { modifiers: [{ tag: "height", value: size }], props: undefined, children: [] },
  }
}

/** A horizontal gap inside a row, since the host lays rows out with no gap of its own. */
export function horizontalSpacer(size: number): RenderNode {
  return {
    tag: "Spacer",
    value: { modifiers: [{ tag: "width", value: size }], props: undefined, children: [] },
  }
}

/** A gap in a row that takes the width left over, the only child Android gives that width to. */
export function flexibleSpacer(): RenderNode {
  return { tag: "Spacer", value: { modifiers: [], props: undefined, children: [] } }
}

export function column(
  children: RenderNode[],
  modifiers: Modifier[] = [],
  align: { horizontalAlignment?: HorizontalAlignment; verticalArrangement?: Arrangement } = {},
): RenderNode {
  return {
    tag: "Column",
    value: {
      modifiers,
      props: {
        horizontalAlignment: align.horizontalAlignment ?? "center",
        verticalArrangement: align.verticalArrangement ?? "center",
      },
      children,
    },
  }
}

export function box(children: RenderNode[], modifiers: Modifier[] = [], contentAlignment: ContentAlignment = "center"): RenderNode {
  return { tag: "Box", value: { modifiers, props: { contentAlignment }, children } }
}

/** A row, full width unless given modifiers, whose default spaceBetween pushes a name and its rarity apart. */
export function row(
  children: RenderNode[],
  horizontalArrangement: Arrangement = "spaceBetween",
  modifiers: Modifier[] = [fill],
): RenderNode {
  return {
    tag: "Row",
    value: { modifiers, props: { verticalAlignment: "center", horizontalArrangement }, children },
  }
}

/** A bordered surface inside a card, such as a collectable tile or the ticket block. */
export function panel(children: RenderNode[]): RenderNode {
  return column(children, [fill, pad(12), background("bg.surface.nested", 10), border(1, "fg.tertiary", 10)])
}

export function button(
  label: string,
  clickAction: string,
  variant: ButtonVariant = "primary",
  /** `loading` shows the spinner of the host, and `enabled: false` greys the button out. */
  state: { enabled?: boolean; loading?: boolean } = {},
): RenderNode {
  const { enabled = true, loading = false } = state
  return {
    tag: "Button",
    value: {
      modifiers: [fill],
      props: { text: label, variant, enabled, loading, clickAction },
      children: [],
    },
  }
}

/** A slide to confirm across its space, which takes no slide while it loads or once confirmed. */
export function slideToConfirm(
  label: string,
  confirmAction: string,
  options: {
    secondaryText?: string
    confirmedText?: string
    variant?: SlideVariant
    accent?: ColorToken
    enabled?: boolean
    loading?: boolean
    confirmed?: boolean
  } = {},
): RenderNode {
  const { enabled = true, loading = false, confirmed = false } = options
  return {
    tag: "SlideToConfirm",
    value: {
      modifiers: [fill],
      props: {
        text: label,
        secondaryText: options.secondaryText,
        confirmedText: options.confirmedText,
        variant: options.variant,
        accent: options.accent,
        enabled,
        loading,
        confirmed,
        // A control that takes no slide names no action, as the prototype host expects.
        confirmAction: enabled && !loading && !confirmed ? confirmAction : undefined,
      },
      children: [],
    },
  }
}

/** A finished CTA drawn by the worker: iOS draws a disabled Primary button white, so this grey pill stands in for it. */
export function doneButton(label: string): RenderNode {
  return column([text(label, { style: "title.medium.regular", color: "fg.secondary" })], [fill, pad(12), background("bg.surface.nested", 24)], {
    horizontalAlignment: "center",
  })
}

/** A file of the worker archive, which the host draws as empty space when it cannot read it. */
export function image(path: string, modifiers: Modifier[], fit: ImageFit = "contain"): RenderNode {
  return { tag: "Image", value: { modifiers, props: { source: { tag: "archive", value: path }, fit }, children: [] } }
}

/** A picture on Bulletin by its CID, which the host fetches and draws as empty space when it cannot. */
export function bulletinImage(cid: string, modifiers: Modifier[], fit: ImageFit = "contain"): RenderNode {
  return { tag: "Image", value: { modifiers, props: { source: { tag: "bulletin", value: cid }, fit }, children: [] } }
}

/** A padded, rounded surface with a border, gold when `accent` is set. */
export function card(children: RenderNode[], accent = false): RenderNode {
  return column(children, [
    fill,
    pad(20),
    background("bg.surface.container", 16),
    border(2, accent ? "fg.warning" : "fg.tertiary", 16),
  ])
}

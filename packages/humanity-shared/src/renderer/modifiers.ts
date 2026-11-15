// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// Vendored from @parity/product-sdk-renderer 0.4.0 (paritytech/product-sdk,
// packages/renderer/src/modifiers.ts at c5e0e57), builders unchanged, in-source
// tests left out. 0.5.0 dropped the builders for JSX authoring
// (@parity/product-sdk-react-renderer); this copy keeps the Pocket face and
// chat cards encoding exactly as before until they move to it.
import type {
    BlendingMode,
    ColorToken,
    Dimensions,
    ImageSource,
    Modifier,
    Shape,
    Size,
} from "@parity/truapi";

/**
 * Inner spacing. `padding(16)` is 16 on every edge; `padding(20, 24)` is 20
 * vertical and 24 horizontal.
 *
 * The protocol's `Dimensions` requires `top` and `end` and defaults `bottom` to
 * `top` and `start` to `end`, which is exactly a vertical/horizontal shorthand.
 * Naming it that way is what makes the missing-`end` error unreachable. Reach
 * for {@link paddingEach} when the four edges genuinely differ.
 */
export function padding(vertical: Size, horizontal: Size = vertical): Modifier {
    return { tag: "Padding", value: { top: vertical, end: horizontal } };
}

/** Inner spacing with every edge named. */
export function paddingEach(edges: Dimensions): Modifier {
    return { tag: "Padding", value: edges };
}

/** Outer spacing. Reads as {@link padding} does. */
export function margin(vertical: Size, horizontal: Size = vertical): Modifier {
    return { tag: "Margin", value: { top: vertical, end: horizontal } };
}

/** Outer spacing with every edge named. */
export function marginEach(edges: Dimensions): Modifier {
    return { tag: "Margin", value: edges };
}

/** A background fill. Omitting the shape leaves it to the host. */
export function background(color: ColorToken, shape?: Shape): Modifier {
    return { tag: "Background", value: shape === undefined ? { color } : { color, shape } };
}

/** A border. Omitting the shape leaves it to the host. */
export function border(width: Size, color: ColorToken, shape?: Shape): Modifier {
    return {
        tag: "Border",
        value: shape === undefined ? { width, color } : { width, color, shape },
    };
}

/** A fixed width. */
export function width(value: Size): Modifier {
    return { tag: "Width", value };
}

/** A fixed height. */
export function height(value: Size): Modifier {
    return { tag: "Height", value };
}

/** A minimum width. */
export function minWidth(value: Size): Modifier {
    return { tag: "MinWidth", value };
}

/** A minimum height. */
export function minHeight(value: Size): Modifier {
    return { tag: "MinHeight", value };
}

/** Fill the available width. */
export function fillWidth(value = true): Modifier {
    return { tag: "FillWidth", value };
}

/** Fill the available height. */
export function fillHeight(value = true): Modifier {
    return { tag: "FillHeight", value };
}

/** Opacity, where 0 is transparent and 255 opaque. */
export function opacity(value: number): Modifier {
    return { tag: "Opacity", value };
}

/** How the node composites against what is behind it. */
export function blendingMode(mode: BlendingMode): Modifier {
    return { tag: "BlendingMode", value: mode };
}

/** Rounded corners of the given radius. */
export function rounded(radius: Size): Shape {
    return { tag: "Rounded", value: radius };
}

/** A circle. */
export function circle(): Shape {
    return { tag: "Circle" };
}

/** Square corners. */
export function square(): Shape {
    return { tag: "Square" };
}

/** Image bytes from a Bulletin chain blob, addressed by CID. */
export function bulletin(cid: string): ImageSource {
    return { tag: "Bulletin", value: cid };
}

/** Image bytes from a path inside the product's executable archive. */
export function archive(path: string): ImageSource {
    return { tag: "Archive", value: path };
}

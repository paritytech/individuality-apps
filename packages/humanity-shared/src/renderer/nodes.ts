// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// Vendored from @parity/product-sdk-renderer 0.4.0 (paritytech/product-sdk,
// packages/renderer/src/nodes.ts at c5e0e57), builders unchanged, in-source
// tests left out. 0.5.0 dropped the builders for JSX authoring
// (@parity/product-sdk-react-renderer); this copy keeps the Pocket face and
// chat cards encoding exactly as before until they move to it.
import type {
    Arrangement,
    ButtonVariant,
    ColorToken,
    ContentAlignment,
    HorizontalAlignment,
    ImageFit,
    ImageSource,
    Modifier,
    RendererNode,
    Size,
    TypographyStyle,
    VerticalAlignment,
} from "@parity/truapi";

/** Options every node with modifiers accepts. */
export interface NodeOptions {
    modifiers?: Modifier[];
}

export interface TextOptions extends NodeOptions {
    style?: TypographyStyle;
    color?: ColorToken;
}

export interface ColumnOptions extends NodeOptions {
    horizontalAlignment?: HorizontalAlignment;
    verticalArrangement?: Arrangement;
}

export interface RowOptions extends NodeOptions {
    verticalAlignment?: VerticalAlignment;
    horizontalArrangement?: Arrangement;
}

export interface BoxOptions extends NodeOptions {
    contentAlignment?: ContentAlignment;
}

export interface SpacerOptions {
    width?: Size;
    height?: Size;
}

export interface ButtonOptions extends NodeOptions {
    variant?: ButtonVariant;
    enabled?: boolean;
    loading?: boolean;
    /** The id the host reports when the button is pressed. A button without one is inert. */
    clickAction?: string;
}

export interface TextFieldOptions extends NodeOptions {
    text: string;
    placeholder?: string;
    label?: string;
    enabled?: boolean;
    /** The id the host reports on every change, carrying the new value. */
    valueChangeAction?: string;
}

export interface ImageOptions extends NodeOptions {
    fit?: ImageFit;
}

/**
 * Drops keys whose value is `undefined`.
 *
 * An explicit `undefined` and an absent key are the same thing to the protocol
 * but not to `JSON.stringify`, and a face is compared and measured as JSON.
 */
function defined<T extends object>(props: T): T {
    return Object.fromEntries(
        Object.entries(props).filter(([, value]) => value !== undefined),
    ) as T;
}

/** Nothing. Draws no space. */
export function nil(): RendererNode {
    return { tag: "Nil" };
}

/** A raw string node. {@link text} is what you usually want. */
export function str(content: string): RendererNode {
    return { tag: "String", value: { text: content } };
}

/** A line of text, wrapped in the `String` child the protocol requires. */
export function text(content: string, options: TextOptions = {}): RendererNode {
    const { modifiers = [], ...props } = options;
    return { tag: "Text", value: { modifiers, props: defined(props), children: [str(content)] } };
}

/** Children stacked vertically. */
export function column(children: RendererNode[], options: ColumnOptions = {}): RendererNode {
    const { modifiers = [], ...props } = options;
    return { tag: "Column", value: { modifiers, props: defined(props), children } };
}

/** Children laid out horizontally. */
export function row(children: RendererNode[], options: RowOptions = {}): RendererNode {
    const { modifiers = [], ...props } = options;
    return { tag: "Row", value: { modifiers, props: defined(props), children } };
}

/** Children stacked on top of one another. With no children and a background, a filled rectangle. */
export function box(children: RendererNode[], options: BoxOptions = {}): RendererNode {
    const { modifiers = [], ...props } = options;
    return { tag: "Box", value: { modifiers, props: defined(props), children } };
}

/** Empty space of a fixed size. */
export function spacer(options: SpacerOptions): RendererNode {
    const modifiers: Modifier[] = [];
    if (options.width !== undefined) modifiers.push({ tag: "Width", value: options.width });
    if (options.height !== undefined) modifiers.push({ tag: "Height", value: options.height });
    return { tag: "Spacer", value: { modifiers } };
}

/** A pressable button. Give it a `clickAction` or it reports nothing. */
export function button(label: string, options: ButtonOptions = {}): RendererNode {
    const { modifiers = [], ...props } = options;
    return {
        tag: "Button",
        value: { modifiers, props: defined({ text: label, ...props }), children: [] },
    };
}

/** An editable field. Give it a `valueChangeAction` or it reports nothing. */
export function textField(options: TextFieldOptions): RendererNode {
    const { modifiers = [], ...props } = options;
    return { tag: "TextField", value: { modifiers, props: defined(props) } };
}

/** An image the host fetches. Build the source with `bulletin()` or `archive()`. */
export function image(source: ImageSource, options: ImageOptions = {}): RendererNode {
    const { modifiers = [], ...props } = options;
    return { tag: "Image", value: { modifiers, props: defined({ source, ...props }) } };
}


// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The renderer-tree builders `@parity/product-sdk/renderer` exported up to
 * 0.4.0, vendored in `nodes.ts` and `modifiers.ts`, beside the SDK's checker,
 * which it still ships.
 */
export * from "./nodes.ts";
export * from "./modifiers.ts";
export {
  KNOWN_HOST_LIMITS,
  androidLimits,
  assertFaceValid,
  validateFace,
} from "@parity/product-sdk/renderer";
export type {
  Arrangement,
  BlendingMode,
  ButtonVariant,
  ColorToken,
  ContentAlignment,
  Dimensions,
  Effect,
  HorizontalAlignment,
  ImageFit,
  ImageSource,
  Modifier,
  RendererNode,
  Shape,
  Size,
  TypographyStyle,
  VerticalAlignment,
} from "@parity/product-sdk/renderer";

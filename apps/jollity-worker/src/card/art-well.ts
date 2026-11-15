// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ColorToken } from "./render-node"

export type HostTheme = { name: string | null; light: boolean }

export const DARK_THEME_ART_WELL: ColorToken = "bg.surface.nested"

const BERLIN_DAY_THEME_ID = "berlinDay"
const SOFT_INK_FOR_WHITE_ROOM: ColorToken = "fg.secondary"
const INK_OF_LIGHT_THEME: ColorToken = "fg.primary"

export function artWellOf(theme: HostTheme | null): ColorToken {
  if (!theme?.light) return DARK_THEME_ART_WELL
  return theme.name === BERLIN_DAY_THEME_ID ? SOFT_INK_FOR_WHITE_ROOM : INK_OF_LIGHT_THEME
}

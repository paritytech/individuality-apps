// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { DARK_THEME_ART_WELL } from "./art-well"
import { background, column, fill, height, image, pad, text, type ColorToken, type RenderNode } from "./render-node"

// The height of the intro pictures, so these cards sit in the room as their peers.
const ART_HEIGHT = 212
const ART_PAD = 16

export function artCard(art: string | null, line: string, rest: RenderNode[] = [], well: ColorToken = DARK_THEME_ART_WELL): RenderNode {
  return column(
    [
      ...(art == null
        ? []
        : [
            column([image(art, [fill, height(ART_HEIGHT - 2 * ART_PAD)], "contain")], [
              fill,
              height(ART_HEIGHT),
              pad(ART_PAD),
              background(well, 16),
            ]),
          ]),
      column([text(line, { style: "body.large.regular", color: "fg.primary" }), ...rest], [fill, { tag: "padding", value: [8, 12, 12, 12] }], {
        horizontalAlignment: "start",
      }),
    ],
    [fill, background("bg.surface.container", 16)],
    { horizontalAlignment: "start", verticalArrangement: "spaceBetween" },
  )
}

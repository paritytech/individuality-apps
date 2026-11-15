// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { DARK_THEME_ART_WELL } from "./art-well"
import { background, column, fill, height, image, text, width, type ColorToken, type RenderNode } from "./render-node"

/** A picture of the worker archive, at the width the design gives it inside its panel. */
export type IntroImage = { path: string; width: number }

export type IntroRule = { text: string; image?: IntroImage }

/**
 * The eight rules the room opens with, one message each, in order.
 *
 * The first five are the welcome1 to welcome5 strings of the native Weekly
 * Game chat of the iOS app, in ASCII for the reason copy.ts gives; the next
 * two, on what Membership is and what it gets you, replace welcome6 and
 * welcome7 with a picture each. The host's `ProductBotMessage` takes only
 * text and custom messages from a product, so the
 * worker posts a rule as plain text, and a rule with an `image` as a custom
 * message drawn by `introRuleNode`. The pictures and their widths follow the
 * chat design, and the two Membership ones are drawn to the same shape. They live in public/chat-intro,
 * and apps/jollity-worker/scripts/build.mjs copies them into the worker archive at the same
 * path.
 */
export const INTRO: readonly IntroRule[] = [
  {
    text: "Win up to $2,600 a month by playing a free, fun and quick weekly game.",
    image: { path: "chat-intro/cash.png", width: 257 },
  },
  {
    text: "Once a week, you jump into a two minute game with five other people. Same time, everywhere in the world. The game is easy, copy gestures from other players and make your own.",
    image: { path: "chat-intro/world.png", width: 257 },
  },
  {
    text: "Why gestures? It's very difficult for bots to convincingly copy them live. Playing helps everyone know who the real humans are.",
    image: { path: "chat-intro/no-bots.png", width: 237 },
  },
  {
    text: "How to play in two simple steps:\n1. Copy the gesture",
    image: { path: "chat-intro/host-you.png", width: 237 },
  },
  { text: "2. Tap other players who also copy the gesture", image: { path: "chat-intro/tap.png", width: 257 } },
  // What Membership is, then what it gets you. No amounts: the prizes are
  // chain parameters and the copy would go stale with them.
  {
    text: "Pass the weekly game and you become a Polkadot Member: a person Polkadot knows is real, with your own card.",
    image: { path: "chat-intro/member.png", width: 323 },
  },
  {
    text: "Your Membership is your ticket to the weekly draw, the monthly jackpot and the daily dollar.",
    image: { path: "chat-intro/prizes.png", width: 323 },
  },
  {
    text: "Being a Member gets you the Daily Dollar. How it works:\n1. As a Member, you are in the daily draw.\n2. When a draw lands, your ticket shows up here.\n3. Scratch it to see if you won a dollar.",
    image: { path: "chat-intro/daily-dollar.png", width: 323 },
  },
]

// The design crops every picture to this height with cover, the wider ones too,
// so cash, world and tap lose a little at the top and bottom there as well.
const INTRO_IMAGE_HEIGHT = 212

/**
 * A rule under its picture, the media bubble of the design.
 *
 * The bubble is spaceBetween because that drops the stack spacing iOS puts
 * between the children of a column, and the design has none.
 */
export function introRuleNode(rule: Required<IntroRule>, well: ColorToken = DARK_THEME_ART_WELL): RenderNode {
  return column(
    [
      column(
        [image(rule.image.path, [width(rule.image.width), height(INTRO_IMAGE_HEIGHT)], "cover")],
        [fill, height(INTRO_IMAGE_HEIGHT), background(well, 16)],
        { horizontalAlignment: "center" },
      ),
      column(
        [text(rule.text, { style: "body.large.regular", color: "fg.primary" })],
        [fill, { tag: "padding", value: [8, 12, 10, 12] }],
        { horizontalAlignment: "start" },
      ),
    ],
    [fill, background("bg.surface.container", 16)],
    { horizontalAlignment: "start", verticalArrangement: "spaceBetween" },
  )
}

/**
 * The picture rule whose picture is at `path`, or null for any other value.
 *
 * A rule that later loses its picture can no longer be found and draws as Nil.
 * Carrying its text in the payload as well would let the two drift apart.
 */
export function introRuleByPicture(path: unknown): Required<IntroRule> | null {
  if (typeof path !== "string") return null
  const rule = INTRO.find((candidate) => candidate.image?.path === path)
  return rule?.image ? { text: rule.text, image: rule.image } : null
}

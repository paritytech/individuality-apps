// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { postGameHref } from "@/lib/post-game"

/**
 * Where the draw goes on to: the chest. The host goes there (draw-screen-deps
 * toChest), and the page's hold fetches it ahead (components/draw/hold-to-chest).
 */
export function chestHref(): string {
  return postGameHref("/chest")
}

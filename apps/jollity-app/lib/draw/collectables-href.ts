// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { postGameHref } from "@/lib/post-game"

/**
 * Where the draw goes on to: the collectables screen. The host goes there (draw-screen-deps
 * toCollectables), and the page's hold fetches it ahead (components/draw/hold-to-collectables).
 */
export function collectablesHref(): string {
  return postGameHref("/collectables")
}

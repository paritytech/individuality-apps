// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

import { devLog } from "../debug/log-store"
import { describeError } from "./error-detail"

/**
 * LEAVING — the one place that asks the host to open something else.
 *
 * The host owns navigation between products (`navigateTo`), and outside a
 * container there is only the browser. Callers pass a link and stay ignorant
 * of both: `humanity-target.ts` computes WHERE, this decides HOW to get there.
 */

/** A link the host resolves: a product's page, or a target the host itself
 *  serves, such as a Pocket card (`polkadotapp://pocket/open?product=<id>&card=<id>`).
 *  When `navigateTo` throws (the host refused or failed), this falls back to
 *  navigating the page itself, inside a container too; callers pass only links
 *  the app builds, never one from outside. */
export async function openLink(url: string): Promise<void> {
  try {
    const sdk = await import("@parity/product-sdk-host")
    if (sdk.isInsideContainerSync()) {
      await sdk.navigateTo(url)
      return
    }
  } catch (error) {
    devLog("navigate", `host navigateTo ${url} failed`, { detail: describeError(error) }, "warn")
  }
  if (typeof window !== "undefined") window.location.href = url
}

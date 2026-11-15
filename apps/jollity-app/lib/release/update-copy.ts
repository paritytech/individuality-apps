// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * HOW TO GET THE NEW BUILD, per platform. Nothing in the page loads it: a
 * reload, navigating to our own origin, truapi's navigateTo and a cache-busting
 * query all serve the CID the name was resolved to at launch. iOS re-resolves
 * the name when the product's tab is closed and reopened; Android keeps it for
 * the life of the process, so only a full restart helps. There is no button,
 * because a reload would do nothing.
 */
export type UpdatePlatform = "ios" | "android" | "other"

/** truApi system.info()'s platform string (lib/host/host-info.ts), loosely. */
export function updatePlatform(platform: string | undefined | null): UpdatePlatform {
  const text = (platform ?? "").toLowerCase()
  if (/ios|iphone|ipad/.test(text)) return "ios"
  if (text.includes("android")) return "android"
  return "other"
}

export function updateInstruction(platform: UpdatePlatform): string {
  switch (platform) {
    case "ios":
      return "Close Jollity with the × at the top and open it again."
    case "android":
      return "Close the Polkadot app completely and open it again."
    default:
      return "Restart the app to update."
  }
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Whether this page runs inside a host container. The one doorway for the
 * question, so modules outside lib/host never import product-sdk for it.
 * False when the SDK cannot load.
 */
export async function insideContainer(): Promise<boolean> {
  try {
    const sdk = await import("@parity/product-sdk-host")
    return sdk.isInsideContainerSync()
  } catch {
    return false
  }
}

/**
 * The synchronous guess, for code that cannot wait (telemetry's boot tags):
 * whether the host's bridge script has parked its MessagePort on the window
 * (app/layout.tsx). No SDK load. `insideContainer` is the answer to refine it
 * with.
 */
export function hostPortParked(): boolean {
  try {
    return typeof window !== "undefined" && window !== null && "__HOST_API_PORT__" in window
  } catch {
    return false
  }
}

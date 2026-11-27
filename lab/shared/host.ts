// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { HostNetworkRoutes } from "@parity/product-lab/domain";
import type { BrowserPage } from "@parity/product-lab/ports/browser";

export const opened = new Map<string, {
  page: BrowserPage;
  username: string;
  showCard(): Promise<void>;
  reload(): Promise<void>;
  heads(): Promise<unknown>;
}>();

export function requireLoopback(routes: HostNetworkRoutes): void {
  const endpoints = [
    ...Object.values(routes.chains).map((chain) => chain.ws),
    ...Object.values(routes.services),
  ];
  if (!endpoints.length) throw new Error("The opening needs local fork routes");
  for (const endpoint of endpoints) {
    const url = new URL(endpoint);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
        !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
      throw new Error("The opening refuses a non-loopback or credentialed route");
    }
  }
  for (const chain of ["people", "asset-hub", "bulletin"]) {
    if (!routes.chains[chain]) throw new Error(`Missing fork chain: ${chain}`);
  }
  if (!routes.services["identity-backend"]) throw new Error("Missing local identity backend");
}

/** Close every owned resource even when one fails; retain the original failure too. */
export async function cleanupAll(cleanups: Array<() => unknown | Promise<unknown>>, original?: unknown): Promise<void> {
  const errors: unknown[] = original === undefined ? [] : [original];
  for (const close of [...cleanups].reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Opening or cleanup failed", { cause: errors[0] });
}

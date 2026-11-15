// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The host's coinage purse balance (RFC-0006 `truApi.payment.*`), as the
 * debug panel shows it. The host pushes updates; there is no one-shot read,
 * so the answer is whatever the subscription last delivered. Module-level
 * like the other diagnostics, so the rendered panel and the copied JSON agree.
 */
import { getPaymentManager, type HostSubscription } from "./host-api.ts";

export type CoinageBalanceDiagnostics =
  | { status: "pending" }
  | { status: "unavailable" }
  | { status: "subscribed"; available: bigint | null; updatedAtMs: number | null }
  | { status: "interrupted"; available: bigint | null; reason: string }
  | { status: "error"; reason: string };

let diagnostics: CoinageBalanceDiagnostics | undefined;

export function getCoinageBalanceDiagnostics(): CoinageBalanceDiagnostics | undefined {
  return diagnostics;
}

/** A `SubscriptionError` carries the host's typed interrupt payload in
 *  `reason`; its `message` is the generic "Subscription interrupted", which
 *  says nothing. The payload nests: `Domain{ PermissionDenied }` or
 *  `Domain{ Unknown{ reason } }` — every layer is named so the panel shows
 *  the whole chain, `Domain` included, rather than one opaque tag. */
function describe(reason: unknown): string {
  if (reason == null) return "closed without a reason";
  if (typeof reason === "string") return reason;
  if (typeof reason !== "object") return String(reason);
  if (reason instanceof Error) {
    return "reason" in reason && reason.reason != null ? describe(reason.reason) : reason.message;
  }
  if ("tag" in reason && typeof reason.tag === "string") {
    const value = "value" in reason ? reason.value : undefined;
    if (value == null) return reason.tag;
    if (typeof value === "object" && "reason" in value && typeof value.reason === "string") {
      return `${reason.tag}: ${value.reason}`;
    }
    return `${reason.tag}/${describe(value)}`;
  }
  return String(reason);
}

/**
 * Subscribe to the main purse balance until the returned function is called.
 * `onChange` fires after every diagnostics update so a caller can repaint.
 * Outside a host container the status settles on `unavailable`.
 */
export function watchCoinageBalance(onChange: () => void): () => void {
  let live = true;
  let subscription: HostSubscription | null = null;
  const update = (next: CoinageBalanceDiagnostics) => {
    diagnostics = next;
    if (live) onChange();
  };

  update({ status: "pending" });
  void getPaymentManager()
    .then((payments) => {
      if (!live) return;
      if (payments == null) {
        update({ status: "unavailable" });
        return;
      }
      update({ status: "subscribed", available: null, updatedAtMs: null });
      subscription = payments.subscribeBalance((balance) => {
        update({
          status: "subscribed",
          available: balance.available,
          updatedAtMs: Date.now(),
        });
      });
      subscription.onInterrupt((reason) => {
        const available =
          diagnostics?.status === "subscribed" ? diagnostics.available : null;
        update({ status: "interrupted", available, reason: describe(reason) });
      });
    })
    .catch((reason: unknown) => update({ status: "error", reason: describe(reason) }));

  return () => {
    live = false;
    subscription?.unsubscribe();
    subscription = null;
  };
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What the app knows about the person, attached to every event as Sentry
 * contexts so a failure says who it happened to and in which standing.
 *
 * Set when the state changes, not per log line: the card query writes the
 * `card` and `identity` contexts each time a read lands, the debug override
 * writes `debug` while it forces a scenario. A context is one JSON block on
 * the event, shown in the issue and searchable; the few fields an operator
 * filters on (`card.kind`, `username`) are also tags.
 *
 * Who the person is — usernames, the DotNS name, account addresses — goes
 * on only when the deployer opts in (`VITE_SENTRY_SEND_IDENTITY=true`);
 * otherwise the contexts keep the standing (`kind`, the card state) and the
 * `username` tag is never set. Telemetry itself is off in any build without a
 * `VITE_SENTRY_DSN`, and every call here is the SDK's no-op without a client.
 */
import { getCurrentScope } from "@sentry/browser";

import { sendsIdentity } from "@humanity/shared/telemetry/redact.ts";

import type { HumanityCardResult } from "@humanity/shared/card/read-humanity-card.ts";
import type { HumanityUserId } from "@humanity/shared/identity/humanity-user-id.ts";

export function setIdentityContext(identity: HumanityUserId | null | undefined): void {
  const scope = getCurrentScope();
  if (identity == null) {
    scope.setContext("identity", null);
    scope.setTag("username", undefined);
    return;
  }
  const kind = identity.isUpgraded ? "upgraded" : "lite";
  if (!sendsIdentity()) {
    scope.setContext("identity", { kind });
    scope.setTag("username", undefined);
    return;
  }
  scope.setContext("identity", {
    primaryUsername: identity.primaryUsername,
    username: identity.username,
    kind,
  });
  scope.setTag("username", identity.username);
}

/**
 * The card as last read, with the game account the read used. `undefined`
 * (nothing read yet) leaves the previous context in place, so a refetch in
 * flight does not blank out the standing an error is about to be filed under.
 */
export function setCardContext(card: HumanityCardResult | undefined, gameAccount: string | null): void {
  if (card === undefined) return;
  const scope = getCurrentScope();
  const identity = sendsIdentity();
  if (card.kind !== "card") {
    scope.setContext("card", identity ? { kind: card.kind, gameAccount } : { kind: card.kind });
    scope.setTag("card.kind", card.kind);
    return;
  }
  if (!identity) {
    scope.setContext("card", { ...card.state });
    scope.setTag("card.kind", card.state.kind);
    return;
  }
  scope.setContext("card", {
    ...card.state,
    accountAddress: card.accountAddress,
    ownerAccount: card.ownerAccount,
    gameAccount,
    participantKey: card.participantKey ?? null,
    primaryUsername: card.primaryUsername,
  });
  scope.setTag("card.kind", card.state.kind);
}

/** The debug panel's forced scenario, so a tester's card is not read as a real one. */
export function setDebugContext(scenario: string | null): void {
  const scope = getCurrentScope();
  scope.setContext("debug", scenario == null ? null : { scenario });
  scope.setTag("debug.scenario", scenario ?? undefined);
}

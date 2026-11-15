// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The Resources-alias section: why `register_person` is or is not dispatchable.
 *
 * `register_person` needs the signer to hold an alias in `People.AccountToAlias`
 * carrying `resources_context()`. Three separable things can be wrong, and the
 * upgrade's single "no Resources alias" error cannot distinguish them:
 *
 * - the context this build derives differs from the runtime's,
 * - the host will not derive that context for this app at all,
 * - the context is right and the alias was simply never bound on chain.
 *
 * The host probe (`getProductAccountAlias`) settles the first two; it cannot
 * settle the third, because deriving an alias is not binding it. Naming which
 * one holds is the point of this section.
 */

import type { HumanityCardResult } from "@humanity/shared/card/read-humanity-card.ts";
import type { ResourcesAliasDiagnostics } from "@humanity/shared/chain/resources-alias.ts";

import { hex32Short, MISSING, type DebugRow } from "./debug-format.ts";

const OUTCOME_LABEL: Record<ResourcesAliasDiagnostics["outcome"], string> = {
  match: "ok: host derives the context this build expects",
  "context-mismatch": "mismatch: host and this build disagree",
  "no-ring-key": "no ring-VRF key registered for the people ring under this product",
  rejected: "host refused the request",
  threw: "call failed, see the error row",
  pending: "in flight or never settled",
  unavailable: "no host container",
};

/**
 * Whether the derived alias is actually bound on chain. The card's own reads
 * cannot answer it — `AccountToAlias` is only read by the upgrade preflight —
 * so this row says what is known rather than implying a lookup happened.
 */
function bindingRow(card: HumanityCardResult | undefined): DebugRow {
  if (card?.kind !== "card") {
    return { label: "binding", value: "unknown: no card read" };
  }
  return {
    label: "binding",
    value: card.snapshot.isUpgradedIdentity
      ? "bound: identity already upgraded"
      : "unbound or unknown: People.set_alias_account is host-only, so the SPA cannot bind the Resources alias",
  };
}

/** Rows for the Resources contextual alias. */
export function resourcesAliasRows(
  diagnostics: ResourcesAliasDiagnostics | undefined,
  card: HumanityCardResult | undefined,
): DebugRow[] {
  if (diagnostics == null) {
    return [{ label: "probe", value: "not run" }];
  }

  const rows: DebugRow[] = [
    { label: "probe", value: OUTCOME_LABEL[diagnostics.outcome] },
    { label: "derived context", value: hex32Short(diagnostics.derivedContext) },
  ];

  if (diagnostics.keyOwner != null) {
    rows.push({ label: "key owner", value: diagnostics.keyOwner });
  }
  if (diagnostics.hostContext != null) {
    rows.push({
      label: "host context",
      value: hex32Short(diagnostics.hostContext),
    });
  }
  rows.push({
    label: "alias",
    value:
      diagnostics.alias == null ? MISSING : hex32Short(diagnostics.alias),
  });
  if (diagnostics.error != null) {
    rows.push({ label: "error", value: diagnostics.error });
  }
  rows.push(bindingRow(card));
  rows.push({ label: "probe elapsed", value: `${diagnostics.elapsedMs} ms` });
  return rows;
}

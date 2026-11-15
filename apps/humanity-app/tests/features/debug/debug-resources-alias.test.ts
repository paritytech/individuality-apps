// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { resourcesAliasRows } from "@features/debug/debug-resources-alias.ts";
import type { ResourcesAliasDiagnostics } from "@humanity/shared/chain/resources-alias.ts";
import type { HumanityCardResult } from "@humanity/shared/card/read-humanity-card.ts";

const DERIVED = `0x${"a1".repeat(32)}`;
const OTHER = `0x${"b2".repeat(32)}`;
const ALIAS = `0x${"c3".repeat(32)}`;

/** Only `snapshot.isUpgradedIdentity` reaches the binding row, so the rest of
 *  the card is the least the type admits — a richer fixture would imply the
 *  row consults state it never reads. */
function unUpgradedCard(): HumanityCardResult {
  return {
    kind: "card",
    primaryUsername: "bob.02",
    accountAddress: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    ownerAccount: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    participant: null,
    devicehood: null,
    membershipStanding: null,
    devicehoodRing: null,
    deviceKeyCheck: null,
    state: {
      kind: "candidate",
      score: 4,
      personhoodThreshold: 7,
      gamesRemaining: 1,
    },
    playerIdentities: {
      accountAddress: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
    },
    snapshot: {
      isLitePerson: false,
      isUpgradedIdentity: false,
      participant: null,
      personhoodThreshold: 7,
      policy: { allowedMisses: 5, window: 6 },
      membershipRing: null,
      devicehoodRing: null,
    },
  };
}

function row(
  diagnostics: ResourcesAliasDiagnostics | undefined,
  label: string,
): string | undefined {
  return resourcesAliasRows(diagnostics, undefined).find(
    (entry) => entry.label === label,
  )?.value;
}

describe("resourcesAliasRows", () => {
  it("says the probe has not run when there are no diagnostics", () => {
    expect(row(undefined, "probe")).toBe("not run");
  });

  it("separates a thrown call from a deliberate refusal", () => {
    // "not run" used to swallow both, which is why an empty Resources alias
    // could not be diagnosed at all.
    const threw = row(
      {
        outcome: "threw",
        derivedContext: DERIVED,
        elapsedMs: 2,
        error: "TypeError: getProductAccountAlias is not a function",
      },
      "probe",
    );
    const refused = row(
      { outcome: "rejected", derivedContext: DERIVED, elapsedMs: 2 },
      "probe",
    );

    expect(threw).not.toBe(refused);
    expect(threw).toContain("failed");
  });

  it("reports a probe that never settled as in flight, not as unrun", () => {
    expect(row({ outcome: "pending", derivedContext: DERIVED, elapsedMs: 0 }, "probe"))
      .not.toBe("not run");
  });

  it("reports a host context that matches the derived one", () => {
    const value = row(
      {
        outcome: "match",
        derivedContext: DERIVED,
        hostContext: DERIVED,
        alias: ALIAS,
        elapsedMs: 42,
      },
      "probe",
    );

    expect(value).toContain("ok");
  });

  it("distinguishes a context mismatch from a refusal", () => {
    const mismatch = row(
      {
        outcome: "context-mismatch",
        derivedContext: DERIVED,
        hostContext: OTHER,
        alias: ALIAS,
        elapsedMs: 7,
      },
      "probe",
    );
    const refused = row(
      {
        outcome: "rejected",
        derivedContext: DERIVED,
        elapsedMs: 7,
        error: "NotMember",
      },
      "probe",
    );

    expect(mismatch).toContain("mismatch");
    expect(refused).toContain("refused");
    expect(mismatch).not.toBe(refused);
  });

  it("shows both contexts on a mismatch, so the difference is visible", () => {
    const rows = resourcesAliasRows(
      {
        outcome: "context-mismatch",
        derivedContext: DERIVED,
        hostContext: OTHER,
        alias: ALIAS,
        elapsedMs: 7,
      },
      undefined,
    );

    const derived = rows.find((r) => r.label === "derived context")?.value;
    const host = rows.find((r) => r.label === "host context")?.value;
    expect(derived).toBeDefined();
    expect(host).toBeDefined();
    expect(derived).not.toBe(host);
  });

  it("surfaces the host's refusal reason", () => {
    expect(
      row(
        {
          outcome: "rejected",
          derivedContext: DERIVED,
          elapsedMs: 3,
          error: "RingNotFound",
        },
        "error",
      ),
    ).toBe("RingNotFound");
  });

  it("omits the host context when the host served none", () => {
    const rows = resourcesAliasRows(
      { outcome: "unavailable", derivedContext: DERIVED, elapsedMs: 1 },
      undefined,
    );

    expect(rows.some((r) => r.label === "host context")).toBe(false);
    expect(rows.find((r) => r.label === "alias")?.value).toBe("—");
  });

  it("separates a missing ring key from a refusal and from an unrun probe", () => {
    // Folding this into `rejected` would blame the host for our own missing key.
    const missing = row(
      {
        outcome: "no-ring-key",
        derivedContext: DERIVED,
        keyOwner: "peopl.paseo",
        elapsedMs: 4,
      },
      "probe",
    );
    const refused = row(
      { outcome: "rejected", derivedContext: DERIVED, elapsedMs: 4 },
      "probe",
    );

    expect(missing).not.toBe(refused);
    expect(missing).not.toBe("not run");
  });

  it("names the registry it looked in, so the reader can check the other one", () => {
    const rows = resourcesAliasRows(
      {
        outcome: "no-ring-key",
        derivedContext: DERIVED,
        keyOwner: "peopl.paseo",
        elapsedMs: 4,
      },
      undefined,
    );

    expect(rows.find((r) => r.label === "key owner")?.value).toBe("peopl.paseo");
  });

  it("never claims a binding the SPA cannot observe", () => {
    // `AccountToAlias` is only read by the upgrade preflight, so an un-upgraded
    // card must not be reported as bound either way.
    const value = row(
      { outcome: "match", derivedContext: DERIVED, elapsedMs: 1 },
      "binding",
    );

    expect(value).toBe("unknown: no card read");
  });

  it("scopes the host-only claim to the People pallet's call", () => {
    // The unscoped wording ("set_alias_account is host-only") read as a claim
    // about every pallet's call of that name and sent a debugging session down
    // the wrong path: the SPA *does* submit `PeopleLite.set_alias_account` for
    // the weekly seat. This row may only speak for the Resources alias.
    const value = resourcesAliasRows(
      { outcome: "match", derivedContext: DERIVED, elapsedMs: 1 },
      unUpgradedCard(),
    ).find((entry) => entry.label === "binding")?.value;

    expect(value).toBe(
      "unbound or unknown: People.set_alias_account is host-only, so the SPA cannot bind the Resources alias",
    );
  });
});

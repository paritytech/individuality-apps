// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { liteKeyOwnerRows } from "@features/debug/debug-lite-key-owner.ts";
import type {
  LiteKeyOwnerProbeDiagnostics,
  LiteKeyOwnerReport,
} from "@features/debug/lite-key-owner-probe.ts";

const ATTESTED = `0x${"8c".repeat(32)}`;
const OTHER = `0x${"93".repeat(32)}`;

function report(overrides: Partial<LiteKeyOwnerReport>): LiteKeyOwnerReport {
  return {
    label: "peopl",
    owner: "peopl.paseo",
    outcome: "ok",
    entries: [],
    ...overrides,
  };
}

function diagnostics(
  reports: LiteKeyOwnerReport[],
  verdict: LiteKeyOwnerProbeDiagnostics["verdict"] = { holder: null },
): LiteKeyOwnerProbeDiagnostics {
  return { attestedKey: ATTESTED, reports, verdict, elapsedMs: 42 };
}

function row(
  input: LiteKeyOwnerProbeDiagnostics | undefined,
  label: string,
): string | undefined {
  return liteKeyOwnerRows(input).find((entry) => entry.label === label)?.value;
}

describe("liteKeyOwnerRows", () => {
  it("says the probe has not run when there are no diagnostics", () => {
    expect(row(undefined, "probe")).toBe("not run");
  });

  it("shows the attested key abbreviated", () => {
    const value = row(diagnostics([]), "attested key");
    expect(value).toContain("0x8c8c");
    expect(value).toContain("…");
  });

  it("names which owner holds the attested key", () => {
    const value = row(
      diagnostics(
        [
          report({
            label: "peopl",
            owner: "peopl.paseo",
            entries: [{ key: ATTESTED, declaresLiteRing: true, matchesAttested: true }],
          }),
        ],
        { holder: "peopl", owner: "peopl.paseo" },
      ),
      "verdict",
    );
    expect(value).toBe("peopl (peopl.paseo) holds the attested key");
  });

  it("says no probed owner discloses the key when none match", () => {
    const value = row(
      diagnostics([
        report({
          entries: [{ key: OTHER, declaresLiteRing: true, matchesAttested: false }],
        }),
      ]),
      "verdict",
    );
    expect(value).toContain("no probed owner discloses the attested key");
    expect(value).toContain("not the attested device");
  });

  it("reports each owner's outcome, entry count, and disclosed key", () => {
    const rows = liteKeyOwnerRows(
      diagnostics([
        report({
          label: "peopl",
          owner: "peopl.paseo",
          entries: [{ key: ATTESTED, declaresLiteRing: true, matchesAttested: true }],
        }),
      ]),
    );
    const values = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(values["peopl owner"]).toBe("peopl.paseo");
    expect(values["peopl outcome"]).toContain("ok");
    expect(values["peopl entry count"]).toBe("1");
    expect(values["peopl entry 0"]).toContain("declares people-lite ring");
    expect(values["peopl entry 0"]).toContain("MATCHES ATTESTED KEY");
  });

  it("marks an entry with no disclosure explicitly, not as an absent value", () => {
    const value = row(
      diagnostics([
        report({ entries: [{ key: null, declaresLiteRing: false, matchesAttested: false }] }),
      ]),
      "peopl entry 0",
    );
    expect(value).toContain("(no disclosure)");
    expect(value).toContain("other ring");
    expect(value).not.toContain("MATCHES");
  });

  it("separates a rejected owner from one that succeeded", () => {
    const rows = liteKeyOwnerRows(
      diagnostics([
        report({
          label: "peopl",
          owner: "peopl.paseo",
          entries: [{ key: OTHER, declaresLiteRing: true, matchesAttested: false }],
        }),
        report({
          label: "dim2",
          owner: "dim2.paseo",
          outcome: "rejected",
          entries: [],
          error: "listRingVrfKeys: Rejected",
        }),
      ]),
    );
    const values = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(values["peopl outcome"]).toContain("ok");
    expect(values["dim2 outcome"]).toContain("declined");
    expect(values["dim2 error"]).toBe("listRingVrfKeys: Rejected");
    expect(values["dim2 entry count"]).toBe("0");
  });

  it("shows the probe's elapsed time", () => {
    expect(row(diagnostics([]), "probe elapsed")).toBe("42 ms");
  });
});

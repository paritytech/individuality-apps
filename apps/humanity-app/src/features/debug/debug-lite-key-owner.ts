// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Rows for the lite key owner probe section — free of React and free of
 * chain access, like every other row builder in this feature. The probe
 * itself (`lite-key-owner-probe.ts`) does the host calls and hands back
 * structured diagnostics; this file only turns them into the panel's flat
 * label/value rows.
 */
import { hex32Short, type DebugRow } from "./debug-format.ts";
import type {
  LiteKeyOwnerEntry,
  LiteKeyOwnerProbeDiagnostics,
  LiteKeyOwnerReport,
} from "./lite-key-owner-probe.ts";

const NO_DISCLOSURE = "(no disclosure)";

const OUTCOME_LABEL: Record<LiteKeyOwnerReport["outcome"], string> = {
  ok: "ok: host answered the listing",
  rejected: "host declined: consent refused or no such ring for this owner",
  error: "call failed, see the error row",
};

function entryText(entry: LiteKeyOwnerEntry): string {
  const key = entry.key == null ? NO_DISCLOSURE : hex32Short(entry.key);
  const ring = entry.declaresLiteRing ? "declares people-lite ring" : "other ring";
  const match = entry.matchesAttested ? " · MATCHES ATTESTED KEY" : "";
  return `${key} · ${ring}${match}`;
}

function reportRows(report: LiteKeyOwnerReport): DebugRow[] {
  const rows: DebugRow[] = [
    { label: `${report.label} owner`, value: report.owner },
    { label: `${report.label} outcome`, value: OUTCOME_LABEL[report.outcome] },
    { label: `${report.label} entry count`, value: String(report.entries.length) },
  ];
  if (report.error != null) {
    rows.push({ label: `${report.label} error`, value: report.error });
  }
  for (const [index, entry] of report.entries.entries()) {
    rows.push({ label: `${report.label} entry ${index}`, value: entryText(entry) });
  }
  return rows;
}

function verdictText(verdict: LiteKeyOwnerProbeDiagnostics["verdict"]): string {
  if (verdict.holder == null) {
    return "no probed owner discloses the attested key — this host is not the attested device";
  }
  return `${verdict.holder} (${verdict.owner}) holds the attested key`;
}

/** Rows for the lite key owner probe. */
export function liteKeyOwnerRows(
  diagnostics: LiteKeyOwnerProbeDiagnostics | undefined,
): DebugRow[] {
  if (diagnostics == null) {
    return [{ label: "probe", value: "not run" }];
  }
  const rows: DebugRow[] = [
    { label: "attested key", value: hex32Short(diagnostics.attestedKey) },
  ];
  for (const report of diagnostics.reports) {
    rows.push(...reportRows(report));
  }
  rows.push({ label: "verdict", value: verdictText(diagnostics.verdict) });
  rows.push({ label: "probe elapsed", value: `${diagnostics.elapsedMs} ms` });
  return rows;
}

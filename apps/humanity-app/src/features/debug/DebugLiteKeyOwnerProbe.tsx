// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Operator control for the lite key owner probe.
 *
 * Split out of the rest of the panel, unlike the resources-alias section,
 * because listing a *foreign* owner can raise the host's one-time
 * `AccountAccessReview` consent prompt — see `use-lite-key-owner-probe.ts`.
 * A section rendered unconditionally on every panel open would raise that
 * prompt on a render the operator never asked for, so this one needs a
 * button rather than the resources-alias section's on-open effect.
 */
import { liteKeyOwnerRows } from "./debug-lite-key-owner.ts";
import { MISSING } from "./debug-format.ts";
import { getLiteKeyOwnerProbeDiagnostics } from "./lite-key-owner-probe.ts";
import { useLiteKeyOwnerProbe } from "./use-lite-key-owner-probe.ts";
import type { DebugPageInput } from "./debug-view.ts";

/** The chain-attested lite key, straight from the card's own
 *  `PeopleLite.LitePeople` read — `devicehoodRing` carries it whenever a
 *  record exists, whether or not the ring placement itself later failed. */
function attestedKeyOf(card: DebugPageInput["card"]): string | null {
  if (card?.kind !== "card" || card.devicehoodRing == null) return null;
  return card.devicehoodRing.kind === "no-record"
    ? null
    : card.devicehoodRing.ringVrfKey;
}

export function DebugLiteKeyOwnerProbe({ card }: { card: DebugPageInput["card"] }) {
  const { pending, run } = useLiteKeyOwnerProbe();
  const attestedKey = attestedKeyOf(card);
  const diagnostics = getLiteKeyOwnerProbeDiagnostics();

  return (
    <section className="debug-section">
      <h2 className="debug-title">lite key owner probe</h2>
      <p className="debug-note">
        Listing only — never registers or proves. First run against a new
        owner may raise a host consent prompt.
      </p>
      <button
        type="button"
        className="debug-chip"
        data-pending={pending || undefined}
        disabled={pending || attestedKey == null}
        onClick={() => {
          if (attestedKey != null) run(attestedKey);
        }}
      >
        {pending ? "Probing…" : "Probe lite key owners"}
      </button>
      {attestedKey == null && (
        <p className="debug-warn">
          No PeopleLite.LitePeople record on this card ({MISSING}) — nothing to probe against.
        </p>
      )}
      <dl className="debug-rows">
        {liteKeyOwnerRows(diagnostics).map((row) => (
          <div key={row.label} className="debug-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

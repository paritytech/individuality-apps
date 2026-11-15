// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Operator-triggered probe: which product's registry discloses the
 * chain-attested lite ring-VRF key.
 *
 * `PeopleLite.LitePeople[username owner].ring_vrf_key` is the key
 * `PeopleLite.attest` enrolled in the people-lite ring — the one and only
 * attested key for a lite person. This host declares *some* key at the lite
 * index (`devicehoodRing` on the card), but nothing on the card read says
 * which product's registry that declaration lives under: RFC-0022 pins the
 * lite key at `//peopl.<tld>//index_bytes(1)`, but also says existing keys
 * were migrated onto `peopl.<tld>` paths, so a pre-migration enrolment can
 * legitimately sit elsewhere. This probe settles that empirically instead of
 * by reasoning about it, by listing every candidate owner and comparing.
 *
 * `listRingVrfKeys` on a *foreign* owner is host-side consent-gated (a
 * one-time `AccountAccessReview` prompt per requester/target pair), so this
 * only ever runs on operator command — see `use-lite-key-owner-probe.ts`.
 * Its wire error enum (`HostAccountListRingVrfKeysError`) is
 * `NotConnected | Rejected | Unknown`, with no `NotAllowlisted`, so a
 * listing failure is never itself an owner refusing a request it did not
 * consent to describe — it is either "not logged in", an explicit
 * `Rejected` (declined consent or no such ring), or the catch-all.
 *
 * Listing only: this module never calls `registerRingVrfKey`,
 * `createRingVRFProof`/`createAccountProof`, or `ringVrfSign` on any path —
 * foreign proof minting is separately hard-refused (`NotAllowlisted`) on
 * core hosts, and nothing here needs a proof to answer the question.
 */
import {
  getAccountsProvider,
  toHex,
  type AccountsProvider,
  type HexString,
  type RegisteredRingVrfKey,
  type RingLocation,
} from "@humanity/shared/chain/host-api.ts";
import { devicehoodRingLocation } from "@humanity/shared/chain/individuality.ts";
import {
  candidateProductDomain,
  type NetworkConfig,
} from "@humanity/shared/chain/networks.ts";
import { describeHostError } from "@humanity/shared/chain/resources-alias.ts";
import { ringIdentifier } from "@humanity/shared/chain/ring-membership.ts";
import { declaresRing } from "@humanity/shared/identity/personhood-ring-key.ts";
import { personhoodProductId } from "@humanity/shared/identity/product-domain.ts";

import { errorText } from "./debug-format.ts";

/** The two products this probe can name as the attested key's owner. */
type LiteKeyOwnerLabel = "peopl" | "dim2";

type LiteKeyOwnerOutcome =
  /** The host answered the listing — including with zero entries. */
  | "ok"
  /** The host declined: refused consent, or the owner has no such ring. */
  | "rejected"
  /** The call failed outright — not logged in, an unknown wire error, or the
   *  call threw rather than answering. */
  | "error";

export interface LiteKeyOwnerEntry {
  /** Disclosed public key, hex — `null` when the host granted no disclosure
   *  for this entry (an explicit marker, not an absent field: the entry
   *  exists, but discloses nothing). */
  readonly key: string | null;
  /** Whether this entry declares the people-lite ring location. */
  readonly declaresLiteRing: boolean;
  /** Whether the disclosed key equals the chain-attested key. Always
   *  `false` when `key` is `null` — an undisclosed entry proves nothing. */
  readonly matchesAttested: boolean;
}

export interface LiteKeyOwnerReport {
  readonly label: LiteKeyOwnerLabel;
  readonly owner: string;
  readonly outcome: LiteKeyOwnerOutcome;
  readonly entries: readonly LiteKeyOwnerEntry[];
  readonly error?: string;
}

type LiteKeyOwnerVerdict =
  | { readonly holder: LiteKeyOwnerLabel; readonly owner: string }
  | { readonly holder: null };

export interface LiteKeyOwnerProbeDiagnostics {
  readonly attestedKey: string;
  readonly reports: readonly LiteKeyOwnerReport[];
  readonly verdict: LiteKeyOwnerVerdict;
  readonly elapsedMs: number;
}

let diagnostics: LiteKeyOwnerProbeDiagnostics | undefined;

/** The outcome of the most recent lite key owner probe. */
export function getLiteKeyOwnerProbeDiagnostics():
  | LiteKeyOwnerProbeDiagnostics
  | undefined {
  return diagnostics;
}

function candidateOwners(
  network: NetworkConfig,
): Array<{ label: LiteKeyOwnerLabel; owner: string }> {
  return [
    { label: "peopl", owner: personhoodProductId(network) },
    { label: "dim2", owner: candidateProductDomain(network) },
  ];
}

/** Only `Rejected` is the host declining a request on purpose; `NotConnected`
 *  and `Unknown` are call failures, and — per the wire enum's missing
 *  `NotAllowlisted` arm — neither is an owner-consent refusal either. */
function outcomeFor(error: unknown): "rejected" | "error" {
  if (
    typeof error === "object" &&
    error != null &&
    "tag" in error &&
    error.tag === "Rejected"
  ) {
    return "rejected";
  }
  return "error";
}

function entryFor(
  key: RegisteredRingVrfKey,
  ring: RingLocation,
  collectionId: HexString,
  attestedKey: string,
): LiteKeyOwnerEntry {
  const hex = key.publicKey == null ? null : toHex(key.publicKey);
  return {
    key: hex,
    declaresLiteRing: declaresRing(key, ring, collectionId),
    matchesAttested: hex != null && hex.toLowerCase() === attestedKey.toLowerCase(),
  };
}

/** One owner's listing, isolated: a refusal or throw for this owner must
 *  never take down the others' results. */
async function reportFor(
  provider: AccountsProvider,
  label: LiteKeyOwnerLabel,
  owner: string,
  ring: RingLocation,
  collectionId: HexString,
  attestedKey: string,
): Promise<LiteKeyOwnerReport> {
  try {
    return await provider.listRingVrfKeys(owner, "PublicKey").match(
      (keys): LiteKeyOwnerReport => ({
        label,
        owner,
        outcome: "ok",
        entries: keys.map((key) => entryFor(key, ring, collectionId, attestedKey)),
      }),
      (error): LiteKeyOwnerReport => ({
        label,
        owner,
        outcome: outcomeFor(error),
        entries: [],
        error: describeHostError("listRingVrfKeys", error),
      }),
    );
  } catch (cause) {
    return { label, owner, outcome: "error", entries: [], error: errorText(cause) };
  }
}

/** The first owner whose entries disclose the attested key. Reports are
 *  probed in a fixed order (`peopl`, `dim2`), so ties are impossible
 *  in practice — an attested key is enrolled under exactly one owner. */
function verdictFor(reports: readonly LiteKeyOwnerReport[]): LiteKeyOwnerVerdict {
  for (const report of reports) {
    if (report.entries.some((entry) => entry.matchesAttested)) {
      return { holder: report.label, owner: report.owner };
    }
  }
  return { holder: null };
}

function unavailableReport(
  label: LiteKeyOwnerLabel,
  owner: string,
  reason: string,
): LiteKeyOwnerReport {
  return { label, owner, outcome: "error", entries: [], error: reason };
}

/**
 * Probe every candidate owner product for `attestedKey`, and report which
 * one — if any — discloses it. Never throws: a probe that cannot run is a
 * diagnostic outcome, not a failure the caller has to handle (the convention
 * `resources-alias.ts` states).
 *
 * `attestedKey` is supplied by the caller — the debug panel reads it from
 * the card's `PeopleLite.LitePeople` record, which this probe has no read of
 * its own for.
 */
export async function probeLiteKeyOwners(
  network: NetworkConfig,
  attestedKey: string,
): Promise<LiteKeyOwnerProbeDiagnostics> {
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  const owners = candidateOwners(network);

  try {
    const provider = await getAccountsProvider();
    if (provider == null) {
      diagnostics = {
        attestedKey,
        reports: owners.map(({ label, owner }) =>
          unavailableReport(label, owner, "no host container"),
        ),
        verdict: { holder: null },
        elapsedMs: elapsed(),
      };
      return diagnostics;
    }

    const ring = devicehoodRingLocation(network);
    const collectionId = ringIdentifier("people-lite");

    const reports = await Promise.all(
      owners.map(({ label, owner }) =>
        reportFor(provider, label, owner, ring, collectionId, attestedKey),
      ),
    );

    diagnostics = {
      attestedKey,
      reports,
      verdict: verdictFor(reports),
      elapsedMs: elapsed(),
    };
  } catch (cause) {
    diagnostics = {
      attestedKey,
      reports: owners.map(({ label, owner }) =>
        unavailableReport(label, owner, errorText(cause)),
      ),
      verdict: { holder: null },
      elapsedMs: elapsed(),
    };
  }
  return diagnostics;
}

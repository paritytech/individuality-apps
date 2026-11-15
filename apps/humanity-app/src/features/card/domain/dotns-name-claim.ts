// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * When the app registers the person's full username in dotNS, and how it
 * remembers an attempt — the pure half of `claim-dotns-name.ts`.
 *
 * A full username lives in two places: `Resources.register_person` writes it
 * on the People chain, `DotnsGateway.register_name` mints it in dotNS on Asset
 * Hub. Only the second one makes the person findable (every host verifies a
 * name against dotNS), and until this release the app only ever did the
 * first. So the rule is simply: the card shows a full username and the
 * gateway holds none for that account → register it. That covers both a
 * claim made a moment ago in this app and the names claimed before the fix.
 */
import type { RingPosition } from "@humanity/shared/chain/ring-membership.ts";
import type { DotnsNameErrorCode } from "@humanity/shared/chain/dotns-gateway/register-name.ts";
import type { DotnsGatewayNames } from "@humanity/shared/chain/dotns-gateway/read-names.ts";

/** How long a failed attempt waits before the next one. */
export const DOTNS_CLAIM_RETRY_MS = 30_000;

export type DotnsNameClaimRecord =
  | { status: "sending"; label: string; at: number; attempts: number }
  | {
      status: "sent";
      label: string;
      at: number;
      txHash: string;
      /** The era end of the broadcast tx; after it, an unconfirmed send is retried. */
      expiresAtBlock: number;
      confirmed: boolean;
    }
  | {
      status: "stopped";
      label: string;
      at: number;
      attempts: number;
      code: DotnsNameErrorCode;
      detail: string;
    };

/** Codes a later attempt, unchanged, may get past; the rest need a person or a fix. */
const RETRY_CODES: Record<DotnsNameErrorCode, boolean> = {
  "invalid-label": false,
  "host-missing": true,
  "not-lite-owner": false,
  "account-already-registered": false,
  "ring-not-synced": true,
  proof: true,
  signing: true,
  timeout: true,
  // A dispatch failure is usually a proof the chain pruned mid-flight or a
  // root it had not imported; the next attempt rebuilds the proof.
  "finalized-error": true,
};

export function isRetryableDotnsNameCode(code: DotnsNameErrorCode): boolean {
  return RETRY_CODES[code];
}

export interface DotnsClaimGateInputs {
  /** The card is live and resolved for a person. */
  readonly owner: string | null;
  /** The full username the card shows (People's copy), or null for a lite person. */
  readonly fullUsername: string | null;
  /** What the gateway holds for `owner`; undefined while unread. */
  readonly gateway: DotnsGatewayNames | undefined;
  readonly record: DotnsNameClaimRecord | null;
  /**
   * Where the card's Membership key stands in the `people` ring, or null when
   * the chain could not say. The claim's personhood proof is a ring-VRF proof
   * over that ring, so a key the ring does not hold proves `NotMember`.
   */
  readonly membership: RingPosition | null;
  /** Another attempt is in flight in this tab. */
  readonly busy: boolean;
  readonly now: number;
}

export type DotnsClaimGate =
  | { kind: "idle"; detail: string }
  | { kind: "registered"; detail: string }
  | { kind: "holding"; detail: string; until: number }
  | { kind: "stopped"; detail: string }
  | { kind: "firing"; detail: string; label: string };

/** Decide whether the automatic claim fires now, and why not otherwise. */
export function dotnsClaimGate({
  owner,
  fullUsername,
  gateway,
  record,
  membership,
  busy,
  now,
}: DotnsClaimGateInputs): DotnsClaimGate {
  if (owner == null) return { kind: "idle", detail: "no card" };
  if (fullUsername == null) return { kind: "idle", detail: "no full username on People" };
  if (gateway === undefined) return { kind: "idle", detail: "gateway names not read yet" };
  if (gateway.full === fullUsername) {
    return { kind: "registered", detail: `dotNS holds ${fullUsername}` };
  }
  if (gateway.full != null || gateway.aliasRegistered) {
    return {
      kind: "stopped",
      detail: `the account already registered ${gateway.full ?? "a name"} in dotNS`,
    };
  }
  // A key the ring is known not to hold (queued, suspended, never added) can
  // only prove `NotMember`, and the retry timer would repeat that every 30 s.
  // Unknown (null) still proves: the host's own key may be in the ring.
  // Nothing is recorded, so the claim fires as soon as the card shows the key
  // included.
  if (membership != null && membership.kind !== "included") {
    return { kind: "idle", detail: `Membership key is ${membership.kind} in the people ring` };
  }
  if (busy) return { kind: "idle", detail: "an attempt is in flight" };
  if (record?.status === "sending" && now - record.at < DOTNS_CLAIM_RETRY_MS) {
    return { kind: "holding", detail: "an attempt was sending", until: record.at + DOTNS_CLAIM_RETRY_MS };
  }
  if (record?.status === "sent" && record.label === fullUsername) {
    // Included or unconfirmed: the gateway read is what retires it. Give an
    // unconfirmed broadcast its era before trying again.
    const until = record.at + DOTNS_CLAIM_RETRY_MS;
    if (!record.confirmed && now < until) {
      return { kind: "holding", detail: `${record.txHash} broadcast, unconfirmed`, until };
    }
    if (record.confirmed && now < until) {
      return { kind: "holding", detail: `${record.txHash} included, waiting for the gateway read`, until };
    }
  }
  if (record?.status === "stopped" && record.label === fullUsername) {
    if (!isRetryableDotnsNameCode(record.code)) {
      return { kind: "stopped", detail: `${record.code}: ${record.detail}` };
    }
    const until = record.at + DOTNS_CLAIM_RETRY_MS;
    if (now < until) {
      return { kind: "holding", detail: `retry after ${record.code}`, until };
    }
  }
  return { kind: "firing", detail: `dotNS has no full name for ${owner}`, label: fullUsername };
}

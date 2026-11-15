// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { ss58Encode } from "@parity/product-sdk/address";
import { AccountId } from "@polkadot-api/substrate-bindings";
import { Binary } from "polkadot-api";
import { toHex } from "polkadot-api/utils";

import { getAssetHubClient, type AssetHubApi } from "@humanity/shared/chain/asset-hub-client.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";

const logger = loggerFor("chain", "dotns-gateway");

const READ_TIMEOUT_MS = 15_000;
const BEST = { at: "best" } as const;
/** The app's SS58 prefix; the SDK descriptors render Asset Hub addresses with the chain's own. */
const SS58_PREFIX = 42;
const accountId = AccountId();
const utf8 = new TextDecoder("utf-8", { fatal: false });

/** What `DotnsGateway.AccountNames` holds for an account: the gateway's own record, not the contracts'. */
export interface DotnsGatewayNames {
  /** The lite label (`alice.42`), reserved through `reserve_name`. */
  readonly lite: string | null;
  /** The full label (`alice`), registered through `register_name`. */
  readonly full: string | null;
  /** `DotnsGateway.AccountAlias` holds the account: it already registered a full name. */
  readonly aliasRegistered: boolean;
}

/**
 * The names the gateway pallet recorded for `who` at the best block. The
 * pallet's map is written only by its own calls, so this is exactly "did the
 * full username go through `register_name`" — the question #1433 is about.
 */
export async function readDotnsGatewayNames(who: string): Promise<DotnsGatewayNames> {
  const { api } = await getAssetHubClient();
  const [names, alias] = await withTimeout(
    Promise.all([
      api.query.DotnsGateway.AccountNames.getValue(who, BEST),
      api.query.DotnsGateway.AccountAlias.getValue(who, BEST),
    ]),
    READ_TIMEOUT_MS,
    "Reading the dotNS gateway names timed out.",
  );
  return {
    lite: names?.lite ? labelText(names.lite.label) : null,
    full: names?.full ? labelText(names.full.label) : null,
    aliasRegistered: alias != null,
  };
}

/**
 * The account `DotnsGateway.LiteLabelOwner` records for a lite label, as a
 * prefix-42 address like every account the app handles, or null. The typed
 * read renders it with Asset Hub's prefix (`1…` on paseo), so a string
 * comparison against the card's owner would never match.
 */
export async function readLiteLabelOwner(liteLabel: string): Promise<string | null> {
  const { api } = await getAssetHubClient();
  const owner = await withTimeout(
    api.query.DotnsGateway.LiteLabelOwner.getValue(Binary.fromText(liteLabel), BEST),
    READ_TIMEOUT_MS,
    "Reading the lite label owner timed out.",
  );
  return owner == null ? null : ss58Encode(accountId.enc(owner), SS58_PREFIX);
}

/**
 * The SDK descriptors type a `Vec<u8>` as `Uint8Array`, PAPI hands back a
 * `Binary`; accept either rather than trust one over the other.
 */
function labelText(label: Uint8Array | { asBytes(): Uint8Array }): string {
  return utf8.decode(label instanceof Uint8Array ? label : label.asBytes());
}

export type RingRevisionStatus = "imported" | "pending" | "pruned";

/**
 * Whether Asset Hub's `MembersSubscriber` holds the People ring root revision
 * a proof was built against. The subscriber keeps only the latest roots per
 * ring, so an absent revision is `pending` while every held revision is
 * older, and `pruned` once a newer one has replaced it — a pruned proof must
 * be rebuilt, waiting for it is pointless.
 */
export async function readRingRevisionStatus(
  api: AssetHubApi,
  collection: Uint8Array,
  ringIndex: number,
  revision: number,
): Promise<RingRevisionStatus> {
  // A rebuild can bump the generation mid-wait; read it on every poll.
  const generation = await api.query.MembersSubscriber.CurrentGeneration.getValue(BEST);
  const roots = await api.query.MembersSubscriber.RingRoots.getValue(
    generation,
    toHex(collection),
    ringIndex,
    BEST,
  );
  const held = (roots ?? []).map((record) => record.revision);
  if (held.includes(revision)) return "imported";
  if (held.some((r) => r > revision)) return "pruned";
  return "pending";
}

export class RingRevisionError extends Error {
  readonly status: Exclude<RingRevisionStatus, "imported">;

  constructor(status: Exclude<RingRevisionStatus, "imported">, message: string) {
    super(message);
    this.name = "RingRevisionError";
    this.status = status;
  }
}

export interface AwaitRingRevisionOptions {
  /** Give up after this long; the claim is retried from scratch later. */
  deadlineMs?: number;
  /** Poll interval; Asset Hub imports a root within a few blocks of People building it. */
  intervalMs?: number;
  onPoll?: (status: RingRevisionStatus, elapsedMs: number) => void;
}

/**
 * Block until Asset Hub has imported `revision` of `ringIndex`, or throw
 * `RingRevisionError("pending")` at the deadline / `("pruned")` as soon as a
 * newer root has displaced it.
 */
export async function awaitRingRevision(
  api: AssetHubApi,
  collection: Uint8Array,
  ringIndex: number,
  revision: number,
  { deadlineMs = 180_000, intervalMs = 6_000, onPoll }: AwaitRingRevisionOptions = {},
): Promise<void> {
  const started = Date.now();
  for (;;) {
    const status = await withTimeout(
      readRingRevisionStatus(api, collection, ringIndex, revision),
      READ_TIMEOUT_MS,
      "Reading the subscriber ring roots timed out.",
    );
    const elapsed = Date.now() - started;
    onPoll?.(status, elapsed);
    logger.debug("ring {ringIndex} revision {revision}: {status} after {elapsed}ms", {
      ringIndex,
      revision,
      status,
      elapsed,
    });
    if (status === "imported") return;
    if (status === "pruned") {
      throw new RingRevisionError(
        "pruned",
        `Asset Hub already replaced ring ${ringIndex} revision ${revision}; the proof must be rebuilt.`,
      );
    }
    if (elapsed + intervalMs > deadlineMs) {
      throw new RingRevisionError(
        "pending",
        `Asset Hub has not imported ring ${ringIndex} revision ${revision} after ${Math.round(elapsed / 1000)}s.`,
      );
    }
    const { promise: tick, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, intervalMs);
    await tick;
  }
}

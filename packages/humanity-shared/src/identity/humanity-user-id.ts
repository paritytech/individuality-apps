// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  getAccountsProvider,
  type AccountsProvider,
} from "@humanity/shared/chain/host-api.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";

const logger = loggerFor("identity", "user-id");

export interface HumanityUserId {
  /** Primary username exactly as returned by the host. */
  readonly primaryUsername: string;
  /** People Chain username without the terminal DotNS extension. */
  readonly username: string;
  /** True when the label carries no lite `.<digits>` suffix. */
  readonly isUpgraded: boolean;
}

/**
 * Mirrors `is_lite_person_label` / `is_person_label` in the Individuality
 * runtime (`individuality/support/src/labels.rs`): a Lite person label is a
 * DotNS stem (lowercase letter or digit at each end, internal hyphens
 * allowed, no dot) followed by `.` and at least two ASCII digits. A full
 * person label is lowercase ASCII letters only, so any label that is not
 * lite belongs to an upgraded (full) person. Expects a normalized
 * (lowercased, extension-stripped) label.
 */
export function isLiteUsernameLabel(label: string): boolean {
  return LITE_LABEL.test(label);
}

const LITE_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[0-9]{2,}$/;

/**
 * DotNS extensions are network-scoped: paseo-next-v2 issues `.paseo` names,
 * previewnet issues `.testnet`, and mainnet issues `.dot`. Historical `.test`
 * names are still accepted so stale host state can be read after a reset.
 * `Resources.UsernameOwnerOf` is keyed by the bare label, so every terminal
 * extension is stripped.
 */
const DOTNS_EXTENSION = /\.(?:dot|paseo|test|testnet)$/i;

function normalizePrimaryUsername(primaryUsername: string): string | null {
  const trimmed = primaryUsername.trim();
  const username = trimmed.replace(DOTNS_EXTENSION, "").trim().toLowerCase();
  return username === "" ? null : username;
}

/**
 * Parses a raw primary DotNS username exactly like the live host path: trim →
 * strip the terminal `.dot`/`.paseo`/`.testnet` extension (plus historical
 * `.test`) → lowercase → classify vs upgraded.
 */
export function parseHumanityUserId(
  primaryUsername: string,
): HumanityUserId | null {
  const username = normalizePrimaryUsername(primaryUsername);
  return username == null
    ? null
    : { primaryUsername, username, isUpgraded: !isLiteUsernameLabel(username) };
}

/**
 * Resolve a host-confirmed DotNS identity through the supplied session.
 *
 * A refusal reads as no identity, which is the "account isn't available"
 * screen, so the host's reason is logged: a declined disclosure, a session
 * that is not connected and a broken bridge all look the same from the card.
 */
export async function resolveHumanityUserIdFromProvider(
  provider: AccountsProvider,
): Promise<HumanityUserId | null> {
  return provider.getUserId().match(
    ({ primaryUsername }) => parseHumanityUserId(primaryUsername),
    (error) => {
      logger.warning("host refused the user id; error={error}", {
        error:
          error instanceof Object
            ? JSON.stringify(error, Object.getOwnPropertyNames(error))
            : String(error),
      });
      return null;
    },
  );
}

/** Resolve the connected user's primary DotNS identity after host connection. */
export async function resolveHumanityUserId(): Promise<HumanityUserId | null> {
  const provider = await getAccountsProvider();
  return provider == null
    ? null
    : resolveHumanityUserIdFromProvider(provider);
}

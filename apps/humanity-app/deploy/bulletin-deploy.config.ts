// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";

/**
 * Product manifest for publishing the Humanity SPA as an on-chain Polkadot
 * product. Consumed only via an explicit
 * `bulletin-deploy --config apps/humanity-app/deploy/bulletin-deploy.config.ts`, which makes the
 * deploy write the name, icon and per-executable text records instead of a bare
 * contenthash.
 *
 * Two constraints are load-bearing:
 *  - `domain` must equal the CLI's positional domain argument verbatim;
 *    publishManifest throws a NonRetryableError on any mismatch, so it carries
 *    the network's TLD (`.paseo` on paseo-next-v2, `.testnet` on preview).
 *  - This file must stay outside the build directory's ancestry. bulletin-deploy
 *    auto-discovers a config by walking up from the build dir, and an
 *    auto-discovered manifest would also apply to the CI deploys that pass a
 *    bare label, where the domain comparison above cannot hold.
 *
 * `icon.path` and every `executables[].path` resolve relative to this file.
 *
 * DEPLOY_DOMAIN is required rather than defaulted: the deploy label is per
 * environment (`DOTNS_LABEL`), so any baked-in fallback here would eventually
 * publish this product under a stale name. `npm run humanity:setup` exports it from the
 * same value it passes to the CLI.
 */
const domain = process.env.DEPLOY_DOMAIN;
if (domain === undefined || domain === "") {
  throw new Error(
    "DEPLOY_DOMAIN is required: set it to the full dotNS name being deployed, " +
      "e.g. DEPLOY_DOMAIN=peopl.paseo. Deploy via `npm run humanity:setup`, which " +
      "exports it alongside the CLI's positional domain argument.",
  );
}

/**
 * The manifest's app version is the SPA's package version, so bumping
 * apps/humanity-app/package.json is what moves the on-chain version — never
 * a hand edit here.
 */
const spaPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
const appVersion = spaPackage.version.split(/[.-]/, 3).map(Number) as [number, number, number];
if (appVersion.length !== 3 || appVersion.some((part) => !Number.isInteger(part))) {
  throw new Error(
    `apps/humanity-app/package.json version "${spaPackage.version}" is not MAJOR.MINOR.PATCH.`,
  );
}

export default {
  domain,
  displayName: "Humanity",
  description:
    "Your membership card, prize draws, and a chance to win a dollar every day.",
  icon: { path: "./icon.png", format: "png" as const },
  executables: [
    {
      kind: "app" as const,
      path: "../dist",
      appVersion,
    },
    // The worker: headless, long-lived, one per product, and the host boots
    // it once for every surface it serves (one WebView, one JS context).
    //
    // `includes.chat: false` (bulletin-deploy requires the key): the Daily Dollar's chat and background
    // registration run in Jollity's chat worker, and so do its pushes. The app
    // still registers while it is open.
    //
    // `includes.pocket` and `pocket.cards`: the Humanity card. The host pins
    // a `humanity` card for the `peopl` product on its own, drawn from a face
    // bundled with the app, and asks this worker to draw it only once this
    // record lists the card (the Android host's `PublishedPocketCards.find`).
    // `preview` is a path in this worker's published folder, shown until the
    // worker draws; a host refuses a URL there.
    //
    // bulletin-deploy (0.19.x) writes only `$v`, `kind`, `appVersion`,
    // `entrypoint` and `includes`, and drops `pocket` without a word, so
    // `scripts/publish-pocket-cards.mts` adds it to the published record
    // after every deploy (`npm run humanity:setup` runs it). Until the CLI composes it,
    // a publish on its own leaves the card on the app's placeholder.
    {
      kind: "worker" as const,
      path: "../../humanity-worker/dist",
      appVersion,
      entrypoint: "index.js",
      includes: { chat: false, pocket: true },
      pocket: {
        cards: [{ id: "humanity", title: "Humanity", preview: "pocket/devicehood.json" }],
      },
    },
  ],
  // Cross-product grants the host honours without a prompt, read from this
  // root manifest on chain (bulletin-deploy >= 0.19.0 writes them; hosts on
  // truapi-host >= 0.17.0 resolve them). See `trustedProductsFromEnv` below.
  trustedProducts: trustedProductsFromEnv(process.env.HUMANITY_TRUSTED_PRODUCTS),
};

/**
 * Cross-product grants, read from `HUMANITY_TRUSTED_PRODUCTS`. Unset or empty
 * means no grants: a deploy lets no other product act for it until the
 * deployer names one. The names are DotNS labels on the network being
 * deployed to, and only whoever owns a label there controls what it runs, so
 * list only products you own or trust.
 *
 * Format: a JSON object from a bare product label to the grants it gets.
 *
 *   HUMANITY_TRUSTED_PRODUCTS='{"dim2":["context","storage"]}'
 *
 * Each entry says what another product may do *to this one*:
 *  - `context`: act as this product's account — its identity, its
 *    signatures, its ring-VRF proofs. Deliberately wide: a product granted it
 *    can sign as this product. A game that signs a lite person up in one tap
 *    (instead of being refused as NotAllowlisted) needs it, and so does a
 *    second name serving these same bundles (a staging name built with the
 *    setup script's `--product-label`), whose ring-VRF proofs are minted with this
 *    product's key and have no prompt fallback (RFC-0024).
 *  - `storage`: read this product's host storage, every key, read-only. A
 *    game's chat worker uses it to read the Daily Dollar registry
 *    (`humanity:daily-dollar:<owner>`) so a ticket scratched here does not
 *    show as unscratched there; without it the read is refused with
 *    AccessNotGranted.
 *
 * Keys are bare labels: the host appends the network's TLD, so `dim2.paseo`
 * would name a product that does not exist and grant nothing (the CLI rejects
 * a suffixed key at config load, and so does this function). A key naming a
 * product that is not registered on the network is inert until someone
 * registers that name — which is why the default is empty.
 */
function trustedProductsFromEnv(
  raw: string | undefined,
): Record<string, Array<"context" | "storage">> {
  if (raw === undefined || raw.trim() === "") return {};
  const fail = (why: string): never => {
    throw new Error(
      `HUMANITY_TRUSTED_PRODUCTS ${why}. Expected a JSON object from a bare ` +
        `product label to its grants, e.g. '{"dim2":["context","storage"]}'.`,
    );
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("is not a JSON object");
  }
  const grants: Record<string, Array<"context" | "storage">> = {};
  for (const [label, value] of Object.entries(parsed)) {
    if (!/^[a-z0-9-]+$/.test(label)) {
      fail(`key "${label}" is not a bare DotNS label (no TLD, lowercase)`);
    }
    if (!Array.isArray(value) || value.length === 0) {
      fail(`"${label}" must map to a non-empty array of grants`);
    }
    for (const grant of value as unknown[]) {
      if (grant !== "context" && grant !== "storage") {
        fail(`"${label}" has unknown grant ${JSON.stringify(grant)} (known: context, storage)`);
      }
    }
    grants[label] = [...new Set(value as Array<"context" | "storage">)];
  }
  return grants;
}

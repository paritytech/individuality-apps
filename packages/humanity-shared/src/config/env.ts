// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * `import.meta.env` is read exactly once, here — the sole exception is
 * `@shared/config/debug-panel.ts`, which must keep its literal at the gate to
 * stay tree-shakeable. Vite statically replaces these at build time, so
 * nothing else downstream should touch `import.meta.env`.
 */

const peopleWsUrl = import.meta.env["VITE_PEOPLE_WS_URL"]?.trim() ?? "";
const network = import.meta.env["VITE_NETWORK"]?.trim() ?? "";
const localNetwork = Object.freeze({
  VITE_LOCAL_PEOPLE_WS_URL: import.meta.env["VITE_LOCAL_PEOPLE_WS_URL"],
  VITE_LOCAL_PEOPLE_GENESIS_HASH: import.meta.env["VITE_LOCAL_PEOPLE_GENESIS_HASH"],
  VITE_LOCAL_ASSET_HUB_WS_URL: import.meta.env["VITE_LOCAL_ASSET_HUB_WS_URL"],
  VITE_LOCAL_ASSET_HUB_GENESIS_HASH: import.meta.env["VITE_LOCAL_ASSET_HUB_GENESIS_HASH"],
});
/**
 * Bare DotNS label of the app's product account. The suffix belongs to the
 * network (see `NetworkConfig.dotnsSuffix`), so anything supplied here from the
 * first dot on is DISCARDED rather than honoured — recomposing it from
 * `VITE_NETWORK` is the whole point, and it is what silently makes a stale
 * `peopl.paseo` correct again on previewnet.
 *
 * The superseded `VITE_DOTNS_PRODUCT_DOMAIN` is still read as a label source so
 * an existing `.env` keeps working. It is reported, not enforced.
 *
 * Nothing here throws. A module-load throw in a browser is a blank page with
 * the reason buried in devtools — the quietest failure available, not the
 * loudest — and there is nothing worth failing on: a DotNS label is a single
 * segment, so trimming to it always yields the name the network would issue.
 */
const rawProductLabel = import.meta.env["VITE_DOTNS_PRODUCT_LABEL"]?.trim() ?? "";
const legacyProductDomain =
  import.meta.env["VITE_DOTNS_PRODUCT_DOMAIN"]?.trim() ?? "";
const rawLabelSource = (rawProductLabel || legacyProductDomain).toLowerCase();

const productLabel = rawLabelSource.split(".")[0] || "peopl";

// `console`, not the app logger: `logger.ts` reads this module, so importing it
// here would be a cycle. A config deprecation has to report before logging
// exists anyway.
if (rawProductLabel === "" && legacyProductDomain !== "") {
  console.warn(
    `VITE_DOTNS_PRODUCT_DOMAIN is superseded. Rename it to ` +
      `VITE_DOTNS_PRODUCT_LABEL=${productLabel}; the suffix now comes from VITE_NETWORK.`,
  );
} else if (rawLabelSource !== "" && rawLabelSource !== productLabel) {
  console.warn(
    `VITE_DOTNS_PRODUCT_LABEL="${rawLabelSource}" is not a bare label. ` +
      `Using "${productLabel}" and taking the suffix from VITE_NETWORK.`,
  );
}

/**
 * An optional subname to run under, for local development: `dev` puts the
 * product at `dev.<label>.<suffix>` instead of `<label>.<suffix>`.
 *
 * Why a subname and not another label: the host core decides cross-product
 * access from the label directly above the TLD, so `dev.peopl.testnet` reads
 * the game product's account exactly as `peopl.testnet` does, while it has a
 * product id of its own that a host can point at a laptop without disturbing
 * the published product. A label of its own (`humanity-dev`) would have no
 * such grant and no card to draw. Bare like the label; anything else is
 * ignored with a warning.
 */
const rawProductSubname = import.meta.env["VITE_DOTNS_PRODUCT_SUBNAME"]?.trim().toLowerCase() ?? "";
const productSubname = rawProductSubname.includes(".") ? "" : rawProductSubname;
if (rawProductSubname !== productSubname) {
  console.warn(`VITE_DOTNS_PRODUCT_SUBNAME="${rawProductSubname}" is not a bare label; ignoring it.`);
}
/** LogTape severity levels, least to most verbose. */
const LOG_LEVELS = [
  "fatal",
  "error",
  "warning",
  "info",
  "debug",
  "trace",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Bare label of the product whose host storage holds Jollity's game
 * registration record (`@individuality/shared-records`), when it is not the
 * game's own product. A preview build can read a sandboxed game deployment
 * this way: a sandbox that plays on `dim2`'s product account still derives
 * the account from `dim2`, but its storage is its own. Empty means the
 * game's product.
 */
const rawGameStorageLabel = import.meta.env["VITE_GAME_STORAGE_LABEL"]?.trim() ?? "";
if (rawGameStorageLabel.includes(".")) {
  console.warn(`VITE_GAME_STORAGE_LABEL="${rawGameStorageLabel}" is not a bare label; ignoring it.`);
}
const gameStorageLabel = rawGameStorageLabel.includes(".") ? "" : rawGameStorageLabel;

/** `VITE_LOG_LEVEL` picks the root LogTape threshold (default `info`). */
function parseLogLevel(raw: string | undefined): LogLevel {
  const level = raw?.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(level ?? "")
    ? (level as LogLevel)
    : "info";
}

const logLevel = parseLogLevel(import.meta.env["VITE_LOG_LEVEL"]);
/**
 * The `dim2.<tld>` product-account index the weekly game is played on: the
 * one candidate account this app reads the score, the game and the seat on,
 * and registers personhood as. Jollity signs people up at index 1
 * (`signupAccountIndex()` in packages/jollity-protocol/src/config.ts), so
 * that is the default;
 * `VITE_GAME_ACCOUNT_INDEX` overrides it for a build.
 */
const DEFAULT_GAME_ACCOUNT_INDEX = 1;
const rawGameAccountIndex = import.meta.env["VITE_GAME_ACCOUNT_INDEX"]?.trim() ?? "";
const gameAccountIndex = /^\d+$/.test(rawGameAccountIndex)
  ? Number(rawGameAccountIndex)
  : DEFAULT_GAME_ACCOUNT_INDEX;
if (rawGameAccountIndex !== "" && !/^\d+$/.test(rawGameAccountIndex)) {
  console.warn(
    `VITE_GAME_ACCOUNT_INDEX="${rawGameAccountIndex}" is not a non-negative integer; ` +
      `using ${DEFAULT_GAME_ACCOUNT_INDEX}.`,
  );
}

/**
 * Genesis hashes that replace a hosted network's built-in ones
 * (`VITE_PEOPLE_GENESIS_HASH`, `VITE_ASSET_HUB_GENESIS_HASH`). Previewnet's
 * genesis rotates on every reset, so a build for a reset previewnet sets them
 * instead of waiting for a code change. Each must be `0x` and 64 hex
 * characters; anything else is reported and ignored. Ignored for local, which
 * has its own required variables.
 */
function parseGenesisOverride(name: string, raw: string | undefined): `0x${string}` | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    console.warn(`${name}="${value}" is not 0x and 64 hex characters; ignoring it.`);
    return null;
  }
  return value.toLowerCase() as `0x${string}`;
}
const peopleGenesisHash = parseGenesisOverride(
  "VITE_PEOPLE_GENESIS_HASH",
  import.meta.env["VITE_PEOPLE_GENESIS_HASH"],
);
const assetHubGenesisHash = parseGenesisOverride(
  "VITE_ASSET_HUB_GENESIS_HASH",
  import.meta.env["VITE_ASSET_HUB_GENESIS_HASH"],
);

/** True only in `vite dev`; a production build folds this to `false` so
 *  dev-only surfaces drop out entirely. */
const dev = import.meta.env.DEV;

/**
 * Sentry. The DSN is the deployer's own and lives outside the repo
 * (`VITE_SENTRY_DSN` at build time); unset means telemetry is compiled in but
 * never initialised, so nothing is sent: not from `vite dev`, a test run, or
 * any build without one. `VITE_SENTRY_TRACES_SAMPLE_RATE` (0–1, default
 * 0.1) samples the flow transactions: one in ten is enough for p50/p95 per
 * story, and the worker's beat and the card refetch would otherwise burn the
 * quota. Errors are never sampled. The release is baked in by the
 * build (`__APP_RELEASE__`, see each `vite.config.ts`).
 *
 * `VITE_SENTRY_SEND_IDENTITY` is the opt-in for who a report is about:
 * usernames and account addresses. Only `true` turns it on; unset, a build
 * with a DSN still reports errors and timings, with those left out of the
 * contexts and tags and redacted from the text it sends (`redact.ts`).
 */
const DEFAULT_TRACES_SAMPLE_RATE = 0.1;
const sentryDsn = import.meta.env["VITE_SENTRY_DSN"]?.trim() ?? "";
const rawTracesSampleRate = import.meta.env["VITE_SENTRY_TRACES_SAMPLE_RATE"]?.trim() ?? "";
const parsedTracesSampleRate = Number(rawTracesSampleRate);
const tracesSampleRate =
  rawTracesSampleRate !== "" && parsedTracesSampleRate >= 0 && parsedTracesSampleRate <= 1
    ? parsedTracesSampleRate
    : DEFAULT_TRACES_SAMPLE_RATE;
if (rawTracesSampleRate !== "" && tracesSampleRate !== parsedTracesSampleRate) {
  console.warn(
    `VITE_SENTRY_TRACES_SAMPLE_RATE="${rawTracesSampleRate}" is not in 0..1; using ${DEFAULT_TRACES_SAMPLE_RATE}.`,
  );
}
const sendIdentity =
  (import.meta.env["VITE_SENTRY_SEND_IDENTITY"]?.trim().toLowerCase() ?? "") === "true";
declare const __APP_RELEASE__: string | undefined;
const release =
  typeof __APP_RELEASE__ === "string" && __APP_RELEASE__ !== "" ? __APP_RELEASE__ : null;

export interface EnvConfig {
  readonly chain: {
    readonly network: string;
    /** null when unset — callers fall back to the network registry default. */
    readonly peopleWsUrl: string | null;
    readonly localNetwork: import("./local-network.ts").LocalNetworkEnv;
    /** Hosted-network genesis overrides, null when unset; ignored for local. */
    readonly genesisOverride: {
      readonly people: `0x${string}` | null;
      readonly assetHub: `0x${string}` | null;
    };
    /** `dim2.<tld>` product-account index the game is played on. */
    readonly gameAccountIndex: number;
    /** Bare label of the product whose storage holds the game registration
     *  record, or `""` for the game's own product (`VITE_GAME_STORAGE_LABEL`). */
    readonly gameStorageLabel: string;
  };
  readonly host: {
    /** Bare DotNS label of the app-scoped host product account. Compose it
     *  into a name with `dotnsName(network, label)` — never concatenate a
     *  suffix at the call site. */
    readonly productLabel: string;
    /** Subname the product runs under, or `""` for the product itself. */
    readonly productSubname: string;
  };
  readonly logging: {
    /** Root LogTape threshold; `trace` is the most verbose. */
    readonly level: LogLevel;
  };
  readonly telemetry: {
    /** Sentry DSN, or null when this build reports nothing. */
    readonly sentryDsn: string | null;
    /** Fraction of flow transactions kept, 0–1. */
    readonly tracesSampleRate: number;
    /** Whether reports may name the person: usernames and account addresses
     *  (`VITE_SENTRY_SEND_IDENTITY=true`). Off unless set. */
    readonly sendIdentity: boolean;
    /** `<package>@<version>+<short sha>` from the build, or null in tests. */
    readonly release: string | null;
  };
  /** Development build (`npm run humanity:dev`). */
  readonly dev: boolean;
}

export const envConfig: EnvConfig = Object.freeze({
  chain: Object.freeze({
    network,
    peopleWsUrl: network === "local" || peopleWsUrl === "" ? null : peopleWsUrl,
    localNetwork,
    genesisOverride: Object.freeze({ people: peopleGenesisHash, assetHub: assetHubGenesisHash }),
    gameAccountIndex,
    gameStorageLabel,
  }),
  host: Object.freeze({
    productLabel,
    productSubname,
  }),
  logging: Object.freeze({
    level: logLevel,
  }),
  telemetry: Object.freeze({
    sentryDsn: sentryDsn === "" ? null : sentryDsn,
    tracesSampleRate,
    sendIdentity,
    release,
  }),
  dev,
});

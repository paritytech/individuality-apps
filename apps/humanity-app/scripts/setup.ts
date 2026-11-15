#!/usr/bin/env node
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Build and deploy the Humanity SPA product to `<label>.<tld>` via
 * `bulletin-deploy`.
 *
 * Reads the app's dotenv cascade (`apps/humanity-app/.env*`; an exported shell
 * variable always wins),
 * builds the two shipping workspaces with the resolved `VITE_*` values, then
 * hands the app's build directory to the `bulletin-deploy` CLI.
 *
 * The product ships TWO executables, out of two packages: the app
 * (`@humanity/app` -> `apps/humanity-app/dist`) and the headless Pocket card
 * worker (`@humanity/worker` -> `apps/humanity-worker/dist`). The repo
 * root's `build` script chains both, which is what this script runs. The
 * worker is declared in the product manifest, so `--no-manifest` deploys the
 * app alone and the worker output is irrelevant there.
 *
 * Both the app and the worker read their env files from `apps/humanity-app`,
 * and this script also injects the app's `.env` into the build's environment,
 * so both builds see the same `VITE_*`.
 *
 * Usage:
 *   npm run humanity:setup -- [--env preview|paseo-next-v2] [--publish|--no-publish]
 *                             [--no-manifest] [--skip-build] [--dry-run]
 *
 * A deploy needs `DOTNS_LABEL` and `DOTNS_MNEMONIC`. A `--dry-run` needs
 * neither: it prints the plan for `peopl` (the product's own name) and
 * reports whether a deploy key is set.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkTarget, stackCheckDisabled } from "./trinity-stacks.mts";

const ENV_FILES = [
  ".env.production.local",
  ".env.production",
  ".env.local",
  ".env",
] as const;

const MIN_BULLETIN_DEPLOY = "0.25.0";

/**
 * Per-environment values owned by the network's Trinity stack descriptor.
 * `tld` and `gateway` are copies of network data and are cross-checked against
 * the live descriptor on every run — see assertTargetMatchesStack.
 */
interface DeployTarget {
  /** DotNS suffix the CLI appends to a bare label. */
  tld: string;
  /** Host used to build the post-deploy URL. */
  gateway: string;
  /** SPA chain registry key handed to the build as VITE_NETWORK. */
  network: string;
  /** Whether the env has a deployed Publisher registry. */
  publishable: boolean;
}

const DEPLOY_TARGETS: Record<string, DeployTarget> = {
  preview: {
    tld: "testnet",
    gateway: "testnet.li",
    network: "previewnet",
    publishable: false,
  },
  "paseo-next-v2": {
    tld: "paseo",
    gateway: "paseo.li",
    network: "paseo-next-v2",
    publishable: false,
  },
};

// Keep historical `test` so a stale Preview name receives the explicit
// wrong-environment error instead of being parsed as a subdomain label.
const KNOWN_TLDS = ["dot", "paseo", "test", "testnet"];

/**
 * The product's own bare label. A dry run plans for it when DOTNS_LABEL is
 * unset; a deploy never assumes it, so nothing reaches the product's name by
 * omission.
 */
const PRODUCT_LABEL = "peopl";

interface Flags {
  env?: string;
  publish?: boolean;
  skipBuild: boolean;
  buildOnly: boolean;
  dryRun: boolean;
  allowNetworkMismatch: boolean;
  jsMerkle: boolean;
  noManifest: boolean;
  /** Bare label the bundles derive the on-chain product account from, when
   *  it differs from the served name. Unset means the served label. */
  productLabel?: string;
}

class SetupError extends Error {}

function fail(message: string, ...detail: string[]): never {
  throw new SetupError([message, ...detail].join("\n"));
}

function loadEnvFile(path: string): boolean {
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed
      .slice(equals + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
  }
  return true;
}

/** The app package (`apps/humanity-app`) and the repository root above it. */
function locate(): { app: string; root: string } {
  const entry = process.argv[1];
  if (!entry) fail("Cannot resolve the app directory: process.argv[1] is empty.");
  const app = resolve(dirname(entry), "..");
  const root = resolve(app, "../..");
  if (!existsSync(resolve(app, "package.json")) || !existsSync(resolve(root, "package.json"))) {
    fail(
      `Cannot resolve the app directory from ${entry}.`,
      "Expected this script to live at <repo-root>/apps/humanity-app/scripts/setup.ts.",
    );
  }
  return { app, root };
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    skipBuild: false,
    buildOnly: false,
    dryRun: false,
    allowNetworkMismatch: false,
    jsMerkle: true,
    noManifest: false,
  };
  const requireValue = (name: string, value: string | undefined): string => {
    if (!value || value.startsWith("-")) fail(`${name} requires a value.`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--env":
        flags.env = requireValue("--env", argv[(i += 1)]);
        break;
      case "--publish":
        flags.publish = true;
        break;
      case "--no-publish":
        flags.publish = false;
        break;
      case "--skip-build":
        flags.skipBuild = true;
        break;
      case "--build-only":
        flags.buildOnly = true;
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--allow-network-mismatch":
        flags.allowNetworkMismatch = true;
        break;
      case "--no-js-merkle":
        flags.jsMerkle = false;
        break;
      case "--no-manifest":
        flags.noManifest = true;
        break;
      case "--product-label":
        flags.productLabel = requireValue("--product-label", argv[(i += 1)]);
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        fail(`Unknown argument: ${arg}`, "Run with --help to see usage.");
    }
  }
  return flags;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Build and deploy the Humanity SPA.",
      "",
      "Usage: npm run humanity:setup -- [options]",
      "",
      "Options:",
      "  --env <id>        preview | paseo-next-v2 (default: BULLETIN_ENV, else",
      "                    derived from VITE_NETWORK, else paseo-next-v2)",
      "  --publish         List the name in the on-chain Publisher registry",
      "  --no-publish      Upload only (default)",
      "  --skip-build      Deploy the existing apps/humanity-app/dist and",
      "                    apps/humanity-worker/dist trees",
      "  --build-only      Build the app and worker bundles and stop before any deploy",
      "  --dry-run         Print the resolved plan and exit without building or deploying",
      "  --allow-network-mismatch",
      "                    Permit a VITE_NETWORK that disagrees with the environment",
      "  --no-js-merkle    Use IPFS Kubo instead of pure-JS merkleization",
      "  --no-manifest     Use bulletin-deploy's legacy positional deploy mode:",
      "                    deploys the app only. The worker executable is declared",
      "                    in the manifest, so it requires the manifest.",
      "  --product-label <label>",
      "                    Bare label the app and worker derive the on-chain",
      "                    product account from, when the served name is not the",
      "                    product's own (a preview served as myapp-preview",
      "                    can still act for myapp). Defaults to the served label.",
      "  -h, --help        Show this help",
      "",
      "Environment (apps/humanity-app/.env cascade; shell wins):",
      "  DOTNS_MNEMONIC / MNEMONIC   12- or 24-word DotNS owner phrase. Required",
      "                              for a deploy; a --dry-run runs without it.",
      "  BULLETIN_ENV                Deploy environment id.",
      "  DOTNS_LABEL                 Bare DotNS label for the served name and the",
      "                              on-chain product account. Required for a",
      "                              deploy; a --dry-run plans for peopl without it.",
      "  BULLETIN_DEPLOY_PUBLISH     true to pass --publish.",
      "  VITE_NETWORK                previewnet | paseo-next-v2; also selects the",
      "                              default deploy environment.",
      "  HUMANITY_TRUSTED_PRODUCTS   JSON grants for other products; empty grants",
      "                              none (see deploy/bulletin-deploy.config.ts).",
      "  HUMANITY_STACK_LINK_PREVIEW / HUMANITY_STACK_LINK_PASEO_NEXT_V2",
      "                              Trinity stack descriptor link the TLD and",
      "                              gateway are checked against.",
      "",
    ].join("\n"),
  );
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return undefined;
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return undefined;
}

/**
 * The deploy phrase, when one is set: DOTNS_MNEMONIC, or its alias MNEMONIC.
 * Undefined when neither is, so a dry run can report the gap instead of
 * failing on it; a phrase that is set but malformed is always an error.
 */
function findMnemonic(): string | undefined {
  const dotns = (process.env["DOTNS_MNEMONIC"] ?? "").trim().replace(/\s+/g, " ");
  const generic = (process.env["MNEMONIC"] ?? "").trim().replace(/\s+/g, " ");
  if (dotns && generic && dotns !== generic) {
    fail(
      "DOTNS_MNEMONIC and MNEMONIC are both set to different values.",
      "Remove one of them so the deploying account is unambiguous.",
    );
  }
  const mnemonic = dotns || generic;
  if (!mnemonic) return undefined;
  const words = mnemonic.split(" ").length;
  if (words !== 12 && words !== 24) {
    fail(`Deploy mnemonic has ${words} words; expected 12 or 24.`);
  }
  return mnemonic;
}

/**
 * The CLI silently falls back to a well-known dev account when no mnemonic is
 * present, which would deploy from the wrong owner, so an absent phrase is a
 * hard error for a deploy rather than a default.
 */
function requireMnemonic(): string {
  const mnemonic = findMnemonic();
  if (!mnemonic) {
    fail(
      "No deploy mnemonic found.",
      "Set DOTNS_MNEMONIC (or MNEMONIC) in apps/humanity-app/.env, or export it:",
      '  export DOTNS_MNEMONIC="your twelve word phrase ..."',
      "Refusing to continue: bulletin-deploy would fall back to a shared dev account.",
    );
  }
  return mnemonic;
}

function resolveLabel(raw: string, tld: string): string {
  const label = raw.trim().replace(/^\.+|\.+$/g, "");
  if (!label) fail("DotNS label is empty.");
  if (label.endsWith(`.${tld}`)) return label.slice(0, -(tld.length + 1));
  const suffix = label.includes(".") ? label.slice(label.lastIndexOf(".") + 1) : "";
  if (!suffix) return label;
  if (KNOWN_TLDS.includes(suffix)) {
    fail(
      `DotNS label "${label}" ends in .${suffix}, but this environment uses .${tld} names.`,
      "Pass the bare label instead; bulletin-deploy appends the environment's TLD.",
    );
  }
  fail(
    `DotNS label "${label}" carries an unsupported suffix .${suffix}.`,
    `Pass a bare label; bulletin-deploy will deploy it as <label>.${tld}.`,
  );
}

function versionGte(current: string, minimum: string): boolean {
  const semver = /(\d+)\.(\d+)\.(\d+)/;
  const found = (current.match(semver)?.slice(1, 4) ?? []).map(Number);
  const want = (minimum.match(semver)?.slice(1, 4) ?? []).map(Number);
  if (found.length !== 3) return false;
  for (let i = 0; i < 3; i += 1) {
    if (found[i] !== want[i]) return found[i] > want[i];
  }
  return true;
}

function assertBulletinDeploy(): string {
  const probe = spawnSync("bulletin-deploy", ["--version"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (probe.error || probe.status !== 0) {
    fail(
      "bulletin-deploy is not available on PATH.",
      "Install it first:",
      "  npm install -g bulletin-deploy@0.25.0",
    );
  }
  const version = `${probe.stdout}`.trim();
  if (!versionGte(version, MIN_BULLETIN_DEPLOY)) {
    fail(
      `bulletin-deploy ${version} is older than the required ${MIN_BULLETIN_DEPLOY}.`,
      "Update it:",
      "  npm install -g bulletin-deploy@0.25.0",
    );
  }
  return version;
}

/**
 * `tld` and `gateway` above are the network's to change, and it did: preview
 * has changed this suffix during resets (`.dot` -> `.test` -> `.testnet`). A
 * stale copy makes every deploy die late inside the CLI on the manifest domain
 * comparison, with no hint that this table was the cause. Compare the copies
 * with the live network descriptor (bulletin-deploy bundles a copy of it, but
 * does not export it) before any build, so the drift names itself. An
 * unreachable descriptor skips the check with a note.
 */
async function assertTargetMatchesStack(envId: string, target: DeployTarget): Promise<void> {
  if (stackCheckDisabled(process.env["HUMANITY_SETUP_SKIP_STACK_CHECK"])) return;
  const result = await checkTarget(envId, target);
  if (result.status === "skipped") process.stderr.write(`Note: ${result.note}\n`);
  if (result.status !== "drift") return;
  fail(
    `DEPLOY_TARGETS["${envId}"] disagrees with the network's Trinity stack descriptor:`,
    ...result.lines.map((line) => `  ${line}`),
    "Update DEPLOY_TARGETS in scripts/setup.ts to match, then re-run.",
  );
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) fail(`Failed to spawn ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited with status ${result.status ?? "unknown"}.`);
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const { app, root } = locate();

  const loaded = ENV_FILES.filter((name) => loadEnvFile(resolve(app, name)));

  const requestedNetwork = process.env["VITE_NETWORK"]?.trim() || undefined;
  const networkEnvId = Object.keys(DEPLOY_TARGETS).find(
    (id) => DEPLOY_TARGETS[id]?.network === requestedNetwork,
  );
  if (requestedNetwork && !networkEnvId) {
    fail(
      `VITE_NETWORK="${requestedNetwork}" is not a deployable network.`,
      `Expected one of: ${Object.values(DEPLOY_TARGETS)
        .map((entry) => entry.network)
        .join(", ")}.`,
    );
  }
  const envId = (
    flags.env ??
    process.env["BULLETIN_ENV"] ??
    networkEnvId ??
    "paseo-next-v2"
  ).trim();
  const target = DEPLOY_TARGETS[envId];
  if (!target) {
    fail(
      `Unsupported deploy environment "${envId}".`,
      `Expected one of: ${Object.keys(DEPLOY_TARGETS).join(", ")}.`,
    );
  }
  await assertTargetMatchesStack(envId, target);

  // A dry run shows the plan for the product's own name when no label is
  // set; a deploy must name its target.
  const rawLabel = process.env["DOTNS_LABEL"]?.trim();
  if (!rawLabel && !flags.dryRun) {
    fail(
      "DOTNS_LABEL is required.",
      "Set it in apps/humanity-app/.env or export it before deploying.",
    );
  }
  const label = resolveLabel(rawLabel || PRODUCT_LABEL, target.tld);
  const domain = `${label}.${target.tld}`;
  const labelNote = rawLabel ? "" : " (DOTNS_LABEL unset; the product's own name)";
  // Read, not required, so the plan can say whether a deploy could follow.
  // The deploy itself insists on it below, after the dry run has exited.
  const deployKey = findMnemonic();

  const publish =
    flags.publish ??
    parseBoolean(process.env["BULLETIN_DEPLOY_PUBLISH"]) ??
    false;
  if (publish && !target.publishable) {
    fail(
      `--publish is unavailable on "${envId}": it has no deployed Publisher registry.`,
      "Re-run without --publish; neither Humanity deployment target currently has a Publisher registry.",
    );
  }

  // The served name and the product the bundles act for are usually the same
  // label. A preview or staging name served under its own label can still
  // derive the on-chain product account of the main name (`--product-label`), or
  // it reads an account nobody funded (and staging's bytes could not be
  // promoted unchanged).
  const productLabel =
    flags.productLabel == null ? label : resolveLabel(flags.productLabel, target.tld);
  const productDomain = `${productLabel}.${target.tld}`;
  if (
    requestedNetwork &&
    requestedNetwork !== target.network &&
    !flags.allowNetworkMismatch
  ) {
    fail(
      `VITE_NETWORK="${requestedNetwork}" disagrees with the "${envId}" deploy environment, which serves the "${target.network}" chain registry.`,
      "The bundle would read a different chain than the network it is deployed on.",
      `Fix it either way: deploy to "${networkEnvId}" by dropping --env/BULLETIN_ENV, or set VITE_NETWORK=${target.network}.`,
      "Pass --allow-network-mismatch only if the split is deliberate.",
    );
  }
  const network = requestedNetwork ?? target.network;
  const distDir = resolve(app, "dist");
  const workerDir = resolve(root, "apps/humanity-worker/dist");
  const workerEntry = resolve(workerDir, "index.js");
  const manifestPath = resolve(app, "deploy/bulletin-deploy.config.ts");
  const iconPath = resolve(app, "deploy/icon.png");
  const version = assertBulletinDeploy();

  process.stdout.write(
    [
      "",
      "Humanity deploy",
      `  env files:        ${loaded.length ? loaded.join(", ") : "(none found)"}`,
      `  bulletin-deploy:  ${version}`,
      `  environment:      ${envId}`,
      `  domain:           ${domain}${labelNote}`,
      `  product domain:   ${productDomain}`,
      `  deploy key:       ${deployKey ? `set (${deployKey.split(" ").length} words)` : "none; a deploy needs DOTNS_MNEMONIC"}`,
      `  manifest:         ${flags.noManifest ? "disabled (--no-manifest)" : manifestPath}`,
      `  VITE_NETWORK:     ${network}`,
      `  publish:          ${publish ? "yes" : "no (upload only)"}`,
      `  js merkle:        ${flags.jsMerkle ? "yes" : "no"}`,
      `  spa:              ${flags.skipBuild ? "deploy existing dist (--skip-build)" : "build and deploy"}`,
      `  dist:             ${distDir}`,
      `  worker:           ${flags.noManifest ? "not deployed (--no-manifest ships the app only)" : workerEntry}`,
      "",
    ].join("\n"),
  );

  if (flags.dryRun) {
    process.stdout.write("Dry run: nothing was built or deployed.\n");
    return;
  }
  // Before the build, so a missing key fails in a second, not after a build;
  // and as a string, so the CLI never sees MNEMONIC unset and its dev phrase.
  const mnemonic = requireMnemonic();
  if (!flags.noManifest && !flags.buildOnly) {
    for (const path of [manifestPath, iconPath]) {
      if (!existsSync(path)) fail(`Missing deployment file: ${path}`);
    }
  }

  if (!flags.skipBuild) {
    // One command, two executables: the repo root's `humanity:build` script
    // chains `@humanity/app` and `@humanity/worker`, so the worker bundle is
    // produced here too, from the same injected `VITE_*` values as the app.
    // Keeping it in the root script (rather than a second `run(...)` here)
    // means `npm run humanity:build` in CI proves the worker bundles as well.
    run("npm", ["run", "humanity:build"], root, {
      ...process.env,
      VITE_DOTNS_PRODUCT_LABEL: productLabel,
      VITE_NETWORK: network,
    });
  }

  if (!existsSync(resolve(distDir, "index.html"))) {
    fail(
      `No build output at ${distDir}.`,
      flags.skipBuild
        ? "Drop --skip-build so the bundle is built first."
        : "The build reported success but produced no index.html.",
    );
  }

  // The worker is reachable only through the manifest, so it is only required
  // when the manifest is in use. A gap here means either --skip-build over a
  // dist tree built before the worker existed, or a build that stopped
  // chaining `@humanity/worker` — either way the deploy would publish a
  // `worker.<name>` record pointing at nothing.
  if (!flags.noManifest && !existsSync(workerEntry)) {
    fail(
      `No worker build output at ${workerEntry}.`,
      flags.skipBuild
        ? "Drop --skip-build so the worker is built too, or build it alone: npm run build --workspace @humanity/worker."
        : "The build reported success but produced no worker bundle; check that the root humanity:build script still chains @humanity/worker.",
      "Or pass --no-manifest to deploy the app alone, without the worker.",
    );
  }

  if (flags.buildOnly) {
    process.stdout.write(
      `\nBuilt ${distDir}${flags.noManifest ? "" : ` and ${workerDir}`}. Stopping before deploy (--build-only).\n` +
        `Deploy it with: npm run humanity:setup -- --env ${envId} --skip-build\n`,
    );
    return;
  }

  const deployArgs = ["--env", envId];
  if (!flags.noManifest) deployArgs.push("--config", manifestPath);
  if (flags.jsMerkle) deployArgs.push("--js-merkle");
  if (publish) deployArgs.push("--publish");
  deployArgs.push(distDir, flags.noManifest ? label : domain);
  // The phrase travels in the CLI's MNEMONIC env var, never in argv: argv is
  // echoed by this script's own failure message (and by `ps`), and a CI log
  // must not carry the deploy key even though Actions masks known secrets.
  const deployEnv: NodeJS.ProcessEnv = { ...process.env, MNEMONIC: mnemonic };
  if (!flags.noManifest) deployEnv["DEPLOY_DOMAIN"] = domain;
  run("bulletin-deploy", deployArgs, root, deployEnv);
  // bulletin-deploy drops the worker's `pocket.cards`, and a host draws the
  // Humanity card from the worker only once they are published; this adds
  // them to the record the CLI just wrote (see the script's header).
  if (!flags.noManifest) {
    run(
      resolve(root, "node_modules/.bin/tsx"),
      [resolve(app, "scripts/publish-pocket-cards.mts"), "--env", envId],
      root,
      deployEnv,
    );
  }

  const url = `https://${label}.${target.gateway}`;
  process.stdout.write(
    `\nDeployed\n  spa     ${url}\n` +
      (flags.noManifest
        ? ""
        : `  worker  ${workerDir} (Pocket card worker of ${domain})\n`),
  );
  reportToGitHubActions({ envId, domain, url });
}

/**
 * Under GitHub Actions, surface the result where the run shows it: `url` and
 * `domain` as step outputs (a deploy workflow can feed `url` to its
 * environment's deployment link) and a line in the job summary. A no-op
 * elsewhere.
 */
function reportToGitHubActions(result: { envId: string; domain: string; url: string }): void {
  const output = process.env["GITHUB_OUTPUT"];
  if (output) {
    appendFileSync(output, `url=${result.url}\ndomain=${result.domain}\n`);
  }
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) {
    appendFileSync(
      summary,
      `Deployed \`${result.domain}\` to **${result.envId}** → ${result.url}\n`,
    );
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof SetupError) {
    process.stderr.write(`\nError: ${error.message}\n\n`);
    process.exit(1);
  }
  throw error;
}

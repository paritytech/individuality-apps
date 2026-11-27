// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Run Seity inside a local `truapi-host` (the trinity-user-agents CLI).
 *
 *   npm run dev:host                          # paseo-next-v2
 *   npm run dev:host -- --network previewnet
 *   HOST_SESSION=second npm run dev:host      # an independent person
 *   HOST_CLI_SIGNER_MNEMONIC="…" npm run dev:host   # run as an existing identity
 *
 * A trimmed copy of `apps/humanity-app/scripts/dev-host.mjs`, with one thing
 * kept on purpose: the host serves the app as **`peopl.<tld>`**, the
 * personhood product, as Humanity is deployed. That product's account 0 holds
 * the person's usernames (RFC-0028, in `truapi-host` 0.32.0 and later), and the
 * host hands a product its own accounts, so this lets Seity sign the profile
 * write. A product under any other id would need a grant for it.
 *
 * Host state is kept in the git-ignored `.truapi-host/<slot>/`; delete it for
 * a fresh person. The first run creates a lite person (`seityavatar.NN`) and
 * takes about a minute, printing nothing until "Paired with seityavatar.NN".
 *
 * The installed `truapi-host` must match `@parity/truapi` in this app's
 * package-lock.json: they speak one wire codec.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  installCommand,
  installedHostVersion,
  lockedTruapiVersion,
  versionSkew,
} from "../../../scripts/lib/truapi-host-version.mjs";

/** See Humanity's dev-host for why previewnet needs its PoP controller pinned. */
const NETWORKS = {
  previewnet: { tld: "testnet", popController: "0xCC932348606cc1f3318cADeC5A5Cd2CA447f8a4b" },
  "paseo-next-v2": { tld: "paseo" },
};

const args = process.argv.slice(2);
const networkIdx = args.indexOf("--network");
const network = networkIdx === -1 ? "paseo-next-v2" : args[networkIdx + 1];
if (!(network in NETWORKS)) {
  console.error(`unknown --network "${network}"; one of ${Object.keys(NETWORKS).join(", ")}`);
  process.exit(2);
}
const { tld, popController } = NETWORKS[network];
const productId = `peopl.${tld}`;

const appDir = fileURLToPath(new URL("..", import.meta.url));
const slot = process.env["HOST_SESSION"]?.trim() || "default";
const signerMnemonic = process.env["HOST_CLI_SIGNER_MNEMONIC"]?.trim() || "";
const basePath = resolve(appDir, ".truapi-host", slot);
// The CLI keeps sessions under `<base-path>/v2/<network>/<name>_signing_host`
// and only the name restores one, so reuse whichever the slot holds.
const sessionsDir = join(basePath, "v2", network);
/** The CLI creates an account only for a name with at least 6 lowercase ASCII letters. */
function hasEnoughLetters(name) {
  return (name.match(/[a-z]/g) ?? []).length >= 6;
}
const existing = existsSync(sessionsDir)
  ? readdirSync(sessionsDir)
      .map((dir) => /^(.+)_signing_host$/.exec(dir)?.[1])
      // A name the CLI refuses (see below) only ever leaves an empty folder.
      .filter((name) => name && hasEnoughLetters(name))
      .sort(
        (a, b) =>
          statSync(join(sessionsDir, `${b}_signing_host`)).mtimeMs -
          statSync(join(sessionsDir, `${a}_signing_host`)).mtimeMs,
      )
  : [];
/**
 * A new session's lite username stem. The CLI needs at least 6 lowercase
 * ASCII letters in it to create an account (digits and separators do not
 * count), so `seity` alone is refused. HOST_USERNAME overrides.
 */
const session =
  existing[0] ??
  process.env["HOST_USERNAME"]?.trim() ??
  (slot === "default" ? "seityavatar" : slot.toLowerCase().replace(/[^a-z0-9]/g, ""));
if (!existing[0] && !signerMnemonic && !hasEnoughLetters(session)) {
  console.error(
    `session name "${session}" needs at least 6 lowercase letters for the CLI to create an account; ` +
      "pick another HOST_SESSION or set HOST_USERNAME",
  );
  process.exit(2);
}

const hostPort = Number(process.env["HOST_PORT"] ?? 9965);
const appPort = Number(process.env["APP_PORT"] ?? 5190);

console.log(`• Host product ${productId} on ${network}`);
console.log(
  signerMnemonic
    ? "• Signing as the identity behind HOST_CLI_SIGNER_MNEMONIC"
    : existing.length > 0
      ? `• Session ${session} from .truapi-host/${slot}`
      : `• New session: creating lite person ${session}.NN (about a minute; wait for "Paired with")`,
);

const truapiVersion = lockedTruapiVersion(appDir);
const skew = versionSkew(installedHostVersion(), truapiVersion);
if (skew) console.warn(`warning: ${skew}`);

const child = spawn(
  "truapi-host",
  [
    "dev",
    "--network",
    network,
    "--base-path",
    basePath,
    "--port",
    String(hostPort),
    "--app-port",
    String(appPort),
    ...(signerMnemonic ? [] : ["--session", session]),
    "--product-id",
    productId,
    "--",
    "npm",
    "run",
    "dev",
    "--",
    "--port",
    String(appPort),
  ],
  {
    cwd: appDir,
    stdio: "inherit",
    env: {
      // The CLI updates itself to the latest release on start. The app bundles
      // one @parity/truapi and the two speak one wire codec, so keep the CLI on
      // the version the lockfile names; reinstall it to move.
      TRUAPI_HOST_NO_UPDATE: "1",
      ...process.env,
      ...(popController && !process.env["HOST_CLI_DOTNS_POP_CONTROLLER"]
        ? { HOST_CLI_DOTNS_POP_CONTROLLER: popController }
        : {}),
      VITE_NETWORK: network,
      VITE_HOST_BRIDGE_URL: `http://127.0.0.1:${hostPort}/bootstrap.js`,
    },
  },
);
child.on("error", (err) => {
  if (err.code === "ENOENT") {
    console.error(
      `truapi-host not found on PATH. Install the version of @parity/truapi in package-lock.json${
        truapiVersion ? ` (${truapiVersion})` : ""
      }:\n  ${installCommand(truapiVersion)}`,
    );
    process.exit(127);
  }
  throw err;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Run the SPA hosted against a local `truapi-host` (the trinity-user-agents CLI).
 *
 *   npm run humanity:dev:host              # paseo-next-v2, product peopl.paseo
 *   npm run humanity:dev:host -- --network previewnet
 *   HOST_SESSION=humanity.62 npm run humanity:dev:host
 *   HOST_CLI_SIGNER_MNEMONIC="…" HOST_SESSION=phone npm run humanity:dev:host
 *
 * HOST_CLI_SIGNER_MNEMONIC (the CLI's own variable) runs the host as an
 * existing identity — the one your phone holds, say — instead of creating a
 * throwaway person. The CLI forbids `--session` in that mode, so none is
 * passed; the slot still keeps the state apart from other runs.
 *
 * The host serves the product under its deployed name, `peopl.<tld>` —
 * `peopl.testnet` on previewnet, `peopl.paseo` on paseo-next-v2 — which is
 * also the id the person keys derive under (see `product-domain.ts`), so the
 * app owns its keys here exactly as it does inside a phone host.
 *
 * This needs the `truapi-host` whose version is the `@parity/truapi`
 * package-lock.json resolves: the CLI ships in the same trinity-user-agents
 * release as that library, and the two speak one wire codec. The install hint
 * below reads the version from the lockfile, and the launcher warns when the
 * installed CLI's major.minor differs (scripts/lib/truapi-host-version.mjs at
 * the repository root). The username claim needs the unwatermarked signing
 * calls added in paritytech/trinity-user-agents#731. Cores older than that
 * also pinned their reserved keys to `peopl.dot`
 * (trinity-user-agents#619, fixed in PR 627), so a phone identity paired without a
 * username and a CLI-made person held keys in no ring this app reads.
 * Sessions such a CLI created hold those keys; delete the slot and onboard
 * again.
 *
 * HOST_WORKER=1 also runs the worker: `vite build --watch`
 * writes `apps/humanity-worker/dist-dev/index.js`, the host serves it and boots it from
 * `http://127.0.0.1:<host port>/chat`. It is off by default because it passes
 * `--worker-bundle`, which released `truapi-host` builds reject until
 * paritytech/trinity-user-agents#1061 lands; use it with a source build of that PR.
 *
 * Host state (the signer identity) is kept in the git-ignored `.truapi-host/`
 * so restarts reuse it and deleting it starts over. HOST_SESSION=<name> is a
 * second, independent one.
 *
 * Every instance needs its own host port and app port, and the bridge script
 * `vite dev` injects has to point at *its* host. This picks the first free
 * pair from 9955/5183 upward and wires the three together, so a second run
 * (another session, another network) starts alongside the first instead of
 * failing on `Address already in use`. HOST_PORT / APP_PORT pin them.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installCommand,
  installedHostVersion,
  lockedTruapiVersion,
  versionSkew,
} from "../../../scripts/lib/truapi-host-version.mjs";

/**
 * `popController`: the `DotnsPopController` H160 the CLI reads usernames from,
 * handed over as `HOST_CLI_DOTNS_POP_CONTROLLER` where the CLI's own on-chain
 * discovery cannot find it. Discovery reads `DotnsGateway.DispatcherAddress`
 * and asks that contract `protocolRegistry()`. On previewnet the pallet stores
 * `0xa889…c3db`, an address with no code there (every view returns empty
 * success, `Revive.AccountInfoOf` is unset), so the CLI logs
 * `DotnsPopController.protocolRegistry(): ABI decode failed at word` thirty
 * times and gives up. The controller itself is deployed and answers; this is
 * the address trinity-user-agents' SPEC.md §21 names for both networks. On
 * paseo-next-v2 the stored address is a live `RootGatewayDispatcher`, so
 * discovery works and nothing is overridden. Drop the previewnet entry once
 * its gateway pallet is repointed.
 */
const NETWORKS = {
  previewnet: {
    tld: "testnet",
    popController: "0xCC932348606cc1f3318cADeC5A5Cd2CA447f8a4b",
  },
  "paseo-next-v2": { tld: "paseo" },
};

const args = process.argv.slice(2);
const networkIdx = args.indexOf("--network");
const network = networkIdx === -1 ? "paseo-next-v2" : args[networkIdx + 1];
if (!(network in NETWORKS)) {
  console.error(
    `unknown --network "${network}"; one of ${Object.keys(NETWORKS).join(", ")}`,
  );
  process.exit(2);
}
const { tld, popController } = NETWORKS[network];
const productId = `peopl.${tld}`;

/**
 * Host state lives in the app, not the user's home: `apps/humanity-app/.truapi-host/<slot>/`
 * (git-ignored) is handed to the CLI as `--base-path`. The CLI stores a
 * session under the lite username it assigns (`humanity` → `humanity.62`) and
 * only that name restores it, so the launcher reuses whichever session the
 * slot already holds and never asks anyone to remember a number. Delete the
 * folder for a fresh person; HOST_SESSION=<slot> is a second, independent one.
 */
const slot = process.env["HOST_SESSION"]?.trim() || "default";
const signerMnemonic = process.env["HOST_CLI_SIGNER_MNEMONIC"]?.trim() || "";
const basePath = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  ".truapi-host",
  slot,
);
// The CLI keeps its state under `<base-path>/v2/<network>/` (`STATE_VERSION`).
const sessionsDir = join(basePath, "v2", network);
const existing = existsSync(sessionsDir)
  ? readdirSync(sessionsDir)
      .map((dir) => /^(.+)_signing_host$/.exec(dir)?.[1])
      .filter(Boolean)
      .sort(
        (a, b) =>
          statSync(join(sessionsDir, `${b}_signing_host`)).mtimeMs -
          statSync(join(sessionsDir, `${a}_signing_host`)).mtimeMs,
      )
  : [];
/**
 * A new session's lite username. The CLI attests `<name>.NN` for a fresh
 * person and refuses a base name the identity backend reports as taken —
 * `humanity` is, since 2026-09 — so a slot other than `default` names its
 * person after itself (letters and digits only; the CLI drops the rest).
 * HOST_USERNAME overrides.
 */
const session =
  existing[0] ??
  process.env["HOST_USERNAME"]?.trim() ??
  (slot === "default" ? "humanity" : slot.replace(/[^a-z0-9]/gi, ""));
const shortBase = `apps/humanity-app/.truapi-host/${slot}`;
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workerFlag = process.env["HOST_WORKER"]?.trim() ?? "";
const withWorker = workerFlag !== "" && workerFlag !== "0";
const workerBundle = join(repoRoot, "apps", "humanity-worker", "dist-dev", "index.js");

console.log(`• Host product ${productId}`);
if (popController && !process.env["HOST_CLI_DOTNS_POP_CONTROLLER"]) {
  console.log(
    `• dotNS controller pinned to ${popController} (${network}'s gateway pallet points at an undeployed dispatcher)`,
  );
}
if (signerMnemonic) {
  console.log(
    `• Signing as the identity behind HOST_CLI_SIGNER_MNEMONIC, state in ${shortBase}`,
  );
} else if (existing.length > 0) {
  console.log(
    `• Session ${session} from ${shortBase} (HOST_SESSION=<name> for another)`,
  );
} else {
  console.log(
    [
      `• New session in ${shortBase} on ${network}, lite username ${session}.NN`,
      `  Creating a lite person: registering a username, then waiting for it to`,
      `  join the ring. Takes about a minute and prints nothing meanwhile — wait`,
      `  for "Paired with ${session}.NN". Restarts reuse it; delete the folder`,
      `  for a fresh one. (TRUAPI_HOST_LOG=debug shows progress)`,
      ``,
    ].join("\n"),
  );
}

function isFree(port, host) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host }, () => srv.close(() => resolve(true)));
  });
}

async function freePort(env, start, host) {
  const pinned = process.env[env]?.trim();
  if (pinned) return Number(pinned);
  for (let port = start; port < start + 50; port++) {
    if (await isFree(port, host)) return port;
  }
  throw new Error(`no free port from ${start}`);
}

const hostPort = await freePort("HOST_PORT", 9955, "127.0.0.1");
const appPort = await freePort("APP_PORT", 5183, "0.0.0.0");
if (
  !process.env["HOST_PORT"] &&
  !process.env["APP_PORT"] &&
  (hostPort !== 9955 || appPort !== 5183)
) {
  console.log(
    `• ports 9955/5183 busy (another dev:host?) — using host :${hostPort}, app :${appPort}`,
  );
}

if (withWorker) {
  console.log(
    `• Chat surface: http://127.0.0.1:${hostPort}/chat (boots apps/humanity-worker from dist-dev; reload the page to restart the worker)`,
  );
} else {
  console.log(
    "• No worker (HOST_WORKER=1 builds it and serves the chat surface)",
  );
}

const children = [];
const truapiVersion = lockedTruapiVersion(repoRoot);
const skew = versionSkew(installedHostVersion(), truapiVersion);
if (skew) console.warn(`warning: ${skew}`);
/** Stops every child but `except`, then leaves with its outcome. */
function stopAll(except, code, signal) {
  for (const c of children) if (c !== except && c.exitCode === null) c.kill();
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
}

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
    ...(withWorker ? ["--worker-bundle", workerBundle] : []),
    "--",
    "npm",
    "run",
    "dev",
    "--workspace",
    "@humanity/app",
    "--",
    "--port",
    String(appPort),
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
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
      "truapi-host not found on PATH. Install the version of @parity/truapi in package-lock.json" +
        (truapiVersion ? ` (${truapiVersion})` : "") +
        ":\n" +
        `  ${installCommand(truapiVersion)}`,
    );
    stopAll(child, 127);
  }
  throw err;
});
children.push(child);
child.on("exit", (code, signal) => stopAll(child, code, signal));

/**
 * The worker's watch build, run as vite itself rather than through `npm run`:
 * npm does not pass a kill on to its script, so the watcher would outlive the
 * launcher. Its `build` script prepends `tsc`, hence no `--watch` through it.
 */
if (withWorker) {
  const worker = spawn(
    join(repoRoot, "node_modules", ".bin", "vite"),
    ["build", "--watch", "--outDir", "dist-dev"],
    {
      cwd: join(repoRoot, "apps", "humanity-worker"),
      stdio: "inherit",
      env: { ...process.env, VITE_NETWORK: network },
    },
  );
  children.push(worker);
  worker.on("exit", (code, signal) => stopAll(worker, code, signal));
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const c of children) c.kill(sig);
  });
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Run the app HOSTED, in a plain browser tab, against a local `truapi-host`
// (paritytech/trinity-user-agents, `truapi-host dev`). The CLI starts a real signing
// host on loopback, waits for its signer, then runs `next dev` and stops both
// on Ctrl-C. The app reaches the host through the bridge script the host
// serves itself (`http://127.0.0.1:<port>/bootstrap.js`), which app/layout.tsx
// injects while `NEXT_PUBLIC_TRUAPI_HOST_PORT` is set — development only.
// The snippet parks a MessagePort on `window.__HOST_API_PORT__`, the same seam
// native webview hosts inject, so container detection, the product account,
// signing and the statement store are unmodified product code.
//
//   npm run dev:host                              # previewnet, product dim2.testnet
//   npm run dev:host -- --network nextv2        # or paseo-next-v2; preview = previewnet
//   HOST_SESSION=bob npm run dev:host             # a second, independent person
//   HOST_USERNAME=alicejolly npm run dev:host     # pick the new person's username base
//   HOST_CLI_SIGNER_MNEMONIC="…" HOST_SESSION=phone npm run dev:host   # an existing identity
//   SKIP_PERMISSION_GATE=1 npm run dev:host       # reach the home screen (see below)
//   HOST_PRODUCT_CONFIG=<file> npm run dev:host   # seed the host's manifest cache (see below)
//   npm run dev:host -- --product-config <file>   # same, as an argument (repeatable)
//
// Slot resolution (network, state dir, session, ports) lives in
// scripts/lib/host-slot.mjs.
//
// THE VERSION MATTERS: the host's wire codec moves with its version, and the
// app (`@parity/product-sdk-host` → `@parity/truapi`), this CLI and the
// phone must move together — a skew reads as `Malformed protocol error
// payload` from the first host call, which looks like "not in a host". The
// CLI ships in the same release as the `@parity/truapi` library, so install
// the truapi-host whose version is the `@parity/truapi` package-lock.json
// resolves: the install hint below reads it from the lockfile, and this
// launcher warns when the installed CLI's major.minor differs
// (scripts/lib/truapi-host-version.mjs). Keep TRUAPI_HOST_NO_UPDATE=1
// exported so the CLI's self-update cannot move it.
//
// THE LITE SEAT needs nothing from this launcher: the app binds the person's
// lite alias in the background and Register signs up free (#84), and the host
// lists peopl's lite key by itself.
//
// HOST_PRODUCT_CONFIG / --product-config <file> is forwarded to `truapi-host
// dev --product-config`: a local product-config JSON that seeds the host's
// manifest cache — for the lite seat, the `trustedProducts` grant peopl gives
// dim2. The host resolves that grant from peopl.<tld>'s ON-CHAIN dotNS
// manifest by itself, so this is the FALLBACK for a machine where the manifest is
// unreachable, never the default: the host keeps a seeded config for 24 h and
// it MASKS on-chain resolution for that long, so a run that works with it says
// nothing about the live grant. Verify without it first.
//
// ONE THING THE CLI CANNOT DO: serve chain reads. Its `feature_supported`
// answers false for every chain, so `getHostProvider` throws and the app reads
// the People chain over its own WebSocket instead (lib/game-source.ts falls
// back to NEXT_PUBLIC_PEOPLE_WS while KEEPING the host's identity, signer and
// statement store). This launcher therefore points NEXT_PUBLIC_PEOPLE_WS at
// the People chain of the SAME network the host signs against, unless you set
// it yourself — and then it is on you that the two agree: a signer on
// previewnet submitting to a chain read from paseo-next-v2 fails in ways that
// look like anything but a network mismatch.
//
// Host state (the signer identity) is kept in the git-ignored `.truapi-host/`
// at the repo root so restarts reuse it and deleting it starts over. The CLI
// stores a session under the lite username it assigns (`jollityqxzk` →
// `jollityqxzk.62`) and only that name restores it, so this reuses whichever
// session the slot already holds and nobody has to remember a number. A NEW
// session asks for `jollity` + four random letters (HOST_USERNAME overrides):
// a username base yields only about ten distinct `.NN` accounts (the two
// digits promise more than the backend hands out), and one shared base would
// run dry across the people using this repo.
//
// HOST_CLI_SIGNER_MNEMONIC (the CLI's own variable) runs the host as an
// EXISTING identity — the person your phone holds, say — instead of creating
// a throwaway one. The CLI forbids `--session` in that mode, so none is
// passed; the slot still keeps its state apart from other runs. Testnet keys
// only: confirmations are auto-approved.
//
// Every instance needs its own host port and app port, and the injected bridge
// has to point at *its* host. This picks the first free pair from 9955/3000
// upward, so a second run (another session, another network) starts alongside
// the first instead of failing on `Address already in use`. HOST_PORT /
// APP_PORT pin them. Each slot also gets its own Next dist dir
// (`.next-host-<slot>/`, via next.config.ts's NEXT_DIST_DIR) because `next dev`
// refuses to start while another one holds the same `.next` — and a plain
// `npm run dev` alongside keeps its own. `next dev` then insists on writing
// `<distDir>/types/**` into the tsconfig it is given (and re-serializes the
// whole file), so each slot also gets a generated `.next-host-<slot>.tsconfig.json`
// that `extends` the real tsconfig.json and absorbs that rewrite. Both are
// git-ignored; the tree stays clean.
//
// SKIP_PERMISSION_GATE=1 sets NEXT_PUBLIC_SKIP_PERMISSION_GATE for the app
// (lib/use-permission-gate.ts): skips the one-time /permissions pass on app
// open. The gate's camera step needs a real camera, which a headless browser
// lacks; every host grant it asks for is auto-approved
// here (AutoSigning: Allocated, StatementSubmit: true — measured). The grants
// still run when you visit /permissions.
//
// HOST_BASE_PATH puts the slot's host state somewhere other than
// `.truapi-host/<slot>` (scripts/lib/host-slot.mjs). NEXT_DEV_ARGS appends
// arguments to `next dev` (e.g. `--webpack`, should next/font fail under
// Turbopack).
//
// HOST_ONLY=1 starts the host and NOTHING wrapped: no `next dev`, no per-slot Next
// dist dir or tsconfig, for a test runner that serves its own bundle and points
// it at this host's bridge.
//
// TRUAPI_HOST_PRODUCT_ID overrides the product id (kept in lock-step with the
// app's NEXT_PUBLIC_PRODUCT_DOTNS: the host derives the player account from it
// and refuses to sign for any other — and a mismatch is SILENT: reads work,
// signing later fails PermissionDenied).
import { spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  NETWORKS,
  freePort,
  networkFromArgs,
  productIdFor,
  randomUsernameBase,
  repoRoot,
  slotState,
} from "./lib/host-slot.mjs"
import {
  installCommand,
  installedHostVersion,
  lockedTruapiVersion,
  versionSkew,
} from "./lib/truapi-host-version.mjs"

const argv = process.argv.slice(2)
const network = networkFromArgs(argv)
const productId = productIdFor(network)
// product configs: the env one, then every `--product-config <file>` argument
const productConfigs = [
  ...(process.env.HOST_PRODUCT_CONFIG?.trim() ? [process.env.HOST_PRODUCT_CONFIG.trim()] : []),
  ...argv.flatMap((arg, i) => (arg === "--product-config" && argv[i + 1] ? [argv[i + 1]] : [])),
]
if (productConfigs.length) {
  console.log(
    `• product config ${productConfigs.join(", ")} — seeds the host's manifest cache for 24h and\n` +
      `  masks on-chain resolution meanwhile; a fallback for an unreachable manifest, not the default.`,
  )
}

const peopleWs = process.env.NEXT_PUBLIC_PEOPLE_WS?.trim() || NETWORKS[network].peopleWs
if (peopleWs !== NETWORKS[network].peopleWs) {
  console.log(
    `• NEXT_PUBLIC_PEOPLE_WS=${peopleWs} — make sure it IS the ${network} People chain:\n` +
      `  the host signs against ${network}; reads from another chain fail obscurely.`,
  )
}

const assetHubWs = process.env.NEXT_PUBLIC_ASSET_HUB_WS?.trim() || NETWORKS[network].assetHubWs
if (!assetHubWs) {
  console.log(`• no Asset Hub endpoint for ${network}: set NEXT_PUBLIC_ASSET_HUB_WS, or the collectables screen cannot open`)
}

const slot = process.env.HOST_SESSION?.trim() || "default"
const { basePath, existing, shortBase } = slotState(slot, network)
// Requested username base; the CLI assigns `<base>.NN` (letters only).
const session = existing[0] ?? process.env.HOST_USERNAME?.trim() ?? randomUsernameBase()
const signerMnemonic = process.env.HOST_CLI_SIGNER_MNEMONIC?.trim() || ""

if (signerMnemonic) {
  console.log(`• Signing as the identity behind HOST_CLI_SIGNER_MNEMONIC, state in ${shortBase}`)
} else if (existing.length > 0) {
  console.log(`• Session ${session} from ${shortBase} (HOST_SESSION=<name> for another)`)
} else {
  console.log(
    [
      `• New session in ${shortBase} on ${network}`,
      `  Creating a lite person: registering the username ${session}, then waiting for it to`,
      `  join the ring. Takes about a minute and prints nothing meanwhile — wait`,
      `  for "✓ Paired with …". Restarts reuse it; delete the folder`,
      `  for a fresh one. (TRUAPI_HOST_LOG=debug shows progress)`,
      ``,
    ].join("\n"),
  )
}

const hostPort = await freePort("HOST_PORT", 9955)
const appPort = await freePort("APP_PORT", 3000)
if (!process.env.HOST_PORT && !process.env.APP_PORT && (hostPort !== 9955 || appPort !== 3000)) {
  console.log(`• ports 9955/3000 busy (another dev:host?) — using host :${hostPort}, app :${appPort}`)
}
console.log(`• product ${productId} · chain reads ${peopleWs}`)

// Per-slot Next state: dist dir + the tsconfig `next dev` may rewrite. The
// generated tsconfig repeats the base `include` (TS does not merge it across
// `extends`) plus the dist dir's type globs, so Next finds nothing to add.
const hostOnly = process.env.HOST_ONLY === "1"
// the Next app lives in its own workspace; `next dev`, its dist dir and the
// generated tsconfig are all relative to it, host state stays at the repo root
const appRoot = join(repoRoot, "apps/jollity-app")
const distDir = process.env.NEXT_DIST_DIR ?? `.next-host-${slot}`
const tsconfigPath = process.env.NEXT_TSCONFIG ?? `.next-host-${slot}.tsconfig.json`
if (!process.env.NEXT_TSCONFIG && !hostOnly) {
  const base = JSON.parse(readFileSync(join(appRoot, "tsconfig.json"), "utf8"))
  const include = (base.include ?? []).filter((glob) => !glob.startsWith(".next/"))
  writeFileSync(
    join(appRoot, tsconfigPath),
    JSON.stringify(
      {
        // GENERATED by scripts/dev-host.mjs on every run — edit tsconfig.json instead.
        extends: "./tsconfig.json",
        include: [...include, `${distDir}/types/**/*.ts`, `${distDir}/dev/types/**/*.ts`],
      },
      null,
      2,
    ) + "\n",
  )
}

const truapiVersion = lockedTruapiVersion(repoRoot)
const skew = versionSkew(installedHostVersion(), truapiVersion)
if (skew) console.warn(`warning: ${skew}`)

const child = spawn(
  "truapi-host",
  [
    "dev",
    "--network", network,
    "--base-path", basePath,
    "--port", String(hostPort),
    "--app-port", String(appPort),
    ...(signerMnemonic ? [] : ["--session", session]),
    "--product-id", productId,
    // absolute: the CLI runs in the app workspace, not where the caller stood
    ...productConfigs.flatMap((file) => ["--product-config", resolve(file)]),
    ...(hostOnly
      ? []
      : [
          "--",
          "npx", "next", "dev", "--port", String(appPort),
          ...(process.env.NEXT_DEV_ARGS?.trim() ? process.env.NEXT_DEV_ARGS.trim().split(/\s+/) : []),
        ]),
  ],
  {
    cwd: appRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      // never let the CLI self-update under us: the wire codec moves with the
      // version and the app is pinned to one (the lockfile's @parity/truapi); a
      // CLI that moved `current` between two runs would fail every host call
      // until pinned back
      TRUAPI_HOST_NO_UPDATE: "1",
      NEXT_PUBLIC_TRUAPI_HOST_PORT: String(hostPort),
      NEXT_PUBLIC_PRODUCT_DOTNS: productId,
      NEXT_PUBLIC_NETWORK_NAME: network === "previewnet" ? "previewnet" : "paseo",
      NEXT_PUBLIC_PEOPLE_WS: peopleWs,
      ...(assetHubWs ? { NEXT_PUBLIC_ASSET_HUB_WS: assetHubWs } : {}),
      ...(process.env.SKIP_PERMISSION_GATE === "1" ? { NEXT_PUBLIC_SKIP_PERMISSION_GATE: "1" } : {}),
      NEXT_DIST_DIR: distDir,
      NEXT_TSCONFIG: tsconfigPath,
    },
  },
)
child.on("error", (err) => {
  if (err.code === "ENOENT") {
    console.error(
      "truapi-host not found on PATH. Install the version of @parity/truapi in package-lock.json" +
        (truapiVersion ? ` (${truapiVersion})` : "") + ":\n" +
        `  ${installCommand(truapiVersion)}\n` +
        "The CLI and the library speak one wire codec, so they move together; export TRUAPI_HOST_NO_UPDATE=1 so it stays there.",
    )
    process.exit(127)
  }
  throw err
})
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
// Ctrl-C reaches the CLI directly (same foreground group); a signal aimed at
// this process alone (npm, an IDE stop button, `kill`) would orphan host and
// next, so forward it.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig))

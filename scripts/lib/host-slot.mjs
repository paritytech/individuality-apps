// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// One `truapi-host` SLOT on this machine: which network it signs against, where
// its state lives, which persistent session it restores, and which loopback
// ports are free for it, for `npm run dev:host` (scripts/dev-host.mjs, the app
// inside a host) and the live E2E bots (scripts/e2e-live), so they agree on
// what "the bob slot on previewnet" means without re-deriving it.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))

/** The People chain each host network preset signs against, and the game's
 *  DotNS name there: the product is `dim2.<tld>` on every network. */
export const NETWORKS = {
  previewnet: {
    peopleWs: "wss://previewnet.substrate.dev/people",
    assetHubWs: "wss://previewnet.substrate.dev/asset-hub",
    productId: "dim2.testnet",
    // dotNS, for loading a deployed app the way a host does
    tld: "testnet",
    // the app the live E2E tests when none is named (scripts/e2e-live)
    defaultApp: "dim2.testnet",
    ethRpc: "https://previewnet.substrate.dev/eth-rpc",
    contentResolver: "0x7F74D7CD50f5a834270E2ad395a01b01891AB37d",
    ipfsGateway: "https://previewnet.substrate.dev",
  },
  "paseo-next-v2": {
    peopleWs: "wss://paseo-people-next-system-rpc.polkadot.io",
    assetHubWs: "wss://paseo-asset-hub-next-rpc.polkadot.io",
    productId: "dim2.paseo",
    tld: "paseo",
    // paseo's main deploys stage at dim2next (built for dim2.paseo); dim2.paseo is the release
    defaultApp: "dim2next.paseo",
    ethRpc: "https://eth-rpc-paseo-next.polkadot.io",
    contentResolver: "0x7F74D7CD50f5a834270E2ad395a01b01891AB37d",
    ipfsGateway: "https://paseo-bulletin-next-ipfs.polkadot.io",
  },
}

// The CLI wants its preset names; these are the short forms people say.
const NETWORK_ALIASES = {
  preview: "previewnet",
  previewnet: "previewnet",
  nextv2: "paseo-next-v2",
  paseo: "paseo-next-v2",
  "paseo-next-v2": "paseo-next-v2",
}

/** `--network <name>` from argv (default previewnet), or exit 2 on an unknown one. */
export function networkFromArgs(args) {
  const idx = args.indexOf("--network")
  const arg = idx === -1 ? "previewnet" : (args[idx + 1] ?? "")
  const network = NETWORK_ALIASES[arg]
  if (!network) {
    console.error(`unknown --network "${arg}"; one of ${Object.keys(NETWORK_ALIASES).join(", ")}`)
    process.exit(2)
  }
  return network
}

/** A network name or short form -> the canonical NETWORKS key; empty / unset = undefined; unknown throws. */
export function parseNetwork(raw) {
  const v = (raw ?? "").trim().toLowerCase()
  if (!v) return undefined
  const network = NETWORK_ALIASES[v]
  if (!network) throw new Error(`network "${raw}" is not one of ${Object.keys(NETWORK_ALIASES).join(", ")}`)
  return network
}

/** The live E2E's network: `E2E_NETWORK` (any alias), default previewnet. */
export const networkFromEnv = (env = process.env) => parseNetwork(env.E2E_NETWORK) ?? "previewnet"

/** The game's product id on `network`: env override, else the network's
 *  `dim2.<tld>`. The host derives the player account from it and signs for no
 *  other, so the app gets the same value (NEXT_PUBLIC_PRODUCT_DOTNS). */
export const productIdFor = (network) =>
  process.env.TRUAPI_HOST_PRODUCT_ID ?? process.env.NEXT_PUBLIC_PRODUCT_DOTNS ?? NETWORKS[network].productId

const letters = "abcdefghijklmnopqrstuvwxyz"
/** A NEW session asks for `jollity` + four random letters: a username base
 *  yields only about ten `.NN` accounts, and one shared base runs dry. */
export const randomUsernameBase = () =>
  "jollity" + Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * 26)]).join("")

/**
 * Where slot `slot` keeps its state on `network`, and the session it holds.
 * The CLI stores a session under the lite username it assigns
 * (`jollityqxzk` → `jollityqxzk.62`) and only that name restores it, so the
 * most recently used one is reused; `existing` is empty for a fresh slot.
 *
 * Two state layouts: truapi-host ≥ 0.17 writes `<base>/v2/<network>/` and
 * ≤ 0.16 wrote `<base>/<network>/`; both hold the `<username>_signing_host/`
 * dirs plus `signing-host/current-session`, the name of the session in use.
 * The v2 tree wins when it holds a session (a slot upgraded in place has
 * both); a v2 tree with none falls back to the old tree, so an old session
 * is restored rather than a new person created. `current-session` is listed
 * first when it names a dir that is there.
 */
const hasSessions = (dir) => existsSync(dir) && readdirSync(dir).some((d) => d.endsWith("_signing_host"))

export function slotState(slot, network) {
  // HOST_BASE_PATH (absolute, or relative to the repo) moves the slot's state
  // out of `.truapi-host/` — CI keeps host state, which in mnemonic mode is
  // the identity, under $RUNNER_TEMP, outside the workspace
  const override = process.env.HOST_BASE_PATH?.trim()
  const basePath = override ? resolve(repoRoot, override) : join(repoRoot, ".truapi-host", slot)
  const v2 = join(basePath, "v2", network)
  const v1 = join(basePath, network)
  const sessionsDir = hasSessions(v2) || !hasSessions(v1) ? v2 : v1
  const byRecency = existsSync(sessionsDir)
    ? readdirSync(sessionsDir)
        .map((dir) => /^(.+)_signing_host$/.exec(dir)?.[1])
        .filter(Boolean)
        .sort(
          (a, b) =>
            statSync(join(sessionsDir, `${b}_signing_host`)).mtimeMs -
            statSync(join(sessionsDir, `${a}_signing_host`)).mtimeMs,
        )
    : []
  const currentFile = join(sessionsDir, "signing-host", "current-session")
  const current = existsSync(currentFile) ? readFileSync(currentFile, "utf8").trim() : ""
  const existing =
    current && byRecency.includes(current) ? [current, ...byRecency.filter((name) => name !== current)] : byRecency
  return { slot, basePath, sessionsDir, existing, shortBase: override ? basePath : `.truapi-host/${slot}` }
}

function isFree(port, host) {
  return new Promise((done) => {
    const srv = createServer()
    srv.unref()
    // only "in use" is a taken port — an address family the machine lacks
    // (EADDRNOTAVAIL on ::1) says nothing about the port
    srv.once("error", (err) => done(err.code !== "EADDRINUSE"))
    srv.listen({ port, host }, () => srv.close(() => done(true)))
  })
}

// A port is free only if nothing holds it on loopback (v4 AND v6) *or* the
// wildcard: a server bound to one of those alone would not show up when
// probing another — a vite dev on [::1]:3000 is exactly what `localhost`
// resolves to in the browser, and it is invisible to a 127.0.0.1 probe.
const PROBE_HOSTS = ["127.0.0.1", "::1", "0.0.0.0"]

/** The first free port from `start`, unless env `pin` names one. */
export async function freePort(pin, start) {
  const pinned = pin ? process.env[pin]?.trim() : undefined
  if (pinned) return Number(pinned)
  for (let port = start; port < start + 50; port++) {
    let free = true
    for (const host of PROBE_HOSTS) if (!(await isFree(port, host))) free = false
    if (free) return port
  }
  throw new Error(`no free port from ${start}`)
}

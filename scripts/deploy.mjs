#!/usr/bin/env node
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// One command per product: build it for a network and publish it under your DotNS name with a
// pinned bulletin-deploy. DEPLOYMENT.md walks through it.
//
//   DOMAIN=my-game.paseo DOTNS_MNEMONIC="…" npm run deploy -- jollity paseo
//   DOMAIN=my-card.paseo DOTNS_MNEMONIC="…" npm run deploy -- humanity paseo
//   npm run deploy -- jollity polkadot --dry-run      what a network lacks, without deploying
//   npm run deploy -- jollity --stack <link|url|file> any other network, by its stack descriptor
//
// previewnet and paseo are built into both apps. pcf-devnet, polkadot (bulletin-deploy's other
// built-in networks) and any --stack are read from the network's Trinity stack descriptor and
// checked against what Jollity needs: a network that passes is built from its descriptor, and one
// that does not gets every unmet requirement listed and no deploy. Humanity knows only the two
// built-in networks.
//
// DOMAIN is the full name, TLD included. DOTNS_MNEMONIC (or MNEMONIC) is the 12- or 24-word phrase
// of the account that owns it; without one bulletin-deploy would fall back to a well-known shared
// development account and anyone could repoint the name, so the script refuses. Extra flags after
// the network go to Humanity's setup (`--publish`, `--dry-run`, …). BULLETIN_DEPLOY_SPEC overrides
// the pinned tool.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

/** the version this repository's deploy configs were last proven with */
const BULLETIN_DEPLOY = process.env.BULLETIN_DEPLOY_SPEC || "bulletin-deploy@0.25.0"

/** networks both apps carry a configuration for: bulletin-deploy's env, the TLD, each app's name */
const BUILT_IN = {
  previewnet: { env: "preview", tld: "testnet", jollity: "previewnet", humanity: "preview" },
  paseo: { env: "paseo-next-v2", tld: "paseo", jollity: "paseo", humanity: "paseo-next-v2" },
}
const ALIASES = { preview: "previewnet", "paseo-next-v2": "paseo" }
/** bulletin-deploy 0.25.0's other built-in networks, by the descriptor and key it pins */
const STACKS = {
  "pcf-devnet": {
    url: "https://stack.api.polkadotcommunity.foundation/.well-known/trinity-stack.json",
    key: "0x1fbc5eed0deb09fe4eeefdf45350b4b4cf36370d9bbb93ca2818b076737a0ed3",
  },
  polkadot: {
    url: "https://stack.api.pcf.network/.well-known/trinity-stack.json",
    key: "0xdcddb708759dade2e3850368ce0add2072f424ba53f1a2128f3339d646cffe28",
  },
}
/** the People-chain pallets Jollity's chain code calls */
const GAME_PALLETS = ["Game", "Score", "Airdrop"]

function fail(...lines) {
  console.error(lines.join("\n"))
  process.exit(1)
}

const usage = () =>
  fail(
    "usage: npm run deploy -- <jollity|humanity> <network> [--dry-run]",
    "       npm run deploy -- jollity --stack <link|url|file> [--dry-run]",
    `networks: ${[...Object.keys(BUILT_IN), ...Object.keys(STACKS)].join(", ")}`,
  )

// ---- arguments ----

const [product, ...rest] = process.argv.slice(2)
if (product !== "jollity" && product !== "humanity") usage()
let networkName
let stackArg
const extra = []
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--stack") stackArg = rest[++i] ?? usage()
  else if (!rest[i].startsWith("-") && networkName === undefined && stackArg === undefined) networkName = ALIASES[rest[i]] ?? rest[i]
  else extra.push(rest[i])
}
if ((networkName === undefined) === (stackArg === undefined)) usage()
const dryRun = extra.includes("--dry-run")
if (networkName !== undefined && !BUILT_IN[networkName] && !STACKS[networkName]) {
  fail(`Unknown network "${networkName}". One of: ${[...Object.keys(BUILT_IN), ...Object.keys(STACKS)].join(", ")}, or --stack <link|url|file>.`)
}
if (product === "jollity" && extra.some((flag) => flag !== "--dry-run")) fail(`Unknown flag for Jollity: ${extra.filter((f) => f !== "--dry-run").join(" ")}`)

const run = (command, args, env) => {
  const result = spawnSync(command, args, { stdio: "inherit", env: { ...process.env, ...env } })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// ---- Humanity: its own setup does the work; this only names the network and puts the CLI on PATH ----

if (product === "humanity") {
  const network = BUILT_IN[networkName]
  if (!network) {
    fail(
      `Humanity knows previewnet and paseo only. Another network needs an entry in`,
      `packages/humanity-shared/src/chain/networks.ts and DEPLOY_TARGETS in apps/humanity-app/scripts/setup.ts.`,
    )
  }
  const label = (process.env.DOTNS_LABEL ?? process.env.DOMAIN ?? "").trim()
  if (!label && !dryRun) fail(`Set DOMAIN to the name you deploy to, e.g. DOMAIN=my-card.${network.tld}`)
  run("npx", ["-y", "-p", BULLETIN_DEPLOY, "--", "npm", "run", "humanity:setup", "--", "--env", network.humanity, ...extra],
    label ? { DOTNS_LABEL: label } : {})
  process.exit(0)
}

// ---- Jollity ----

const descriptorOf = async () => {
  const { decodeLink, parse } = await import("@parity/trinity-stack")
  if (stackArg !== undefined && existsSync(stackArg)) return parse(readFileSync(stackArg)).descriptor
  const pointer = stackArg === undefined ? STACKS[networkName] : /^https?:\/\//.test(stackArg) ? { url: stackArg } : decodeLink(stackArg)
  const { createStackReader } = await import("@parity/trinity-stack/reader")
  const reader = createStackReader({ refresh: "once", timeoutMs: 15_000 })
  try {
    return (await reader.get(pointer)).descriptor
  } finally {
    reader.close()
  }
}

/** one JSON-RPC call over a WebSocket */
const rpc = (url, method) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => { ws.close(); reject(new Error("no answer in 20 s")) }, 20_000)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, jsonrpc: "2.0", method, params: [] }))
    ws.onmessage = (event) => {
      clearTimeout(timer)
      ws.close()
      const reply = JSON.parse(event.data)
      if (reply.error) reject(new Error(reply.error.message))
      else resolve(reply.result)
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error("connection failed")) }
  })

/** the name-link contracts the app is built with (packages/individuality-name-link/src/dotns-names.ts) */
const pinnedDotnsContracts = () => {
  const source = readFileSync(new URL("../packages/individuality-name-link/src/dotns-names.ts", import.meta.url), "utf8")
  const pick = (name) => source.match(new RegExp(`${name}:\\s*"(0x[0-9a-fA-F]{40})"`))?.[1]?.toLowerCase()
  return { storeFactory: pick("storeFactory"), reverseResolver: pick("reverseResolver") }
}

/**
 * Checks a network's descriptor against what a Jollity build needs, and returns the build's
 * settings or every requirement it misses. The app runs on such a network in its `local` mode
 * (packages/jollity-protocol/src/local-network.mjs), which takes every endpoint from the build.
 */
async function checkStack(descriptor) {
  const missing = []
  const chain = (role) => descriptor.chains?.find((c) => c.role === role)
  const service = (kind) => descriptor.services?.find((s) => s.kind === kind)?.urls?.[0]
  const people = chain("People")
  const assetHub = chain("AssetHub")
  const backend = service("dub")
  if (!people?.rpc?.[0]) missing.push("a People chain with an RPC endpoint")
  else if (!people.statementStore) missing.push("a People chain that serves the statement store (the game's signalling)")
  if (!assetHub?.rpc?.[0]) missing.push("an Asset Hub with an RPC endpoint")
  if (!backend) missing.push("a `dub` service: the device-uniqueness backend that hands out TURN credentials")
  if (descriptor.tld !== "testnet") {
    missing.push(`the .testnet TLD: the app's local mode derives its product accounts under .testnet, and this network uses .${descriptor.tld}`)
  }
  const pinned = pinnedDotnsContracts()
  for (const name of ["storeFactory", "reverseResolver"]) {
    const theirs = descriptor.dotns?.[name]?.toLowerCase()
    if (theirs !== pinned[name]) {
      missing.push(`the DotNS ${name} the name link is built with (${pinned[name]}); this network's is ${theirs ?? "not listed"}`)
    }
  }
  if (people?.rpc?.[0]) {
    try {
      const { decAnyMetadata, unifyMetadata } = await import("@polkadot-api/substrate-bindings")
      const pallets = new Set(unifyMetadata(decAnyMetadata(await rpc(people.rpc[0], "state_getMetadata"))).pallets.map((p) => p.name))
      const absent = GAME_PALLETS.filter((p) => !pallets.has(p))
      if (absent.length) missing.push(`the game's pallets on the People chain; its runtime has no ${absent.join(", ")}`)
    } catch (error) {
      missing.push(`a People chain this script can reach to check its pallets (${people.rpc[0]}: ${error.message})`)
    }
  }
  const collections = (process.env.NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS ?? "").trim()
  if (!collections) missing.push("NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS: the collectible collection ids the game accepts on this network")
  if (missing.length) return { missing }
  return {
    env: {
      NEXT_PUBLIC_NETWORK_NAME: "local",
      NEXT_PUBLIC_PEOPLE_WS: people.rpc[0],
      NEXT_PUBLIC_PEOPLE_GENESIS: people.genesisHash,
      NEXT_PUBLIC_ASSET_HUB_WS: assetHub.rpc[0],
      NEXT_PUBLIC_ASSET_HUB_GENESIS: assetHub.genesisHash,
      NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL: backend,
      NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS: collections,
    },
  }
}

const builtIn = BUILT_IN[networkName]
let tld
let networkEnv
let target
if (builtIn) {
  tld = builtIn.tld
  networkEnv = { NEXT_PUBLIC_NETWORK_NAME: builtIn.jollity }
  target = ["--env", builtIn.env]
} else {
  const label = networkName ?? stackArg
  let descriptor
  try {
    descriptor = await descriptorOf()
  } catch (error) {
    fail(`Could not read the stack descriptor for ${label}: ${error.message}`)
  }
  const checked = await checkStack(descriptor)
  if (checked.missing) {
    fail(
      `Jollity cannot run on ${descriptor.name ?? label} yet. The network lacks:`,
      ...checked.missing.map((m) => `  - ${m}`),
      "DEPLOYMENT.md (Other networks) says what each one takes.",
    )
  }
  tld = descriptor.tld
  networkEnv = checked.env
  target = networkName ? ["--env", networkName] : ["--stack", stackArg]
}

const domain = (process.env.DOMAIN ?? "").trim()
if (!domain) fail(`Set DOMAIN to the name you deploy to, e.g. DOMAIN=my-game.${tld}`)
if (!domain.endsWith(`.${tld}`)) fail(`DOMAIN must end in .${tld} on this network (got ${domain})`)

const dotns = (process.env.DOTNS_MNEMONIC ?? "").trim().replace(/\s+/g, " ")
const generic = (process.env.MNEMONIC ?? "").trim().replace(/\s+/g, " ")
if (dotns && generic && dotns !== generic) fail("DOTNS_MNEMONIC and MNEMONIC are set to different phrases; keep one.")
const mnemonic = dotns || generic
if (!mnemonic && !dryRun) {
  fail(
    "No deploy phrase found. Export the phrase of the account that owns the name:",
    '  export DOTNS_MNEMONIC="your twelve word phrase …"',
    "Refusing to continue: bulletin-deploy would fall back to a shared development account.",
  )
}
const words = mnemonic ? mnemonic.split(" ").length : 12
if (words !== 12 && words !== 24) fail(`The deploy phrase has ${words} words; expected 12 or 24.`)

const buildEnv = { ...networkEnv, NEXT_PUBLIC_PRODUCT_DOTNS: domain, PRODUCT_DOTNS: domain }
const deployArgs = ["-y", BULLETIN_DEPLOY, ...target, "--js-merkle", "--config", "deploy/bulletin-deploy.config.ts",
  "--no-transfer-to-signedin-user", "./apps/jollity-app/out", domain]
if (dryRun) {
  console.log(`Jollity → ${domain}`)
  for (const [k, v] of Object.entries(buildEnv)) console.log(`  ${k}=${v}`)
  console.log(`  then: npx ${deployArgs.join(" ")}`)
  console.log(mnemonic ? "  deploy phrase: set" : "  deploy phrase: NOT SET (required for a deploy)")
  process.exit(0)
}
run("npm", ["run", "build", "-w", "@jollity/app"], buildEnv)
run("npm", ["run", "build:chat"], buildEnv)
run("npx", deployArgs, { ...buildEnv, MNEMONIC: mnemonic, DEPLOY_DOMAIN: domain })

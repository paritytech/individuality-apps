#!/usr/bin/env node
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Builds Jollity (the app and its chat worker) for one DotNS name and publishes it with
// bulletin-deploy.
//
//   DOMAIN=my-game.testnet DOTNS_MNEMONIC="…" npm run deploy:previewnet
//   DOMAIN=my-game.paseo   DOTNS_MNEMONIC="…" npm run deploy:paseo
//
// DOMAIN is the full name you publish to, TLD included. DOTNS_MNEMONIC (or MNEMONIC) is the
// 12- or 24-word phrase of the account that owns it. The deploy refuses to run without one:
// bulletin-deploy would otherwise fall back to a well-known shared development account, and
// anyone could repoint the name. BULLETIN_DEPLOY_SPEC overrides the pinned tool version;
// DEPLOY_DISPLAY_NAME and DEPLOY_TRUSTED_PRODUCTS are read by deploy/bulletin-deploy.config.ts.
import { spawnSync } from "node:child_process"

const NETWORKS = {
  previewnet: { env: "preview", tld: "testnet" },
  paseo: { env: "paseo-next-v2", tld: "paseo" },
}
/** the version this repository's deploy config was last proven with */
const BULLETIN_DEPLOY = process.env.BULLETIN_DEPLOY_SPEC || "bulletin-deploy@0.25.0"

function fail(...lines) {
  console.error(lines.join("\n"))
  process.exit(1)
}

const networkName = process.argv[2]
const network = NETWORKS[networkName]
if (!network) fail(`usage: node scripts/deploy.mjs <${Object.keys(NETWORKS).join("|")}>`)

const domain = (process.env.DOMAIN ?? "").trim()
if (!domain) fail(`Set DOMAIN to the name you deploy to, e.g. DOMAIN=my-game.${network.tld}`)
if (!domain.endsWith(`.${network.tld}`)) fail(`DOMAIN must end in .${network.tld} on ${networkName} (got ${domain})`)

const dotns = (process.env.DOTNS_MNEMONIC ?? "").trim().replace(/\s+/g, " ")
const generic = (process.env.MNEMONIC ?? "").trim().replace(/\s+/g, " ")
if (dotns && generic && dotns !== generic) fail("DOTNS_MNEMONIC and MNEMONIC are set to different phrases; keep one.")
const mnemonic = dotns || generic
if (!mnemonic) {
  fail(
    "No deploy phrase found. Export the phrase of the account that owns the name:",
    '  export DOTNS_MNEMONIC="your twelve word phrase …"',
    "Refusing to continue: bulletin-deploy would fall back to a shared development account.",
  )
}
const words = mnemonic.split(" ").length
if (words !== 12 && words !== 24) fail(`The deploy phrase has ${words} words; expected 12 or 24.`)

const run = (command, args, env) => {
  const result = spawnSync(command, args, { stdio: "inherit", env: { ...process.env, ...env } })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const buildEnv = { NEXT_PUBLIC_NETWORK_NAME: networkName, NEXT_PUBLIC_PRODUCT_DOTNS: domain, PRODUCT_DOTNS: domain }
run("npm", ["run", "build", "-w", "@jollity/app"], buildEnv)
run("npm", ["run", "build:chat"], buildEnv)
run(
  "npx",
  ["-y", BULLETIN_DEPLOY, "--env", network.env, "--js-merkle", "--config", "deploy/bulletin-deploy.config.ts",
    "--no-transfer-to-signedin-user", "./apps/jollity-app/out", domain],
  { ...buildEnv, MNEMONIC: mnemonic, DEPLOY_DOMAIN: domain },
)

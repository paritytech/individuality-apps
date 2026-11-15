// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Product manifest for publishing Jollity as an on-chain Polkadot product. The
// app executable is Next's static export (out/).
//
// Consumed by `bulletin-deploy --config deploy/bulletin-deploy.config.ts`. It
// writes the root + per-executable text records on the deployed name. Without a
// manifest bulletin-deploy sets a contenthash and stops, which leaves the product
// on iOS 0.10.0's legacy resolution path.
//
// The manifest is also what makes the CHAT EXTENSION exist: the worker below is
// declared with `includes.chat`, so the host wires up its chat surface and
// registers `worker.<name>` with its own CID. Ship apps/jollity-worker/dist/index.js without
// declaring it here and it is an inert file nothing registers — no bot, no room,
// no welcome card.
//
// Paths resolve relative to THIS file's directory (deploy/):
//   - icon.path → deploy/icon.png
//   - app       → ../apps/jollity-app/out         `npm run build` (Next output: "export"). Must
//                 match the deploy build dir so the already-uploaded content CID
//                 is REUSED rather than re-hashed and uploaded a second time.
//   - worker    → ../apps/jollity-worker/dist  `npm run build:chat`
//                 (apps/jollity-worker/scripts/build.mjs).
//
// Kept OUT of the build dirs' ancestry on purpose. bulletin-deploy auto-discovers
// a config by walking UP from the build dir, so a config at the repo root would be
// picked up implicitly and one inside out/ would ship to users. deploy/ is a
// sibling of both, neither of those, so it stays opt-in via --config.
//
// Plain object, no `defineConfig` import: the CLI is run through `npx`, where the
// `bulletin-deploy` package is not resolvable from this file's module scope.
//
// `domain` MUST equal the name passed to the CLI. publishManifest compares the two
// VERBATIM and hard-fails on any mismatch, so it has to carry the network's TLD as
// well — paseo-next-v2 serves `.paseo`, not `.dot`. Hence DEPLOY_DOMAIN: set it
// to the same name you pass to bulletin-deploy, from one value.
const domain = process.env.DEPLOY_DOMAIN
if (!domain) throw new Error("Set DEPLOY_DOMAIN to the DotNS name you deploy to, with its TLD (for example my-game.paseo)")

// The one link in the chain nothing else checks.
//
// The chat card's buttons navigate to the app BY NAME, and that name can only be
// known at build time (there is no host call for a product to ask its own
// identity). So the worker
// bundle carries a baked-in copy, via PRODUCT_DOTNS → __PRODUCT_DOTNS__ → SPA_URL
// (apps/jollity-worker/src/state.ts). apps/jollity-worker/scripts/build.mjs refuses to build without it.
//
// But a name that is merely PRESENT is not a name that is CORRECT: a bundle built
// for one name and deployed to another would publish cheerfully and send every
// button to the wrong product. `domain` here is the authoritative deploy target,
// so this is the one place that can compare the two. A deploy script should
// derive both from one value; a hand-run deploy of a stale dist can drift —
// this catches it.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { DISPLAY_NAME, DESCRIPTION, TRUSTED_PRODUCTS } from "./constants"

if (!process.env.SKIP_WORKER_NAME_CHECK) {
  const candidates = [
    resolve(process.cwd(), "apps/jollity-worker/dist/index.js"), // deploy run from the repo root (the documented command)
    resolve(process.cwd(), "../apps/jollity-worker/dist/index.js"), // ...or from deploy/
  ]
  let bundle: string | null = null
  let readFrom = ""
  for (const path of candidates) {
    try {
      bundle = readFileSync(path, "utf8")
      readFrom = path
      break
    } catch {
      /* try the next candidate */
    }
  }
  if (bundle === null) {
    throw new Error(
      `Cannot verify the worker bundle's baked-in product name: apps/jollity-worker/dist/index.js was not found.\n` +
        `  Looked in:\n${candidates.map((c) => `    ${c}`).join("\n")}\n` +
        `  Run the deploy from the repo root, or build first:\n` +
        `    NEXT_PUBLIC_NETWORK_NAME=<network> PRODUCT_DOTNS=${domain} npm run build:chat\n` +
        `  To deploy anyway: SKIP_WORKER_NAME_CHECK=1`,
    )
  }
  // JSON.stringify so the match is against the compiled string literal, not a
  // coincidental substring of a URL or comment elsewhere in the bundle.
  if (!bundle.includes(JSON.stringify(domain))) {
    throw new Error(
      `The worker bundle was NOT built for "${domain}", so the chat card's buttons would\n` +
        `navigate to the wrong product (or, if the name is empty, silently do nothing on iOS).\n` +
        `  Bundle: ${readFrom}\n` +
        `  Rebuild for this target, then deploy again:\n` +
        `    NEXT_PUBLIC_NETWORK_NAME=<network> PRODUCT_DOTNS=${domain} npm run build:chat\n` +
        `  To deploy anyway: SKIP_WORKER_NAME_CHECK=1`,
    )
  }
}

export default {
  domain,
  displayName: DISPLAY_NAME,
  description: DESCRIPTION,
  icon: { path: "./icon.png", format: "png" as const },
  executables: [
    { kind: "app" as const, path: "../apps/jollity-app/out", appVersion: [0, 1, 0] as const },
    {
      kind: "worker" as const,
      path: "../apps/jollity-worker/dist",
      appVersion: [0, 1, 0] as const,
      entrypoint: "index.js",
      includes: { chat: true, pocket: false },
    },
  ],
  trustedProducts: TRUSTED_PRODUCTS,
}

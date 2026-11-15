// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Declares what the product IS, separate from what a deploy UPLOADS.
//
// bulletin-deploy.config.ts spreads these into the manifest it publishes.
export const DISPLAY_NAME = process.env.DEPLOY_DISPLAY_NAME ?? "Jollity"

export const DESCRIPTION = "Play a game, claim a name and get prizes"

// Other products the host lets read this product's storage ("storage") or act
// in its context ("context") without a permission prompt. A grant lets the
// named product's owner do those things as this product, so a deployment
// grants nothing by default and names only products it controls or trusts:
//
//   DEPLOY_TRUSTED_PRODUCTS='{"my-card":["storage","context"]}'
//
// The keys are DotNS labels without the TLD, as the host matches them.
const GRANTS = new Set(["storage", "context"])

function trustedProducts(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("DEPLOY_TRUSTED_PRODUCTS must be a JSON object of label → grants")
  }
  for (const [label, grants] of Object.entries(parsed)) {
    if (!Array.isArray(grants) || grants.some((grant) => !GRANTS.has(grant))) {
      throw new Error(`DEPLOY_TRUSTED_PRODUCTS: "${label}" must list grants from ${[...GRANTS].join(", ")}`)
    }
  }
  return parsed as Record<string, string[]>
}

export const TRUSTED_PRODUCTS = trustedProducts(process.env.DEPLOY_TRUSTED_PRODUCTS)

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Render the root manifest a promotion should publish, from deploy/constants.ts
 * and the record the network already holds.
 *
 * A release repoints CIDs and uploads nothing, so it cannot recompute the icon
 * CID that bulletin-deploy assigns at upload time. The fields the product
 * declares are taken from it, and `$v` and the icon are kept from the network.
 *
 * Reads the current record as JSON on stdin, the shape `dotns text view <name>
 * <key> --json` prints. Writes the value to publish on stdout, or nothing when
 * it already matches, so the workflow can skip the transaction:
 *
 *   dotns text view my-game.paseo manifest --env paseo-v2 --json \
 *     | DEPLOY_TRUSTED_PRODUCTS='{"my-gamenext":["context"]}' npx tsx scripts/sync-manifest.mts > manifest.json
 *   test -s manifest.json && dotns text set my-game.paseo manifest --env paseo-v2 < manifest.json
 *
 * Exits non-zero when the name carries no manifest at all. That is a name the
 * promotion has never published to, and guessing a whole manifest for it would
 * write a product description nobody reviewed.
 */
import { DISPLAY_NAME, DESCRIPTION, TRUSTED_PRODUCTS } from "../deploy/constants"

interface ProductManifest {
  $v?: number
  displayName?: string
  description?: string
  icon?: { cid: string; format: string }
  trustedProducts?: Record<string, string[]>
}

const input = await new Promise<string>((resolve) => {
  let data = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => (data += chunk))
  process.stdin.on("end", () => resolve(data))
})

const view = JSON.parse(input) as { exists?: boolean; value?: string }
if (!view.exists || !view.value) {
  console.error("The name carries no manifest record. Publish it with bulletin-deploy first.")
  process.exit(1)
}

const current = JSON.parse(view.value) as ProductManifest
if (!current.icon?.cid) {
  console.error("The published manifest carries no icon CID, which a promotion cannot recompute.")
  process.exit(1)
}

const next: ProductManifest = {
  $v: current.$v ?? 1,
  displayName: DISPLAY_NAME,
  description: DESCRIPTION,
  icon: current.icon,
  trustedProducts: TRUSTED_PRODUCTS,
}

// Key order is not significant to a reader, and a reordered write would look
// like a change on every release. The keys are sorted at every depth by hand,
// because a key list handed to JSON.stringify filters the nested objects too,
// and the grants then compare as `{}` on both sides.
const canonical = (value: ProductManifest) =>
  JSON.stringify(value, (_key, field: unknown) =>
    field && typeof field === "object" && !Array.isArray(field)
      ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => (a < b ? -1 : 1)))
      : field,
  )

if (canonical(next) === canonical(current)) process.exit(0)
process.stdout.write(JSON.stringify(next))

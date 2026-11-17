// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Which network legs a Deploy run starts. deploy.yml decides it with GitHub
// expressions (the deploy job's matrix `include` and `if`, the comment's `if`,
// the concurrency suffix), evaluated before any runner exists. This module is
// the same table in plain JS: deploy-matrix.test.ts evaluates those
// expressions over every event and requires them to equal planLegs, and the
// Comment job imports planLegs to know what was planned.
//
//   push main, workflow_dispatch   both legs, or the one inputs.network picks
//   PR opened/synchronize/reopened previewnet starts, and its gate ends it
//                                  green unless deployed sources changed
//                                  (scripts/ci/changes.mjs) or deploy-preview
//                                  is on. Paseo only when deploy-paseo is on.
//   PR labeled deploy-preview      previewnet, plus paseo when deploy-paseo is
//                                  already on the PR
//   PR labeled deploy-paseo        the previewnet gate plus paseo
//   PR labeled anything else       nothing: the job's `if` is false
//
// Every productive label event carries the complete current label plan and
// shares the PR's concurrency group with pushes, so a replaced pending push
// cannot lose a required leg.

export const PREVIEW_LABEL = "deploy-preview"
export const PASEO_LABEL = "deploy-paseo"

/** one row per network: the properties the deploy job reads off `matrix`, byte for byte deploy.yml's rows */
export const LEGS = {
  preview: { env: "preview", "display-name": "Previewnet", "network-name": "previewnet", suffix: ".testnet", shell: "testnet.li", "staging-suffix": "", "deployer-product-id": "" },
  "paseo-next-v2": { env: "paseo-next-v2", "display-name": "Paseo", "network-name": "paseo", suffix: ".paseo", shell: "paseo.li", "staging-suffix": "next", "deployer-product-id": "uid.paseo" },
}

const pick = (preview, paseo) => [preview && LEGS.preview, paseo && LEGS["paseo-next-v2"]].filter(Boolean)

export function planLegs({ event, action = "", label = "", labels = [], network = "" }) {
  if (event !== "pull_request") {
    const n = network || "all"
    return pick(n !== "paseo-next-v2", n !== "preview")
  }
  if (action === "labeled") {
    if (label !== PREVIEW_LABEL && label !== PASEO_LABEL) return []
    return pick(true, labels.includes(PASEO_LABEL))
  }
  return pick(true, labels.includes(PASEO_LABEL))
}

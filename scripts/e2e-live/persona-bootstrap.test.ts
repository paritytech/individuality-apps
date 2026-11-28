// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import manifest from "./persona-bootstrap.json"
import { buildBootstrapPlan, validatePersonaManifest, writePublicJournal } from "./persona-bootstrap"

const profiles = Object.fromEntries(manifest.personas.map((persona) => [persona.profile, {}]))

describe("persona bootstrap manifest", () => {
  it("pins the nine semantic, dual-network personas in issue order", () => {
    const personas = validatePersonaManifest(manifest)
    expect(personas.map((persona) => persona.profile)).toEqual([
      "locale-la-enus",
      "locale-tokyo-jajp",
      "locale-berlin-dede",
      "uplink-limited-pixel6a",
      "camera-denied",
      "camera-missing",
      "storm-pixel6a-timeline",
      "video-role-late-flip",
      "video-role-late-never",
    ])
    expect(personas.map((persona) => persona.base)).toEqual([
      "jollylaenus",
      "jollytokyojp",
      "jollyberlinde",
      "jollyuplink",
      "jollycamdeny",
      "jollycammiss",
      "jollystorm",
      "jollyvideoflip",
      "jollyvideonever",
    ])
  })

  it("plans previewnet before paseo and creates only missing mappings", () => {
    const plan = buildBootstrapPlan({ manifest, profiles, pools: { previewnet: {}, "paseo-next-v2": {} }, secretNames: new Set(), journals: {}, localSlots: new Set() })
    expect(plan.slice(0, 4).map((step) => [step.profile, step.network, step.action])).toEqual([
      ["locale-la-enus", "previewnet", "create"],
      ["locale-la-enus", "paseo-next-v2", "create"],
      ["locale-tokyo-jajp", "previewnet", "create"],
      ["locale-tokyo-jajp", "paseo-next-v2", "create"],
    ])
  })

  it("is a no-op only when mapping, pool, secret and retained slot all agree", () => {
    const profile = manifest.personas[0].profile
    const username = "jollylaenus.42"
    const account = "5Account"
    const plan = buildBootstrapPlan({
      manifest: { personas: [manifest.personas[0]] },
      profiles: { [profile]: { identity: { previewnet: username } } },
      pools: { previewnet: { [username]: account }, "paseo-next-v2": {} },
      secretNames: new Set(["E2E_POOL_PREVIEWNET"]),
      journals: { [`${profile}:previewnet`]: { profile, network: "previewnet", username, account, secret: "E2E_POOL_PREVIEWNET" } },
      localSlots: new Set([`previewnet:${username}`]),
      networks: ["previewnet"],
    })
    expect(plan).toMatchObject([{ action: "verify", username, account, aggregateMembership: "unverifiable" }])
  })

  it("resumes a completed public journal and creates a replacement only under explicit rebuild", () => {
    const profile = manifest.personas[0].profile
    const journal = { profile, network: "previewnet" as const, username: "jollylaenus.42", account: "5Account", secret: "E2E_POOL_PREVIEWNET" }
    const common = {
      manifest: { personas: [manifest.personas[0]] }, profiles: { [profile]: {} }, pools: { previewnet: { [journal.username]: journal.account }, "paseo-next-v2": {} },
      secretNames: new Set([journal.secret]), journals: { [`${profile}:previewnet`]: journal }, localSlots: new Set([`previewnet:${journal.username}`]), networks: ["previewnet" as const],
    }
    expect(buildBootstrapPlan(common)).toMatchObject([{ action: "resume", username: journal.username }])
    expect(buildBootstrapPlan({ ...common, rebuild: new Set([`${profile}:previewnet`]) })).toMatchObject([{ action: "rebuild", previousUsername: journal.username }])
  })

  it("adopts the sole semantic retained slot after interruption before the journal", () => {
    const profile = manifest.personas[0].profile
    const plan = buildBootstrapPlan({
      manifest: { personas: [manifest.personas[0]] },
      profiles: { [profile]: {} },
      pools: { previewnet: {}, "paseo-next-v2": {} },
      secretNames: new Set(),
      journals: {},
      localSlots: new Set(["previewnet:jollylaenus.46"]),
      networks: ["previewnet"],
    })
    expect(plan).toMatchObject([{ action: "resume", username: "jollylaenus.46" }])
  })

  it("writes restart journals with private directory and file modes", () => {
    const root = mkdtempSync(join(tmpdir(), "persona-bootstrap-"))
    const path = join(root, "nested", "persona.json")
    const journal = { profile: "locale-la-enus", network: "previewnet" as const, username: "jollylaenus.42", account: "5Account", secret: "E2E_POOL_PREVIEWNET" }
    writePublicJournal(path, journal)
    expect(statSync(join(root, "nested")).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
import { mkdtempSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

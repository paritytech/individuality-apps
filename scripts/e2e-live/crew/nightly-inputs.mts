// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Read-only fresh-pool inventory; never calls the allocating probe.
import { appendFileSync } from "node:fs"
import { createPeopleClient } from "@jollity/game-chain"
import { liteAliasBinding } from "../../lib/lite-chain.mts"
import { NETWORKS } from "../../lib/host-slot.mjs"
import { parseFreshPool, unboundFresh } from "../fresh-pool"

const { client, api } = createPeopleClient(process.env.PEOPLE_WS || NETWORKS.previewnet.peopleWs)
const timer = setTimeout(() => { console.error("suite chain inventory timed out"); process.exit(1) }, 60_000)
try {
  const regular = parseFreshPool(process.env.E2E_IDENTITIES_PREVIEWNET)
  const fresh = await unboundFresh(parseFreshPool(process.env.E2E_FRESH_IDENTITIES_PREVIEWNET), regular, async (account) => (await liteAliasBinding(api, account)) !== undefined)
  if (!process.env.GITHUB_ENV) throw new Error("GITHUB_ENV is required")
  appendFileSync(process.env.GITHUB_ENV, `E2E_UNBOUND_FRESH_USERS=${JSON.stringify(fresh)}\n`)
} finally { clearTimeout(timer); client.destroy() }

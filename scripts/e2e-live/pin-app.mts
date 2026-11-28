// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * PIN THE APP BUILD, AS LATE AS POSSIBLE: resolve E2E_APP's dotNS name to the
 * CID every runner loads (E2E_APP_CID), right before the play runners start.
 *
 * The probe also resolves it (to fail early on a name that serves nothing),
 * but the probe then sleeps up to an hour. A deploy that lands in that sleep
 * publishes a newer build AND writes it into the version gist, so a runner
 * loading the CID pinned at probe time opens a bundle the app itself calls
 * stale ("A new version is out") and never signs up. On previewnet every push
 * to main redeploys dim2.testnet, the release name, so this is not rare
 * (game 32, 5 Oct 2026: probe 21:13, deploy 21:19, every bot stale).
 *
 * An optional E2E_APP_CID_INPUT is used verbatim instead of resolving dotNS;
 * that is how several workflow runs keep one build across a comparison series.
 *
 *   E2E_APP=dim2.testnet E2E_NETWORK=previewnet npx tsx scripts/e2e-live/pin-app.mts
 *
 * Writes `app_cid=<cid>` and `app_pin_source=input|resolved` to
 * $GITHUB_OUTPUT (stdout when unset). `app: local` pins nothing.
 */
import { appendFileSync } from "node:fs"
import { resolveCid, runTarget } from "./deployed-app"
import { selectAppPin } from "./app-pin"

const { app } = runTarget(process.env)
const pin = await selectAppPin(app, process.env.E2E_APP_CID_INPUT, resolveCid)
console.log(pin.cid ? `app ${app} -> ${pin.cid} (pinned by ${pin.source}, for every runner)` : "app local: nothing to pin")
const lines = `app_cid=${pin.cid}\napp_pin_source=${pin.source}\n`
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines)
else process.stdout.write(lines)

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { dirname, parse, resolve } from "node:path"
import { loadCrewCatalogue } from "./catalogue"
import { deterministicClock, flagArguments, requiredFlag } from "./cli-arguments"
import { applyPublicationBundle } from "./publish"

interface Arguments {
  stateDir: string
  bundlePath: string
  now: Date
}

function argumentsFrom(argv: string[]): Arguments {
  const values = flagArguments(argv, ["--state", "--bundle", "--now"])
  const usage = "usage: publish-cli.mts --state <history-root> --bundle <publication-bundle.json>"
  const stateDir = resolve(requiredFlag(values, "--state", usage))
  const bundlePath = resolve(requiredFlag(values, "--bundle", usage))
  if (stateDir === parse(stateDir).root) throw new Error("refusing to publish into a filesystem root")
  return { stateDir, bundlePath, now: deterministicClock(values, "CREW_PUBLISH_TEST_CLOCK") }
}

const args = argumentsFrom(process.argv.slice(2))
const result = applyPublicationBundle({
  stateDir: args.stateDir,
  bundle: JSON.parse(readFileSync(args.bundlePath, "utf8")),
  catalogue: loadCrewCatalogue(),
  portraitDir: new URL("./portraits/", import.meta.url),
  portraitSourceDir: dirname(args.bundlePath),
  now: args.now,
})
process.stdout.write(`${JSON.stringify(result)}\n`)

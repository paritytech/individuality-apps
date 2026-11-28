// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { loadProfiles } from "../profile"
import { loadCrewCatalogue } from "./catalogue"
import { CREW_DOCUMENT_PATH, renderCrewDocument } from "./document"

const outputArgument = process.argv.indexOf("--out")
if (outputArgument >= 0 && !process.argv[outputArgument + 1]) throw new Error("--out needs a path")

const output = resolve(outputArgument >= 0 ? process.argv[outputArgument + 1] : CREW_DOCUMENT_PATH)
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, renderCrewDocument(loadCrewCatalogue(), loadProfiles()))
console.log(`wrote ${output}`)

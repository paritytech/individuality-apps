// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadProfiles } from "../profile"
import { loadCrewCatalogue, type CrewCatalogue } from "./catalogue"
import { CREW_DOCUMENT_PATH, renderCrewDocument } from "./document"

const temporaryDirectories: string[] = []

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
})

describe("PreviewNet crew document", () => {
  it("matches a freshly rendered temporary document byte-for-byte", () => {
    const directory = mkdtempSync(join(tmpdir(), "previewnet-crew-doc-"))
    temporaryDirectories.push(directory)
    const output = join(directory, "crew.md")
    writeFileSync(output, renderCrewDocument(loadCrewCatalogue(), loadProfiles()))

    const committed = readFileSync(resolve(CREW_DOCUMENT_PATH))
    expect(readFileSync(output)).toEqual(committed)
  })

  it("renders all identities and scenarios with their bound profiles", () => {
    const catalogue = loadCrewCatalogue()
    const markdown = renderCrewDocument(catalogue, loadProfiles())

    expect(markdown).toContain("31 active identities")
    expect(markdown.match(/^### /gm)).toHaveLength(catalogue.scenarios.length)
    for (const identity of catalogue.identities) {
      expect(markdown).toContain(identity.username)
      expect(markdown).toContain(identity.portrait)
    }
    for (const scenario of catalogue.scenarios) expect(markdown).toContain(`### ${scenario.profile} —`)
  })

  it("escapes hostile Markdown and raw HTML from catalogue text", () => {
    const catalogue = structuredClone(loadCrewCatalogue()) as CrewCatalogue
    catalogue.identities[0].displayName = "A | [link](bad) <script>alert(1)</script>"
    catalogue.identities[0].tagline = "one\rtwo\nthree\r\nfour"
    catalogue.scenarios[0].purpose = "Break | [table] <img src=x>"

    const markdown = renderCrewDocument(catalogue, loadProfiles())
    expect(markdown).not.toContain("<script>")
    expect(markdown).not.toContain("<img src=x>")
    expect(markdown).not.toContain("\r")
    expect(markdown).toContain("A \\| \\[link\\](bad) &lt;script&gt;alert(1)&lt;/script&gt;")
    expect(markdown).toContain("one two three four")
    expect(markdown).toContain("Break \\| \\[table\\] &lt;img src=x&gt;")
  })
})

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { identityFor, type Profile } from "../profile"
import { assertPublicSafe } from "../public-safety"
import type { CrewCatalogue, PublicParameter, ScenarioPresentation } from "./catalogue"

export const CREW_DOCUMENT_PATH = "docs/e2e-live-previewnet-crew.md"

const markdown = (value: unknown): string =>
  String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("`", "\\`")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll(/\r\n?|\n/g, " ")

const parameterValue = (value: PublicParameter): string => (typeof value === "string" ? JSON.stringify(value) : Array.isArray(value) ? JSON.stringify(value) : String(value))

const codeUnitOrder = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const scenarioSection = (scenario: ScenarioPresentation): string => {
  const parameters = Object.entries(scenario.parameters)
    .sort(([left], [right]) => codeUnitOrder(left, right))
    .map(([key, value]) => `- **${markdown(key)}:** ${markdown(parameterValue(value))}`)
  const lifecycle = Object.entries(scenario.phases).map(([phase, narration]) => `| ${markdown(phase)} | ${markdown(narration)} |`)
  const actions = Object.entries(scenario.actions).map(
    ([action, narration]) => `| ${markdown(action)} | ${markdown(narration.active)} | ${markdown(narration.recovered ?? "—")} | ${markdown(narration.failed)} |`,
  )

  return [
    `### ${markdown(scenario.profile)} — ${markdown(scenario.title)}`,
    "",
    `**Purpose:** ${markdown(scenario.purpose)}`,
    "",
    `**Expected behavior:** ${markdown(scenario.expected)}`,
    "",
    "#### Safe parameters",
    "",
    ...(parameters.length ? parameters : ["None."]),
    "",
    "#### Video narration lifecycle",
    "",
    "| Phase | Overlay narration |",
    "| --- | --- |",
    ...lifecycle,
    "",
    "#### Action narration",
    "",
    ...(actions.length
      ? ["| Action | Active | Recovered | Failed |", "| --- | --- | --- | --- |", ...actions]
      : ["No disruptive actions."]),
  ].join("\n")
}

export function renderCrewDocument(catalogue: CrewCatalogue, profiles: Profile[]): string {
  const activeCount = catalogue.identities.length
  const identities = catalogue.identities.map((identity) => {
    const boundProfiles = profiles.filter((profile) => identityFor(profile, "previewnet") === identity.username).map((profile) => profile.name)
    return `| ${markdown(identity.displayName)} | ${markdown(identity.username)} | ${markdown(identity.portrait)} | ${markdown(identity.tagline)} | ${markdown(identity.speciality)} | ${markdown(boundProfiles.join(", ") || "—")} |`
  })

  const document = [
    "# PreviewNet crew and scenario catalogue",
    "",
    "**Generated file. Do not edit by hand.**",
    "",
    "- Identity source: scripts/e2e-live/crew/catalogue.json",
    "- Scenario presentation: derived from scripts/e2e-live/profiles.json and the validated live-E2E plans",
    "- Regenerate: npm run e2e-live:crew-doc",
    `- Catalogue version: ${catalogue.version}`,
    `- Coverage: ${activeCount} active identities and ${catalogue.scenarios.length} scenarios`,
    "",
    "Identity prose is presentation-only. Scenario parameters, narration, and evidence wording are derived from the executable live-E2E profiles and plans on every render.",
    "",
    "## Boot harness",
    "",
    `**${markdown(catalogue.harness.displayName)}:** ${markdown(catalogue.harness.description)}`,
    "",
    "The harness owns boot-only infrastructure checks and never impersonates a playing identity.",
    "",
    "## Identities",
    "",
    "| Identity | PreviewNet username | Portrait filename | Tagline | Speciality | Bound profiles |",
    "| --- | --- | --- | --- | --- | --- |",
    ...identities,
    "",
    "## Scenarios",
    "",
    ...catalogue.scenarios.flatMap((scenario, index) => [scenarioSection(scenario), ...(index === catalogue.scenarios.length - 1 ? [] : [""])]),
    "",
  ].join("\n")
  assertPublicSafe("crew document", document)
  return document
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { identityFor, loadProfiles, type Profile } from "../profile"
import { allRoles, profileForName } from "../profiles"
import { assertPublicSafe } from "../public-safety"
import { deriveScenarioPresentations } from "./presentation"
import catalogueJson from "./catalogue.json"

export { requiredNarrationActions } from "./presentation"

export interface CrewIdentity {
  key: string
  username: string
  displayName: string
  portrait: string
  tagline: string
  backstory: string
  speciality: string
  palette: { primary: `#${string}`; secondary: `#${string}`; ink: `#${string}` }
}

export interface ScenarioActionPresentation {
  active: string
  recovered?: string
  failed: string
}

export type PublicParameter = string | number | boolean | readonly number[]

export interface ScenarioPresentation {
  profile: string
  title: string
  purpose: string
  expected: string
  criteria: string[]
  parameters: Record<string, PublicParameter>
  phases: {
    preparing: string
    verifying: string
    passed: string
    failed: string
  }
  actions: Record<string, ScenarioActionPresentation>
}

export interface CrewCatalogue {
  version: 1
  harness: {
    key: string
    displayName: string
    description: string
  }
  identities: CrewIdentity[]
  scenarios: ScenarioPresentation[]
}

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`)
}

const object = (where: string, value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(where, "expected an object")
  return value as Record<string, unknown>
}

const fields = (where: string, value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = allowed): void => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(where, `no field ${key}`)
  for (const key of required) if (!(key in value)) fail(where, `needs field ${key}`)
}

const string = (where: string, value: unknown, maxLength = 500): string => {
  if (typeof value !== "string" || value.trim() === "") fail(where, "expected a non-empty string")
  if (value.length > maxLength) fail(where, `expected at most ${maxLength} characters`)
  return value as string
}

const sentenceCount = (value: string): number => (value.match(/[.!?](?:\s|$)/g) ?? []).length || 1

const colour = (where: string, value: unknown): `#${string}` => {
  const parsed = string(where, value)
  if (!/^#[0-9A-Fa-f]{6}$/.test(parsed)) fail(where, "expected #RRGGBB")
  return parsed as `#${string}`
}

const linearChannel = (hex: string): number => {
  const value = Number.parseInt(hex, 16) / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}
const luminance = (hex: string): number => 0.2126 * linearChannel(hex.slice(1, 3)) + 0.7152 * linearChannel(hex.slice(3, 5)) + 0.0722 * linearChannel(hex.slice(5, 7))
export const contrast = (one: string, two: string): number => {
  const [bright, dark] = [luminance(one), luminance(two)].sort((a, b) => b - a)
  return (bright + 0.05) / (dark + 0.05)
}

const duplicate = <T>(values: readonly T[]): T | undefined => values.find((value, index) => values.indexOf(value) !== index)
const sameMembers = (one: readonly string[], two: readonly string[]): boolean => one.length === two.length && one.every((entry) => two.includes(entry))

export function validateCrewCatalogue(raw: unknown, profiles: Profile[] = loadProfiles()): CrewCatalogue {
  assertPublicSafe("catalogue", raw)
  const root = object("catalogue", raw)
  fields("catalogue", root, ["version", "harness", "identities"])
  if (root.version !== 1) fail("catalogue.version", "expected 1")

  const harnessRaw = object("catalogue.harness", root.harness)
  fields("catalogue.harness", harnessRaw, ["key", "displayName", "description"])
  const harness = {
    key: string("catalogue.harness.key", harnessRaw.key),
    displayName: string("catalogue.harness.displayName", harnessRaw.displayName),
    description: string("catalogue.harness.description", harnessRaw.description),
  }

  if (!Array.isArray(root.identities)) fail("catalogue.identities", "expected an array")
  const identities: CrewIdentity[] = root.identities.map((entry, index) => {
    const where = `catalogue.identities[${index}]`
    const value = object(where, entry)
    fields(where, value, ["key", "username", "displayName", "portrait", "tagline", "backstory", "speciality", "palette"])
    const portrait = string(`${where}.portrait`, value.portrait)
    if (!/^[a-z0-9-]+\.webp$/.test(portrait) || portrait.includes("..") || portrait.includes(":") || portrait.startsWith("/")) fail(`${where}.portrait`, "expected a safe WebP filename")
    const paletteRaw = object(`${where}.palette`, value.palette)
    fields(`${where}.palette`, paletteRaw, ["primary", "secondary", "ink"])
    const palette = {
      primary: colour(`${where}.palette.primary`, paletteRaw.primary),
      secondary: colour(`${where}.palette.secondary`, paletteRaw.secondary),
      ink: colour(`${where}.palette.ink`, paletteRaw.ink),
    }
    if (contrast(palette.ink, palette.primary) < 4.5) fail(`${where}.palette.ink`, "contrast against primary must be at least 4.5:1")
    const tagline = string(`${where}.tagline`, value.tagline)
    const backstory = string(`${where}.backstory`, value.backstory)
    if (sentenceCount(tagline) > 2) fail(`${where}.tagline`, "expected at most two sentences")
    if (sentenceCount(backstory) > 2) fail(`${where}.backstory`, "expected at most two sentences")
    return {
      key: string(`${where}.key`, value.key),
      username: string(`${where}.username`, value.username),
      displayName: string(`${where}.displayName`, value.displayName),
      portrait,
      tagline,
      backstory,
      speciality: string(`${where}.speciality`, value.speciality),
      palette,
    }
  })

  for (const field of ["key", "username", "portrait"] as const) {
    const repeated = duplicate(identities.map((identity) => identity[field]))
    if (repeated !== undefined) fail("catalogue.identities", `duplicate ${field} ${repeated}`)
  }
  const repeatedPalette = duplicate(identities.map((identity) => `${identity.palette.primary}/${identity.palette.secondary}`))
  if (repeatedPalette) fail("catalogue.identities", `duplicate palette ${repeatedPalette}`)

  const activeUsernames = identities.map((identity) => identity.username)
  const expectedUsernames = activePreviewnetUsernames(profiles)
  if (!sameMembers(activeUsernames, expectedUsernames)) fail("catalogue.identities", `active usernames must equal allRoles PreviewNet identities (expected ${expectedUsernames.join(", ")})`)

  const catalogue: CrewCatalogue = { version: 1, harness, identities, scenarios: deriveScenarioPresentations(identities, profiles) }
  assertPublicSafe("catalogue", catalogue)
  return catalogue
}

let loadedCatalogue: CrewCatalogue | null = null
export function loadCrewCatalogue(profiles?: Profile[]): CrewCatalogue {
  if (!profiles && loadedCatalogue) return loadedCatalogue
  const catalogue = validateCrewCatalogue(catalogueJson, profiles ?? loadProfiles())
  if (!profiles) loadedCatalogue = catalogue
  return catalogue
}

export function crewIdentity(username: string, catalogue: CrewCatalogue = loadCrewCatalogue()): CrewIdentity {
  const identity = catalogue.identities.find((entry) => entry.username === username)
  if (!identity) throw new Error(`no crew identity for ${username}`)
  return identity
}

export function scenarioPresentation(profile: string, catalogue: CrewCatalogue = loadCrewCatalogue()): ScenarioPresentation {
  const scenario = catalogue.scenarios.find((entry) => entry.profile === profile)
  if (!scenario) throw new Error(`no crew scenario for ${profile}`)
  return scenario
}

export function activePreviewnetUsernames(profiles: Profile[] = loadProfiles()): string[] {
  return [...new Set(allRoles(profiles, "previewnet").map(({ profile }) => identityFor(profileForName(profile, profiles) as Profile, "previewnet") as string))]
}

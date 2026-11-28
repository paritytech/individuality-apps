// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { regularPoolSecret } from "./regular-pool"

export const PERSONA_NETWORKS = ["previewnet", "paseo-next-v2"] as const
export type PersonaNetwork = (typeof PERSONA_NETWORKS)[number]

export interface PersonaSpec { profile: string; base: string }
export interface PersonaManifest { personas: PersonaSpec[] }
export interface PublicJournal { profile: string; network: PersonaNetwork; username: string; account: string; secret: string }
type ProfileMapping = { identity?: string | Partial<Record<PersonaNetwork, string>> }
type BootstrapAction = "create" | "resume" | "verify" | "repair" | "rebuild"
export interface BootstrapStep {
  profile: string; base: string; network: PersonaNetwork; action: BootstrapAction
  username?: string; account?: string; secret?: string; aggregateMembership?: "unverifiable"; previousUsername?: string; problems: string[]
}

export function writePublicJournal(path: string, journal: PublicJournal): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  chmodSync(dirname(path), 0o700)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

const profileIdentity = (profile: ProfileMapping | undefined, network: PersonaNetwork): string | undefined => {
  const identity = profile?.identity
  return typeof identity === "string" ? identity : identity?.[network]
}

export function validatePersonaManifest(raw: unknown): PersonaSpec[] {
  const manifest = raw as Partial<PersonaManifest> | null
  if (!manifest || !Array.isArray(manifest.personas) || !manifest.personas.length) throw new Error("persona-bootstrap.json needs a non-empty personas array")
  const profiles = new Set<string>(), bases = new Set<string>()
  return manifest.personas.map((rawPersona, index) => {
    const persona = rawPersona as Partial<PersonaSpec>
    if (typeof persona.profile !== "string" || !persona.profile) throw new Error(`personas[${index}].profile must be a non-empty string`)
    if (typeof persona.base !== "string" || !/^[a-z]{4,24}$/.test(persona.base)) throw new Error(`personas[${index}].base must be 4-24 lowercase letters`)
    if (profiles.has(persona.profile)) throw new Error(`duplicate persona profile ${persona.profile}`)
    if (bases.has(persona.base)) throw new Error(`duplicate persona base ${persona.base}`)
    profiles.add(persona.profile); bases.add(persona.base)
    return { profile: persona.profile, base: persona.base }
  })
}

export function buildBootstrapPlan(opts: {
  manifest: unknown
  profiles: Record<string, ProfileMapping>
  pools: Record<PersonaNetwork, Record<string, string>>
  secretNames: ReadonlySet<string>
  journals: Record<string, PublicJournal | undefined>
  localSlots: ReadonlySet<string>
  networks?: readonly PersonaNetwork[]
  rebuild?: ReadonlySet<string>
}): BootstrapStep[] {
  const networks = opts.networks ?? PERSONA_NETWORKS
  const rebuild = opts.rebuild ?? new Set<string>()
  const steps: BootstrapStep[] = []
  for (const persona of validatePersonaManifest(opts.manifest)) {
    if (!opts.profiles[persona.profile]) throw new Error(`manifest profile ${persona.profile} is absent from profiles.json`)
    for (const network of networks) {
      const mapped = profileIdentity(opts.profiles[persona.profile], network)
      const journal = opts.journals[`${persona.profile}:${network}`]
      const retained = [...opts.localSlots].filter((slot) => slot.startsWith(`${network}:${persona.base}.`)).map((slot) => slot.slice(network.length + 1))
      if (!mapped && !journal && retained.length > 1) throw new Error(`${persona.profile}/${network} has multiple retained ${persona.base}.* slots; use --rebuild explicitly or resolve the ambiguity`)
      const username = mapped ?? journal?.username ?? retained[0]
      const account = username ? opts.pools[network][username] ?? journal?.account : undefined
      const secret = username ? regularPoolSecret(network) : undefined
      if (rebuild.has(`${persona.profile}:${network}`)) {
        steps.push({ profile: persona.profile, base: persona.base, network, action: "rebuild", ...(username && { previousUsername: username }), problems: [] })
        continue
      }
      if (!username) {
        steps.push({ profile: persona.profile, base: persona.base, network, action: "create", problems: [] })
        continue
      }
      const problems = [
        ...(!account ? [`${network} pool has no account for ${username}`] : []),
        ...(!secret || !opts.secretNames.has(secret) ? [`repository secret ${secret ?? "(unknown)"} is absent`] : []),
        ...(!opts.localSlots.has(`${network}:${username}`) ? [`retained signer slot for ${username} is absent`] : []),
      ]
      const action: BootstrapAction = !mapped && (journal || retained[0]) ? "resume" : problems.length ? "repair" : "verify"
      const aggregatePresent = Boolean(secret && opts.secretNames.has(secret))
      steps.push({ profile: persona.profile, base: persona.base, network, action, username, ...(account && { account }), ...(secret && { secret }), ...(aggregatePresent && { aggregateMembership: "unverifiable" as const }), problems })
    }
  }
  return steps
}

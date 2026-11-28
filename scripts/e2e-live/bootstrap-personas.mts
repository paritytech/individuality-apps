// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Rebuildable persona identity bootstrap. The default is a read-only
 * plan. External mutation requires --apply and exactly one --network.
 * Mnemonics remain solely in the retained truapi-host slots and are piped by
 * new-identity.mts to GitHub secrets over stdin.
 */
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { buildBootstrapPlan, PERSONA_NETWORKS, writePublicJournal, type PersonaNetwork, type PublicJournal } from "./persona-bootstrap"
import { poolVariable } from "./players"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const flags = (name: string): string[] => args.flatMap((value, index) => (value === name && args[index + 1] ? [args[index + 1]] : []))
const has = (name: string): boolean => args.includes(name)
const apply = has("--apply")
const repoName = flag("--repo")
const root = resolve(flag("--state-root") ?? join(repo, ".truapi-host", "persona-bootstrap"))
const poolStateDirs = flags("--pool-state-dir").map((path) => resolve(path))
if (!poolStateDirs.length) poolStateDirs.push(dirname(root))
const requestedNetwork = flag("--network")
if (requestedNetwork && !PERSONA_NETWORKS.includes(requestedNetwork as PersonaNetwork)) throw new Error(`--network must be ${PERSONA_NETWORKS.join(" or ")}`)
if (apply && !requestedNetwork) throw new Error("--apply requires exactly one --network")
const networks = requestedNetwork ? [requestedNetwork as PersonaNetwork] : PERSONA_NETWORKS
const rebuildProfile = flag("--rebuild")
if (rebuildProfile && !apply) throw new Error("--rebuild <profile> requires --apply")

const manifest = JSON.parse(readFileSync(join(repo, "scripts/e2e-live/persona-bootstrap.json"), "utf8")) as unknown
const profilesPath = join(repo, "scripts/e2e-live/profiles.json")
const readProfiles = (): { profiles: { name: string; identity?: string | Partial<Record<PersonaNetwork, string>> }[] } => JSON.parse(readFileSync(profilesPath, "utf8"))

function gh(ghArgs: string[]): string {
  const result = spawnSync("gh", [...ghArgs, ...(repoName ? ["--repo", repoName] : [])], { cwd: repo, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`gh ${ghArgs.slice(0, 3).join(" ")} failed: ${String(result.stderr || result.stdout).trim()}`)
  return result.stdout.trim()
}

function readPool(network: PersonaNetwork): Record<string, string> {
  const text = gh(["variable", "get", poolVariable(network)])
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${poolVariable(network)} is not a JSON object`)
  return parsed as Record<string, string>
}

function journalPath(profile: string, network: PersonaNetwork): string {
  return join(root, "journals", network, `${profile}.json`)
}

function readJournal(profile: string, network: PersonaNetwork): PublicJournal | undefined {
  const path = journalPath(profile, network)
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as PublicJournal : undefined
}

function writeProfileIdentity(profileName: string, network: PersonaNetwork, username: string): void {
  const document = readProfiles()
  const profile = document.profiles.find((candidate) => candidate.name === profileName)
  if (!profile) throw new Error(`profile ${profileName} disappeared from profiles.json`)
  const old = profile.identity
  profile.identity = typeof old === "string"
    ? { "paseo-next-v2": old, [network]: username }
    : { ...(old ?? {}), [network]: username }
  const tmp = `${profilesPath}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`)
  renameSync(tmp, profilesPath)
}

function localSlots(): Set<string> {
  const found = new Set<string>()
  for (const network of PERSONA_NETWORKS) {
    const dir = join(root, "slots", network)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) if (!name.startsWith(".new-")) found.add(`${network}:${name}`)
  }
  return found
}

function state(): ReturnType<typeof buildBootstrapPlan> {
  const profileDocument = readProfiles()
  const profiles = Object.fromEntries(profileDocument.profiles.map((profile) => [profile.name, profile]))
  const pools: Record<PersonaNetwork, Record<string, string>> = { previewnet: {}, "paseo-next-v2": {} }
  for (const network of networks) pools[network] = readPool(network)
  const secretEntries = JSON.parse(gh(["secret", "list", "--json", "name"])) as { name: string }[]
  const secretNames = new Set<string>(secretEntries.map((entry) => entry.name))
  const journals: Record<string, PublicJournal | undefined> = {}
  for (const persona of (manifest as { personas: { profile: string }[] }).personas) for (const network of PERSONA_NETWORKS) journals[`${persona.profile}:${network}`] = readJournal(persona.profile, network)
  const rebuild = rebuildProfile && requestedNetwork ? new Set([`${rebuildProfile}:${requestedNetwork}`]) : undefined
  return buildBootstrapPlan({ manifest, profiles, pools, secretNames, journals, localSlots: localSlots(), networks, rebuild })
}

function printPlan(plan: ReturnType<typeof buildBootstrapPlan>): void {
  console.log("profile | network | action | identity | aggregate secret")
  for (const step of plan) {
    const secretPresent = step.secret && !step.problems.some((problem) => problem.startsWith("repository secret "))
    const aggregateState = secretPresent ? `present; ${step.aggregateMembership === "unverifiable" ? "membership unverifiable" : "membership not checked"}` : "set/rebuilt during apply"
    console.log(`${step.profile} | ${step.network} | ${step.action} | ${step.username ? "existing" : "assigned during apply"} | ${aggregateState}`)
  }
  const trouble = plan.flatMap((step) => step.problems.map((problem) => `${step.profile}/${step.network}: ${problem}`))
  if (trouble.length) console.log(`repair checks: ${trouble.join("; ")}`)
}

async function main(): Promise<void> {
  if (apply) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
  }
  const plan = state()
  printPlan(plan)
  if (!apply) return
  for (const step of plan) {
    const resultPath = join(root, "results", step.network, `${step.profile}.json`)
    const childArgs = ["tsx", "scripts/e2e-live/new-identity.mts", "--network", step.network, "--state-root", root, "--result-file", resultPath, ...poolStateDirs.flatMap((path) => ["--pool-state-dir", path]), ...(repoName ? ["--repo", repoName] : [])]
    if (step.action === "create" || step.action === "rebuild") childArgs.push("--base", step.base)
    else if (step.username) childArgs.push("--adopt", step.username)
    else throw new Error(`${step.profile}/${step.network}: ${step.action} has no retained identity to adopt`)
    console.log(`${step.profile}/${step.network}: ${step.action}`)
    const result = spawnSync("npx", childArgs, { cwd: repo, stdio: "inherit" })
    const entries = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) as { username: string; account: string; secret: string }[] : []
    const created = entries.at(-1)
    if (created) {
      const recovery: PublicJournal = { profile: step.profile, network: step.network, username: created.username, account: created.account, secret: created.secret }
      writePublicJournal(journalPath(step.profile, step.network), recovery)
    }
    if (result.status !== 0) throw new Error(`${step.profile}/${step.network}: identity bootstrap failed; rerun the same command to adopt the retained verified signer`)
    if (!created) throw new Error(`${step.profile}/${step.network}: no public result was written`)
    writeProfileIdentity(step.profile, step.network, created.username)
    console.log(`${step.profile}/${step.network}: verified and mapped (${created.username}, ${created.secret})`)
  }
  console.log("apply complete; a repeated plan must report verify for every selected persona")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

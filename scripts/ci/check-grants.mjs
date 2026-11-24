// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Reads the grants a Humanity name publishes and checks them.
//
// The grants are the trustedProducts of the name's manifest text record:
// which other products the host lets use Humanity's account and storage
// without a prompt. Jollity's sign-up and its chat worker need them, so a
// name whose grants drift breaks Jollity with no Humanity release (#40).
//
// A name passes when its grants equal the HUMANITY_TRUSTED_PRODUCTS variable,
// each list sorted and de-duplicated as release.yml's "Check the staged
// grants" compares them, and when Jollity's label (JOLLITY_DOTNS_DOMAIN) holds
// at least context and storage, so emptying the variable cannot pass either.
//
// Each name ends in one of these outcomes:
//   ok          the grants are right;
//   wrong       the read worked, and the grants are wrong or missing;
//   unchecked   the read failed or timed out, so nothing is known about them;
//   undeployed  only with --not-deployed-warns: the name does not exist, as
//               on a network that was reset and has had no deploy since.
// A failed read is never reported as missing grants. Paseo's RPC can take
// about 20 s to open a websocket, so each read is tried a few times first.
//
// The read is `dotns text view <name> manifest --json` with no key: the CLI's
// key variables are removed from its environment, so it can only read.
//
// Usage: node scripts/ci/check-grants.mjs [--unchecked-warns] [--not-deployed-warns] [--confirm-wrong] [--results <file>] --env paseo-v2 <name>... [--stack <stack> <name>...]
//   --env <dotns env> or --stack <stack descriptor> says where the names
//   after it are read: --stack (dotns-cli 2.0.0 and later) reads on a network
//   from its published descriptor instead of the CLI's bundled copy, which
//   goes stale when a network such as previewnet restarts.
//   reads HUMANITY_TRUSTED_PRODUCTS and JOLLITY_DOTNS_DOMAIN from the
//   environment, prints one ::error or ::notice line per name, writes
//   outcome=ok|wrong|unchecked|undeployed to $GITHUB_OUTPUT, and exits 0
//   (ok or undeployed), 1 (any name wrong) or 2 (none wrong, but some could
//   not be checked).
//   With --unchecked-warns, a name that could not be checked is a warning
//   and exits 0, for a job that must not fail on a slow RPC.
//   With --not-deployed-warns, a name that does not exist is the outcome
//   undeployed: a warning that it was not deployed since the network's last
//   reset, exit 0. A name that exists with wrong or no grants is still
//   wrong. Without it, a name that does not exist is wrong: it grants
//   nothing.
//   With --confirm-wrong, grants found wrong are read again after
//   GRANTS_CONFIRM_DELAY_SECONDS (45), and only that second read counts: a
//   read right after a publish can reach an RPC node that is a block behind
//   and still serves the old manifest. If the second read fails, the name is
//   unchecked.
//   Anything that crashes the checker is reported as unchecked too, never
//   as exit 1, which means wrong grants.
//   With --results, the outcome and every name's result are also written to
//   <file> as JSON, for scripts/ci/sentry-grants.mjs: a wrong name carries
//   the grants expected and found and, per product, the grants missing and
//   extra; an unchecked one carries the read error in its detail. A run that
//   compared nothing writes no results and an `error` instead.
//   DOTNS_BIN overrides the CLI (default `dotns` on PATH);
//   GRANTS_READ_ATTEMPTS, GRANTS_READ_TIMEOUT_SECONDS and
//   GRANTS_READ_DELAY_SECONDS tune the retries (3 reads, 90 s each, 15 s apart).
import { spawn } from "node:child_process"
import { appendFileSync, writeFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"

/** What Jollity's label needs at least: game-registration.ts reads storage and signs as Humanity. */
export const FLOOR = ["context", "storage"]

export const EXIT = { ok: 0, wrong: 1, unchecked: 2, undeployed: 0 }

/** The retries when GRANTS_READ_* leave them unset: a workflow's timeout must fit them for every name it reads. */
export const READ_DEFAULTS = { attempts: 3, timeoutSeconds: 90, delaySeconds: 15 }

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/


/** Each list sorted and de-duplicated, keys sorted: jq -S 'map_values(unique)'. */
export function normalize(grants) {
  const out = {}
  for (const key of Object.keys(grants).sort()) out[key] = [...new Set(grants[key])].sort()
  return out
}

export const show = (grants) => JSON.stringify(normalize(grants))

/** The grants the repository intends, from HUMANITY_TRUSTED_PRODUCTS. Throws on a value release.yml would refuse. */
export function expectedGrants(raw) {
  if (raw === undefined || raw.trim() === "") throw new Error("HUMANITY_TRUSTED_PRODUCTS is not set")
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("HUMANITY_TRUSTED_PRODUCTS is not valid JSON")
  }
  if (!isGrants(parsed)) throw new Error("HUMANITY_TRUSTED_PRODUCTS is not an object of label to grant list")
  return normalize(parsed)
}

function isGrants(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((list) => Array.isArray(list) && list.every((g) => typeof g === "string"))
  )
}

/**
 * One `dotns text view <name> manifest --json` answer: whether the name
 * exists, and its manifest text, or null when it has none. Throws when the
 * answer is not the CLI's JSON, which means the read itself failed.
 */
export function grantsFromRead(stdout) {
  let record
  try {
    record = JSON.parse(stdout)
  } catch {
    throw new Error(`the CLI printed no JSON: ${stdout.trim().slice(0, 200) || "(nothing)"}`)
  }
  if (record === null || typeof record !== "object" || typeof record.exists !== "boolean") {
    throw new Error(`the CLI's answer has no exists field: ${stdout.trim().slice(0, 200)}`)
  }
  const none = !record.exists || record.value === null || record.value === undefined || record.value === ""
  return { exists: record.exists, manifest: none ? null : record.value }
}

/**
 * Per product, the grants HUMANITY_TRUSTED_PRODUCTS has that `found` lacks
 * (missing) and the ones `found` has that it does not (extra); products that
 * match are left out. Both arguments are normalized grants.
 */
export function grantDiff(found, want) {
  const labels = [...new Set([...Object.keys(want), ...Object.keys(found)])].sort()
  const products = []
  for (const label of labels) {
    const has = found[label] ?? []
    const wants = want[label] ?? []
    const missing = wants.filter((g) => !has.includes(g))
    const extra = has.filter((g) => !wants.includes(g))
    if (missing.length > 0 || extra.length > 0) products.push({ label, missing, extra })
  }
  return products
}

/**
 * Judges the grants a name publishes: what is wrong with them (problems, []
 * when nothing is), the grants found (normalized, or null when the manifest
 * yields none), how they differ from `want` per product, and which grants
 * Jollity needs that its label lacks.
 */
export function judgeGrants({ manifest, want, floorLabel }) {
  const none = (problem) => ({ problems: [problem], found: null, products: grantDiff({}, want), floor: { label: floorLabel, lacking: [...FLOOR] } })
  if (manifest === null) return none("it has no manifest, so it grants nothing")
  let parsed
  try {
    parsed = JSON.parse(manifest)
  } catch {
    return none("its manifest is not JSON, so a host reads no grants from it")
  }
  const raw = parsed?.trustedProducts
  if (raw === undefined) return none("its manifest has no trustedProducts, so it grants nothing")
  if (!isGrants(raw)) return none(`its trustedProducts is not an object of label to grant list: ${JSON.stringify(raw)}`)
  const got = normalize(raw)
  const problems = []
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    problems.push(`it grants ${JSON.stringify(got)} but HUMANITY_TRUSTED_PRODUCTS is ${JSON.stringify(want)}`)
  }
  const lacking = FLOOR.filter((g) => !(got[floorLabel] ?? []).includes(g))
  if (lacking.length > 0) {
    problems.push(`${floorLabel} lacks ${lacking.join(" and ")}, which Jollity needs`)
  }
  return { problems, found: got, products: grantDiff(got, want), floor: lacking.length > 0 ? { label: floorLabel, lacking } : null }
}

/** What is wrong with the grants a name publishes, or [] when nothing is. */
export const grantProblems = (args) => judgeGrants(args).problems

/** Reads a name's manifest with the dotns CLI, with no key, on `where` (["--env", env] or ["--stack", stack]), and kills it after timeoutMs. */
export function readManifest(name, where, { bin = "dotns", timeoutMs = 90_000 } = {}) {
  const childEnv = { ...process.env }
  for (const key of ["DOTNS_MNEMONIC", "DOTNS_KEY_URI", "DOTNS_KEYSTORE_PASSWORD", "DOTNS_KEYSTORE_PATH", "DOTNS_SIGNER"]) {
    delete childEnv[key]
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["text", "view", name, "manifest", ...where, "--json"], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    // The CLI keeps reconnecting to an RPC that is down, so it never exits by itself.
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(new Error(`could not start ${bin}: ${error.message}`))
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (signal === "SIGKILL") reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`))
      else if (code !== 0) reject(new Error(`${bin} exited ${code}: ${(stderr || stdout).trim().slice(0, 300)}`))
      else resolve(stdout)
    })
  })
}

/**
 * Checks one name. `read(name)` resolves to the CLI's stdout; it is tried up
 * to `attempts` times, `delayMs` apart, before the name counts as unchecked.
 * With `confirmWrongMs`, a wrong result is read again that long after, and
 * the second result is the one returned.
 */
export async function checkName({ name, want, floorLabel, read, attempts = 3, delayMs = 15_000, confirmWrongMs, notDeployedWarns = false }) {
  const once = () => checkOnce({ name, want, floorLabel, read, attempts, delayMs, notDeployedWarns })
  const first = await once()
  if (first.outcome !== "wrong" || confirmWrongMs === undefined) return first
  await sleep(confirmWrongMs)
  const second = await once()
  const wait = `${Math.round(confirmWrongMs / 1000)} s`
  if (second.outcome === "ok") return { ...second, detail: `${second.detail} (a read ${wait} earlier saw old grants)` }
  if (second.outcome === "wrong") return { ...second, detail: `${second.detail} (the same again ${wait} later)` }
  if (second.outcome === "undeployed") return second
  return { ...second, detail: `a first read found wrong grants (${first.detail}), and the read ${wait} later to confirm it failed: ${second.detail}` }
}

async function checkOnce({ name, want, floorLabel, read, attempts, delayMs, notDeployedWarns }) {
  const failures = []
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let found
    try {
      found = grantsFromRead(await read(name))
    } catch (error) {
      failures.push(`attempt ${attempt}: ${error.message}`)
      if (attempt < attempts) await sleep(delayMs)
      continue
    }
    if (!found.exists && notDeployedWarns) {
      return { name, outcome: "undeployed", detail: "the name does not exist, so it was not deployed since the network's last reset" }
    }
    const judged = judgeGrants({ manifest: found.manifest, want, floorLabel })
    if (judged.problems.length === 0) return { name, outcome: "ok", detail: `grants ${show(want)}, as HUMANITY_TRUSTED_PRODUCTS says` }
    const { problems, ...grants } = judged
    return { name, outcome: "wrong", detail: problems.join("; "), expected: want, ...grants }
  }
  return { name, outcome: "unchecked", detail: failures.join("; ") }
}

/** The run's outcome: wrong before unchecked, since a known break matters more than an unknown, and both before undeployed, which only warns. */
export function overall(results) {
  for (const outcome of ["wrong", "unchecked", "undeployed"]) if (results.some((r) => r.outcome === outcome)) return outcome
  return "ok"
}

/** A workflow command's message, with the characters GitHub reads as markup escaped. */
const escapeData = (text) => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")

/** The GitHub annotation for one result. */
export function annotation({ name, outcome, detail }, { uncheckedWarns = false } = {}) {
  const line = (level, title, message) => `::${level} title=${title}::${escapeData(message)}`
  if (outcome === "ok") return line("notice", `Grants right on ${name}`, `${detail}.`)
  if (outcome === "undeployed") {
    return line(
      "warning",
      `${name} not deployed since the reset`,
      `${detail}. Its grants are checked again once a Humanity deploy publishes it there.`,
    )
  }
  if (outcome === "wrong") {
    return line(
      "error",
      `Grants wrong on ${name}`,
      `${detail}. Jollity cannot use Humanity's account or storage while this lasts. Publish the name again with the right HUMANITY_TRUSTED_PRODUCTS, or fix the variable.`,
    )
  }
  return line(
    uncheckedWarns ? "warning" : "error",
    `Could not check the grants of ${name}`,
    `The manifest could not be read, so the grants are unknown, not missing (${detail}). Usually the network's RPC is slow or down. Run the check again.`,
  )
}

const USAGE = "usage: check-grants.mjs [--unchecked-warns] [--not-deployed-warns] [--confirm-wrong] [--results <file>] --env <dotns env> <name>... [--stack <stack> <name>...]"

/** The flags, and each name with where it is read: the --env or --stack before it. */
export function parseArgs(argv) {
  const names = []
  let where = null
  let confirmWrong = false
  const notDeployedWarns = argv.includes("--not-deployed-warns")
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env" || argv[i] === "--stack") {
      const value = argv[++i]
      if (!value) throw new Error(USAGE)
      where = [argv[i - 1], value]
    } else if (argv[i] === "--unchecked-warns" || argv[i] === "--not-deployed-warns") continue
    else if (argv[i] === "--results") i++
    else if (argv[i] === "--confirm-wrong") confirmWrong = true
    else if (where === null) throw new Error(USAGE)
    else names.push({ name: argv[i], where })
  }
  if (names.length === 0) throw new Error(USAGE)
  return { names, confirmWrong, notDeployedWarns }
}

/** Read apart from the other flags, so a crash in parsing them still honours them. */
const uncheckedWarns = process.argv.includes("--unchecked-warns")
const resultsFile = process.argv.includes("--results") ? process.argv[process.argv.indexOf("--results") + 1] : undefined

/** Writes the --results file. Like the step output, a file that cannot be written is a warning. */
function writeResults(results) {
  if (!resultsFile) return
  try {
    writeFileSync(resultsFile, `${JSON.stringify(results, null, 2)}\n`)
  } catch (error) {
    console.log(`::warning title=No grants results file::${escapeData(String(error))}`)
  }
}

/** Writes to $GITHUB_OUTPUT. A file that cannot be written is a warning: the exit code still carries the outcome. */
function output(line) {
  try {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`)
  } catch (error) {
    console.log(`::warning title=No step output::${escapeData(String(error))}`)
  }
}

async function main() {
  const { names, confirmWrong, notDeployedWarns } = parseArgs(process.argv.slice(2))
  const floorLabel = process.env.JOLLITY_DOTNS_DOMAIN ?? ""
  let want
  try {
    if (!LABEL.test(floorLabel)) throw new Error("JOLLITY_DOTNS_DOMAIN is not a bare DotNS label")
    want = expectedGrants(process.env.HUMANITY_TRUSTED_PRODUCTS)
  } catch (error) {
    // Nothing was compared, so the grants are unknown, not wrong.
    console.log(`::${uncheckedWarns ? "warning" : "error"} title=Could not check the grants::${error.message}. Set the repo variable, then run the check again.`)
    output("outcome=unchecked")
    writeResults({ outcome: "unchecked", error: `${error.message}. Set the repo variable, then run the check again.`, results: [] })
    process.exit(uncheckedWarns ? EXIT.ok : EXIT.unchecked)
  }
  const attempts = Number(process.env.GRANTS_READ_ATTEMPTS || READ_DEFAULTS.attempts)
  const timeoutMs = Number(process.env.GRANTS_READ_TIMEOUT_SECONDS || READ_DEFAULTS.timeoutSeconds) * 1000
  const delayMs = Number(process.env.GRANTS_READ_DELAY_SECONDS ?? READ_DEFAULTS.delaySeconds) * 1000
  const confirmWrongMs = confirmWrong ? Number(process.env.GRANTS_CONFIRM_DELAY_SECONDS ?? 45) * 1000 : undefined
  const bin = process.env.DOTNS_BIN || "dotns"
  const results = []
  for (const { name, where } of names) {
    const read = (n) => readManifest(n, where, { bin, timeoutMs })
    const result = await checkName({ name, want, floorLabel, attempts, delayMs, confirmWrongMs, notDeployedWarns, read })
    console.log(annotation(result, { uncheckedWarns }))
    results.push(result)
  }
  const outcome = overall(results)
  output(`outcome=${outcome}`)
  writeResults({ outcome, results })
  // The summary is a courtesy: failing to write it must not hide the outcome.
  try {
    if (process.env.GITHUB_STEP_SUMMARY) {
      const rows = results.map((r) => `| \`${r.name}\` | ${r.outcome} | ${r.detail.replaceAll("|", "\\|")} |`)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, ["### Humanity grants", "", "| Name | Outcome | Detail |", "|---|---|---|", ...rows, ""].join("\n") + "\n")
    }
  } catch (error) {
    console.log(`::warning title=No grants summary::${escapeData(String(error))}`)
  }
  process.exit(uncheckedWarns && outcome === "unchecked" ? EXIT.ok : EXIT[outcome])
}

/** A crash means the grants are unknown, so it must never exit 1, which says they are wrong. */
function crashed(error) {
  const message = escapeData(`The checker stopped, so the grants are unknown: ${error?.stack ?? error}`)
  console.log(`::${uncheckedWarns ? "warning" : "error"} title=Could not check the grants::${message}`)
  output("outcome=unchecked")
  writeResults({ outcome: "unchecked", error: `The checker stopped, so the grants are unknown: ${error?.message ?? error}`, results: [] })
  process.exit(uncheckedWarns ? EXIT.ok : EXIT.unchecked)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.on("uncaughtException", crashed)
  main().catch(crashed)
}

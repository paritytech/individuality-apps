// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * ONE COMMAND, N NEW BOT IDENTITIES: attested lite persons on previewnet (default) or paseo-next-v2, each
 * wired into the identity pool (players.ts). A test is a profile + an identity;
 * this is the identity half.
 *
 *   npx tsx scripts/e2e-live/new-identity.mts --count 4              # random usernames, on previewnet
 *   npx tsx scripts/e2e-live/new-identity.mts --network paseo-next-v2 --count 2   # paseo's pool (also E2E_NETWORK=)
 *   npx tsx scripts/e2e-live/new-identity.mts --count 2 --base chaos # base: letters only
 *   npx tsx scripts/e2e-live/new-identity.mts --dry-run              # create + verify, touch no secret
 *   npx tsx scripts/e2e-live/new-identity.mts --fresh --count 3     # UNBOUND persons for check-seat-preparing (the fresh pool, one consumed per run)
 *   npx tsx scripts/e2e-live/new-identity.mts --fresh --prune-spent  # drop the fresh persons that now read bound; mint nothing
 *   npx tsx scripts/e2e-live/new-identity.mts --fresh --prune-spent --count 2   # prune, then top up by 2
 *   npx tsx scripts/e2e-live/new-identity.mts --rebuild-regular      # rebuild the regular JSON secret from local slots
 *   npx tsx scripts/e2e-live/new-identity.mts --rebuild-regular --delete-migrated-legacy # only AFTER a live pool-only proof
 *   npx tsx scripts/e2e-live/new-identity.mts --adopt e2e-4          # an EXISTING slot into the pool
 *   npx tsx scripts/e2e-live/new-identity.mts --adopt jollitypvab.33  # the slot a previous --dry-run left (.truapi-host/<username>)
 *   npx tsx scripts/e2e-live/new-identity.mts --settle jollitypv.91 --settle jollitypv.34   # settle EXISTING bots' dotNS claims (see step 3); touches no slot, secret or variable
 *   npx tsx scripts/e2e-live/new-identity.mts --settle jollitypv.91 --dry-run   # only report whether a claim is pending, submit nothing
 *
 * PER IDENTITY, in this order (a failure stops before the next step, and the
 * pool never lists a person whose claim is not settled or whose secret is not set):
 *   1. create   `truapi-host dev --network <network> --base-path <slot> --session <base>
 *               --product-id dim2.<tld> -- sleep 3600`: a new session makes a new lite person
 *               `<base>.NN`; wait until the slot's accounts.json says attested, then stop the host.
 *               The slot is renamed to .truapi-host/<username> (the desk convention: scripts/lite-key.mts
 *               --slot <username>, scripts/player-status.mts).
 *   2. verify   scripts/lite-key.mts --as dim2: dim2 can mint the lite proof; prints the game account
 *               (product-account #1), the seat the bot signs up with. Retried: a new member takes
 *               a few minutes to enter the lite ring.
 *   3. settle   settle the username's dotNS claim (settle-claim.ts, issue #697): minting leaves it a PENDING claim on
 *               the DotnsPopController, which the host ignores after 7 days, so the bot would lose its name. A read-only
 *               dry-run first; nothing pending counts as success and submits nothing. Else one Revive.call to
 *               settlePendingClaims, paid by the network's public dev account (previewnet //Alice, paseo-next-v2 the
 *               dev-seed root), never by the bot: about 0.43 PAS storage deposit + 0.06 PAS fee per name.
 *               --dry-run runs the dry-run alone and submits nothing; --adopt settles too; --settle <username> is this step alone.
 *   4. secret   rebuild the network's ONE E2E_POOL[_PREVIEWNET] JSON secret from retained local slots.
 *   5. pool     the network's repo variable (E2E_IDENTITIES on paseo-next-v2, E2E_IDENTITIES_PREVIEWNET on previewnet), JSON {username: game account}, gains the entry.
 * Then add `"identity": {"<network>": "<username>"}` to a profile in profiles.json (and nothing else is needed).
 *
 * THE MNEMONIC never reaches a terminal, an argv, a log or a file this script writes: it is read from the
 * slot's accounts.json (where truapi-host keeps it, under .truapi-host/, gitignored), held in memory and
 * piped to `gh` on stdin. Output goes through redact().
 *
 * THE REGULAR POOL (regular-pool.ts) uses one secret per network. Existing E2E_ID_<USER> secrets remain the
 * workflow's first fallback during migration. `--rebuild-regular` copies every identity with a retained local slot
 * into the aggregate and leaves identities without a slot on their legacy secret. After an all-bots game proves the
 * aggregate path, repeat with `--delete-migrated-legacy` to retire only the legacy secrets covered by that rebuild.
 *
 * THE FRESH POOL does not take a secret per person either (fresh-pool.ts): steps 3 and 4 become ONE rebuild. The mnemonics of
 * every person still in the pool go into the single JSON secret E2E_FRESH_POOL_PREVIEWNET (E2E_FRESH_POOL), read from
 * the persons' local slots (.truapi-host/<username>; a secret cannot be read back), and the pool variable
 * E2E_FRESH_IDENTITIES_PREVIEWNET (E2E_FRESH_IDENTITIES) is written to match. --prune-spent first asks the chain
 * (PeopleLite.AccountToAlias, read-only) which pool persons are bound now, drops them from both, and deletes a
 * spent person's own legacy E2E_ID_<USER> secret (never one of the regular pool's). The secret count stays flat.
 *
 * LIMITS: GitHub caps repository secrets at 100, but regular and fresh identity counts are now bounded by each
 * aggregate secret's 48 KB value limit rather than one secret slot per identity. The concurrent-job cap of the
 * GitHub plan still applies (one job per runner group), and groups of at most 6 are formed by the chain shuffle:
 * a profile cannot choose who it plays with.
 *
 * Needs `gh` logged in with secrets/variables write on the repo. --repo <owner/name> overrides the repo gh infers.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { NETWORKS, freePort, networkFromEnv, parseNetwork, randomUsernameBase, repoRoot } from "../lib/host-slot.mjs"
import { deletableLegacy, freshPoolSecret, freshPoolVariable, rebuildFreshPool } from "./fresh-pool"
import { identityFor, loadProfiles } from "./profile"
import { USERNAME_RE, identitySecretName, poolVariable } from "./players"
import { assertRegularPoolState, poolFromVariableRead, rebuildRegularPool, regularPoolSecret } from "./regular-pool"
import { settleClaim } from "./settle-claim"

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const flags = (name: string): string[] => args.flatMap((value, index) => (value === name && args[index + 1] ? [args[index + 1]] : []))
function fail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(1)
}
/** --network previewnet|paseo-next-v2 (default previewnet; E2E_NETWORK works too, any host-slot.mjs alias). Identities
 *  are PER CHAIN: the person, its secret's pool variable and the product (dim2.<tld>) all follow it. */
const NETWORK = ((): keyof typeof NETWORKS => {
  try {
    return (parseNetwork(flag("--network")) ?? networkFromEnv()) as keyof typeof NETWORKS
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
})()
const PRODUCT = NETWORKS[NETWORK].productId
/** --fresh: the person goes to the FRESH pool (fresh-pool.ts: unbound persons, one per check-seat-preparing run), not the regular one.
 *  Never play as it before the run that consumes it: the app binds a person the first time it plays. */
const FRESH = args.includes("--fresh")
const PRUNE = args.includes("--prune-spent")
if (PRUNE && !FRESH) fail("--prune-spent works on the fresh pool: add --fresh")
const FRESH_SECRET = freshPoolSecret(NETWORK)
const REGULAR_SECRET = regularPoolSecret(NETWORK)
const POOL_VARIABLE = FRESH ? freshPoolVariable(NETWORK) : poolVariable(NETWORK)
const stateRootArg = flag("--state-root")
const STATE = stateRootArg ? join(resolve(stateRootArg), "slots", NETWORK) : join(repoRoot, ".truapi-host")
const PERSONA_STATE = join(repoRoot, ".truapi-host", "persona-bootstrap", "slots", NETWORK)
/** Additional directories that directly contain <username> slots. The desk's durable regular pool can span the
 * historical main .truapi-host tree and persona-bootstrap/slots/<network>; every rebuild must see all of them. */
const POOL_STATE_DIRS = [...new Set([STATE, ...(existsSync(PERSONA_STATE) ? [PERSONA_STATE] : []), ...flags("--pool-state-dir").map((path) => resolve(path))])]
const RESULT_FILE = flag("--result-file") ? resolve(flag("--result-file") as string) : null
const localHost = join(homedir(), ".local", "bin", "truapi-host")
const HOST_BIN = flag("--host-bin") ?? process.env.TRUAPI_HOST_BIN ?? (existsSync(localHost) ? localHost : "truapi-host")
const SECRET_LIMIT = 100

const has = (name: string) => args.includes(name)
const repoArgs = flag("--repo") ? ["--repo", flag("--repo") as string] : []
const dryRun = has("--dry-run")
const adopt = flag("--adopt")
const rebuildRegular = has("--rebuild-regular")
const settleOnly = flags("--settle")
const deleteMigratedLegacy = has("--delete-migrated-legacy")
const count = Number(flag("--count") ?? 1)
const baseArg = flag("--base")
const pruneOnly = PRUNE && flag("--count") === undefined && !adopt
if (rebuildRegular && FRESH) fail("--rebuild-regular is for the regular pool; remove --fresh")
if (deleteMigratedLegacy && !rebuildRegular) fail("--delete-migrated-legacy requires --rebuild-regular")
if (rebuildRegular && (adopt || baseArg !== undefined || flag("--count") !== undefined || PRUNE)) fail("--rebuild-regular is a standalone operation; do not combine it with --adopt, --base, --count or --prune-spent")
if (rebuildRegular && dryRun) fail("--rebuild-regular --dry-run cannot verify the write; run without --dry-run after reviewing the documented migration steps")
if (has("--settle") && !settleOnly.length) fail("--settle needs a username")
if (settleOnly.length && (adopt || baseArg !== undefined || flag("--count") !== undefined || FRESH || PRUNE || rebuildRegular)) fail("--settle is a standalone operation; do not combine it with --adopt, --base, --count, --fresh, --prune-spent or --rebuild-regular")
for (const username of settleOnly) if (!USERNAME_RE.test(username)) fail(`--settle "${username}" is not a lite username`)
if (!adopt && !pruneOnly && (!Number.isInteger(count) || count < 1 || count > 20)) fail("--count must be 1-20")
if (baseArg !== undefined && !/^[a-z]{4,24}$/.test(baseArg)) fail("--base must be 4-24 lowercase letters only")

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (line: string) => console.log(line)
mkdirSync(STATE, { recursive: true, mode: 0o700 })
if (stateRootArg) chmodSync(STATE, 0o700)

let secretsInPlay: string[] = []
/** Never let a mnemonic through: every captured output is passed here. */
const redact = (text: string): string => secretsInPlay.reduce((t, s) => (s ? t.split(s).join("<mnemonic>") : t), text)

interface Account {
  name: string
  mnemonic: string
  lite_username?: string
  address: string
  attested?: boolean
}

/** <slot>/v2/<network>/<username>_signing_host/accounts.json for the slot's session. */
function readAccount(slotDir: string): Account | null {
  const dir = join(slotDir, "v2", NETWORK)
  if (!existsSync(dir)) return null
  for (const d of readdirSync(dir).filter((x) => x.endsWith("_signing_host"))) {
    const f = join(dir, d, "accounts.json")
    if (!existsSync(f)) continue
    try {
      const accounts = (JSON.parse(readFileSync(f, "utf8")) as { accounts?: Account[] }).accounts ?? []
      const a = accounts.find((x) => x.lite_username && x.mnemonic)
      if (a) return a
    } catch {
      /* half-written: the caller polls again */
    }
  }
  return null
}

/** Find one retained regular signer across every declared pool state directory. Duplicate copies must agree. */
function readPoolAccount(username: string): Account | null {
  const found = POOL_STATE_DIRS.map((dir) => readAccount(join(dir, username))).filter((account): account is Account => account !== null)
  if (!found.length) return null
  if (found.some((account) => account.lite_username !== username || account.mnemonic !== found[0].mnemonic)) throw new Error(`retained signer copies for ${username} disagree across --pool-state-dir roots`)
  return found[0]
}

function stop(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    /* already gone */
  }
}

/** 1. a new lite person in a fresh slot; resolves with its account once attested. */
async function create(base: string): Promise<{ slotDir: string; account: Account }> {
  const tmpSlot = join(STATE, `.new-${base}-${Date.now()}`)
  mkdirSync(tmpSlot, { recursive: true, mode: 0o700 })
  if (stateRootArg) chmodSync(tmpSlot, 0o700)
  const port = await freePort(undefined, 9990)
  const appPort = await freePort(undefined, 3090)
  const child = spawn(
    HOST_BIN,
    ["dev", "--network", NETWORK, "--base-path", tmpSlot, "--session", base, "--product-id", PRODUCT, "--port", String(port), "--app-port", String(appPort), "--", "sleep", "3600"],
    { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TRUAPI_HOST_NO_UPDATE: "1" } },
  )
  let tail = ""
  const keep = (c: Buffer) => (tail = (tail + c.toString()).slice(-1500))
  child.stdout?.on("data", keep)
  child.stderr?.on("data", keep)
  let exited = false
  let spawnFailure = ""
  let ok = false
  child.on("exit", () => (exited = true))
  child.on("error", (error) => {
    spawnFailure = error.message
    exited = true
  })
  try {
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) {
      const a = readAccount(tmpSlot)
      // redact from the moment the mnemonic exists, so every error path below is covered
      if (a && !secretsInPlay.includes(a.mnemonic)) secretsInPlay.push(a.mnemonic)
      if (a?.attested && a.lite_username) {
        ok = true
        return { slotDir: tmpSlot, account: a }
      }
      if (exited) throw new Error(`truapi-host exited before the person was attested${spawnFailure ? `: ${spawnFailure}` : `:\n${redact(tail)}`}`)
      await sleep(2000)
    }
    throw new Error(`no attested person after 240 s:\n${redact(tail)}`)
  } finally {
    stop(child)
    await sleep(1500)
    // a failed creation is not kept: the slot (and the mnemonic in it) goes, the success path renames it
    if (!ok) rmSync(tmpSlot, { recursive: true, force: true })
  }
}

/** 2. dim2 can mint the lite proof; returns the game account (the seat). */
async function verify(slot: string): Promise<string> {
  let last = ""
  for (let attempt = 1; attempt <= 8; attempt++) {
    const r = spawnSync("npx", ["tsx", "scripts/lite-key.mts", "--base-path", join(STATE, slot), "--as", "dim2", "--network", NETWORK, "--host-bin", HOST_BIN], { cwd: repoRoot, encoding: "utf8", timeout: 240_000 })
    const out = redact(`${r.stdout ?? ""}${r.stderr ?? ""}`)
    const seat = new RegExp(`game account ${PRODUCT.replace(".", "\\.")} #1 = (\\S+)`).exec(out)?.[1]
    if (r.status === 0 && out.includes("createRingVRFProof → OK") && seat) return seat
    last = out.split("\n").slice(-6).join("\n")
    log(`  lite-key attempt ${attempt}/8 not yet (${/KeyNotInRing/.test(out) ? "KeyNotInRing: the ring has not taken the person in yet" : "see below"}); retrying in 30 s`)
    await sleep(30_000)
  }
  throw new Error(`lite-key never succeeded for ${slot}:\n${last}`)
}

function gh(ghArgs: string[], input?: string): { ok: boolean; out: string } {
  const r = spawnSync("gh", [...ghArgs, ...repoArgs], { input, encoding: "utf8" })
  return { ok: r.status === 0, out: redact(`${r.stdout ?? ""}${r.stderr ?? ""}`).trim() }
}

/** Read the network's public identity pool. */
function readPool(): Record<string, string> {
  return poolFromVariableRead(POOL_VARIABLE, gh(["variable", "get", POOL_VARIABLE]))
}

function checkSecretBudget(adding: number): void {
  const list = gh(["secret", "list", "--json", "name", "--jq", "length"])
  if (!list.ok) throw new Error(`gh secret list failed: ${list.out}`)
  const n = Number(list.out)
  if (n + adding > SECRET_LIMIT) throw new Error(`${n} repo secrets exist and the limit is ${SECRET_LIMIT}: ${adding} more do not fit`)
}

/** The fresh pool: rebuild the ONE secret and the variable from the local slots (see the header), optionally pruning
 *  the persons the chain says are bound now. `add` is a person just minted. */
async function updateFreshPool(add?: { username: string; account: string; mnemonic: string }): Promise<void> {
  const variable = readPool()
  const listed = gh(["secret", "list", "--json", "name", "--jq", ".[].name"])
  if (!listed.ok) throw new Error(`gh secret list failed: ${listed.out}`)
  const secrets = new Set(listed.out.split("\n"))
  const legacy = new Set(Object.keys(variable).filter((u) => secrets.has(identitySecretName(u))))
  const spent = new Set<string>()
  if (PRUNE) {
    const { createPeopleClient } = await import("@jollity/game-chain")
    const { liteAliasBinding } = await import("../lib/lite-chain.mts")
    const { client, api } = createPeopleClient(process.env.PEOPLE_WS || NETWORKS[NETWORK].peopleWs)
    try {
      for (const [username, account] of Object.entries(variable)) if ((await liteAliasBinding(api, account)) !== undefined) spent.add(username)
    } finally {
      client.destroy()
    }
  }
  const mnemonicOf = (username: string): string | undefined => {
    const m = readAccount(join(STATE, username))?.mnemonic
    if (m && !secretsInPlay.includes(m)) secretsInPlay.push(m)
    return m
  }
  const next = rebuildFreshPool({ variable, mnemonicOf, spent, legacy, add })
  // WRITE ORDER: the secret first, then the variable (a person is never listed without a mnemonic). A crash between the two leaves
  // the secret ahead of the variable: just run the same command again, the rebuild is idempotent and repairs it.
  const s = gh(["secret", "set", FRESH_SECRET], JSON.stringify(next.secret))
  if (!s.ok) throw new Error(`gh secret set ${FRESH_SECRET} failed: ${s.out}`)
  const w = gh(["variable", "set", POOL_VARIABLE, "--body", JSON.stringify(next.variable)])
  if (!w.ok) throw new Error(`gh variable set ${POOL_VARIABLE} failed: ${w.out}`)
  // a spent person's own secret (minted before the one-secret pool) frees a slot. Fail closed: an unreadable regular pool
  // deletes nothing, and no person a profile names is ever touched
  const regular = gh(["variable", "get", poolVariable(NETWORK)])
  let regularPool: Record<string, string> | null = null
  if (regular.ok && regular.out) {
    try {
      regularPool = JSON.parse(regular.out) as Record<string, string>
    } catch {
      regularPool = null
    }
  }
  const named = new Set(loadProfiles().flatMap((p) => identityFor(p, NETWORK) ?? []))
  let deleted = 0
  for (const username of deletableLegacy(next.dropped, legacy, regularPool, named)) if (gh(["secret", "delete", identitySecretName(username)]).ok) deleted++
  if (regularPool === null && next.dropped.length) log(`  the regular pool ${poolVariable(NETWORK)} could not be read: no legacy secret deleted`)
  log(`fresh pool: ${Object.keys(next.variable).length} person(s) in ${POOL_VARIABLE}, ${Object.keys(next.secret).length} mnemonic(s) in ${FRESH_SECRET}; pruned ${next.dropped.length} spent${next.dropped.length ? ` (${next.dropped.join(", ")})` : ""}, deleted ${deleted} legacy secret(s)`)
}

/** The regular pool: rebuild its ONE aggregate secret from local slots. Entries with no local signer stay on an
 * individual legacy secret. Deletion is a separate, explicit second phase after an all-bots run proves the pool path. */
function updateRegularPool(add?: { username: string; account: string; mnemonic: string }, deleteLegacy = false): void {
  const variable = readPool()
  const listed = gh(["secret", "list", "--json", "name", "--jq", ".[].name"])
  if (!listed.ok) throw new Error(`gh secret list failed: ${listed.out}`)
  const secretNames = new Set(listed.out.split("\n").filter(Boolean))
  assertRegularPoolState(POOL_VARIABLE, variable, REGULAR_SECRET, secretNames)
  const legacy = new Set(Object.keys(variable).filter((username) => secretNames.has(identitySecretName(username))))
  const mnemonicOf = (username: string): string | undefined => {
    const mnemonic = readPoolAccount(username)?.mnemonic
    if (mnemonic && !secretsInPlay.includes(mnemonic)) secretsInPlay.push(mnemonic)
    return mnemonic
  }
  const next = rebuildRegularPool({ variable, mnemonicOf, legacy, add })

  // WRITE ORDER: aggregate secret first, then the public variable. A crash leaves the secret ahead and a rerun repairs it.
  const secretWrite = gh(["secret", "set", REGULAR_SECRET], JSON.stringify(next.secret))
  if (!secretWrite.ok) throw new Error(`gh secret set ${REGULAR_SECRET} failed: ${secretWrite.out}`)
  const variableWrite = gh(["variable", "set", POOL_VARIABLE, "--body", JSON.stringify(next.variable)])
  if (!variableWrite.ok) throw new Error(`gh variable set ${POOL_VARIABLE} failed: ${variableWrite.out}`)

  let deleted = 0
  if (deleteLegacy) {
    for (const username of next.migratedLegacy) {
      const name = identitySecretName(username)
      const result = gh(["secret", "delete", name])
      if (!result.ok) throw new Error(`aggregate secret is set, but gh secret delete ${name} failed: ${result.out}`)
      deleted++
    }
  }
  log(`regular pool: ${Object.keys(next.variable).length} person(s) in ${POOL_VARIABLE}, ${Object.keys(next.secret).length} mnemonic(s) in ${REGULAR_SECRET}; ${next.legacyOnly.length} legacy-only, ${deleted} migrated legacy secret(s) deleted`)
}

/** 3. settle the dotNS claim (settle-claim.ts). Dry-run first; nothing pending is success. --dry-run never submits. */
async function settle(username: string): Promise<void> {
  const outcome = await settleClaim(NETWORK, username, { submit: !dryRun })
  if (outcome.settled === 0) log(`  settle: ${username} has no pending claim (already settled)`)
  else if (outcome.txHash) log(`  settled ${username} on ${NETWORK} (tx ${outcome.txHash}, deposit ${outcome.depositPas} PAS)`)
  else log(`  settle (--dry-run): ${username} has ${outcome.settled} pending claim(s), deposit ${outcome.depositPas} PAS; nothing submitted`)
}

const done: { username: string; account: string; secret: string; slot: string }[] = []

function secureTree(path: string): void {
  if (!stateRootArg || !existsSync(path)) return
  const stat = lstatSync(path)
  chmodSync(path, stat.isDirectory() ? 0o700 : 0o600)
  if (stat.isDirectory()) for (const name of readdirSync(path)) secureTree(join(path, name))
}

function writePublicResult(): void {
  if (!RESULT_FILE) return
  mkdirSync(dirname(RESULT_FILE), { recursive: true, mode: 0o700 })
  const tmp = `${RESULT_FILE}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(done, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, RESULT_FILE)
}

async function one(base: string | null, adoptSlot: string | null): Promise<void> {
  let slotDir: string
  let account: Account
  if (adoptSlot) {
    slotDir = join(STATE, adoptSlot)
    const a = readAccount(slotDir)
    if (!a?.attested || !a.lite_username) throw new Error(`slot ${adoptSlot} holds no attested lite person under ${NETWORK}`)
    account = a
    secretsInPlay.push(a.mnemonic)
    log(`adopting ${a.lite_username} from slot ${adoptSlot}`)
  } else {
    log(`creating a lite person (base ${base}); about a minute`)
    ;({ slotDir, account } = await create(base as string))
  }
  const username = account.lite_username as string
  if (!USERNAME_RE.test(username)) throw new Error(`the host assigned "${username}", not a lite username`)
  let slot = adoptSlot ?? username
  if (!adoptSlot) {
    const final = join(STATE, username)
    if (existsSync(final)) {
      rmSync(slotDir, { recursive: true, force: true })
      throw new Error(`.truapi-host/${username} already exists`)
    }
    renameSync(slotDir, final)
    secureTree(final)
    slot = username
    log(`  created ${username}, slot .truapi-host/${username}`)
  }
  log(`  verifying with lite-key (dim2 mints the lite proof)`)
  const seat = await verify(slot)
  secureTree(join(STATE, slot))
  log("  verified: lite-key proof and product account")
  const secret = FRESH ? FRESH_SECRET : REGULAR_SECRET
  done.push({ username, account: seat, secret, slot })
  // Public recovery metadata is durable before either GitHub mutation. If a
  // later step fails, bootstrap-personas can adopt this verified signer.
  writePublicResult()
  await settle(username)
  if (dryRun) {
    return
  }
  if (FRESH) await updateFreshPool({ username, account: seat, mnemonic: account.mnemonic })
  else updateRegularPool({ username, account: seat, mnemonic: account.mnemonic })
  log(`  secret ${secret} set, ${username} added to ${POOL_VARIABLE}`)
  secretsInPlay = secretsInPlay.filter((s) => s !== account.mnemonic)
}

async function main(): Promise<void> {
  if (settleOnly.length) {
    for (const username of settleOnly) await settle(username)
    return
  }
  if (!dryRun) {
    let adding = pruneOnly ? 0 : count
    if (FRESH) {
      // the whole fresh pool is ONE secret: the first top-up creates it, every later one adds nothing
      const listed = gh(["secret", "list", "--json", "name", "--jq", ".[].name"])
      if (!listed.ok) throw new Error(`gh secret list failed: ${listed.out}`)
      adding = listed.out.split("\n").includes(FRESH_SECRET) ? 0 : 1
    } else {
      // The whole regular pool is ONE secret: minting or adopting another identity does not grow the secret count.
      const listed = gh(["secret", "list", "--json", "name", "--jq", ".[].name"])
      if (!listed.ok) throw new Error(`gh secret list failed: ${listed.out}`)
      adding = listed.out.split("\n").includes(REGULAR_SECRET) ? 0 : 1
    }
    checkSecretBudget(adding)
  }
  if (pruneOnly) {
    if (dryRun) throw new Error("--dry-run touches no secret, and --prune-spent without a mint has nothing else to do")
    await updateFreshPool()
    return
  }
  if (rebuildRegular) {
    updateRegularPool(undefined, deleteMigratedLegacy)
    return
  }
  if (adopt) await one(null, adopt)
  else for (let i = 0; i < count; i++) await one(baseArg ?? randomUsernameBase(), null)
  log("\nidentity pool additions:")
  for (const d of done) log(`  ${d.username}  ${d.secret}  slot ${d.slot}`)
  log(FRESH ? `next: nothing. check-seat-preparing takes the first still-unbound person of ${POOL_VARIABLE} (run it with bots='["check-seat-preparing"]'); do not play as these persons yourself, the app binds one the first time it plays` : `next: add "identity": {"${NETWORK}": "<username>"} to a profile in scripts/e2e-live/profiles.json`)
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`✗ ${redact(e instanceof Error ? e.message : String(e))}`)
    if (done.length) console.error(`already done: ${done.map((d) => d.username).join(", ")}`)
    process.exit(1)
  },
)

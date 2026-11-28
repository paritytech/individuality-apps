// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE LIVE E2E's RUNNER: N hosted players against the chosen network (E2E_NETWORK, default previewnet), then the
 * Playwright journey over them. The same file runs on the desk and in CI.
 *
 *   npm run e2e:live:boot      # stage (a) only: boot, oracle, hosted home
 *   npm run e2e:live           # boot, then the whole journey (b–d skip with no game)
 *   npx tsx scripts/e2e-live/boot.mts --hold    # boot and keep them up (Ctrl-C)
 *
 * WHO PLAYS is derived (players.ts), never listed here: the usernames are read
 * back from each host at pairing.
 *
 * Per player it
 *   1. runs the ORACLE (oracle.mts): pairs as the expected person, derives the
 *      playing account on its own, and mints the lite proof as dim2;
 *   2. boots one dev-host SLOT (scripts/dev-host.mjs: a `truapi-host dev` on its
 *      own ports) and waits for "Signing host ready", "Paired with <expected>"
 *      and the app port answering. WHICH APP is E2E_APP (#284): a dotNS name
 *      (default: the network's, dim2.testnet; deployed-app.ts resolves it, fetches the bundle
 *      from IPFS and serves it behind the host, with the host's bridge script in
 *      every page), or `local` = a `next dev` of this checkout wrapped by the host;
 *   3. (`local` only) PRE-WARMS every route the journey visits, because `next dev`
 *      compiles a route on its first visit and a 2-vCPU runner would spend the
 *      registration window doing it. A deployed bundle compiles nothing.
 * Then it optionally waits for REGISTRATION_START, runs the spec, stops
 * everything, and fails if a mnemonic shows up in anything it wrote.
 *
 * TWO MODES.
 *   CI / "as CI":  E2E_PLAYER_MNEMONIC + E2E_SLOT=<n> (one bot per runner). The
 *                  host gets a FRESH, EMPTY base path under E2E_STATE_DIR
 *                  (default $RUNNER_TEMP/e2e-live-hosts-<n>, else the OS temp
 *                  dir), wiped first. The mnemonic reaches ITS slot's CLI as
 *                  HOST_CLI_SIGNER_MNEMONIC and nothing else; it is stripped
 *                  from every child env.
 *   Desk:          no mnemonic. Reuses every `.truapi-host/e2e-<n>` slot
 *                  present and its session (several in one process is the desk
 *                  convenience; CI never does); needs no secrets.
 *
 * THE MODEL (#284): ONE generic bot program, exactly two inputs.
 *   identity   E2E_PLAYER_MNEMONIC (one secret per runner)
 *   behaviour  E2E_PROFILE, a profile name (profiles.ts; default "baseline" =
 *              register once, approve every tile, let the auto-confirm file).
 *              Validated here, carried boot -> slots.json -> journey ->
 *              result-<n>.json -> the gather summary. "baseline" applies
 *              nothing. Any other name is in profiles.json and WIRED:
 *                device/CPU/clock/camera  journey.pw.ts + browser-profile.ts
 *                                         (stage (a) asserts they took)
 *                network                  network.ts: netem.sh apply (+ block-udp
 *                                         when relay-only) here, just before the
 *                                         journey, on a Linux CI runner only;
 *                                         `clear` in the finally; the mid-game
 *                                         swap/blackout by the journey at its turn
 *                role                     roles.ts: changed-verdict confirm,
 *                                         late-join, kill-relaunch, background
 *                env + fixture            this file serves one profile-defined
 *                                         JSON response and resolves its URL
 *                guards                   guards.ts: page + chain ones in the
 *                                         journey, Sentry ones by guards-cli.mts
 *                                         after settlement
 *              A profile with a `pending` reason can not be scheduled by the
 *              matrix (timing.ts botMatrix), only booted by hand.
 *   E2E_SLOT   only an INDEX (ports, output dir, artifact names), never a
 *              behaviour switch.
 * The CI matrix is a list of profiles built from ONE input (timing.ts botMatrix),
 * so a new bot or behaviour is a data change. A bot's IDENTITY is its profile's
 * `identity` (a username in the public E2E_IDENTITIES pool; the mnemonic is selected
 * from E2E_POOL[_PREVIEWNET], with a legacy E2E_ID_<USERNAME> fallback). ADD A TEST = ADD A PROFILE + AN IDENTITY: one
 * command, `npx tsx scripts/e2e-live/new-identity.mts`. Limits: 100 repo secrets, the concurrent-job
 * cap, and groups of at most 6 formed by the chain shuffle.
 *
 * E2E_SLOT=<n> boots ONLY slot n (one oracle, one host, one `next dev`, one
 * page), which is what a CI matrix runner does; there the mnemonic is
 * E2E_PLAYER_MNEMONIC, the only secret the runner holds. Every slot, in every
 * mode, writes <E2E_OUT>/result-<n>.json (result.ts) for the gather job, which
 * alone decides whether the game counts as played (a runner cannot know the
 * others settled).
 *
 * THREE E2E_SLOT PROCESSES ON ONE DESK, against the same game: three
 * terminals, each with its own slot, base port and out dir, which is what
 * keeps them from colliding (ports, the log files, the CI-mode state dir):
 *
 *   E2E_SLOT=1 E2E_BASE_PORT=10000 E2E_OUT=scripts/out/e2e-live-1 npm run e2e:live
 *   E2E_SLOT=2 E2E_BASE_PORT=11000 E2E_OUT=scripts/out/e2e-live-2 npm run e2e:live
 *   E2E_SLOT=3 E2E_BASE_PORT=12000 E2E_OUT=scripts/out/e2e-live-3 npm run e2e:live
 *
 * Start them together with REGISTRATION_START set to the same chain second
 * (the chain clock is the only synchronisation; each sleeps until it). Each
 * slot also gets its own `next dev` dist dir (build/e2e-live-<n>) and, in CI
 * mode, its own state dir (e2e-live-hosts-<n>).
 *
 * Env: E2E_APP (dotNS name or "local", default dim2.testnet = previewnet; E2E_NETWORK previewnet|paseo-next-v2, default previewnet; E2E_APP_PRODUCT
 * overrides the product id the name is built for; E2E_DOTNS_RPC /
 * E2E_DOTNS_RESOLVER / E2E_IPFS_GATEWAY override the network's endpoints),
 * E2E_STAGE (boot | all; --boot-only = boot), E2E_OUT (default
 * scripts/out/e2e-live, git-ignored: logs, slots.json, screenshots),
 * REGISTRATION_START (chain s; sleep until then before the journey, never past
 * REGISTRATION_ENDS - 90 s),
 * NEXT_PUBLIC_SENTRY_DSN and NEXT_PUBLIC_SENTRY_DSN_TEST (forwarded to every
 * slot's `next dev` so the bots send telemetry, to the test project dim2-testing
 * when the test DSN is set; tag NEXT_PUBLIC_SENTRY_TAG, default e2e-bot; both
 * unset = off),
 * NEXT_DEV_ARGS (forwarded to next dev, e.g. --webpack), PLAYWRIGHT_ROOT (a
 * directory with @playwright/test installed, when this repo has none),
 * E2E_SLOT (one slot, above), E2E_BASE_PORT (default 9955 hosts /
 * 3000 apps; with a base: hosts at base, apps at base+100, oracles at base+200,
 * each plus the slot's position), E2E_DESK_STATE (desk mode:
 * the directory holding the e2e-N slots, default .truapi-host; a worktree
 * points it at the main checkout's).
 *
 * The chain is only READ here; the players' own sign-up and report are the
 * app's, driven by the spec.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, type WriteStream } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { freePort, productIdFor, repoRoot, slotState } from "../lib/host-slot.mjs"
import { sleepMsFor, wallMsFor } from "./decide"
import { derivePlayers, portPlan, stripSecrets } from "./players"
import { createServer } from "node:http"
import { bootSeatVerdict } from "./chain-checks"
import { awaitSharedNetwork } from "./group-boundary"
import { rolePlan } from "./roles"
import { assertDevlogHarness, fixtureRequestPath, localPermissionGateEnv, materializeProfileEnv, shouldEnforceDevlogHarness } from "./profile"
import { hostPidOf, startHostControl } from "./host-crash"
import { fixtureDescription, fixtureLogLine } from "./stale-build-check"
import { hostPidFile, planHasHostChainOperation } from "./host-chain-cut"
import { NetworkController, netemEnabled, netemStep, networkPlan } from "./network"
import { profileForName, resolveProfile } from "./profiles"
import { BOT_TAG, botProject, botTelemetry, sentryConfig } from "./telemetry-env"
import { MIN_WINDOW_S } from "./timing"
import { chainReadExitError } from "./chain-read-runtime"
import { startRunnerHealth } from "./runner-health"
import { LOCAL_APP, assertTestTagBridge, bundleNamesProduct, bundleSendsToProject, commitFromBundle, extractSite, fetchCar, parseCar, patchTestTag, pinnedCid, productFor, resolveCid, runTarget, serveSite, stripSentryDsns, versionFromBundle, type DeployedBuild, type LoadedApp, type ServedSite } from "./deployed-app"
import { appRefreshLoader, pinSourceForLoad } from "./app-pin"
import { guardConsole, runPrivacy } from "./player-privacy"

export const ROUTES = ["/", "/game", "/prize-draw", "/chest"]

const argv = process.argv.slice(2)
const HOLD = argv.includes("--hold")
const STAGE = argv.includes("--boot-only") ? "boot" : (process.env.E2E_STAGE ?? "all")
const OUT = resolve(repoRoot, process.env.E2E_OUT ?? "scripts/out/e2e-live")
// other players are masked the moment this process prints them (player-privacy.ts)
guardConsole(runPrivacy(
  JSON.parse(readFileSync(join(repoRoot, "scripts/e2e-live/profiles.json"), "utf8")),
  JSON.parse(readFileSync(join(repoRoot, "scripts/e2e-live/persona-bootstrap.json"), "utf8")),
))
/** WHICH APP the bots test (#284): a dotNS name (default previewnet's dim2.testnet; dim2next.paseo = what main
 *  deployed on paseo, dim2.paseo = the release, dim2-pr<N>-sandbox00.paseo = a PR's preview), loaded from the chain
 *  and IPFS the way a host loads it (deployed-app.ts), or "local" = `next dev` of THIS checkout
 *  (desk work, and the check that a change to the harness itself still boots). */
const { network: NETWORK, app: APP } = (() => {
  try {
    return runTarget()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
})()
// the children (oracle, host, the journey and its chain reads) take the chosen network from here, canonical
process.env.E2E_NETWORK = NETWORK
const DEPLOYED = APP !== LOCAL_APP
/** A PR / boot_only run holds the DEDICATED boot identity (secret E2E_BOOT_MNEMONIC, user vars.E2E_BOOT_USER), never a
 *  live bot's: it proves the boot and never registers. E2E_BOOT_IDENTITY=1 says so. */
const BOOT_IDENTITY = process.env.E2E_BOOT_IDENTITY === "1"
const EXPECTED_USER = process.env.E2E_EXPECTED_USER?.trim() ?? ""
/** the product id the host signs for: compiled into the deployed bundle (deployed-app.ts productFor), else the network's default */
const PRODUCT = DEPLOYED ? productFor(APP, process.env.E2E_APP_PRODUCT) : null
/** Desk mode: where the e2e-N slots live (a worktree has no .truapi-host of its own). */
const DESK_STATE = resolve(repoRoot, process.env.E2E_DESK_STATE ?? ".truapi-host")
const deskSlotNumbers = (): number[] => {
  if (!existsSync(DESK_STATE)) return []
  return readdirSync(DESK_STATE).flatMap((name) => {
    const m = /^e2e-(\d+)$/.exec(name)
    return m && statSync(join(DESK_STATE, name)).isDirectory() ? [Number(m[1])] : []
  })
}
let derived: ReturnType<typeof derivePlayers>
try {
  derived = derivePlayers(process.env, deskSlotNumbers())
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}
const PLAYERS = derived.players
// the bot's behaviour: a profile NAME (profiles.json or the reserved "baseline"),
// validated here too so a desk run with a typo fails before anything boots
let PROFILE: string
try {
  PROFILE = resolveProfile(process.env.E2E_PROFILE)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}
const PROFILE_DEF = profileForName(PROFILE)
try {
  assertDevlogHarness(
    PROFILE_DEF,
    process.env.E2E_DEVLOG_HARNESS === "1",
    shouldEnforceDevlogHarness(process.env.GITHUB_EVENT_NAME, STAGE),
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}
const NET_PLAN = networkPlan(PROFILE_DEF, undefined, NETWORK)
const ROLE = rolePlan(PROFILE_DEF, process.env.E2E_ROLES === "1")
async function startFixture(): Promise<{ env: Record<string, string>; close: () => void }> {
  if (!PROFILE_DEF?.fixture) return { env: PROFILE_DEF ? materializeProfileEnv(PROFILE_DEF) : {}, close: () => {} }
  const { path, body } = PROFILE_DEF.fixture
  // created empty: "no reads" must read as zero requests, not as a fixture that never ran
  writeFileSync(join(OUT, "fixture.log"), "")
  const server = createServer((req, res) => {
    // one line per answered request: the journey's stale-build check passes only beside a read (stale-build-check.ts)
    if (fixtureRequestPath(req.url) === path) appendFileSync(join(OUT, "fixture.log"), fixtureLogLine(path, new Date().toISOString()) + "\n")
    if (fixtureRequestPath(req.url) !== path) {
      res.statusCode = 404
      res.end("not found")
      return
    }
    res.setHeader("content-type", "application/json")
    res.setHeader("access-control-allow-origin", "*")
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const url = `http://localhost:${(server.address() as { port: number }).port}${path}`
  return { env: materializeProfileEnv(PROFILE_DEF, url), close: () => void server.close() }
}
let roleEnv: Record<string, string> = {}
let closeFixture = (): void => {}
/** the deployed bundle's static servers, one per slot: closed in the finally */
const siteServers: ServedSite[] = []
const siteBySlot = new Map<number, ServedSite>()

/** THE DEPLOYED APP, loaded once per run: dotNS name -> CID -> the CAR from IPFS -> the files, the product checked
 *  against what the host will sign for and the bot's Sentry tag set (deployed-app.ts says why and how). */
async function loadDeployed(cidOverride?: string, refresh = false): Promise<DeployedBuild> {
  const started = Date.now()
  const configuredCid = pinnedCid()
  const cid = cidOverride ?? configuredCid ?? (await resolveCid(APP))
  say(`app ${APP}: dotNS app.${APP} -> ${cid}`)
  // A player restart must finish comfortably inside the waiting room. Initial
  // boot keeps the broad gateway retry budget; refresh gets one bounded fetch.
  const car = refresh ? await fetchCar(cid, NETWORK, process.env, 30_000, 1) : await fetchCar(cid, NETWORK)
  const files = extractSite(parseCar(car))
  const version = versionFromBundle(files)
  const commit = commitFromBundle(files)
  say(`app ${APP}: ${(car.length / 1e6).toFixed(1)} MB, ${files.size} files, build ${version ?? "unknown"} in ${((Date.now() - started) / 1000).toFixed(1)} s`)
  if (!files.has("index.html")) throw new Error(`app ${APP} (${cid}) holds no index.html: not a static export`)
  if (!bundleNamesProduct(files, PRODUCT!)) {
    throw new Error(`the bundle at ${APP} (${cid}) never names the product ${PRODUCT}: the host would derive another account and every signature would fail PermissionDenied (set E2E_APP_PRODUCT if the name is built for another)`)
  }
  const telemetryTag = TELEMETRY.env.NEXT_PUBLIC_SENTRY_TAG
  const harnessTag = process.env.E2E_DEVLOG_HARNESS === "1" ? process.env.NEXT_PUBLIC_SENTRY_TAG?.trim() || BOT_TAG : ""
  const tag = telemetryTag || harnessTag
  if (tag) {
    const changed = patchTestTag(files, tag)
    assertTestTagBridge(Boolean(harnessTag), changed, APP, cid)
    say(changed ? `page harness: test.tag set to ${tag} in ${changed} place(s) of the served bundle (a deploy bakes it empty)` : `page harness: WARNING no testTag:"" in the bundle`)
    const testProjectId = sentryConfig(process.env).ids.test
    if (telemetryTag && botProject(process.env) === "test" && testProjectId && !bundleSendsToProject(files, testProjectId)) {
      say("telemetry: the served bundle bakes no test-project DSN (built before SENTRY_DSN_TEST): its bots write to the production project")
    }
  }
  if (!telemetryTag) {
    const stripped = stripSentryDsns(files)
    say(`telemetry off for this run: stripped ${stripped} baked Sentry DSN(s) from the private served copy${harnessTag ? "; devlog page harness remains on" : ""}`)
  }
  const pinSource = pinSourceForLoad(process.env.E2E_APP_PIN_SOURCE, configuredCid, cidOverride)
  return { loaded: { app: APP, product: PRODUCT, cid, version, commit, ...(pinSource && { pinSource }), files: files.size }, files }
}

/** A refresh never uses E2E_APP_CID: that pin describes the build the run
 *  booted, while a real restart re-resolves the product name. */
async function refreshDeployed(): Promise<DeployedBuild> {
  const cid = await resolveCid(APP, process.env, fetch, 1000, 10_000, 2)
  return loadDeployed(cid, true)
}
/** boot owns physical network start/atOpen/final clear; journey owns only the turn timeline. */
let networkController: NetworkController | null = null
let netemActive = false
const E2E_BASE_PORT = Number(process.env.E2E_BASE_PORT ?? 0)
const mnemonics = PLAYERS.map((p) => p.mnemonic)
const CI_MODE = derived.mode === "ci"
/** slotState for a desk slot under DESK_STATE (its HOST_BASE_PATH override). */
const deskSlot = (n: number) => {
  const prev = process.env.HOST_BASE_PATH
  process.env.HOST_BASE_PATH = join(DESK_STATE, `e2e-${n}`)
  try {
    return slotState(`e2e-${n}`, NETWORK)
  } finally {
    if (prev === undefined) delete process.env.HOST_BASE_PATH
    else process.env.HOST_BASE_PATH = prev
  }
}
// one state dir per slot, so two processes on a desk never wipe each other's
const STATE_DIR = resolve(process.env.E2E_STATE_DIR ?? join(process.env.RUNNER_TEMP ?? tmpdir(), `e2e-live-hosts-${PLAYERS[0].n}`))
if (CI_MODE && (STATE_DIR === repoRoot || STATE_DIR.startsWith(repoRoot + "/"))) {
  console.error(`E2E_STATE_DIR (${STATE_DIR}) is inside the repo; host state must live outside the workspace`)
  process.exit(2)
}

mkdirSync(OUT, { recursive: true })
const stopRunnerHealth = startRunnerHealth(join(OUT, "runner-health.jsonl"))
const t0 = Date.now()
const secs = () => +((Date.now() - t0) / 1000).toFixed(1)
const redact = (text: string) => mnemonics.reduce((t, m) => (m ? t.split(m).join("<redacted>") : t), text)
const mainLog = createWriteStream(join(OUT, "boot.log"))
const say = (line: string) => {
  const text = redact(`${String(secs()).padStart(6)}s  ${line}`)
  console.log(text)
  mainLog.write(text + "\n")
}

/** Sentry for the bots' `next dev`: the DSN and the tag, or nothing (telemetry-env.ts). */
const TELEMETRY = botTelemetry(process.env)

/** A child env with no E2E secret in it; `extra` may add this child's own. */
const childEnv = (extra: Record<string, string>) => ({ ...stripSecrets(process.env), ...TELEMETRY.env, TRUAPI_HOST_NO_UPDATE: "1", ...extra })

const children: ChildProcess[] = []
/** stop functions of the host-crash watchers */
const hostControls: (() => void)[] = []
/** Spawn with every output line redacted into `log`, handing lines to `onLine`. */
function run(cmd: string, args: string[], env: Record<string, string>, log: WriteStream, onLine?: (line: string) => void) {
  const child = spawn(cmd, args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: true })
  children.push(child)
  let buf = ""
  const feed = (chunk: Buffer) => {
    buf += chunk.toString()
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const raw of lines) {
      // a child's mask command goes straight to the runner, never into a log file (player-privacy.ts, mask.ts)
      if (raw.startsWith("::add-mask::")) {
        process.stdout.write(raw + "\n")
        continue
      }
      const line = redact(raw)
      log.write(line + "\n")
      onLine?.(line)
    }
  }
  child.stdout?.on("data", feed)
  child.stderr?.on("data", feed)
  return child
}

function stopAll() {
  for (const stop of hostControls.splice(0)) stop()
  for (const c of children) {
    if (c.exitCode !== null || c.pid === undefined) continue
    try {
      process.kill(-c.pid, "SIGTERM") // the whole group: dev-host, the CLI, next
    } catch {
      c.kill("SIGTERM")
    }
  }
}
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    stopAll()
    process.exit(130)
  })

interface Oracle {
  pairedAs: string | null
  account: string | null
  liteProof: string
  seat: { alias: string | null; blockers: string[]; canSignUp: boolean } | null
  error?: string
}
export interface Slot {
  n: number
  user: string
  hostPort: number
  appPort: number
  oracle: Oracle
  pairedAs: string | null
  timings: { oracleS: number; hostReadyS: number | null; appUpS: number | null; prewarm: Record<string, number> }
  /** what this bot loaded: the deployed bundle's name, product, CID and build stamp ("local" for next dev) */
  app: LoadedApp
}

/** Ports for every slot up front, so parallel boots cannot pick the same one. */
async function pickPorts(): Promise<{ host: number; app: number }[]> {
  const taken = new Set<number>()
  const pick = async (start: number) => {
    for (let p = start; ; p++) {
      if (taken.has(p)) continue
      // freePort probes upward from p; take p only when p itself is free
      if ((await freePort(undefined, p)) === p) {
        taken.add(p)
        return p
      }
    }
  }
  const out = []
  for (let i = 0; i < PLAYERS.length; i++) {
    const plan = portPlan(E2E_BASE_PORT, i)
    const host = await pick(plan.hostStart)
    const app = await pick(plan.appStart)
    out.push({ host, app })
  }
  return out
}

function runOracle(i: number, port: number): Promise<{ oracle: Oracle; seconds: number }> {
  const p = PLAYERS[i]
  const started = Date.now()
  const log = createWriteStream(join(OUT, `oracle-${p.n}.log`))
  let basePath: string
  const extra: Record<string, string> = {}
  const args = ["tsx", "scripts/e2e-live/oracle.mts", "--network", NETWORK, "--port", String(port), ...(PRODUCT ? ["--product", PRODUCT] : [])]
  if (CI_MODE) {
    basePath = join(STATE_DIR, `oracle-${p.n}`)
    extra.HOST_CLI_SIGNER_MNEMONIC = p.mnemonic
  } else {
    const st = deskSlot(p.n)
    if (!st.existing[0]) throw new Error(`desk slot e2e-${p.n} has no session in ${st.basePath} (E2E_DESK_STATE)`)
    basePath = st.basePath
    args.push("--session", st.existing[0])
  }
  args.push("--base-path", basePath)
  return new Promise((done, fail) => {
    let oracle: Oracle | undefined
    const child = run("npx", args, childEnv(extra), log, (line) => {
      if (line.startsWith("ORACLE ")) oracle = JSON.parse(line.slice(7)) as Oracle
    })
    child.on("exit", (code) => {
      log.end()
      if (!oracle) return fail(new Error(`oracle ${p.n} exited ${code} without a result (see oracle-${p.n}.log)`))
      done({ oracle, seconds: (Date.now() - started) / 1000 })
    })
  })
}

async function httpGet(url: string, timeoutMs: number): Promise<{ seconds: number; body: string }> {
  const started = Date.now()
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  const body = await res.text()
  if (!res.ok) {
    throw new Error(
      `${url} → HTTP ${res.status}${res.status >= 500 ? " (if next/font/google fails under Turbopack, set NEXT_DEV_ARGS=--webpack)" : ""}`,
    )
  }
  return { seconds: (Date.now() - started) / 1000, body }
}
const httpOk = async (url: string, timeoutMs: number) => (await httpGet(url, timeoutMs)).seconds

/** The host-chain cut (host-chain-cut.ts) moves the slot's truapi-host into its own cgroup: its pid goes to <out>/host-pid-<n> when
 *  the host is ready, at boot and after every host-crash respawn, and only for a plan that has a host-chain cut. */
function writeHostPid(n: number, devHostPid: number | undefined): void {
  if (!planHasHostChainOperation(NET_PLAN)) return
  const pid = devHostPid === undefined ? null : hostPidOf(devHostPid)
  if (pid === null) say(`slot ${n}: no truapi-host process under dev-host ${devHostPid}: a host-chain cut will fail NOT PROVEN`)
  else writeFileSync(hostPidFile(OUT, n), String(pid))
}

function bootSlot(i: number, ports: { host: number; app: number }, oracle: Oracle, oracleS: number, loaded: LoadedApp): Promise<Slot> {
  const p = PLAYERS[i]
  const log = createWriteStream(join(OUT, `slot-${p.n}.log`))
  const extra: Record<string, string> = {
    HOST_SESSION: `e2e-${p.n}`,
    HOST_PORT: String(ports.host),
    APP_PORT: String(ports.app),
    ...localPermissionGateEnv(PROFILE_DEF),
    ...(DEPLOYED
      ? // the host alone: the deployed bundle is served below, there is no `next dev` to wrap
        { HOST_ONLY: "1", TRUAPI_HOST_PRODUCT_ID: PRODUCT! }
      : {
          // under build/, which git and eslint already ignore: dev-host's default
          // `.next-host-<slot>/` is linted by `npm run lint` (1500 errors per run)
          NEXT_DIST_DIR: `build/e2e-live-${p.n}`,
          ...roleEnv,
        }),
  }
  if (CI_MODE) {
    const base = join(STATE_DIR, `slot-${p.n}`)
    rmSync(base, { recursive: true, force: true })
    mkdirSync(base, { recursive: true })
    extra.HOST_BASE_PATH = base
    extra.HOST_CLI_SIGNER_MNEMONIC = p.mnemonic
  } else {
    extra.HOST_BASE_PATH = join(DESK_STATE, `e2e-${p.n}`)
  }
  const slot: Slot = {
    n: p.n,
    user: oracle.pairedAs ?? "",
    hostPort: ports.host,
    appPort: ports.app,
    oracle,
    pairedAs: null,
    timings: { oracleS, hostReadyS: null, appUpS: null, prewarm: {} },
    app: loaded,
  }
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`slot ${p.n}: host not ready in 300 s (see slot-${p.n}.log)`)), 300_000)
    const child = run("node", ["scripts/dev-host.mjs", "--network", NETWORK], childEnv(extra), log, (line) => {
      const paired = /Paired with (\S+)/.exec(line)
      if (paired) slot.pairedAs = paired[1]
      if (line.includes("Signing host ready") && slot.timings.hostReadyS === null) {
        slot.timings.hostReadyS = secs()
        say(`slot ${p.n}: signing host ready (paired as ${slot.pairedAs ?? "?"}) at :${ports.host}`)
        clearTimeout(timer)
        // the username is never configured: the oracle's host and this one must name the same person
        if (!slot.pairedAs || slot.pairedAs !== oracle.pairedAs) return fail(new Error(`slot ${p.n} paired as ${slot.pairedAs}, the oracle's host as ${oracle.pairedAs}`))
        // the host-chain cut (host-chain-cut.ts) moves THIS process into its own cgroup: the journey's netem call reads its pid here
        writeHostPid(p.n, child.pid)
        done(slot)
      }
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      fail(new Error(`slot ${p.n}: dev-host exited ${code} (see slot-${p.n}.log)`))
    })
    // The host-crash role and #726's waiting-room recovery both ask the
    // controller to kill this slot's truapi-host and start it again on the
    // same ports/session. Only here are the spawn env (in CI the signer
    // mnemonic) and the dev-host's pid.
    if (ROLE.kind === "host-crash" || planHasHostChainOperation(NET_PLAN)) {
      // the dev-host now serving the slot: the original, then each respawn (a second crash must find the new host)
      let serving = child
      hostControls.push(
        startHostControl({
          out: OUT,
          slot: p.n,
          hostPort: ports.host,
          devHostPid: () => serving.pid,
          // the host alone (HOST_ONLY): a `next dev` the killed host wrapped is still serving the app port
          pairedAs: () => slot.pairedAs,
          respawn: (onLine) => {
            serving = run("node", ["scripts/dev-host.mjs", "--network", NETWORK], childEnv({ ...extra, HOST_ONLY: "1", HOST_PORT: String(ports.host), APP_PORT: String(ports.app) }), log, (line) => {
              onLine(line)
              // a respawned host is a new process: a later host-chain cut must find IT, not the killed one
              if (line.includes("Signing host ready")) writeHostPid(p.n, proc.pid)
            })
            const proc = serving
            return { onExit: (cb) => void proc.on("exit", (code) => cb(code)) }
          },
          say,
        }),
      )
    }
  })
}

async function waitForApp(slot: Slot) {
  const deadline = Date.now() + 300_000
  for (;;) {
    try {
      await httpOk(`http://localhost:${slot.appPort}/`, 240_000)
      slot.timings.appUpS = secs()
      return
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`slot ${slot.n}: app :${slot.appPort} not up in 300 s (${String(error)})`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

/** `next dev` compiles a route on its first visit, and its client chunks on
 *  their first request: pay for both now, for every route, so the handover
 *  to /game does not wait on a compile. */
async function prewarm(slot: Slot) {
  const origin = `http://localhost:${slot.appPort}`
  for (const route of ROUTES) {
    // A cold `next dev` on a 2-vCPU runner can answer one request with a 500
    // while it is still writing its own manifests ("SyntaxError: Unexpected
    // end of JSON input" right after a 200: CI a live run, game 175, the
    // whole boot died on it). That is the dev server racing itself, not the
    // app: retry a few times before calling the slot broken.
    for (let attempt = 1; ; attempt++) {
      try {
        const page = await httpGet(origin + route, 240_000)
        const chunks = [...new Set([...page.body.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]))]
        const started = Date.now()
        await Promise.all(chunks.map((c) => httpGet(origin + c, 240_000)))
        slot.timings.prewarm[route] = +(page.seconds + (Date.now() - started) / 1000).toFixed(1)
        break
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        if (attempt >= 4) throw new Error(`slot ${slot.n}: pre-warm ${route} failed ${attempt}×: ${why}`)
        say(`slot ${slot.n}: pre-warm ${route} attempt ${attempt} failed (${why}), retrying`)
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  }
  say(`slot ${slot.n}: pre-warmed ${JSON.stringify(slot.timings.prewarm)} (s per route, page + its chunks)`)
}

/** chain-read.mts state, for the one clock reading the wait needs. */
function readChainNow(): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn("npx", ["tsx", "scripts/e2e-live/chain-read.mts", "state"], { cwd: repoRoot, env: childEnv({}), stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    child.stdout.on("data", (c: Buffer) => (out += c.toString()))
    child.stderr.on("data", (c: Buffer) => (err += c.toString()))
    child.on("exit", (code) => (code === 0 ? done(JSON.parse(out).chainNow as number) : fail(chainReadExitError("state", code, err))))
  })
}

/** The Playwright CLI: this repo's @playwright/test (it lands with #203; CI
 *  installs it --no-save meanwhile), else PLAYWRIGHT_ROOT's. */
function playwrightCli(): { cli: string; nodePath?: string } {
  const req = createRequire(join(repoRoot, "package.json"))
  try {
    return { cli: join(dirname(req.resolve("@playwright/test/package.json")), "cli.js") }
  } catch {
    const root = process.env.PLAYWRIGHT_ROOT
    if (!root) throw new Error("no @playwright/test here: `npm i --no-save @playwright/test@1.63.0`, or set PLAYWRIGHT_ROOT")
    const r = createRequire(join(resolve(root), "package.json"))
    const pkg = r.resolve("@playwright/test/package.json")
    // the spec and the config import @playwright/test; NODE_PATH lets them
    // resolve the SAME copy the CLI runs (two copies refuse to load)
    return { cli: join(dirname(pkg), "cli.js"), nodePath: join(resolve(root), "node_modules") }
  }
}

/** Every file this run wrote, checked for each mnemonic. */
function leakScan(): string[] {
  if (!CI_MODE) return []
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const st = statSync(path)
      if (st.isDirectory()) walk(path)
      else if (st.size < 50_000_000) {
        const text = readFileSync(path, "latin1")
        if (mnemonics.some((m) => text.includes(m))) hits.push(path)
      }
    }
  }
  if (existsSync(OUT)) walk(OUT)
  return hits
}

async function main(): Promise<number> {
  say(`app ${APP}${PRODUCT ? ` (product ${PRODUCT})` : " (next dev of this checkout)"} · mode ${CI_MODE ? `CI (mnemonics, fresh host state in ${STATE_DIR})` : "desk (.truapi-host/e2e-N slots)"} · ${PLAYERS.length} slot(s) ${PLAYERS.map((p) => p.n).join(",")} · profile ${PROFILE} · stage ${STAGE} · out ${OUT}`)
  if (CI_MODE) {
    rmSync(STATE_DIR, { recursive: true, force: true })
    mkdirSync(STATE_DIR, { recursive: true })
  }
  say(TELEMETRY.describe)
  // a fixture points the app at a local version server, which only a `next dev` build can be told: on a deployed bundle the
  // profile's check could only fail for a reason that is not the build's, so it stops here, saying how to run it
  if (DEPLOYED && PROFILE_DEF?.fixture) {
    say(`the ${PROFILE_DEF.role.label ?? PROFILE_DEF.name} profile needs next dev (it points the app at a local fixture) and is NOT played against ${APP}: run it with app=local (E2E_APP=local)`)
    return 2
  }
  const fx = DEPLOYED ? { env: {}, close: () => {} } : await startFixture()
  roleEnv = fx.env
  closeFixture = fx.close
  const deployed = DEPLOYED ? await loadDeployed() : null
  const loaded: LoadedApp = deployed?.loaded ?? { app: LOCAL_APP, product: null, cid: null, version: null, commit: process.env.GITHUB_SHA ?? null, files: null }
  if (fx.env.NEXT_PUBLIC_VERSION_URL) say(`stale-build fixture: ${fixtureDescription(fx.env, productIdFor(NETWORK))}`)
  // the host the run really uses, in every bot's artifacts (and the stale-build check's failure detail)
  const host = spawnSync("truapi-host", ["--version"], { encoding: "utf8" })
  const hostVersion = (host.stdout || host.stderr || "truapi-host --version printed nothing").trim()
  writeFileSync(join(OUT, "host-version.txt"), `${hostVersion}\n`)
  say(`host: ${hostVersion}`)
  const ports = await pickPorts()

  // 1. the oracles, one host each, sequentially (each is a few seconds)
  const oracles: { oracle: Oracle; seconds: number }[] = []
  for (let i = 0; i < PLAYERS.length; i++) {
    const r = await runOracle(i, portPlan(E2E_BASE_PORT, i).oracle)
    say(`oracle ${PLAYERS[i].n}: paired ${r.oracle.pairedAs} · account ${r.oracle.account} · lite proof ${r.oracle.liteProof} · blockers [${r.oracle.seat?.blockers.join(", ") ?? "?"}]${r.oracle.error ? ` · ERROR ${r.oracle.error}` : ""} (${r.seconds.toFixed(1)} s)`)
    if (r.oracle.error && !r.oracle.account) throw new Error(`oracle ${PLAYERS[i].n}: ${r.oracle.error}`)
    if (!r.oracle.pairedAs) throw new Error(`oracle ${PLAYERS[i].n}: the host paired as nobody`)
    oracles.push(r)
    if (EXPECTED_USER && r.oracle.pairedAs !== EXPECTED_USER) throw new Error(`oracle ${PLAYERS[i].n}: paired as ${r.oracle.pairedAs}, this run's identity should be ${EXPECTED_USER} (a game bot: its profile's identity from E2E_POOL[_PREVIEWNET] or a legacy E2E_ID_<USERNAME>; a boot run: E2E_BOOT_MNEMONIC / variable E2E_BOOT_USER)`)
  }
  // The boot identity never plays: it must not be in a live game, where opening the app would send it to /game and into the
  // mesh. Registered anywhere = stop here, before the app is opened (the home page is as far as such a run goes).
  if (BOOT_IDENTITY) {
    if (STAGE !== "boot") throw new Error("the boot identity (E2E_BOOT_IDENTITY=1) only runs stage (a): E2E_STAGE must be boot")
    const verdicts = oracles.map((o) => bootSeatVerdict(o.oracle.seat))
    if (verdicts.includes("unknown")) throw new Error("the boot identity's seat could not be read from the chain, so it is not known to be free of a game: not opening the app")
    if (verdicts.includes("registered")) {
      say("the boot identity is REGISTERED in a game: not opening the app (it would join that game's mesh). Stopping after the oracle.")
      writeFileSync(join(OUT, "summary.md"), "**Boot run stopped after the oracle:** the boot identity is registered in a game, so the app was not opened.\n")
      // a profile with a fixture is a CHECK of the app's own screen: a run that never opened the app proved nothing, so it is no green
      return PROFILE_DEF?.fixture ? 1 : 0
    }
  }

  // 2. the slots, in parallel
  say(`booting ${PLAYERS.length} slot(s): ${ports.map((p, i) => `${oracles[i].oracle.pairedAs} host :${p.host} app :${p.app}`).join(" · ")}`)
  const slots = await Promise.all(PLAYERS.map((_, i) => bootSlot(i, ports[i], oracles[i].oracle, oracles[i].seconds, loaded)))
  // a deployed app is a static server over the bundle, pointed at THIS slot's host bridge, once the host is up
  if (deployed) {
    for (const s of slots) {
      const site = await serveSite(deployed, s.appPort, `http://127.0.0.1:${s.hostPort}/bootstrap.js`, appRefreshLoader(deployed.loaded, refreshDeployed))
      siteServers.push(site)
      siteBySlot.set(s.n, site)
    }
  }
  await Promise.all(slots.map(waitForApp))
  say(`apps up: ${slots.map((s) => `${s.n} at ${s.timings.appUpS} s`).join(", ")}`)

  // 3. pre-warm, one slot at a time (each compiles its own dist dir; in
  //    parallel they only fight over the CPU)
  //    (a deployed bundle compiles nothing: there is nothing to warm)
  if (!DEPLOYED) for (const s of slots) await prewarm(s)
  const slotsFile = join(OUT, "slots.json")
  writeFileSync(slotsFile, JSON.stringify({ network: NETWORK, mode: CI_MODE ? "ci" : "desk", profile: PROFILE, app: loaded, bootSeconds: secs(), slots }, null, 2))
  say(`boot done in ${secs()} s → ${slotsFile}`)

  if (HOLD) {
    say("holding (Ctrl-C stops everything)")
    await new Promise(() => {})
  }

  // 4. wait for the registration, on the chain clock
  const regStart = Number(process.env.REGISTRATION_START ?? "")
  let groupReleaseByMs: number | undefined
  if (STAGE !== "boot" && Number.isFinite(regStart) && regStart > 0) {
    const at = { chainNowS: await readChainNow(), wallNowMs: Date.now() }
    const regEnds = Number(process.env.REGISTRATION_ENDS ?? "")
    if (Number.isFinite(regEnds)) groupReleaseByMs = wallMsFor(regEnds - MIN_WINDOW_S, at)
    const waitMs = sleepMsFor(regStart, regEnds, at, 90)
    say(`registration opens at chain ${regStart} (chain now ${at.chainNowS}): ${waitMs > 0 ? `sleeping ${Math.round(waitMs / 1000)} s` : "registration already open"}`)
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs))
  }

  // 4b. the bot's NETWORK, just before the journey (network.ts says why not
  //     earlier): shape the egress, block UDP for a relay-only bot, log the
  //     result. A profile that asks for a network it cannot get FAILS the bot,
  //     never plays unshaped (that would be a false green).
  writeFileSync(join(OUT, "profile.json"), JSON.stringify({ profile: PROFILE, definition: PROFILE_DEF }, null, 2))
  const externallyShaped = await awaitSharedNetwork({
    ...process.env,
    ...(groupReleaseByMs === undefined ? {} : { E2E_GROUP_RELEASE_BY_MS: String(groupReleaseByMs) }),
  })
  const net = netemEnabled(process.env)
  netemActive = (externallyShaped || net.on) && NET_PLAN.start.length > 0
  networkController = new NetworkController({
    plan: NET_PLAN,
    active: externallyShaped || net.on,
    shared: externallyShaped,
    profileName: PROFILE_DEF?.network.profile,
    inactiveReason: net.why,
    run: (call, onLifecycle) => netemStep(repoRoot, OUT, call, say, onLifecycle),
    write: (line) => appendFileSync(join(OUT, "netem.log"), line + "\n"),
    say,
  })
  await networkController.start({ bootOnly: STAGE === "boot" })

  // 5. the journey
  const { cli, nodePath } = playwrightCli()
  say(`journey: playwright ${cli}${nodePath ? ` (NODE_PATH ${nodePath})` : ""}`)
  const pwLog = createWriteStream(join(OUT, "journey.log"))
  const code = await new Promise<number>((done) => {
    const child = run(
      process.execPath,
      [cli, "test", "-c", "scripts/e2e-live/playwright.config.ts"],
      childEnv({ E2E_SLOTS: slotsFile, E2E_STAGE: STAGE, E2E_OUT: OUT, E2E_PROFILE: PROFILE, E2E_RUN_STARTED_AT: new Date(t0).toISOString(), E2E_NETEM_ACTIVE: netemActive ? "1" : "", ...(nodePath ? { NODE_PATH: nodePath } : {}) }),
      pwLog,
      (line) => console.log(line),
    )
    child.on("exit", (c) => done(c ?? 1))
  })
  // The journey knows when it asked for a refresh, while this parent owns the
  // mutable site server. Read each server's final build after Playwright exits
  // so every result says which bytes that bot actually played.
  for (const s of slots) {
    const file = join(OUT, `result-${s.n}.json`)
    if (!existsSync(file)) continue
    const app = siteBySlot.get(s.n)?.current() ?? loaded
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), app }, null, 2))
  }
  // The same on the run's summary (a boot-only run has no gather job). Desk
  // slots may reload at different instants, so list each final build.
  const summaryFile = join(OUT, "summary.md")
  const finalApps = slots.map((s) => ({ slot: s.n, app: siteBySlot.get(s.n)?.current() ?? loaded }))
  const labels = finalApps.map(({ app }) => app.cid
    ? `${app.app} (product ${app.product}), build ${app.version ?? "unknown"}, CID ${app.cid}${app.pinSource === "input" ? ", pinned by input" : ""}`
    : `${app.app} (next dev of this checkout)`)
  const head = new Set(labels).size === 1
    ? `**App under test:** ${labels[0]}`
    : `**Apps finally played:**\n${finalApps.map(({ slot }, i) => `- bot ${slot}: ${labels[i]}`).join("\n")}`
  writeFileSync(summaryFile, `${head}\n\n${existsSync(summaryFile) ? readFileSync(summaryFile, "utf8") : ""}`)
  return code
}

let exitCode = 1
try {
  exitCode = await main()
} catch (error) {
  say(`✗ ${error instanceof Error ? error.message : String(error)}`)
  exitCode = 1
} finally {
  stopRunnerHealth()
  const controller = networkController as NetworkController | null
  if (controller) {
    // Drain atOpen work, then clear shaping before artifact upload/the next step; the workflow clears again with always().
    try {
      await controller.stop({ clear: true })
    } catch (error) {
      console.error(`netem clear failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  stopAll()
  for (const server of siteServers) server.close()
  closeFixture()
  await new Promise((r) => setTimeout(r, 1500))
  mainLog.end()
  await new Promise<void>((r) => mainLog.on("finish", () => r()))
  const leaks = leakScan()
  if (leaks.length) {
    for (const path of leaks) rmSync(path, { force: true })
    console.error(`✗ A MNEMONIC REACHED ${leaks.length} FILE(S) THIS RUN WROTE; deleted, so nothing uploads them:\n  ${leaks.join("\n  ")}`)
    exitCode = 3
  }
}
process.exit(exitCode)

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Should the live E2E prepare a run now? Reads the chosen network's (E2E_NETWORK, default previewnet) Game pallet and
// answers play / skip (the rules are in decide.ts). STRICTLY READ-ONLY: it
// queries storage and nothing else; games are scheduled by the chain itself (previewnet) or by a person (paseo), never by this.
//
//   npx tsx scripts/e2e-live/probe.mts
//
// It never sleeps: `play` means "boot now"; the play job waits for
// `registrationStart` itself, after its minutes of boot (scripts/e2e-live/boot.mts).
//
// Env: E2E_NETWORK, E2E_APP, PEOPLE_WS (default: the network's People RPC), MIN_LEFT_S (90),
// LEAD_S (3600), CONNECT_TIMEOUT_S (60). Prints the verdict as JSON on
// stdout; with GITHUB_OUTPUT set, also `decision`, `game`, `game_at`,
// `dedupe_key` (carries the network), `registration_start`, `registration_ends`, `report_ends`,
// `lead_s`, `job_minutes`, `app_cid` (E2E_APP resolved once), `matrix` (BOTS env: "all", "rotate", "core", a count or a JSON list of profile names; needs E2E_IDENTITIES, the network's pool; `rotate` also needs E2E_ROTATION_RUN; see timing.ts botMatrix), `telemetry_profile` (true when any resolved bot is T1-T12), `devlog_harness` (true for every game matrix: sign-up reads the app clock through the in-page bridge), and `chain_now` lines.
// A `play` the CI cannot join in time (timing.ts) is an error, not a skip.
// Exit 0 for every decision, non-zero only for a real error (RPC down, ...).
//
// Time is the chain's (Timestamp.Now).
import { appendFileSync } from "node:fs"
import { createPeopleClient } from "@jollity/game-chain"
import { liteAliasBinding } from "../lib/lite-chain.mts"
import { NETWORKS } from "../lib/host-slot.mjs"
import { decide, type DecideInput, type Verdict } from "./decide"
import { LOCAL_APP, requirePrPreview, resolveCid, runTarget } from "./deployed-app"
import { loadProfiles, matrixNeedsDevlogHarness, needsTelemetryOracle } from "./profile"
import { personaSchedule, profileForName } from "./profiles"
import { botMatrix, coldSuiteCandidateMinLeftS, planTiming, reportEndsFor } from "./timing"
import { drawnFresh, freshPoolVariable, listedProfiles, parseFreshPool, unboundFresh, reserveFresh } from "./fresh-pool"
import { parseIdentities } from "./players"
import { rolePlan } from "./roles"
import { runnerGroups } from "./runner-group"
import { resolveNamedProofs, validateProofPreflight, videoProofViewer } from "./proof-preflight"

const num = (name: string, dflt: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return dflt
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name}="${raw}" is not a non-negative number`)
  return n
}

// the network is E2E_NETWORK (default previewnet); an E2E_APP of another network's TLD fails here, before any wait
const { network: NETWORK, app: APP } = runTarget()
const WS = process.env.PEOPLE_WS || NETWORKS[NETWORK].peopleWs
const MIN_LEFT_S = num("MIN_LEFT_S", 90)
const LEAD_S = num("LEAD_S", 3600)
const CONNECT_TIMEOUT_S = num("CONNECT_TIMEOUT_S", 60)
const enabled = (name: string): boolean => ["1", "true"].includes((process.env[name] ?? "").trim().toLowerCase())

type Probed = Verdict & { phases: DecideInput["phases"]; schedulePlayTimes: number[]; reportEnds: number | null }

async function probeOnce(): Promise<Probed> {
  const { client, api } = createPeopleClient(WS)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer from ${WS} within ${CONNECT_TIMEOUT_S} s (RPC endpoint down or unreachable)`)),
        CONNECT_TIMEOUT_S * 1000,
      )
    })
    const read = async (): Promise<DecideInput & { currentGame?: { reportEnds: number; rounds: number; maxGroupSize: number }; reportingS: number }> => {
      const [game, schedules, nowMs, stored, defaults] = await Promise.all([
        api.query.Game.Game.getValue(),
        api.query.Game.GameSchedules.getValue(),
        api.query.Timestamp.Now.getValue(),
        api.query.Game.StoredPhaseDurations.getValue(),
        api.constants.Game.DefaultPhaseDurations(),
      ])
      // set_game_phases writes StoredPhaseDurations; None falls back to the constant.
      const p = stored ?? defaults
      const suiteProfiles = process.env.E2E_PUBLIC_SUITE_ID
        ? listedProfiles(process.env.BOTS).map((name) => profileForName(name))
        : []
      return {
        chainNow: Number(nowMs / 1000n),
        game: game
          ? {
              index: game.index,
              state: game.state.type,
              registrationEnds: game.registration_ends,
              gameAt: game.game_date,
            }
          : undefined,
        currentGame: game ? { reportEnds: game.report_ends, rounds: game.rounds, maxGroupSize: game.max_group_size } : undefined,
        schedulePlayTimes: schedules.map((s) => s.game_play_time),
        phases: { registration: p.registration, shuffle: p.shuffle, postShuffleMargin: p.post_shuffle_margin },
        reportingS: p.reporting,
        minLeftS: MIN_LEFT_S,
        candidateMinLeftS: process.env.E2E_PUBLIC_SUITE_ID
          ? coldSuiteCandidateMinLeftS(suiteProfiles, { shuffle: p.shuffle, postShuffleMargin: p.post_shuffle_margin })
          : undefined,
        leadS: LEAD_S,
        network: NETWORK,
      }
    }
    const input = await Promise.race([read(), timeout])
    const verdict = decide(input)
    // report_ends: ONE definition (timing.ts reportEndsFor), shared with the
    // play spec; the pallet's own figures count only for the current game
    const own = input.game && input.game.gameAt === verdict.gameAt ? input.currentGame : undefined
    const reportEnds = verdict.gameAt === null ? null : reportEndsFor({ gameAt: verdict.gameAt, ...own }, { reporting: input.reportingS })
    return { ...verdict, phases: input.phases, schedulePlayTimes: input.schedulePlayTimes, reportEnds }
  } finally {
    clearTimeout(timer)
    client.destroy()
  }
}

/** The pool's persons PeopleLite.AccountToAlias holds no binding for (fresh-pool.ts): the ledger of which are spent is the chain. */
async function unboundPersons(pool: Record<string, string>, regular: Record<string, string>): Promise<string[]> {
  const { client, api } = createPeopleClient(WS)
  try {
    return await unboundFresh(pool, regular, async (account) => (await liteAliasBinding(api, account)) !== undefined)
  } finally {
    client.destroy()
  }
}

async function main(): Promise<void> {
  const verdict = await probeOnce()
  console.log(JSON.stringify(verdict, null, 2))
  const out = process.env.GITHUB_OUTPUT
  // A PR preview exists only when its Deploy run published one (#924).
  // Resolve immediately after the play verdict, before unrelated bot/fresh
  // planning can make an external People RPC. A skip still performs no dotNS
  // lookup, and the resolved CID is reused below.
  const previewCid = verdict.decision === "play"
    ? await requirePrPreview(APP, NETWORK)
    : null
  // the matrix: BOTS (the dispatch's `bots`, default: see the workflow) is the one knob
  const rawBots = (process.env.BOTS ?? "").trim()
  const rotationRun = rawBots === "rotate" ? Number(process.env.E2E_ROTATION_RUN) : undefined
  const rotationHalf = rawBots === "rotate" ? process.env.E2E_ROTATION_HALF as "A" | "B" | undefined : undefined
  if (rawBots === "rotate" && rotationHalf !== "A" && rotationHalf !== "B") throw new Error(`rotate needs E2E_ROTATION_HALF=A or B (got ${String(rotationHalf)})`)
  const identities = parseIdentities(process.env.E2E_IDENTITIES)
  // the fresh pool is read from the chain only when a profile of this run draws from it
  const needsFresh = (text: string): boolean => listedProfiles(text).some((name) => loadProfiles().some((p) => p.freshIdentity && p.name === name))
  const freshPool = needsFresh(rawBots) ? parseFreshPool(process.env.E2E_FRESH_IDENTITIES) : {}
  const fresh = Object.keys(freshPool).length ? await unboundPersons(freshPool, identities) : []
  if (needsFresh(rawBots) && process.env.E2E_PUBLIC_SUITE_ID) reserveFresh(fresh, 1)
  if (needsFresh(rawBots)) console.log(`${freshPoolVariable(NETWORK)}: ${fresh.length} of ${Object.keys(freshPool).length} person(s) still unbound`)
  const bots = botMatrix(process.env.BOTS, undefined, undefined, identities, NETWORK, rotationRun, rotationHalf, fresh)
  const telemetryProfile = bots.some((bot) => needsTelemetryOracle(profileForName(bot.profile)))
  const devlogHarness = matrixNeedsDevlogHarness(bots.map((bot) => profileForName(bot.profile)))
  const clockWatchFault = enabled("E2E_CLOCK_WATCH_FAULT")
  const proofs = resolveNamedProofs(process.env.E2E_PROOFS, rawBots, enabled("E2E_FLIP_VERDICT"), clockWatchFault)
  validateProofPreflight({
    proofs,
    bots,
    roles: enabled("E2E_ROLES"),
    telemetry: enabled("E2E_TELEMETRY") || clockWatchFault,
    explicitTelemetry: enabled("E2E_TELEMETRY"),
    gameLogToSentry: enabled("E2E_GAME_LOG_TO_SENTRY"),
    telemetryProfile,
    flipVerdict: enabled("E2E_FLIP_VERDICT"),
    clockWatchFault,
  })
  if (proofs.length) console.log(`proof preflight: ${proofs.join(", ")} ready with ${bots.length} resolved bot(s); final build provenance will be checked after the run`)
  // the persons this run drew: the gather job gets them as E2E_FRESH_DRAWN (the run binds them, so the chain stops listing them)
  const drawn = drawnFresh(bots, freshPool, (name) => profileForName(name)?.freshIdentity === true)
  const runBotAccounts = bots.map(({ identity }) => drawn[identity] ?? identities[identity])
  if (runBotAccounts.some((account) => !account)) throw new Error("the resolved run bot set contains an identity without an account")
  const share = (process.env.E2E_SHARE || "off") as "off" | "measure" | "on"
  if (!["off", "measure", "on"].includes(share)) throw new Error(`E2E_SHARE must be off, measure or on (got ${share})`)
  const groups = runnerGroups(bots, {
    share,
    soloRunner: process.env.E2E_SOLO_RUNNER || undefined,
    sharedRunner: process.env.E2E_SHARED_RUNNER || undefined,
  })
  const proofViewer = videoProofViewer(proofs, bots)
  const proofViewerRole = proofViewer ? rolePlan(profileForName(proofViewer.profile), true) : null
  if (proofViewer && proofViewerRole?.kind !== "reload") throw new Error(`video-role-proof viewer ${proofViewer.profile} is not a reload role`)
  const proofViewerAccount = proofViewer ? identities[proofViewer.identity] : ""
  const proofViewerReloadTurn = proofViewerRole?.kind === "reload" ? String(proofViewerRole.reloadAtTurn) : ""
  if (rawBots === "rotate") {
    const schedule = personaSchedule(NETWORK, rotationRun, undefined, rotationHalf)
    console.log(`rotation half ${schedule.half}, dispatch ${schedule.runNumber}: scheduled ${schedule.scheduled.join(", ")}; rotated out ${schedule.rotatedOut.join(", ")}`)
  }
  let jobMinutes = ""
  let appCid = ""
  let leadS = 0
  if (verdict.decision === "play") {
    // every wait and timeout of the run derives from the game's chain times
    const plan = planTiming({
      chainNow: verdict.chainNow,
      registrationStart: verdict.registrationStart ?? verdict.chainNow,
      registrationEnds: verdict.registrationEnds ?? Number.NaN,
      reportEnds: verdict.reportEnds ?? Number.NaN,
    })
    if (!plan.ok) throw new Error(plan.reason)
    jobMinutes = String(plan.jobMinutes)
    // ONE build per game: the CID is resolved here, once, and every runner loads exactly it (E2E_APP_CID)
    if (APP !== LOCAL_APP) {
      appCid = previewCid ?? await resolveCid(APP)
      console.log(`app ${APP} -> ${appCid} (pinned for every runner)`)
    }
    leadS = plan.leadS
    console.log(`timing: tap at chain ${plan.firstTapAt} (${Math.round(plan.windowLeftS)} s of window left), runners start in ${Math.round(plan.leadS)} s, job timeout ${plan.jobMinutes} min, ${bots.length} bot(s) in ${groups.include.length} runner group(s)`)
  }
  if (out) {
    appendFileSync(
      out,
      [
        `decision=${verdict.decision}`,
        `game=${verdict.gameIndex ?? ""}`,
        `game_at=${verdict.gameAt ?? ""}`,
        `dedupe_key=${verdict.dedupeKey ?? ""}`,
        `registration_start=${verdict.registrationStart ?? ""}`,
        `registration_ends=${verdict.registrationEnds ?? ""}`,
        `report_ends=${verdict.reportEnds ?? ""}`,
        `lead_s=${leadS}`,
        `job_minutes=${jobMinutes}`,
        `app_cid=${appCid}`,
        `matrix=${JSON.stringify({ include: groups.include })}`,
        `telemetry_profile=${telemetryProfile}`,
        `devlog_harness=${devlogHarness}`,
        `proofs=${JSON.stringify(proofs)}`,
        `proof_head=${proofs.length ? process.env.GITHUB_SHA ?? "" : ""}`,
        `fresh_drawn=${JSON.stringify(drawn)}`,
        `groups=${JSON.stringify(groups.manifest)}`,
        `run_bot_accounts=${JSON.stringify(runBotAccounts)}`,
        `video_role_viewer_account=${proofViewerAccount}`,
        `video_role_viewer_reload_turn=${proofViewerReloadTurn}`,
        `chain_now=${verdict.chainNow}`,
        "",
      ].join("\n"),
    )
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`probe failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  },
)

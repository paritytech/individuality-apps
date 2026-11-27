// Pure parts of game-chain-report.mts, no network:  npx vitest run scripts/game-chain-report.test.mts
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { networkFromEnv } from "./lib/host-slot.mjs"
import {
  accountRow,
  assembleStagedReport,
  attestedByRule,
  checkAttendance,
  checkpointCapturedBlocks,
  decodeExtrinsics,
  decodeReportCalls,
  interimClamp,
  pickVotes,
  reportWindow,
  registrationOf,
  registrationOpensIso,
  type DecodedExtrinsic,
  firstTrue,
  firstTrueNear,
  groupOf,
  interimAtMs,
  mapPool,
  mergeCaptureStage,
  networkForPeopleWs,
  phaseOf,
  positionalGame,
  reportsFromEvents,
  scoreRow,
  reportFieldAvailability,
  tallyFromReports,
  type ChainEvent,
  type PlayerRec,
  type ReportCall,
  type ScoreRec,
} from "./game-chain-report.mts"

describe("positionalGame", () => {
  it("reads only the leading positional game index", () => {
    expect(positionalGame(["920", "--game-at", "1792374000"])).toBe(920)
  })

  it("does not mistake numeric flag values for a game index", () => {
    expect(positionalGame(["--game-at", "1792374000", "--registration-opens", "1792373610"])).toBeNull()
  })
})

describe("staged live capture", () => {
  const base = { format: 2 as const, game: 835, network: "previewnet", ws: "wss://previewnet.substrate.dev/people", registrationOpens: "2026-10-17T15:00:00Z", registrationOpensBlock: 90, observations: [], blocks: [], warnings: [] }
  const point = (block: number, phase: "reporting" | "after") => ({ capturedAt: "2026-10-17T15:01:00Z", block, blockHash: `0x${block}`, chainTime: "2026-10-17T15:01:00Z", phase })

  it("keeps the first kickoff and the freshest live point", () => {
    let staged = mergeCaptureStage(null, base, "kickoff", point(100, "reporting"))
    staged = mergeCaptureStage(staged, base, "kickoff", point(101, "reporting"))
    staged = mergeCaptureStage(staged, base, "last-live", point(120, "reporting"))
    staged = mergeCaptureStage(staged, base, "last-live", point(121, "reporting"))
    expect(staged.stages.kickoff?.block).toBe(100)
    expect(staged.stages["last-live"]?.block).toBe(121)
    expect(staged.observations.map((capture) => capture.evidence.block)).toEqual([100, 101, 120, 121])
  })

  it("checkpoints post-Reporting blocks without falsely completing settlement", () => {
    const kickoff = point(100, "reporting")
    const current = mergeCaptureStage(null, base, "kickoff", kickoff)
    const pendingBlock = { block: 121, blockHash: "0x121", chainTime: "2026-10-17T15:29:00Z",
      events: [], reportCalls: [], decodeProblems: [] }
    const checkpoint = checkpointCapturedBlocks(current, { ...base, blocks: [pendingBlock] })
    expect(checkpoint.blocks).toEqual([pendingBlock])
    expect(checkpoint.stages.kickoff).toEqual(kickoff)
    expect(checkpoint.stages.settlement).toBeUndefined()
    expect(checkpoint.observations).toHaveLength(1)
  })

  it("marks only hours-old per-player registration details optional", () => {
    expect(reportFieldAvailability({
      record: { index: 835 }, settlement: { block: 130 }, accounts: [
        { account: "5A", registeredAt: null, registeredBlock: null, registrationCall: null, registrationOrigin: null },
        { account: "5B", registeredAt: "t", registeredBlock: 1, registrationCall: "Game.sign_up", registrationOrigin: "PeopleLiteAuth" },
      ],
    })).toMatchObject({
      required: { record: true, accounts: true, settlement: true },
      perPlayerRegistration: { present: ["5B"], unavailable: ["5A"], optional: true },
    })
  })

  it("normalizes probe epoch seconds to ISO while retaining ISO input", () => {
    expect(registrationOpensIso("1792254600")).toBe("2026-10-17T16:30:00.000Z")
    expect(registrationOpensIso("2026-10-17T15:10:00Z")).toBe("2026-10-17T15:10:00.000Z")
    expect(registrationOpensIso("not-a-time")).toBeNull()
  })

  it("assembles a settled report only from retained values and occurrences", () => {
    const account = {
      account: "5A", firstGame: 835, sentReport: false, reportBlock: null, reportTime: null,
      positions: [0], groups: [0], yesPerson: 0, noNotPerson: 0, expectedMaxVoteWeight: 0,
      voteWeight: 0, credibility: "Invited", earlyAttendance: null, attended: null,
      yesBeatsNo: false, scoreBefore: null, scoreAfter: null,
      registeredAt: null, registeredBlock: null, registrationCall: null, registrationOrigin: null,
      registrationLookup: "skipped-pruned-or-unavailable" as const,
    }
    const record = { index: 835, registrationEnds: 1, shuffleDeadline: 2, gameDate: 1792255200,
      reportEnds: 3, rounds: 1, maxGroupSize: 6, playerCount: 1, airdropsScheduled: 0,
      pendingAttendance: 0, groups: 1 }
    const kickoff = { ...point(100, "reporting"), record, accounts: [account] }
    const settlement = { ...point(130, "after"), settlement: { block: 130, time: "2026-10-17T15:30:00Z" },
      scoresAfter: { "5A": { score: 1, streak: { type: "Attended", value: 1 }, reachedPersonhood: false,
        lastAttendedGame: 835, attendanceHistory: 1 } }, draws: [] }
    const staged = {
      ...base,
      stages: { kickoff, settlement },
      observations: [{ name: "kickoff" as const, evidence: kickoff }, { name: "settlement" as const, evidence: settlement }],
      blocks: [{ block: 130, blockHash: "0x130", chainTime: "2026-10-17T15:30:00Z",
        events: [{ block: 130, name: "ReportSubmitted" as const, extrinsic: 1, who: "5A", game: 835 },
          { block: 130, name: "GameEnded" as const, extrinsic: null, game: 835 }],
        reportCalls: [{ account: "5A", fullReport: [[]] }], decodeProblems: [] }],
    }
    const result = assembleStagedReport(staged)
    expect(result.accounts[0]).toMatchObject({ account: "5A", sentReport: true, reportBlock: 130, attended: true })
    expect(result.fieldAvailability.required).toEqual({ record: true, accounts: true, settlement: true })
  })

  it("keeps staged final assembly free of historical RPC reads", () => {
    const source = readFileSync(new URL("./game-chain-report.mts", import.meta.url), "utf8")
    const body = source.slice(source.indexOf("export function assembleStagedReport"), source.indexOf("async function main"))
    expect(body).not.toMatch(/getValue|getValues|getBlockBody|getMetadata/)
    expect(source.indexOf("if (!captureStage && out && stagedBeforeConnect)")).toBeLessThan(source.indexOf("const { client, api } = createPeopleClient(ws)"))
    expect(source.indexOf("persistStaged(checkpointCapturedBlocks(current, captureBase()))")).toBeLessThan(source.indexOf("const ended = blocks.flatMap"))
  })
})

describe("networkForPeopleWs", () => {
  it("derives Preview and Paseo from their People RPC URLs", () => {
    expect(networkForPeopleWs("wss://previewnet.substrate.dev/people")).toBe("previewnet")
    expect(networkForPeopleWs("wss://paseo-people-next-system-rpc.polkadot.io")).toBe("paseo-next-v2")
  })

  it("normalizes host case and trailing slashes without accepting a different path", () => {
    expect(networkForPeopleWs("WSS://PREVIEWNET.SUBSTRATE.DEV/people/")).toBe("previewnet")
    expect(networkForPeopleWs("wss://previewnet.substrate.dev/asset-hub")).toBe("unknown")
  })

  it("labels malformed and custom endpoints explicitly unknown", () => {
    expect(networkForPeopleWs("not a websocket URL")).toBe("unknown")
    expect(networkForPeopleWs("wss://archive.example/people")).toBe("unknown")
  })
})

const state = (type: string) => ({ type, value: {} }) as never
const g = (index: number, type: string) => ({ index, state: state(type) })

describe("phaseOf: where a block sits relative to one game", () => {
  it("is reporting only for this game in Reporting", () => {
    expect(phaseOf(g(166, "Reporting"), 166)).toBe("reporting")
  })
  it("is after for no game, a later game or a later state", () => {
    expect(phaseOf(null, 166)).toBe("after")
    expect(phaseOf(g(167, "Registration"), 166)).toBe("after")
    expect(phaseOf(g(166, "PlayerProcess"), 166)).toBe("after")
  })
  it("is before for an earlier game", () => {
    expect(phaseOf(g(165, "Reporting"), 166)).toBe("before")
  })
})

describe("firstTrue: the settlement-block search", () => {
  const pred = async (n: number) => n >= 1270972 // game 166: Reporting up to #1270971
  it("finds the first block past Reporting", async () => {
    expect(await firstTrue(1270882, 1311834, pred)).toBe(1270972)
  })
  it("returns null when the predicate is never true", async () => {
    expect(await firstTrue(1, 100, async () => false)).toBeNull()
  })
  it("returns lo when it is already true", async () => {
    expect(await firstTrue(5, 100, async () => true)).toBe(5)
  })
})

describe("firstTrueNear: the search backwards from a block", () => {
  it("finds a target a few blocks back without scanning from 1", async () => {
    const seen: number[] = []
    const r = await firstTrueNear(1270882, async (n) => (seen.push(n), n >= 1270854))
    expect(r).toBe(1270854)
    expect(seen.length).toBeLessThan(20)
  })
  it("falls back to the whole range when the target is far", async () => {
    expect(await firstTrueNear(1000, async (n) => n >= 3)).toBe(3)
  })
  it("returns null when even the start is false", async () => {
    expect(await firstTrueNear(100, async () => false)).toBeNull()
  })
})

describe("mapPool", () => {
  it("keeps order and never exceeds the limit", async () => {
    let live = 0
    let peak = 0
    const r = await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      peak = Math.max(peak, ++live)
      await new Promise((res) => setTimeout(res, 5))
      live--
      return x * 2
    })
    expect(r).toEqual([2, 4, 6, 8, 10, 12, 14])
    expect(peak).toBeLessThanOrEqual(3)
  })
  it("handles an empty list", async () => {
    expect(await mapPool([], 8, async (x) => x)).toEqual([])
  })
})

describe("accounts", () => {
  const player = { first_game: 166, registered: true, sent_report: true, yes_person: 5, no_not_person: 4, expected_max_vote_weight: 9, vote_weight: 1, credibility: { type: "Invited" } } as unknown as PlayerRec
  const score = (lastAttendedGame: number | undefined, s: number) =>
    ({ score: s, streak: { type: "Attended", value: 1 }, reached_personhood: false, last_attended_game: lastAttendedGame, attendance_history: 255 }) as unknown as ScoreRec
  it("groups are the position mod the number of groups", () => {
    expect(groupOf(28, 31, 6)).toBe(4)
    expect(groupOf(0, 31, 6)).toBe(0)
    expect(groupOf(5, 0, 6)).toBe(-1)
  })
  it("builds a row with votes, groups and the attested flag", () => {
    const row = accountRow({ account: "5abc", player, positions: [28, 0], scoreBefore: score(undefined, 0), scoreAfter: score(166, 1), report: { block: 1270962, time: "t" } }, 166, 31, 6)
    expect(row).toMatchObject({ yesPerson: 5, noNotPerson: 4, groups: [4, 0], attended: true, yesBeatsNo: true, reportBlock: 1270962, credibility: "Invited" })
    expect(row.scoreBefore?.score).toBe(0)
    expect(row.scoreAfter?.lastAttendedGame).toBe(166)
  })
  it("no score after means attended is null; no positions means no groups", () => {
    expect(scoreRow(undefined)).toBeNull()
    const row = accountRow({ account: "5abc", player, positions: undefined, scoreBefore: undefined, scoreAfter: undefined }, 166, 31, 6)
    expect(row.attended).toBeNull()
    expect(row.groups).toEqual([])
  })
})

// Game 170 shape: three players, two rounds, one group. Every report landed in ONE block (#1319690), the same block that flipped
// the game to PlayerProcess, so a read of Players at the last Reporting block (#1319689) sees no report at all.
const A = "5A"
const B = "5B"
const C = "5C"
const roster = {
  playerCount: 3,
  maxGroupSize: 6,
  // account -> its position per round: round 0 A=1 B=2 C=0, round 1 A=2 B=0 C=1
  positions: new Map<string, number[]>([
    [A, [1, 2]],
    [B, [2, 0]],
    [C, [0, 1]],
  ]),
}
const P = "Person" as const
const N = "NotPerson" as const
// the co-players of a position are the occupied seats of its group, ascending by index, itself left out:
// A round 0 (pos 1) votes on [C, B]; A round 1 (pos 2) on [B, C]; B round 0 (pos 2) on [C, A]; B round 1 (pos 0) on [C, A];
// C round 0 (pos 0) on [A, B]; C round 1 (pos 1) on [B, A].
const calls: ReportCall[] = [
  { account: A, fullReport: [[P, N], [P, P]] },
  { account: B, fullReport: [[N, P], [N, P]] },
  { account: C, fullReport: [[P, P], [P, P]] },
]

describe("reportsFromEvents: reports come from the events, through the GameEnded block", () => {
  const ev = (block: number, name: ChainEvent["name"], extrinsic: number | null, who?: string, game = 170): ChainEvent => ({ block, name, extrinsic, who, game })
  const events: ChainEvent[] = [
    ev(1319690, "ReportSubmitted", 2, B),
    ev(1319690, "ReportSubmitted", 3, A),
    ev(1319690, "ReportSubmitted", 4, C),
    ev(1319691, "GameEnded", null),
    ev(1319650, "ReportSubmitted", 2, "5Z", 169), // another game's report
  ]
  it("takes every report of this game, including the ones in the block that ends the reporting", () => {
    const r = reportsFromEvents(events, 170)
    expect([...r.keys()].sort()).toEqual([A, B, C])
    expect(r.get(A)).toEqual({ block: 1319690, extrinsic: 3 })
  })
  it("finds the GameEnded block", () => {
    expect(reportsFromEvents(events, 170).ended).toBe(1319691)
  })
  it("a report in the GameEnded block itself still counts (the last report and the end share a block)", () => {
    const r = reportsFromEvents([ev(1319691, "ReportSubmitted", 2, A), ev(1319691, "GameEnded", null)], 170)
    expect(r.get(A)).toEqual({ block: 1319691, extrinsic: 2 })
  })
  it("keeps the first landing when an account somehow reports twice", () => {
    const r = reportsFromEvents([ev(5, "ReportSubmitted", 1, A), ev(6, "ReportSubmitted", 1, A)], 170)
    expect(r.get(A)?.block).toBe(5)
  })
})

describe("tallyFromReports: yes/no per account from the report calls", () => {
  it("maps each vote to the co-player in the same seat order the pallet uses", () => {
    const { tallies, problems } = tallyFromReports(calls, roster)
    expect(problems).toEqual([])
    expect(tallies.get(A)).toEqual({ yes: 4, no: 0 })
    expect(tallies.get(B)).toEqual({ yes: 3, no: 1 })
    expect(tallies.get(C)).toEqual({ yes: 2, no: 2 })
  })
  it("a report of the wrong shape is a problem and is left out of the tallies", () => {
    const { tallies, problems } = tallyFromReports([{ account: A, fullReport: [[P]] }], roster)
    expect(problems.join()).toMatch(/5A/)
    expect(tallies.get(B)).toEqual({ yes: 0, no: 0 })
  })
  it("a reporter with no seat is a problem", () => {
    expect(tallyFromReports([{ account: "5X", fullReport: [] }], roster).problems.join()).toMatch(/5X/)
  })
})

describe("decodeReportCalls: the envelope parser on real bytes", () => {
  // game 170's block 1319690 (paseo-next-v2 People): extrinsics 2, 3, 4 are the three players' Game.report, each a general (0x45)
  // extrinsic, with the chain's metadata of that block. Each filed [[P, P], [P, P]] (all Person, as the 4/0 tallies show).
  const fx = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/game170-block1319690.json.gz", import.meta.url))).toString()) as { metadata: string; extrinsics: Record<string, string> }
  const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"))
  const body: Uint8Array[] = []
  for (const [i, h] of Object.entries(fx.extrinsics)) body[Number(i)] = bytes(h)
  it("reads the three reports' verdicts", async () => {
    const r = await decodeReportCalls(body, bytes(fx.metadata), [2, 3, 4])
    for (const i of [2, 3, 4]) expect(r.get(i)).toEqual([[P, P], [P, P]])
  })
  it("names an extrinsic it cannot read instead of throwing", async () => {
    const r = await decodeReportCalls([Uint8Array.of(4, 0x09, 0, 0)], bytes(fx.metadata), [0])
    expect(typeof r.get(0)).toBe("string")
  })
  // the report of extrinsic 2 with its extension version byte (after the two-byte length and 0x45) moved to 1, which this metadata does not declare
  const atVersionOne = () => {
    const tx = body[2].slice()
    tx[3] = 1
    return tx
  }
  // the same report as a signed v4 extrinsic: 0x84, an all-zero MultiAddress::Id and sr25519 MultiSignature, then its extensions and call
  const asSignedV4 = () => {
    const extensionsAndCall = body[2].slice(4)
    const envelope = Uint8Array.of(0x84, 0x00, ...new Uint8Array(32), 0x01, ...new Uint8Array(64), ...extensionsAndCall)
    const length = (envelope.length << 2) | 1
    return Uint8Array.of(length & 0xff, length >> 8, ...envelope)
  }
  it("reads a signed v4 extrinsic with the extensions of version 0", async () => {
    const r = await decodeReportCalls([asSignedV4()], bytes(fx.metadata), [0])
    expect(r.get(0)).toEqual([[P, P], [P, P]])
  })
  it("reads a signed v4 extrinsic with the extensions of version 0 when decoding a whole block", async () => {
    const [decoded] = await decodeExtrinsics([asSignedV4()], bytes(fx.metadata))
    expect(decoded.error).toBeUndefined()
    expect(decoded.call).toMatchObject({ pallet: "Game", name: "report" })
  })
  it("reads the extensions of the version a general extrinsic names", async () => {
    const r = await decodeReportCalls([atVersionOne()], bytes(fx.metadata), [0])
    expect(r.get(0)).toBe("extrinsic 0 could not be decoded: unknown extension version 1")
  })
  it("reads the extensions of the version a general extrinsic names when decoding a whole block", async () => {
    const [decoded] = await decodeExtrinsics([atVersionOne()], bytes(fx.metadata))
    expect(decoded.error).toBe("unknown extension version 1")
  })
})

describe("pickVotes: storage first, the report calls only when storage misses a report", () => {
  const rec = (sent: boolean) => ({ sent_report: sent }) as unknown as PlayerRec
  const at = (block: number, sent: Record<string, boolean>) => ({ block, players: new Map(Object.entries(sent).map(([a, s]) => [a, rec(s)])) })
  const never = async () => {
    throw new Error("decode must not run")
  }
  it("uses the block before GameEnded when it holds every report (game 170)", async () => {
    const r = await pickVotes({ reporters: [A, B], later: at(1319690, { [A]: true, [B]: true }), last: at(1319689, { [A]: false, [B]: false }), decode: never })
    expect(r).toMatchObject({ source: "storage", voteBlock: 1319690, warnings: [] })
  })
  it("falls to the last Reporting block when the later one was cleared by early enactment (game 166)", async () => {
    const r = await pickVotes({ reporters: [A, B], later: at(1270972, { [A]: false, [B]: false }), last: at(1270971, { [A]: true, [B]: true }), decode: never })
    expect(r).toMatchObject({ source: "storage", voteBlock: 1270971 })
  })
  it("rebuilds from the report calls when neither block shows every report, with a warning", async () => {
    const tallies = new Map([[A, { yes: 1, no: 0 }]])
    const r = await pickVotes({ reporters: [A], later: at(9, { [A]: false }), last: at(8, { [A]: false }), decode: async () => ({ tallies, problems: [], decoded: 1 }) })
    expect(r.source).toBe("report-calls")
    expect(r.tallies).toBe(tallies)
    expect(r.warnings).toHaveLength(1)
  })
  it("says the tallies are incomplete when the calls cannot all be decoded", async () => {
    const r = await pickVotes({ reporters: [A], later: null, last: at(8, { [A]: false }), decode: async () => ({ tallies: new Map(), problems: ["boom"], decoded: 0 }) })
    expect(r.source).toBe("storage-incomplete")
    expect(r.warnings[0]).toMatch(/boom/)
  })
})

describe("interimClamp and reportWindow: where the read stops, the scan ends and the later votes come from", () => {
  it("stops a game that left Reporting before the interim time at the block that leaves it", () => {
    expect(interimClamp(2508452, 2508460)).toEqual({ firstAfter: 2508453, leavingBlock: 2508453 })
  })
  it("stops a game still in Reporting at the interim time right after that time, with no leaving block", () => {
    expect(interimClamp(2630117, 2630117)).toEqual({ firstAfter: 2630118, leavingBlock: null })
  })
  it("scans a clamped interim read through the leaving block and offers that block as later", () => {
    expect(reportWindow({ settleBlock: null, leavingBlock: 2508453, lastReporting: 2508452 })).toEqual({ lastScanned: 2508453, laterCandidate: 2508453 })
  })
  it("scans an unclamped interim read to its last Reporting block and offers no later block", () => {
    expect(reportWindow({ settleBlock: null, leavingBlock: null, lastReporting: 2630117 })).toEqual({ lastScanned: 2630117, laterCandidate: null })
  })
  it("scans a final read through GameEnded and offers the block before it as later", () => {
    expect(reportWindow({ settleBlock: 1319691, leavingBlock: null, lastReporting: 1319689 })).toEqual({ lastScanned: 1319691, laterCandidate: 1319690 })
  })
  it("scans a final read with no GameEnded to its last Reporting block and offers no later block", () => {
    expect(reportWindow({ settleBlock: null, leavingBlock: null, lastReporting: 8 })).toEqual({ lastScanned: 8, laterCandidate: null })
  })
})

describe("attendance by the pallet's rule", () => {
  it("attested needs a report and yes minus one, stopping at 0, at least no", () => {
    expect(attestedByRule(true, 4, 0)).toBe(true)
    expect(attestedByRule(true, 5, 4)).toBe(true)
    expect(attestedByRule(true, 3, 3)).toBe(false)
    expect(attestedByRule(false, 4, 0)).toBe(false)
    expect(attestedByRule(true, 0, 0)).toBe(true)
    expect(attestedByRule(false, 0, 0)).toBe(false)
    expect(attestedByRule(true, 0, 1)).toBe(false)
  })
  it("stays quiet on a reporter with no votes whom Score after scored, and warns if Score after did not", () => {
    const row = { account: A, sentReport: true, yesPerson: 0, noNotPerson: 0 }
    expect(checkAttendance([{ ...row, attended: true }])).toEqual([])
    const w = checkAttendance([{ ...row, attended: false }])
    expect(w).toHaveLength(1)
    expect(w[0]).toMatch(/says true/)
  })
  it("warns where the rule and Score after disagree, and stays quiet where they agree", () => {
    const rows = [
      { account: A, sentReport: true, yesPerson: 4, noNotPerson: 0, attended: true },
      { account: B, sentReport: false, yesPerson: 0, noNotPerson: 0, attended: true }, // the old reader's 170 output
      { account: C, sentReport: true, yesPerson: 2, noNotPerson: 2, attended: null },
    ]
    const w = checkAttendance(rows)
    expect(w).toHaveLength(1)
    expect(w[0]).toMatch(/5B/)
  })
})

describe("registrationOf: how an account signed up, from its block's extrinsics", () => {
  const ex = (index: number, name: string, args: Record<string, unknown>, extensions: Record<string, unknown>, pallet = "Game"): DecodedExtrinsic => ({ index, call: { pallet, name, args }, extensions })
  const signed = (account: string) => ({ VerifyMultiSignature: { type: "Signed", value: { account } } })
  const block = [
    ex(0, "set", {}, {}, "Timestamp"),
    ex(1, "sign_up_with_account_lite_invite", { account: "web" }, { ...signed("web"), PeopleLiteAuth: { type: "AsLiteAliasWithAccount", value: 6 } }),
    ex(2, "sign_up_with_invite", { airdrops: [] }, { ...signed("native"), GameAsInvited: { nonce: 4 } }),
  ]
  it("names the call and the origin for the web route, matched by the account argument", () => {
    expect(registrationOf(block, "web")).toEqual({ call: "Game.sign_up_with_account_lite_invite", origin: "PeopleLiteAuth" })
  })
  it("matches an invite sign-up by its signer when the call has no account argument", () => {
    expect(registrationOf(block, "native")).toEqual({ call: "Game.sign_up_with_invite", origin: "GameAsInvited" })
  })
  it("is null when no sign-up in the block is for the account", () => {
    expect(registrationOf(block, "other")).toBeNull()
    expect(registrationOf([ex(0, "report", { account: "web" }, {})], "web")).toBeNull()
  })
  it("has a null origin when no origin extension is active", () => {
    expect(registrationOf([ex(0, "sign_up_with_account", { account: "a" }, {})], "a")).toEqual({ call: "Game.sign_up_with_account", origin: null })
  })
})

describe("interimAtMs", () => {
  it("accepts epoch seconds, epoch ms and ISO, and rejects junk", () => {
    expect(interimAtMs("1762362180")).toBe(1762362180000)
    expect(interimAtMs("1762362180000")).toBe(1762362180000)
    expect(interimAtMs("2025-11-05T17:03:00Z")).toBe(Date.parse("2025-11-05T17:03:00Z"))
    expect(interimAtMs("soon")).toBeNull()
    expect(interimAtMs(undefined)).toBeNull()
  })
})

describe("the chain reader starts in this repo (smoke)", () => {
  it("scripts/lib/host-slot.mjs exports networkFromEnv, which the reader imports at startup", () => {
    // game-chain-report.mts imports { NETWORKS, networkFromEnv } from ./lib/host-slot.mjs at
    // module load; importing the reader above already proves the import resolves. Pin the
    // export itself so a future edit cannot drop it silently.
    expect(typeof networkFromEnv).toBe("function")
    expect(networkFromEnv({})).toBe("previewnet")
    expect(networkFromEnv({ E2E_NETWORK: "paseo" })).toBe("paseo-next-v2")
    expect(() => networkFromEnv({ E2E_NETWORK: "nope" })).toThrow(/not one of/)
  })
})

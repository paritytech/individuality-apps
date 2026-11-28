// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { loadProfiles, PEER_FAULT_DESCRIPTIONS, type Profile } from "../profile"
import { knownProfiles } from "../profiles"
import { activePreviewnetUsernames, contrast, loadCrewCatalogue, requiredNarrationActions, validateCrewCatalogue, type CrewCatalogue } from "./catalogue"

const ROSTER = [
  ["jollitypv.12", "captain-baseline", "Captain Baseline", "captain-baseline.webp"],
  ["jollitypv.15", "lady-latency", "Lady Latency", "lady-latency.webp"],
  ["jollitypv.20", "relay-ray", "Relay Ray", "relay-ray.webp"],
  ["jollitypv.25", "handoff-hank", "Handoff Hank", "handoff-hank.webp"],
  ["jollitypv.29", "the-rejoiner", "The Rejoiner", "the-rejoiner.webp"],
  ["jollitypv.30", "late-larry", "Late Larry", "late-larry.webp"],
  ["jollylaenus.48", "locale-lola", "Locale Lola", "locale-lola.webp"],
  ["jollytokyojp.41", "tokyo-taro", "Tokyo Taro", "tokyo-taro.webp"],
  ["jollyberlinde.65", "berlin-bruno", "Berlin Bruno", "berlin-bruno.webp"],
  ["jollycamdeny.25", "shutter-sheila", "Shutter Sheila", "shutter-sheila.webp"],
  ["jollycammiss.50", "phantom-phil", "Phantom Phil", "phantom-phil.webp"],
  ["jollyuplink.08", "narrowband-ned", "Narrowband Ned", "narrowband-ned.webp"],
  ["jollystorm.90", "packet-jack", "Packet Jack", "packet-jack.webp"],
  ["jollitypv.32", "chainless-charlie", "Chainless Charlie", "chainless-charlie.webp"],
  ["jollitypv.33", "token-tina", "Token Tina", "token-tina.webp"],
  ["jollitypv.34", "relay-rita", "Relay Rita", "relay-rita.webp"],
  ["jollitypv.38", "tap-tony", "Tap Tony", "tap-tony.webp"],
  ["jollitypv.39", "timewarp-tess", "Timewarp Tess", "timewarp-tess.webp"],
  ["jollitypv.40", "crash-carter", "Crash Carter", "crash-carter.webp"],
  ["jollitypv.47", "longhaul-lou", "Longhaul Lou", "longhaul-lou.webp"],
  ["jollitypv.56", "clockwork-clyde", "Clockwork Clyde", "clockwork-clyde.webp"],
  ["jollitypv.58", "future-fran", "Future Fran", "future-fran.webp"],
  ["jollitypv.62", "background-betty", "Background Betty", "background-betty.webp"],
  ["jollitypv.66", "reload-rex", "Reload Rex", "reload-rex.webp"],
  ["jollitypv.67", "freeze-frame-fred", "Freeze-Frame Fred", "freeze-frame-fred.webp"],
  ["jollitypv.73", "datagram-dana", "Datagram Dana", "datagram-dana.webp"],
  ["jollyvideoflip.90", "flip-fiona", "Flip Fiona", "flip-fiona.webp"],
  ["jollyvideonever.97", "null-nancy", "NULL Nancy", "null-nancy.webp"],
  ["jollitypv.77", "stutter-stu", "Stutter Stu", "stutter-stu.webp"],
  ["jollitypv.78", "chaincut-chip", "Chaincut Chip", "chaincut-chip.webp"],
  ["jollitypv.83", "fifth-turn-felix", "Fifth-Turn Felix", "fifth-turn-felix.webp"],
] as const

const clone = <T>(value: T): T => structuredClone(value)
const profiles = loadProfiles()
const source = (): CrewCatalogue => loadCrewCatalogue(profiles)
const rawSource = (): Record<string, unknown> => JSON.parse(readFileSync(new URL("./catalogue.json", import.meta.url), "utf8")) as Record<string, unknown>

const webpDimensions = (bytes: Buffer): { width: number; height: number } => {
  expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF")
  expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP")
  const chunk = bytes.subarray(12, 16).toString("ascii")
  if (chunk === "VP8X") return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
  if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  if (chunk === "VP8L") {
    const packed = bytes.readUInt32LE(21)
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 }
  }
  throw new Error(`unsupported WebP chunk ${JSON.stringify(chunk)}`)
}

describe("PreviewNet crew catalogue", () => {
  it("pins the version, harness, and fixed 31-character roster", () => {
    const catalogue = source()
    expect(catalogue.version).toBe(1)
    expect(catalogue.harness).toEqual({
      key: "previewnet-boot-harness",
      displayName: "PreviewNet Boot Harness",
      description: "Boot-only infrastructure checks without a playing identity.",
    })
    expect(catalogue.identities).toHaveLength(31)
    expect(catalogue.identities.map(({ username, key, displayName, portrait }) => [username, key, displayName, portrait])).toEqual(ROSTER)
    expect(loadCrewCatalogue()).toBe(loadCrewCatalogue())
  })

  it("keeps identifiers and presentation fields unique and complete", () => {
    const identities = source().identities
    for (const field of ["key", "username", "portrait"] as const) expect(new Set(identities.map((identity) => identity[field])).size, field).toBe(identities.length)
    for (const identity of identities) {
      for (const field of ["key", "username", "displayName", "portrait", "tagline", "backstory", "speciality"] as const) expect(identity[field].trim(), `${identity.key}.${field}`).not.toBe("")
      expect(identity.portrait).toMatch(/^[a-z0-9-]+\.webp$/)
    }
  })

  it("uses readable, distinct palettes", () => {
    const identities = source().identities
    expect(new Set(identities.map((identity) => `${identity.palette.primary}/${identity.palette.secondary}`)).size).toBe(31)
    for (const identity of identities) {
      for (const colour of Object.values(identity.palette)) expect(colour, identity.key).toMatch(/^#[0-9A-Fa-f]{6}$/)
      expect(contrast(identity.palette.ink, identity.palette.primary), identity.key).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("ships one distinct, compact, square WebP portrait per identity", () => {
    const hashes = new Set<string>()
    let totalBytes = 0

    for (const identity of source().identities) {
      const bytes = readFileSync(new URL(`./portraits/${identity.portrait}`, import.meta.url))
      const { width, height } = webpDimensions(bytes)
      expect(width, identity.key).toBe(height)
      expect(width, identity.key).toBeGreaterThanOrEqual(384)
      expect(bytes.length, identity.key).toBeLessThan(100_000)
      totalBytes += bytes.length

      const hash = createHash("sha256").update(bytes).digest("hex")
      expect(hashes.has(hash), identity.key).toBe(false)
      hashes.add(hash)
    }

    expect(hashes).toHaveLength(31)
    expect(totalBytes).toBeLessThan(2_500_000)
  })

  it("matches the executable game-ready PreviewNet identities", () => {
    const executable = activePreviewnetUsernames(profiles).sort()
    const presented = source().identities.map((identity) => identity.username).sort()
    expect(presented).toEqual(executable)
  })

  it("presents every known profile once with exactly its derived action keys", () => {
    const scenarios = source().scenarios
    expect(scenarios.map((scenario) => scenario.profile)).toEqual(knownProfiles(profiles))
    expect(new Set(scenarios.map((scenario) => scenario.purpose)).size).toBe(scenarios.length)
    expect(new Set(scenarios.map((scenario) => scenario.expected)).size).toBe(scenarios.length)
    for (const scenario of scenarios) {
      expect(Object.keys(scenario.actions)).toEqual(requiredNarrationActions(scenario.profile, profiles))
      for (const field of ["title", "purpose", "expected"] as const) expect(scenario[field].trim(), `${scenario.profile}.${field}`).not.toBe("")
      for (const [phase, text] of Object.entries(scenario.phases)) expect(text.trim(), `${scenario.profile}.phases.${phase}`).not.toBe("")
    }
  })

  it("describes representative executable faults with their real timing and recovery contract", () => {
    const storm = source().scenarios.find((scenario) => scenario.profile === "storm-pixel6a-timeline")!
    expect(storm.purpose).toMatch(/turn 3.*30% packet loss.*10 seconds.*turn 6.*lte-poor.*turn 9.*wifi/i)
    expect(storm.parameters).toMatchObject({
      network1AtTurn: 3,
      network1LossPct: 30,
      network1ForS: 10,
      network2AtTurn: 6,
      network2Profile: "lte-poor",
      network3AtTurn: 9,
      network3Profile: "wifi",
    })
    expect(storm.actions["network.1"]).toMatchObject({
      active: expect.stringMatching(/turn 3.*30% packet loss.*10 seconds/i),
      recovered: expect.stringMatching(/ended.*recovery evidence/i),
      failed: expect.stringMatching(/turn 3.*30% packet loss.*10 seconds/i),
    })

    const late = source().scenarios.find((scenario) => scenario.profile === "late-join-turn-5")!
    expect(late.purpose).toMatch(/Fifth-Turn Felix.*turn 5/i)
    expect(late.parameters.roleJoinAfterTurn).toBe(5)

    const throttled = source().scenarios.find((scenario) => scenario.profile === "telemetry-t8-sentry-429")!
    expect(throttled.parameters).toMatchObject({ telemetryFault: "sentry-429", telemetryDurationS: 120, telemetryRetryAfterS: 120 })
    expect(throttled.actions["telemetry.T8"].active).toMatch(/sentry-429.*120 seconds/i)

    const relay = source().scenarios.find((scenario) => scenario.profile === "relay-outage")!
    expect(relay.expected).toMatch(/rtc\.heal.*rtc\.healed.*true.*at least once/i)
    expect(relay.expected).toMatch(/rtc\.heal.*rtc\.healed.*false.*never seen/i)
    expect(relay.expected).toMatch(/rtc\.coverage_pct.*>= 50/i)

    const cachedTurn = source().scenarios.find((scenario) => scenario.profile === "turn-cache-relaunch")!
    expect(cachedTurn.expected).toMatch(/network\.turn-receipt.*turn\.received.*cached.*at least once/i)
    expect(cachedTurn.expected).toMatch(/network\.turn-receipt.*turn\.received.*true.*never seen/i)

    expect(source().scenarios.find((scenario) => scenario.profile === "check-stale-build")!.purpose).toMatch(/stale.*update/i)
    expect(source().scenarios.find((scenario) => scenario.profile === "camera-denied")!.purpose).toMatch(/camera.*denied/i)
    expect(source().scenarios.find((scenario) => scenario.profile === "camera-missing")!.purpose).toMatch(/camera.*missing|no camera/i)
    expect(source().scenarios.find((scenario) => scenario.profile === "telemetry-t6-freeze-after-report")!.purpose).toMatch(/freeze.*report.*30 seconds/i)

    const hostChain = source().scenarios.find((scenario) => scenario.profile === "host-chain-lost")!
    expect(hostChain.purpose).toMatch(/refuse.*45 seconds.*observe.*60-second window/i)
    expect(hostChain.purpose).not.toMatch(/cut the host chain path for 60 seconds/i)

    const background = source().scenarios.find((scenario) => scenario.profile === "kill-background-iphone13")!
    expect(background.purpose).toMatch(/kill.*round 2.*relaunch.*hide.*3 seconds after.*confirm.*9 seconds hidden/i)
    expect(background.actions["role.hidden"].active).toMatch(/hide.*3 seconds after.*confirm/i)
    expect(background.actions["role.visible"].active).toMatch(/show.*9 seconds hidden.*12 seconds after.*confirm/i)
    expect(background.actions["role.hidden"].active).not.toEqual(background.actions["role.killed"].active)

    const slow = source().scenarios.find((scenario) => scenario.profile === "slow-pixel7-lte-poor")!
    expect(slow.parameters).toMatchObject({ cpuThrottle: 4, cameraDelayMs: 9000 })
    expect(slow.purpose).toMatch(/throttle.*4.*delay camera frames.*9000 ms/i)
    expect(slow.purpose.slice(0, 90)).toMatch(/lte-poor.*throttle.*4/i)
    expect(slow.purpose).not.toMatch(/without an injected disruption/i)

    const fastRelay = source().scenarios.find((scenario) => scenario.profile === "relay-iphonese-fastclock")!
    expect(fastRelay.purpose.slice(0, 110)).toMatch(/relay only.*75 seconds ahead/i)

    const berlin = source().scenarios.find((scenario) => scenario.profile === "locale-berlin-dede")!
    expect(berlin.purpose.slice(0, 100)).toMatch(/de-DE.*Europe\/Berlin/i)

    const t9 = source().scenarios.find((scenario) => scenario.profile === "telemetry-t9-blackout")!
    expect(t9.expected).toMatch(/We couldn't connect you to anyone.*bounded blackout.*recovery/i)
    expect(t9.expected).not.toMatch(/We couldn't connect you to anyone.*never/i)
    expect(t9.expected).not.toMatch(/[“”]/)

    const switcher = source().scenarios.find((scenario) => scenario.profile === "switcher-pixel6a-wifi-to-cell")!
    expect(switcher.expected).toMatch(/Your Polkadot app is stuck.*allowed.*scripted fault window/i)
    expect(switcher.expected).toMatch(/We couldn't connect you to anyone.*allowed.*scripted fault window/i)

    const udpCut = source().scenarios.find((scenario) => scenario.profile === "udp-cut-40s")!
    expect(udpCut.expected).toMatch(/We couldn't connect you to anyone.*allowed.*scripted fault window/i)
    expect(udpCut.expected).toMatch(/Your Polkadot app is stuck.*never/i)

    expect(source().scenarios.find((scenario) => scenario.profile === "network-blocked")!.purpose).toMatch(/concurrently with the triggering game action/i)

    const game259 = source().scenarios.find((scenario) => scenario.profile === "game259-lossy-video")!
    expect(game259.title).toBe("Lossy Video")
    expect(source().scenarios.find((scenario) => scenario.profile === "game259-dropped-lane-rebuild")!.title).toBe("Dropped Lane Rebuild")
    expect(source().scenarios.find((scenario) => scenario.profile === "game259-clean-video-control")!.title).toBe("Clean Video Control")
    for (const profile of ["glare-forcer", "late-signal", "one-way-video", "dropped-answer"] as const) {
      const scenario = source().scenarios.find((entry) => entry.profile === profile)!
      expect(scenario.purpose).toContain(PEER_FAULT_DESCRIPTIONS[profile])
      expect(scenario.parameters.peerFault).toBe(profile)
      expect(scenario.expected).toMatch(new RegExp(`e2e-peer-fault.*${profile} fired`, "i"))
    }
    expect(game259.parameters).toMatchObject({
      network1AtRoundChannelsOpenRound: 2,
      network1AtRoundChannelsOpenCount: 5,
      network1AtRoundChannelsOpenByGameS: 105,
    })
    expect(Object.values(game259.parameters).every((value) => typeof value !== "object" || Array.isArray(value))).toBe(true)
  })
})

describe("crew catalogue validation", () => {
  it("rejects duplicate usernames", () => {
    const raw = clone(rawSource()) as { identities: CrewCatalogue["identities"] }
    raw.identities[1].username = raw.identities[0].username
    expect(() => validateCrewCatalogue(raw, profiles)).toThrow(/duplicate.*username/i)
  })

  it.each(["../secret.webp", "/tmp/secret.webp", "https://example.com/a.webp", "portrait.png"])("rejects unsafe portrait path %s", (portrait) => {
    const raw = clone(rawSource()) as { identities: CrewCatalogue["identities"] }
    raw.identities[0].portrait = portrait
    expect(() => validateCrewCatalogue(raw, profiles)).toThrow(/portrait|secret/i)
  })

  it("rejects unknown fields at every level", () => {
    const raw = clone(rawSource()) as Record<string, unknown> & { identities: Array<Record<string, unknown>>; extra?: boolean }
    raw.extra = true
    expect(() => validateCrewCatalogue(raw, profiles)).toThrow(/no field extra/i)
    delete raw.extra
    raw.identities[0].note = "stray"
    expect(() => validateCrewCatalogue(raw, profiles)).toThrow(/no field note/i)
    delete raw.identities[0].note
    raw.scenarios = []
    expect(() => validateCrewCatalogue(raw, profiles)).toThrow(/no field scenarios/i)
  })

  it("rejects malformed colours and secret-like material", () => {
    const colour = clone(rawSource()) as { identities: CrewCatalogue["identities"] }
    ;(colour.identities[0].palette as { primary: string }).primary = "red"
    expect(() => validateCrewCatalogue(colour, profiles)).toThrow(/palette.primary/i)

    const secretField = clone(rawSource()) as Record<string, unknown> & { private_key?: string }
    secretField.private_key = "not public"
    expect(() => validateCrewCatalogue(secretField, profiles)).toThrow(/private_key|secret/i)

    const pem = clone(rawSource()) as { identities: CrewCatalogue["identities"] }
    pem.identities[0].backstory = "-----BEGIN PRIVATE KEY-----"
    expect(() => validateCrewCatalogue(pem, profiles)).toThrow(/private key|secret/i)

    const secrets = [
      "Prefix abandon ability able about above absent absorb abstract absurd abuse access accident suffix",
      "Abandon Ability Able About Above Absent Absorb Abstract Absurd Abuse Access Accident Account Accuse Achieve",
      "DIM2_MNEMONIC",
      "E2E_ID",
      "e2e_id_alice",
      "fooE2E_ID_X",
      "Ｅ２Ｅ＿ＩＤ＿ＡＬＩＣＥ",
      `0x${"ab".repeat(32)}`,
      "//Alice",
      "https://public-key@o0.ingest.sentry.io/123",
      "turn:user:password@relay.example",
      `ghp_${"a".repeat(36)}`,
      `github_pat_${"a".repeat(40)}`,
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl",
      "Bearer abcdefghijklmnop",
    ]
    for (const value of secrets) {
      const secret = clone(rawSource()) as { identities: CrewCatalogue["identities"] }
      secret.identities[0].tagline = value
      expect(() => validateCrewCatalogue(secret, profiles), value).toThrow(/secret|mnemonic|key|authorization|environment|signer|credential|token|jwt|seed/i)
    }
  })

  it("bounds public prose and derives scenario data instead of accepting copies", () => {
    const tooLong = clone(rawSource()) as { identities: CrewCatalogue["identities"] }
    tooLong.identities[0].backstory = "x".repeat(501)
    expect(() => validateCrewCatalogue(tooLong, profiles)).toThrow(/at most 500 characters/i)

    const catalogue = validateCrewCatalogue(rawSource(), profiles)
    expect(catalogue.scenarios.map((scenario) => scenario.profile)).toEqual(knownProfiles(profiles))
    expect(catalogue.scenarios.find((scenario) => scenario.profile === "storm-pixel6a-timeline")!.parameters.network1LossPct).toBe(30)
  })

  it("scans strings derived from validated profiles before publishing them", () => {
    const guardSecret = clone(profiles) as Profile[]
    const guarded = guardSecret.find((profile) => profile.expect.some((entry) => entry.kind === "event"))!
    const event = guarded.expect.find((entry) => entry.kind === "event")!
    event.attrs = { ...(event.attrs ?? {}), synthetic: "SENTRY_DSN" }
    expect(() => validateCrewCatalogue(rawSource(), guardSecret)).toThrow(/environment|secret/i)

    const credentialUrl = clone(profiles) as Profile[]
    credentialUrl[0].locale = "https://public:password@example.test"
    expect(() => validateCrewCatalogue(rawSource(), credentialUrl)).toThrow(/credential|secret/i)
  })
})

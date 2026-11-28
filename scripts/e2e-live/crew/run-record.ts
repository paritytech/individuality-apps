// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { assertPublicSafe } from "../public-safety"
import type { PublicParameter, ScenarioActionPresentation } from "./catalogue"

export const PUBLIC_RESULTS = ["passed", "failed", "inconclusive", "missing", "skipped"] as const
export const RUN_CLASSIFICATIONS = ["nightly", "manual", "branch", "harness-check"] as const

// Guard summaries can exceed ordinary narration prose. The scenario snapshot and
// its unchanged copy in run.expected must share this bounded ceiling.
const MAX_EXPECTATION_LENGTH = 2_048

export type PublicResult = typeof PUBLIC_RESULTS[number]
export type RunClassification = typeof RUN_CLASSIFICATIONS[number]

export interface PublicLink {
  label: string
  url: string
  visibility: "public" | "organization"
}

export interface PublicTimelineEntry {
  at: string
  state: "preparing" | "active" | "recovered" | "not-applied" | "verifying" | "passed" | "failed"
  source: "journey" | "network" | "role" | "outcome"
  action: string | null
  text: string
  detail?: string
}

export interface PublicRecording {
  state: "available" | "missing" | "expired"
  artifactUrl: string | null
  artifactUrls?: string[]
  visibility: "public" | "organization"
  uploadedAt: string | null
  expiresAt: string | null
}

export interface CrewIdentitySnapshot {
  key: string
  username: string
  displayName: string
  portraitFile: string
  portraitSha256: string
  portraitPath: string
  tagline: string
  backstory: string
  speciality: string
  palette: { primary: `#${string}`; secondary: `#${string}`; ink: `#${string}` }
}

export interface ScenarioSnapshot {
  profile: string
  title: string
  purpose: string
  expected: string
  criteria?: string[]
  parameters: Record<string, PublicParameter>
  phases: {
    preparing: string
    verifying: string
    passed: string
    failed: string
  }
  actions: Record<string, ScenarioActionPresentation>
}

export interface PublicDiagnostic {
  criterion: string
  status: "met" | "not-met" | "pending"
  detail: string
}

export interface PublicSourceReceipt {
  workflowPath: string
  event: string
  defaultBranch: string
  artifactId: number | null
  jobId: number | null
}

export interface PublicRunRecord {
  version: 1
  key: string
  runId: number
  attempt: number
  artifactAttempt: number | null
  executionKey: string
  suiteId: string | null
  wave: string | null
  classification: RunClassification
  repository: string
  ref: string
  commit: string
  actor: string
  source: PublicSourceReceipt
  network: "previewnet"
  app: "local" | "deployed"
  game: number | null
  appCid: string | null
  bot: number | null
  identity: CrewIdentitySnapshot | null
  scenario: ScenarioSnapshot | null
  startedAt: string
  finishedAt: string
  result: PublicResult
  productResult: PublicResult
  infrastructure: "complete" | "partial" | "missing" | "superseded"
  supersededBy: string | null
  expected: string[]
  diagnostics?: PublicDiagnostic[]
  /** what this bot's injected fault was meant to do, next to what the app measured.
   *  Optional: records written before the shaping report carry none. */
  shaping?: PublicShaping
  timeline: PublicTimelineEntry[]
  recovery: Array<{ name: string; milliseconds: number }>
  failures: string[]
  links: PublicLink[]
  recording: PublicRecording
}

/** One persona's shaping reading, as the shaping report judged it (lane S4). The
 *  `measured` line is the reader's own sentence, never re-worded here. */
export interface PublicShaping {
  intended: string
  measured: string
  verdict: "impact seen" | "no impact" | "cannot tell"
  /** the reader's caveat, when it had one: a verdict is only as good as its flag */
  note: string | null
}

export interface PublicSuiteRecord {
  version: 1
  key: string
  suiteId: string
  runId: number
  attempts: number[]
  latestAttempt: number
  state: "started" | "completed"
  classification: "nightly" | "manual"
  repository: string
  ref: string
  commit: string
  actor: string
  source: PublicSourceReceipt
  timezone: "Europe/Zurich"
  startedAt: string
  finishedAt: string | null
  planStatus: "provisional" | "available" | "unavailable"
  evidenceStatus: "provisional" | "available" | "unavailable"
  plannedWaves: Array<{ key: string; profiles: string[]; identities: string[]; isolated: boolean }>
  observedRunKeys: string[]
  totals: Record<PublicResult, number>
  infrastructureTotals: Record<"complete" | "partial" | "missing" | "superseded", number>
  coverage: { planned: number; observed: number; complete: boolean; missing: string[] }
  result: PublicResult
  productResult: PublicResult
  infrastructure: "complete" | "partial" | "missing"
  failures: string[]
  links: PublicLink[]
}

export interface PublicationBundle {
  version: 1
  runs: PublicRunRecord[]
  suites: PublicSuiteRecord[]
}

export function scanPublicValue(value: unknown): void {
  const scan = (where: string, entry: unknown): void => {
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => scan(`${where}[${index}]`, item))
      return
    }
    if (!entry || typeof entry !== "object") {
      assertPublicSafe(where, entry)
      return
    }
    for (const [key, nested] of Object.entries(entry)) {
      assertPublicSafe(`${where}.${key}`, { [key]: null })
      if (key === "portraitSha256" && typeof nested === "string" && /^[a-f0-9]{64}$/.test(nested)) continue
      if (key === "portraitPath" && typeof nested === "string" && /^assets\/portraits\/by-sha256\/[a-f0-9]{64}\.webp$/.test(nested)) continue
      scan(`${where}.${key}`, nested)
    }
  }
  scan("public", value)
}

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`)
}

const object = (where: string, value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(where, "expected an object")
  return value as Record<string, unknown>
}

const exactFields = (where: string, value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = allowed): void => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(where, `unknown field ${key}`)
  for (const key of required) if (!(key in value)) fail(where, `needs required field ${key}`)
}

const text = (where: string, value: unknown, max = 1_000): string => {
  if (typeof value !== "string" || value.trim() === "") fail(where, "expected a non-empty string")
  if (value.length > max) fail(where, `expected at most ${max} characters`)
  return value
}

const nullableText = (where: string, value: unknown, max = 1_000): string | null => value === null ? null : text(where, value, max)

const integer = (where: string, value: unknown, minimum = 0): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail(where, `expected an integer >= ${minimum}`)
  return value
}

const finite = (where: string, value: unknown, minimum = 0): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) fail(where, `expected a finite number >= ${minimum}`)
  return value
}

const bool = (where: string, value: unknown): boolean => {
  if (typeof value !== "boolean") fail(where, "expected a boolean")
  return value
}

const literal = <T extends string>(where: string, value: unknown, allowed: readonly T[]): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(where, `expected one of ${allowed.join(", ")}`)
  return value as T
}

const timestamp = (where: string, value: unknown): string => {
  const parsed = text(where, value, 40)
  const millis = Date.parse(parsed)
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== parsed) fail(where, "expected a canonical ISO timestamp")
  return parsed
}

const httpsUrl = (where: string, value: unknown): string => {
  const parsed = text(where, value, 2_048)
  let url: URL
  try {
    url = new URL(parsed)
  } catch {
    fail(where, "expected an absolute HTTPS URL")
  }
  if (url.protocol !== "https:" || url.username || url.password) fail(where, "expected an absolute HTTPS URL without credentials")
  return parsed
}

const slug = (where: string, value: unknown): string => {
  const parsed = text(where, value, 180)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parsed)) fail(where, "expected a URL-safe key")
  return parsed
}

const stringArray = (where: string, value: unknown, maxItems = 1_000, maxLength = 1_000): string[] => {
  if (!Array.isArray(value) || value.length > maxItems) fail(where, `expected an array with at most ${maxItems} entries`)
  return value.map((entry, index) => text(`${where}[${index}]`, entry, maxLength))
}

const validateLink = (where: string, value: unknown, repository: string): PublicLink => {
  const raw = object(where, value)
  exactFields(where, raw, ["label", "url", "visibility"])
  const link: PublicLink = {
    label: text(`${where}.label`, raw.label, 120),
    url: httpsUrl(`${where}.url`, raw.url),
    visibility: literal(`${where}.visibility`, raw.visibility, ["public", "organization"] as const),
  }
  const parsed = new URL(link.url)
  if (parsed.hostname === "github.com" && parsed.pathname.toLowerCase().startsWith(`/${repository.toLowerCase()}/`) && link.visibility !== "organization")
    fail(`${where}.visibility`, "private repository links must be organization-only")
  return link
}

const validatePalette = (where: string, value: unknown): CrewIdentitySnapshot["palette"] => {
  const raw = object(where, value)
  exactFields(where, raw, ["primary", "secondary", "ink"])
  const colour = (field: string): `#${string}` => {
    const parsed = text(`${where}.${field}`, raw[field], 7)
    if (!/^#[0-9A-Fa-f]{6}$/.test(parsed)) fail(`${where}.${field}`, "expected #RRGGBB")
    return parsed as `#${string}`
  }
  return { primary: colour("primary"), secondary: colour("secondary"), ink: colour("ink") }
}

const validateIdentity = (where: string, value: unknown): CrewIdentitySnapshot => {
  const raw = object(where, value)
  exactFields(where, raw, ["key", "username", "displayName", "portraitFile", "portraitSha256", "portraitPath", "tagline", "backstory", "speciality", "palette"])
  const portraitFile = text(`${where}.portraitFile`, raw.portraitFile, 180)
  if (!/^[a-z0-9-]+\.webp$/.test(portraitFile)) fail(`${where}.portraitFile`, "expected a safe WebP filename")
  const portraitSha256 = text(`${where}.portraitSha256`, raw.portraitSha256, 64)
  if (!/^[a-f0-9]{64}$/.test(portraitSha256)) fail(`${where}.portraitSha256`, "expected a lowercase SHA-256 digest")
  const portraitPath = text(`${where}.portraitPath`, raw.portraitPath, 240)
  if (portraitPath !== `assets/portraits/by-sha256/${portraitSha256}.webp`) fail(`${where}.portraitPath`, "must be the content-addressed WebP path")
  return {
    key: slug(`${where}.key`, raw.key),
    username: text(`${where}.username`, raw.username, 180),
    displayName: text(`${where}.displayName`, raw.displayName, 180),
    portraitFile,
    portraitSha256,
    portraitPath,
    tagline: text(`${where}.tagline`, raw.tagline, 500),
    backstory: text(`${where}.backstory`, raw.backstory, 1_000),
    speciality: text(`${where}.speciality`, raw.speciality, 500),
    palette: validatePalette(`${where}.palette`, raw.palette),
  }
}

const validatePublicParameter = (where: string, value: unknown): PublicParameter => {
  if (typeof value === "string") return text(where, value, 500)
  if (typeof value === "number") return finite(where, value, -Number.MAX_VALUE)
  if (typeof value === "boolean") return value
  if (Array.isArray(value)) return value.map((entry, index) => finite(`${where}[${index}]`, entry, -Number.MAX_VALUE))
  fail(where, "expected a public string, number, boolean, or number array")
}

const validateScenario = (where: string, value: unknown): ScenarioSnapshot => {
  const raw = object(where, value)
  exactFields(where, raw, ["profile", "title", "purpose", "expected", "criteria", "parameters", "phases", "actions"], ["profile", "title", "purpose", "expected", "parameters", "phases", "actions"])
  const parametersRaw = object(`${where}.parameters`, raw.parameters)
  const parameters = Object.fromEntries(Object.entries(parametersRaw).map(([key, entry]) => [slug(`${where}.parameters key`, key), validatePublicParameter(`${where}.parameters.${key}`, entry)]))
  const phasesRaw = object(`${where}.phases`, raw.phases)
  exactFields(`${where}.phases`, phasesRaw, ["preparing", "verifying", "passed", "failed"])
  const actionsRaw = object(`${where}.actions`, raw.actions)
  const actions = Object.fromEntries(Object.entries(actionsRaw).map(([key, entry]) => {
    const actionWhere = `${where}.actions.${key}`
    const actionRaw = object(actionWhere, entry)
    exactFields(actionWhere, actionRaw, ["active", "recovered", "failed"], ["active", "failed"])
    return [slug(`${where}.actions key`, key), {
      active: text(`${actionWhere}.active`, actionRaw.active, 1_000),
      ...(actionRaw.recovered === undefined ? {} : { recovered: text(`${actionWhere}.recovered`, actionRaw.recovered, 1_000) }),
      failed: text(`${actionWhere}.failed`, actionRaw.failed, 1_000),
    } satisfies ScenarioActionPresentation]
  }))
  return {
    profile: slug(`${where}.profile`, raw.profile),
    title: text(`${where}.title`, raw.title, 500),
    purpose: text(`${where}.purpose`, raw.purpose, 1_000),
    expected: text(`${where}.expected`, raw.expected, MAX_EXPECTATION_LENGTH),
    ...(raw.criteria === undefined ? {} : { criteria: stringArray(`${where}.criteria`, raw.criteria, 1_000, MAX_EXPECTATION_LENGTH) }),
    parameters,
    phases: {
      preparing: text(`${where}.phases.preparing`, phasesRaw.preparing, 1_000),
      verifying: text(`${where}.phases.verifying`, phasesRaw.verifying, 1_000),
      passed: text(`${where}.phases.passed`, phasesRaw.passed, 1_000),
      failed: text(`${where}.phases.failed`, phasesRaw.failed, 1_000),
    },
    actions,
  }
}

const validateTimeline = (where: string, value: unknown): PublicTimelineEntry[] => {
  if (!Array.isArray(value) || value.length > 10_000) fail(where, "expected an array with at most 10000 entries")
  let previous = -Infinity
  return value.map((entry, index) => {
    const itemWhere = `${where}[${index}]`
    const raw = object(itemWhere, entry)
    exactFields(itemWhere, raw, ["at", "state", "source", "action", "text", "detail"], ["at", "state", "source", "action", "text"])
    const at = timestamp(`${itemWhere}.at`, raw.at)
    const millis = Date.parse(at)
    if (millis < previous) fail(`${itemWhere}.at`, "timeline entries must be chronological")
    previous = millis
    return {
      at,
      state: literal(`${itemWhere}.state`, raw.state, ["preparing", "active", "recovered", "not-applied", "verifying", "passed", "failed"] as const),
      source: literal(`${itemWhere}.source`, raw.source, ["journey", "network", "role", "outcome"] as const),
      action: raw.action === null ? null : text(`${itemWhere}.action`, raw.action, 180),
      text: text(`${itemWhere}.text`, raw.text, 1_000),
      ...(raw.detail === undefined ? {} : { detail: text(`${itemWhere}.detail`, raw.detail, 1_000) }),
    }
  })
}

const validateRecording = (where: string, value: unknown, repository?: string): PublicRecording => {
  const raw = object(where, value)
  exactFields(where, raw, ["state", "artifactUrl", "artifactUrls", "visibility", "uploadedAt", "expiresAt"], ["state", "artifactUrl", "visibility", "uploadedAt", "expiresAt"])
  const state = literal(`${where}.state`, raw.state, ["available", "missing", "expired"] as const)
  const visibility = literal(`${where}.visibility`, raw.visibility, ["public", "organization"] as const)
  if (state === "missing") {
    if (raw.artifactUrl !== null || raw.artifactUrls !== undefined || raw.uploadedAt !== null || raw.expiresAt !== null) fail(where, "a missing recording cannot have artifact timestamps or a link")
    return { state, artifactUrl: null, visibility, uploadedAt: null, expiresAt: null }
  }
  const artifactUrl = httpsUrl(`${where}.artifactUrl`, raw.artifactUrl)
  const parsed = new URL(artifactUrl)
  if (repository && visibility === "organization") {
    const path = parsed.pathname.split("/").filter(Boolean)
    const [owner, name, actions, runs, runId, artifacts, artifactId] = path
    const expectedRepository = repository.toLowerCase().split("/")
    if (
      parsed.hostname !== "github.com"
      || path.length !== 7
      || owner?.toLowerCase() !== expectedRepository[0]
      || name?.toLowerCase() !== expectedRepository[1]
      || actions !== "actions"
      || runs !== "runs"
      || !/^[1-9][0-9]*$/.test(runId ?? "")
      || artifacts !== "artifacts"
      || !/^[1-9][0-9]*$/.test(artifactId ?? "")
    ) fail(`${where}.artifactUrl`, "expected a GitHub Actions artifact URL for the record repository")
  } else if (visibility === "public") {
    const urls = raw.artifactUrls === undefined ? [artifactUrl] : stringArray(`${where}.artifactUrls`, raw.artifactUrls, 100, 2_048)
    for (const [index, url] of urls.entries()) {
      const candidate = new URL(httpsUrl(`${where}.artifactUrls[${index}]`, url))
      const path = candidate.pathname.split("/").filter(Boolean)
      const [owner, name, releases, download, tag, asset] = path
      if (candidate.hostname !== "github.com" || path.length !== 6 || !/^[A-Za-z0-9_.-]+$/.test(owner ?? "") || !/^[A-Za-z0-9_.-]+$/.test(name ?? "") || releases !== "releases" || download !== "download" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag ?? "") || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.mp4$/.test(asset ?? "")) fail(`${where}.artifactUrls[${index}]`, "expected a direct GitHub release MP4 URL")
    }
    if (urls[0] !== artifactUrl) fail(`${where}.artifactUrls`, "must start with artifactUrl")
  }
  const uploadedAt = timestamp(`${where}.uploadedAt`, raw.uploadedAt)
  const expiresAt = timestamp(`${where}.expiresAt`, raw.expiresAt)
  if (Date.parse(expiresAt) <= Date.parse(uploadedAt)) fail(where, "recording expiry must be after upload")
  return { state, artifactUrl, ...(raw.artifactUrls === undefined ? {} : { artifactUrls: raw.artifactUrls as string[] }), visibility, uploadedAt, expiresAt }
}

const validateRepository = (where: string, value: unknown): string => {
  const repository = text(where, value, 200)
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail(where, "expected owner/repository")
  return repository
}

const validateSource = (where: string, value: unknown): PublicSourceReceipt => {
  const raw = object(where, value)
  exactFields(where, raw, ["workflowPath", "event", "defaultBranch", "artifactId", "jobId"])
  const workflowPath = text(`${where}.workflowPath`, raw.workflowPath, 500)
  if (!/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(workflowPath)) fail(`${where}.workflowPath`, "expected a repository workflow path")
  return {
    workflowPath,
    event: slug(`${where}.event`, raw.event),
    defaultBranch: text(`${where}.defaultBranch`, raw.defaultBranch, 180),
    artifactId: raw.artifactId === null ? null : integer(`${where}.artifactId`, raw.artifactId, 1),
    jobId: raw.jobId === null ? null : integer(`${where}.jobId`, raw.jobId, 1),
  }
}

const RUN_FIELDS = [
  "version", "key", "runId", "attempt", "artifactAttempt", "executionKey", "suiteId", "wave", "classification", "repository", "ref", "commit", "actor", "source", "network", "app", "game", "appCid", "bot", "identity", "scenario", "startedAt", "finishedAt", "result", "productResult", "infrastructure", "supersededBy", "expected", "diagnostics", "shaping", "timeline", "recovery", "failures", "links", "recording",
] as const

const REQUIRED_RUN_FIELDS = RUN_FIELDS.filter((field) => field !== "diagnostics" && field !== "shaping")

export function validatePublicRunRecord(value: unknown): PublicRunRecord {
  scanPublicValue(value)
  const raw = object("run", value)
  exactFields("run", raw, RUN_FIELDS, REQUIRED_RUN_FIELDS)
  if (raw.version !== 1) fail("run.version", "expected 1")
  const repository = validateRepository("run.repository", raw.repository)
  const startedAt = timestamp("run.startedAt", raw.startedAt)
  const finishedAt = timestamp("run.finishedAt", raw.finishedAt)
  if (Date.parse(finishedAt) < Date.parse(startedAt)) fail("run.finishedAt", "cannot be before startedAt")
  const classification = literal("run.classification", raw.classification, RUN_CLASSIFICATIONS)
  const infrastructure = literal("run.infrastructure", raw.infrastructure, ["complete", "partial", "missing", "superseded"] as const)
  const supersededBy = nullableText("run.supersededBy", raw.supersededBy, 180)
  if (infrastructure === "superseded" && !supersededBy) fail("run.supersededBy", "is required for superseded infrastructure evidence")
  if (infrastructure !== "superseded" && supersededBy) fail("run.supersededBy", "is allowed only for superseded evidence")
  const identity = raw.identity === null ? null : validateIdentity("run.identity", raw.identity)
  const scenario = raw.scenario === null ? null : validateScenario("run.scenario", raw.scenario)
  if (classification === "harness-check" && identity !== null) fail("run.identity", "harness checks cannot be attributed to a crew identity")
  if (classification !== "harness-check" && (!identity || !scenario)) fail("run", "crew runs require identity and scenario snapshots")
  const recoveryRaw = raw.recovery
  if (!Array.isArray(recoveryRaw) || recoveryRaw.length > 1_000) fail("run.recovery", "expected an array with at most 1000 entries")
  const recovery = recoveryRaw.map((entry, index) => {
    const where = `run.recovery[${index}]`
    const item = object(where, entry)
    exactFields(where, item, ["name", "milliseconds"])
    return { name: text(`${where}.name`, item.name, 180), milliseconds: finite(`${where}.milliseconds`, item.milliseconds) }
  })
  const linksRaw = raw.links
  if (!Array.isArray(linksRaw) || linksRaw.length > 100) fail("run.links", "expected an array with at most 100 entries")
  const links = linksRaw.map((entry, index) => validateLink(`run.links[${index}]`, entry, repository))
  const diagnostics = raw.diagnostics === undefined ? undefined : (() => {
    if (!Array.isArray(raw.diagnostics) || raw.diagnostics.length > 1_000) fail("run.diagnostics", "expected an array with at most 1000 entries")
    return raw.diagnostics.map((entry, index): PublicDiagnostic => {
      const where = `run.diagnostics[${index}]`
      const item = object(where, entry)
      exactFields(where, item, ["criterion", "status", "detail"])
      return {
        criterion: text(`${where}.criterion`, item.criterion, MAX_EXPECTATION_LENGTH),
        status: literal(`${where}.status`, item.status, ["met", "not-met", "pending"] as const),
        detail: text(`${where}.detail`, item.detail, 500),
      }
    })
  })()
  const shaping = raw.shaping === undefined ? undefined : (() => {
    const where = "run.shaping"
    const item = object(where, raw.shaping)
    exactFields(where, item, ["intended", "measured", "verdict", "note"])
    return {
      intended: text(`${where}.intended`, item.intended, 500),
      measured: text(`${where}.measured`, item.measured, 500),
      verdict: literal(`${where}.verdict`, item.verdict, ["impact seen", "no impact", "cannot tell"] as const),
      note: item.note === null ? null : text(`${where}.note`, item.note, 1_000),
    }
  })()
  const record: PublicRunRecord = {
    version: 1,
    key: slug("run.key", raw.key),
    runId: integer("run.runId", raw.runId, 1),
    attempt: integer("run.attempt", raw.attempt, 1),
    artifactAttempt: raw.artifactAttempt === null ? null : integer("run.artifactAttempt", raw.artifactAttempt, 1),
    executionKey: slug("run.executionKey", raw.executionKey),
    suiteId: nullableText("run.suiteId", raw.suiteId, 180),
    wave: nullableText("run.wave", raw.wave, 180),
    classification,
    repository,
    ref: text("run.ref", raw.ref, 500),
    commit: text("run.commit", raw.commit, 128),
    actor: text("run.actor", raw.actor, 180),
    source: validateSource("run.source", raw.source),
    network: literal("run.network", raw.network, ["previewnet"] as const),
    app: literal("run.app", raw.app, ["local", "deployed"] as const),
    game: raw.game === null ? null : integer("run.game", raw.game),
    appCid: nullableText("run.appCid", raw.appCid, 500),
    bot: raw.bot === null ? null : integer("run.bot", raw.bot, 1),
    identity,
    scenario,
    startedAt,
    finishedAt,
    result: literal("run.result", raw.result, PUBLIC_RESULTS),
    productResult: literal("run.productResult", raw.productResult, PUBLIC_RESULTS),
    infrastructure,
    supersededBy,
    expected: stringArray("run.expected", raw.expected, 1_000, MAX_EXPECTATION_LENGTH),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(shaping === undefined ? {} : { shaping }),
    timeline: validateTimeline("run.timeline", raw.timeline),
    recovery,
    failures: stringArray("run.failures", raw.failures, 1_000, 500),
    links,
    recording: validateRecording("run.recording", raw.recording, repository),
  }
  if (!/^[a-f0-9]{40}$/.test(record.commit)) fail("run.commit", "expected a lowercase 40-character commit SHA")
  if (record.diagnostics && record.scenario?.criteria) {
    if (record.diagnostics.length !== record.scenario.criteria.length) fail("run.diagnostics", "must have one entry per scenario criterion")
    record.diagnostics.forEach((diagnostic, index) => {
      if (diagnostic.criterion !== record.scenario!.criteria![index]) fail(`run.diagnostics[${index}].criterion`, "must match the scenario criterion at the same index")
    })
  }
  if ((record.artifactAttempt === null) !== (record.source.artifactId === null)) fail("run.source.artifactId", "must exist exactly when artifactAttempt exists")
  if (record.recording.state !== "missing" && record.artifactAttempt === null) fail("run.recording", "cannot be available without immutable artifact provenance")
  return record
}

const totals = <K extends string>(where: string, value: unknown, keys: readonly K[]): Record<K, number> => {
  const raw = object(where, value)
  exactFields(where, raw, keys)
  return Object.fromEntries(keys.map((key) => [key, integer(`${where}.${key}`, raw[key])])) as Record<K, number>
}

const SUITE_FIELDS = [
  "version", "key", "suiteId", "runId", "attempts", "latestAttempt", "state", "classification", "repository", "ref", "commit", "actor", "source", "timezone", "startedAt", "finishedAt", "planStatus", "evidenceStatus", "plannedWaves", "observedRunKeys", "totals", "infrastructureTotals", "coverage", "result", "productResult", "infrastructure", "failures", "links",
] as const

export function validatePublicSuiteRecord(value: unknown): PublicSuiteRecord {
  scanPublicValue(value)
  const raw = object("suite", value)
  exactFields("suite", raw, SUITE_FIELDS)
  if (raw.version !== 1) fail("suite.version", "expected 1")
  const repository = validateRepository("suite.repository", raw.repository)
  if (!Array.isArray(raw.attempts) || raw.attempts.length === 0) fail("suite.attempts", "expected at least one attempt")
  const attempts = raw.attempts.map((attempt, index) => integer(`suite.attempts[${index}]`, attempt, 1))
  if (new Set(attempts).size !== attempts.length) fail("suite.attempts", "attempts must be unique")
  const latestAttempt = integer("suite.latestAttempt", raw.latestAttempt, 1)
  if (latestAttempt !== Math.max(...attempts)) fail("suite.latestAttempt", "must be the greatest attempt")
  const state = literal("suite.state", raw.state, ["started", "completed"] as const)
  const startedAt = timestamp("suite.startedAt", raw.startedAt)
  const finishedAt = raw.finishedAt === null ? null : timestamp("suite.finishedAt", raw.finishedAt)
  if (finishedAt && Date.parse(finishedAt) < Date.parse(startedAt)) fail("suite.finishedAt", "cannot be before startedAt")
  const planStatus = literal("suite.planStatus", raw.planStatus, ["provisional", "available", "unavailable"] as const)
  const evidenceStatus = literal("suite.evidenceStatus", raw.evidenceStatus, ["provisional", "available", "unavailable"] as const)
  if (!Array.isArray(raw.plannedWaves) || raw.plannedWaves.length > 1_000) fail("suite.plannedWaves", "expected an array with at most 1000 entries")
  const plannedWaves = raw.plannedWaves.map((entry, index) => {
    const where = `suite.plannedWaves[${index}]`
    const wave = object(where, entry)
    exactFields(where, wave, ["key", "profiles", "identities", "isolated"])
    return { key: slug(`${where}.key`, wave.key), profiles: stringArray(`${where}.profiles`, wave.profiles), identities: stringArray(`${where}.identities`, wave.identities), isolated: bool(`${where}.isolated`, wave.isolated) }
  })
  const observedRunKeys = stringArray("suite.observedRunKeys", raw.observedRunKeys)
  const resultTotals = totals("suite.totals", raw.totals, PUBLIC_RESULTS)
  const infrastructureTotals = totals("suite.infrastructureTotals", raw.infrastructureTotals, ["complete", "partial", "missing", "superseded"] as const)
  const coverageRaw = object("suite.coverage", raw.coverage)
  exactFields("suite.coverage", coverageRaw, ["planned", "observed", "complete", "missing"])
  const coverage = {
    planned: integer("suite.coverage.planned", coverageRaw.planned),
    observed: integer("suite.coverage.observed", coverageRaw.observed),
    complete: bool("suite.coverage.complete", coverageRaw.complete),
    missing: stringArray("suite.coverage.missing", coverageRaw.missing),
  }
  if (coverage.observed > coverage.planned) fail("suite.coverage", "observed cannot exceed planned")
  const failures = stringArray("suite.failures", raw.failures, 1_000, 500)
  if (!Array.isArray(raw.links) || raw.links.length > 100) fail("suite.links", "expected an array with at most 100 entries")
  const links = raw.links.map((entry, index) => validateLink(`suite.links[${index}]`, entry, repository))
  const record: PublicSuiteRecord = {
    version: 1,
    key: slug("suite.key", raw.key),
    suiteId: slug("suite.suiteId", raw.suiteId),
    runId: integer("suite.runId", raw.runId, 1),
    attempts,
    latestAttempt,
    state,
    classification: literal("suite.classification", raw.classification, ["nightly", "manual"] as const),
    repository,
    ref: text("suite.ref", raw.ref, 500),
    commit: text("suite.commit", raw.commit, 128),
    actor: text("suite.actor", raw.actor, 180),
    source: validateSource("suite.source", raw.source),
    timezone: literal("suite.timezone", raw.timezone, ["Europe/Zurich"] as const),
    startedAt,
    finishedAt,
    planStatus,
    evidenceStatus,
    plannedWaves,
    observedRunKeys,
    totals: resultTotals,
    infrastructureTotals,
    coverage,
    result: literal("suite.result", raw.result, PUBLIC_RESULTS),
    productResult: literal("suite.productResult", raw.productResult, PUBLIC_RESULTS),
    infrastructure: literal("suite.infrastructure", raw.infrastructure, ["complete", "partial", "missing"] as const),
    failures,
    links,
  }
  if (!/^[a-f0-9]{40}$/.test(record.commit)) fail("suite.commit", "expected a lowercase 40-character commit SHA")
  if (state === "started") {
    if (finishedAt !== null) fail("suite.finishedAt", "a started suite cannot have a finished timestamp")
    if (planStatus !== "provisional" || evidenceStatus !== "provisional") fail("suite", "a started suite needs provisional plan and evidence")
    if (plannedWaves.length || observedRunKeys.length || Object.values(resultTotals).some(Boolean) || Object.values(infrastructureTotals).some(Boolean)) fail("suite", "a started suite must keep plan and totals provisional")
    if (coverage.planned !== 0 || coverage.observed !== 0 || coverage.complete || coverage.missing.length) fail("suite.coverage", "a started suite needs empty provisional coverage")
  } else {
    if (finishedAt === null) fail("suite.finishedAt", "a completed suite needs a finished timestamp")
    const normal = planStatus === "available" && evidenceStatus === "available"
    const catastrophic = planStatus === "unavailable" && evidenceStatus === "unavailable"
    if (!normal && !catastrophic) fail("suite", "a completed suite needs both plan and evidence available or unavailable")
    if (normal && plannedWaves.length === 0) fail("suite.plannedWaves", "a normal completed suite needs a final plan")
    if (catastrophic) {
      if (plannedWaves.length || observedRunKeys.length || coverage.planned || coverage.observed || coverage.complete || coverage.missing.length) fail("suite", "an unavailable catastrophic suite cannot invent plan or evidence")
      if (record.infrastructure !== "missing" || failures.length === 0) fail("suite", "an unavailable catastrophic suite needs missing infrastructure and an explicit failure")
    }
  }
  return record
}

export function validatePublicationBundle(value: unknown): PublicationBundle {
  scanPublicValue(value)
  const raw = object("bundle", value)
  exactFields("bundle", raw, ["version", "runs", "suites"])
  if (raw.version !== 1) fail("bundle.version", "expected 1")
  if (!Array.isArray(raw.runs) || !Array.isArray(raw.suites)) fail("bundle", "runs and suites must be arrays")
  const runs = raw.runs.map(validatePublicRunRecord)
  const suites = raw.suites.map(validatePublicSuiteRecord)
  const duplicate = (values: readonly string[]): string | undefined => values.find((entry, index) => values.indexOf(entry) !== index)
  const duplicateRun = duplicate(runs.map(({ key }) => key))
  if (duplicateRun) fail("bundle.runs", `duplicate key ${duplicateRun}`)
  const duplicateSuite = duplicate(suites.map(({ key }) => key))
  if (duplicateSuite) fail("bundle.suites", `duplicate key ${duplicateSuite}`)
  return { version: 1, runs, suites }
}

export function recordingAt(recording: PublicRecording, now: Date): PublicRecording {
  if (!Number.isFinite(now.getTime())) fail("now", "expected a valid date")
  const parsed = validateRecording("recording", recording)
  if (parsed.state === "missing" || parsed.state === "expired") return parsed
  return now.getTime() >= Date.parse(parsed.expiresAt!) ? { ...parsed, state: "expired" } : parsed
}

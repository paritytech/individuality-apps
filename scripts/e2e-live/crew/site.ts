// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { CrewCatalogue, CrewIdentity } from "./catalogue"
import {
  recordingAt,
  validatePublicRunRecord,
  validatePublicSuiteRecord,
  type PublicLink,
  type PublicRunRecord,
  type PublicSuiteRecord,
} from "./run-record"

export interface CrewSiteState {
  runs: PublicRunRecord[]
  suites: PublicSuiteRecord[]
}

export interface GenerateCrewSiteOptions {
  stateDir: string
  outputDir: string
  catalogue: CrewCatalogue
  portraitDir: URL | string
  now: Date
}

export interface PortraitBytesOptions {
  stateDir: string
  portraitDir: URL | string
  portraitSourceDir?: string
}

const SITE_TIME_ZONE = "Europe/Zurich"

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;")

const titleCase = (value: string): string => value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`
// Older immutable run records used the regression key's `game259` prefix as
// display copy. It names the incident the profile was derived from, not the
// PreviewNet game being shown on the page.
const scenarioCopy = (value: string): string => value.replaceAll("Game259 ", "")
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
const safeSegment = (where: string, value: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`${where}: expected a URL-safe path segment`)
  return value
}

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: SITE_TIME_ZONE,
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
})

const localDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SITE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

const formatTime = (value: string | Date): string => dateFormatter.format(typeof value === "string" ? new Date(value) : value)
const localDate = (value: string | Date): string => localDateFormatter.format(typeof value === "string" ? new Date(value) : value)
const compareText = (one: string, two: string): number => one < two ? -1 : one > two ? 1 : 0
const previousDate = (date: string): string => {
  const [year, month, day] = date.split("-").map(Number)
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10)
}
const localHour = (value: Date): number => Number(new Intl.DateTimeFormat("en-GB", {
  timeZone: SITE_TIME_ZONE,
  hour: "2-digit",
  hourCycle: "h23",
}).format(value))

const readJsonRecords = <T>(directory: string, validate: (value: unknown) => T): T[] => {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .sort((one, two) => compareText(one.name, two.name))
    .flatMap((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) throw new Error(`${directory}: expected JSON record files only, got ${entry.name}`)
      return [validate(JSON.parse(readFileSync(join(directory, entry.name), "utf8")))]
    })
}

export function readCrewSiteState(stateDir: string): CrewSiteState {
  return {
    runs: readJsonRecords(join(stateDir, "data", "runs"), validatePublicRunRecord),
    suites: readJsonRecords(join(stateDir, "data", "suites"), validatePublicSuiteRecord),
  }
}

const newestFirst = <T extends { finishedAt: string; runId: number }>(one: T, two: T): number => {
  const byTime = Date.parse(two.finishedAt) - Date.parse(one.finishedAt)
  return byTime || two.runId - one.runId
}

export function selectLatestSuite(suites: readonly PublicSuiteRecord[]): PublicSuiteRecord | null {
  return [...suites].sort((one, two) => {
    const byStart = Date.parse(two.startedAt) - Date.parse(one.startedAt)
    return byStart || two.runId - one.runId
  })[0] ?? null
}

const resultPill = (label: string, value: string): string => {
  if (!value || value === "missing" || value === "unknown") return ""
  const displayLabel = label === "Product" ? "Game" : label === "Infrastructure" ? "Recording" : label
  const displayValue = value === "complete" ? "Recorded" : value === "partial" ? "Partly recorded" : value
  return `<span class="status status-${escapeHtml(value)}"><span>${escapeHtml(displayLabel)}</span> ${escapeHtml(displayValue)}</span>`
}

const suiteMetrics = (suite: PublicSuiteRecord): string => `<dl class="suite-metrics">
  <div><dt>Passed</dt><dd>${suite.totals.passed}</dd></div><div><dt>Failed</dt><dd>${suite.totals.failed}</dd></div><div><dt>Inconclusive</dt><dd>${suite.totals.inconclusive}</dd></div><div><dt>No game result</dt><dd>${suite.totals.missing}</dd></div><div><dt>Skipped</dt><dd>${suite.totals.skipped}</dd></div>
  <div><dt>Recording complete</dt><dd>${suite.infrastructureTotals.complete}</dd></div><div><dt>Recording partial</dt><dd>${suite.infrastructureTotals.partial}</dd></div><div><dt>Recording missing</dt><dd>${suite.infrastructureTotals.missing}</dd></div><div><dt>Recording superseded</dt><dd>${suite.infrastructureTotals.superseded}</dd></div>
  <div><dt>Coverage</dt><dd>${suite.coverage.observed}/${suite.coverage.planned}${suite.coverage.complete ? " complete" : " incomplete"}</dd></div>
</dl>`

const links = (items: readonly PublicLink[]): string => items.length === 0
  ? "<p class=\"muted\">No links available.</p>"
  : `<ul class="link-list">${items.map((item) => `<li><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label)}</a>${item.visibility === "organization" ? " <span class=\"private-label\">Organization members only</span>" : ""}</li>`).join("")}</ul>`

const page = (title: string, root: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${escapeHtml(title)} · PreviewNet Crew</title>
  <link rel="stylesheet" href="${root}assets/site.css">
  <script src="${root}assets/status.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header"><a class="brand" href="${root}"><span aria-hidden="true">◉</span> PreviewNet Crew</a><span class="network">PreviewNet</span></header>
  <main id="main">${body}</main>
  <footer>PreviewNet Crew · Times shown in Europe/Zurich · Videos are available for 14 days.</footer>
</body>
</html>
`

const identityHistory = (identity: CrewIdentity, runs: readonly PublicRunRecord[]): PublicRunRecord[] => [...runs]
  .filter((run) => run.identity?.key === identity.key)
  .sort((one, two) => newestFirst(one, two) || two.attempt - one.attempt)

const completedNightlyHistory = (history: readonly PublicRunRecord[]): PublicRunRecord[] => history
  .filter(({ classification, infrastructure }) => classification === "nightly" && infrastructure === "complete")

const identityCard = (identity: CrewIdentity, runs: readonly PublicRunRecord[], root = ""): string => {
  const nightlyRuns = completedNightlyHistory(identityHistory(identity, runs))
  const latest = nightlyRuns[0]
  const success = nightlyRuns.find(({ productResult }) => productResult === "passed")
  const status = latest?.productResult ?? "missing"
  return `<article class="identity-card identity-card-${status}" style="--primary:${escapeHtml(identity.palette.primary)};--secondary:${escapeHtml(identity.palette.secondary)};--ink:${escapeHtml(identity.palette.ink)}">
  <a href="${root}identities/${escapeHtml(identity.key)}/">
    <img src="${root}assets/portraits/current/${escapeHtml(identity.portrait)}" width="320" height="320" alt="Portrait of ${escapeHtml(identity.displayName)}">
    <div><h3>${escapeHtml(identity.displayName)}</h3><p>${escapeHtml(identity.tagline)}</p><span>${escapeHtml(identity.speciality)}</span><dl class="card-evidence"><dt>Latest nightly scenario</dt><dd>${escapeHtml(scenarioCopy(latest?.scenario?.title ?? "No completed nightly run yet"))}</dd><dt>Latest nightly result</dt><dd>${escapeHtml(latest?.productResult ?? "Missing")}</dd><dt>Last nightly success</dt><dd>${success ? formatTime(success.finishedAt) : "No successful nightly run yet"}</dd></dl></div>
  </a>
</article>`
}

const runSummary = (run: PublicRunRecord, root: string): string => `<li class="run-row">
  <a href="${root}runs/${escapeHtml(run.key)}/"><strong>${escapeHtml(run.identity?.displayName ?? "Harness check")}</strong><span>${escapeHtml(scenarioCopy(run.scenario?.title ?? "Harness"))}</span></a>
  <span>${formatTime(run.finishedAt)}</span>
  ${resultPill("Product", run.productResult)} ${resultPill("Infrastructure", run.infrastructure)}
</li>`

const gameKey = (run: PublicRunRecord): string | null => run.bot === null ? null : `${run.runId}/${run.attempt}/${run.executionKey}`
const gameRuns = (run: PublicRunRecord, runs: readonly PublicRunRecord[]): PublicRunRecord[] => {
  const key = gameKey(run)
  return key === null ? [] : runs.filter((candidate) => gameKey(candidate) === key).sort((one, two) => (one.bot ?? 0) - (two.bot ?? 0))
}
const playerVideoCount = (count: number): string => `${count} player ${count === 1 ? "video" : "videos"}`
const testGameHeadline = (run: PublicRunRecord, runs: readonly PublicRunRecord[]): string => {
  const game = run.game === null ? "a test game" : `game ${run.game}`
  const botCount = gameRuns(run, runs).length
  return botCount === 0 ? titleCase(game) : `${botCount} ${botCount === 1 ? "bot" : "bots"} played ${game}`
}
const hasAvailableRecording = (run: PublicRunRecord): boolean => run.recording.state === "available"

const gamePovs = (run: PublicRunRecord, runs: readonly PublicRunRecord[]): string => {
  const players = gameRuns(run, runs)
  return `<section><h2>Player videos from this game</h2><p>Run ${run.runId} · attempt ${run.attempt} · execution ${escapeHtml(run.executionKey)}</p>${players.length
    ? `<div class="pov-grid">${players.map((player) => `<article class="pov-card"><h3>${escapeHtml(player.identity?.displayName ?? `Bot ${player.bot ?? "?"}`)}</h3><p>${escapeHtml(scenarioCopy(player.scenario?.title ?? "Test run"))}</p>${recording(player)}<p><a href="../../runs/${escapeHtml(player.key)}/">View run details</a></p></article>`).join("")}</div>`
    : "<p>No player videos were published.</p>"}</section>`
}

const latestSuiteHeadline = (suite: PublicSuiteRecord | null, latestRun: PublicRunRecord | null, runs: readonly PublicRunRecord[], generatedAt: Date): string => {
  if (!suite && latestRun) return `<section class="hero hero-missing">
    <p class="eyebrow">Latest test game · ${formatTime(latestRun.finishedAt)}</p>
    <h1 role="status" aria-live="polite">${testGameHeadline(latestRun, runs)}</h1>
    <div class="status-line">${["passed", "failed"].includes(latestRun.productResult) ? resultPill("Product", latestRun.productResult) : ""}</div>
    <p>${escapeHtml(scenarioCopy(latestRun.scenario?.title ?? latestRun.executionKey))}</p>
    <p><a class="button" href="runs/${escapeHtml(latestRun.key)}/">Watch the game</a></p>
    <p class="as-of">Updated ${formatTime(generatedAt)}</p>
  </section>`
  if (!suite) return `<section class="hero"><p class="eyebrow">Latest published run</p><h1 role="status" aria-live="polite">No runs published yet</h1><p>Published test runs will appear here.</p><p class="as-of">Updated ${formatTime(generatedAt)}</p></section>`
  const result = suite.state === "started" ? "In progress" : titleCase(suite.result)
  const today = localDate(generatedAt)
  const suiteDate = localDate(suite.startedAt)
  const fresh = suiteDate === today || (localHour(generatedAt) < 9 && suiteDate === previousDate(today))
  const label = suite.classification === "nightly" && !fresh ? "Tonight's crew run isn't published yet" : result
  return `<section class="hero hero-${escapeHtml(suite.productResult)}" data-suite-status data-suite-date="${localDate(suite.startedAt)}" data-suite-state="${suite.state}" data-suite-result="${escapeHtml(result)}" data-suite-classification="${escapeHtml(suite.classification)}">
    <p class="eyebrow">Latest suite · ${escapeHtml(titleCase(suite.classification))}</p>
    <h1 data-suite-label role="status" aria-live="polite">${escapeHtml(label)}</h1>
    <div class="status-line">${resultPill("Product", suite.productResult)} ${resultPill("Infrastructure", suite.infrastructure)}</div>
    ${suiteMetrics(suite)}
    ${suite.coverage.missing.length ? `<p class="coverage-missing"><strong>Missing identities:</strong> ${suite.coverage.missing.map(escapeHtml).join(", ")}</p>` : ""}
    <p>Started ${formatTime(suite.startedAt)}${suite.finishedAt ? ` · Finished ${formatTime(suite.finishedAt)}` : ""}</p>
    <p><a class="button" href="suites/${escapeHtml(suite.key)}/">View suite</a></p>
    <p class="as-of">Updated ${formatTime(generatedAt)}</p>
  </section>`
}

const homePage = (catalogue: CrewCatalogue, runs: readonly PublicRunRecord[], suites: readonly PublicSuiteRecord[], now: Date): string => {
  const ordered = [...runs].sort((one, two) => newestFirst(one, two) || two.attempt - one.attempt)
  const latestRun = ordered.find((run) => run.identity !== null) ?? ordered[0] ?? null
  const recent = ordered.slice(0, 20)
  const seenGames = new Set<string>()
  const recentGames = ordered.filter((run) => {
    const key = gameKey(run)
    if (key === null || seenGames.has(key)) return false
    seenGames.add(key)
    return true
  }).slice(0, 8)
  return page("Home", "", `${latestSuiteHeadline(selectLatestSuite(suites), latestRun, runs, now)}
  <section><div class="section-heading"><div><p class="eyebrow">Meet the crew</p><h2>${catalogue.identities.length} test identities</h2></div><p>Each identity has a stable role, portrait, and set of scenarios.</p></div><div class="identity-grid">${catalogue.identities.map((identity) => identityCard(identity, runs)).join("")}</div></section>
  <section><div class="section-heading"><div><p class="eyebrow">Videos</p><h2>Recent games</h2></div></div>${recentGames.length ? `<ol class="run-list">${recentGames.map((run) => `<li class="run-row"><a href="runs/${escapeHtml(run.key)}/"><strong>Game ${run.game ?? run.runId}</strong><span>${playerVideoCount(gameRuns(run, runs).filter(hasAvailableRecording).length)} · ${escapeHtml(run.executionKey)}</span></a><span>${formatTime(run.finishedAt)}</span></li>`).join("")}</ol>` : "<p>No game videos have been published yet.</p>"}</section>
  <section><div class="section-heading"><div><p class="eyebrow">Runs</p><h2>Recent runs</h2></div></div>${recent.length ? `<ol class="run-list">${recent.map((run) => runSummary(run, "")).join("")}</ol>` : "<p>No runs have been published yet.</p>"}</section>`)
}

const identityPage = (identity: CrewIdentity, runs: readonly PublicRunRecord[]): string => {
  const history = identityHistory(identity, runs)
  const nightlyRuns = completedNightlyHistory(history)
  const latest = nightlyRuns[0]
  const success = nightlyRuns.find(({ productResult }) => productResult === "passed")
  const group = (classification: "nightly" | "manual" | "branch"): string => {
    const selected = history.filter((run) => run.classification === classification)
    return `<section class="history-group" id="runs-${classification}"><h3>${titleCase(classification)}</h3>${selected.length ? `<ol class="run-list">${selected.map((run) => runSummary(run, "../../")).join("")}</ol>` : `<p>No ${classification} runs yet.</p>`}</section>`
  }
  return page(identity.displayName, "../../", `<section class="identity-hero" style="--primary:${escapeHtml(identity.palette.primary)};--secondary:${escapeHtml(identity.palette.secondary)};--ink:${escapeHtml(identity.palette.ink)}">
    <img src="../../assets/portraits/current/${escapeHtml(identity.portrait)}" width="420" height="420" alt="Portrait of ${escapeHtml(identity.displayName)}">
    <div><p class="eyebrow">${escapeHtml(identity.username)}</p><h1>${escapeHtml(identity.displayName)}</h1><p class="lede">${escapeHtml(identity.tagline)}</p><p>${escapeHtml(identity.backstory)}</p><dl><dt>Speciality</dt><dd>${escapeHtml(identity.speciality)}</dd><dt>Latest nightly result</dt><dd>${latest ? escapeHtml(latest.productResult) : "No completed nightly runs yet"}</dd><dt>Last nightly success</dt><dd>${success ? formatTime(success.finishedAt) : "No successful nightly run yet"}</dd><dt>Portrait</dt><dd>${escapeHtml(identity.portrait)}</dd></dl></div>
  </section>
  <section><div class="section-heading"><div><p class="eyebrow">Runs</p><h2>Run history</h2></div><nav class="filters" aria-label="Run filters"><a id="filter-nightly" href="#runs-nightly">Nightly</a><a id="filter-manual" href="#runs-manual">Manual</a><a id="filter-branch" href="#runs-branch">Branch</a></nav></div>${history.length ? `${group("nightly")}${group("manual")}${group("branch")}` : "<p>No runs have been published for this identity yet.</p>"}</section>`)
}

const recording = (run: PublicRunRecord): string => {
  const value = run.recording
  if (value.state === "available" && value.artifactUrl && value.expiresAt && value.visibility === "public") {
    const urls = value.artifactUrls ?? [value.artifactUrl]
    const videos = urls.map((url, index) => `<figure>${urls.length > 1 ? `<figcaption>Part ${index + 1}</figcaption>` : ""}<video data-recording-video controls preload="metadata" aria-label="Receiver recording${urls.length > 1 ? ` part ${index + 1}` : ""} for ${escapeHtml(run.identity?.displayName ?? "this run")}"><source src="${escapeHtml(url)}" type="video/mp4"></video><a data-recording-link href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open ${urls.length > 1 ? `part ${index + 1}` : "video"} directly</a></figure>`).join("")
    return `<div class="recording-card" role="status" aria-live="polite" data-recording-expires-at="${escapeHtml(value.expiresAt)}"><p data-recording-label>Video available</p>${videos}<p>Expires ${formatTime(value.expiresAt)}</p></div>`
  }
  if (value.state === "available" && value.artifactUrl && value.expiresAt) return `<div class="recording-card" role="status" aria-live="polite" data-recording-expires-at="${escapeHtml(value.expiresAt)}"><p data-recording-label>Video available</p><a class="button" data-recording-link href="${escapeHtml(value.artifactUrl)}" target="_blank" rel="noopener noreferrer">Watch receiver recording</a><p>Organization members only · Expires ${formatTime(value.expiresAt)}</p></div>`
  if (value.state === "expired") return `<div class="recording-card recording-expired" role="status" aria-live="polite"><p data-recording-label>Video expired</p><p>The public run record remains available.</p></div>`
  return `<div class="recording-card recording-missing" role="status" aria-live="polite"><p data-recording-label>Recording unavailable</p><p>No receiver video was recorded.</p></div>`
}

const diagnosticLogUrl = (run: PublicRunRecord): string => run.source.jobId === null
  ? `https://github.com/${run.repository}/actions/runs/${run.runId}/attempts/${run.attempt}`
  : `https://github.com/${run.repository}/actions/runs/${run.runId}/job/${run.source.jobId}`

const criteriaTable = (run: PublicRunRecord, catalogue: CrewCatalogue): string => {
  const currentCriteria = catalogue.scenarios.find(({ profile }) => profile === run.scenario?.profile)?.criteria
  const criteria = run.scenario?.criteria ?? currentCriteria ?? run.expected
  const diagnostics = run.diagnostics ?? criteria.map((criterion) => ({
    criterion,
    status: run.productResult === "passed" ? "met" as const : "not-met" as const,
    detail: run.productResult === "passed"
      ? "This historical run passed before criterion-level diagnostic details were published."
      : "This historical record did not publish criterion-level diagnostic details.",
  }))
  if (diagnostics.length === 0) return "<p>No acceptance criteria were published for this run.</p>"
  const logUrl = diagnosticLogUrl(run)
  const label = { met: "Met", "not-met": "Not met", pending: "Pending" } as const
  return `<div class="criteria-table-wrap"><table class="criteria-table"><thead><tr><th scope="col">Criterion</th><th scope="col">Result</th><th scope="col">Diagnostic</th><th scope="col">Evidence</th></tr></thead><tbody>${diagnostics.map((diagnostic) => `<tr class="criterion-${diagnostic.status}"><td data-label="Criterion">${escapeHtml(scenarioCopy(diagnostic.criterion))}</td><td data-label="Result"><span class="criterion-status criterion-status-${diagnostic.status}">${label[diagnostic.status]}</span></td><td data-label="Diagnostic">${escapeHtml(diagnostic.detail)}</td><td data-label="Evidence"><a href="${escapeHtml(logUrl)}" target="_blank" rel="noopener noreferrer">Open job log</a><span class="private-label">Organization members only</span></td></tr>`).join("")}</tbody></table></div>`
}

/** What this bot's injected fault was meant to do, next to what the app measured. The
 *  question this answers is "is this persona's fault real?", which a person should be
 *  able to settle on the page without watching the video. Absent for records written
 *  before the shaping report existed, and for personas it cannot judge. */
const shapingSection = (run: PublicRunRecord): string => {
  const shaping = run.shaping
  if (!shaping) return ""
  const note = shaping.note ? `<p class="muted">${escapeHtml(shaping.note)}</p>` : ""
  return `<section><h2>Injected fault and what was measured</h2><dl><dt>Intended</dt><dd>${escapeHtml(shaping.intended)}</dd><dt>Measured</dt><dd>${escapeHtml(shaping.measured)}</dd><dt>Verdict</dt><dd><strong>${escapeHtml(shaping.verdict)}</strong></dd></dl>${note}</section>`
}

const runPage = (run: PublicRunRecord, runs: readonly PublicRunRecord[], catalogue: CrewCatalogue): string => {
  const identity = run.identity
  const scenario = run.scenario
  const timeline = run.timeline.length ? `<ol class="timeline">${run.timeline.map((event) => `<li class="timeline-${escapeHtml(event.state)}"><time datetime="${escapeHtml(event.at)}">${formatTime(event.at)}</time><strong>${escapeHtml(event.state)}</strong><p>${escapeHtml(scenarioCopy(event.text))}</p>${event.detail ? `<p class="muted">${escapeHtml(scenarioCopy(event.detail))}</p>` : ""}</li>`).join("")}</ol>` : "<p>No timeline was recorded.</p>"
  const recovery = run.recovery.length ? `<ul>${run.recovery.map((item) => `<li>${escapeHtml(item.name)}: ${(item.milliseconds / 1_000).toFixed(2)} seconds</li>`).join("")}</ul>` : "<p>No named recovery measurement was recorded.</p>"
  const failures = run.failures.length ? `<ul class="failures">${run.failures.map((failure) => `<li>${escapeHtml(failure)}</li>`).join("")}</ul>` : "<p>No failures recorded.</p>"
  return page(`${identity?.displayName ?? "Harness"} run`, "../../", `<section class="run-hero"><p class="eyebrow">${escapeHtml(run.classification)} · run ${run.runId} · attempt ${run.attempt}</p><h1>${escapeHtml(identity?.displayName ?? "Harness check")}</h1><p class="lede">${escapeHtml(scenarioCopy(scenario?.title ?? "Harness evidence"))}</p><div class="status-line">${resultPill("Product", run.productResult)} ${resultPill("Infrastructure", run.infrastructure)}</div><p>${formatTime(run.startedAt)} – ${formatTime(run.finishedAt)} · Game ${run.game ?? "not observed"}</p></section>
  <div class="detail-grid"><section><h2>Identity snapshot</h2>${identity ? `<img class="snapshot" src="../../${escapeHtml(identity.portraitPath)}" width="240" height="240" alt="Historical portrait of ${escapeHtml(identity.displayName)}"><dl><dt>Username</dt><dd>${escapeHtml(identity.username)}</dd><dt>Tagline</dt><dd>${escapeHtml(identity.tagline)}</dd><dt>Speciality</dt><dd>${escapeHtml(identity.speciality)}</dd><dt>Portrait file</dt><dd>${escapeHtml(identity.portraitFile)}</dd></dl>` : "<p>Harness-only record.</p>"}</section><section><h2>Scenario snapshot</h2>${scenario ? `<h3>${escapeHtml(scenarioCopy(scenario.title))}</h3><p>${escapeHtml(scenarioCopy(scenario.purpose))}</p>` : "<p>Harness-only record.</p>"}</section></div>
  ${scenario ? `<section><h2>Acceptance criteria</h2><p>Each row shows whether this run produced the required evidence.</p>${criteriaTable(run, catalogue)}</section>` : ""}
  <section><h2>Receiver recording</h2>${recording(run)}<p class="muted">The bot-only video expires after 14 days; this result record remains.</p></section>
  ${shapingSection(run)}
  ${run.bot === null ? "" : gamePovs(run, runs)}
  <section><h2>Observed timeline</h2>${timeline}</section>
  <div class="detail-grid"><section><h2>Recovery measurements</h2>${recovery}</section><section><h2>Failures</h2>${failures}</section></div>
  <section><h2>Links</h2>${links(run.links)}</section>`)
}

const suitePage = (suite: PublicSuiteRecord, runs: readonly PublicRunRecord[]): string => {
  const children = suite.observedRunKeys.map((key) => runs.find((run) => run.key === key)!)
  const povs = children.map((run) => `<article class="pov-card"><h3>${escapeHtml(run.identity?.displayName ?? `Bot ${run.bot ?? "?"}`)}</h3><p>${escapeHtml(scenarioCopy(run.scenario?.title ?? "Test run"))}</p>${recording(run)}<p><a href="../../runs/${escapeHtml(run.key)}/">View run details</a></p></article>`).join("")
  return page(`Suite ${suite.suiteId}`, "../../", `<section class="run-hero"><p class="eyebrow">${escapeHtml(suite.classification)} suite · run ${suite.runId}</p><h1>${suite.state === "started" ? "In progress" : titleCase(suite.result)}</h1><div class="status-line">${resultPill("Product", suite.productResult)} ${resultPill("Infrastructure", suite.infrastructure)}</div><p>Started ${formatTime(suite.startedAt)}${suite.finishedAt ? ` · Finished ${formatTime(suite.finishedAt)}` : ""}</p></section>
  <section><h2>Coverage</h2>${suiteMetrics(suite)}${suite.coverage.missing.length ? `<h3>Missing identities</h3><ul>${suite.coverage.missing.map((identity) => `<li>${escapeHtml(identity)}</li>`).join("")}</ul>` : "<p>All planned identities ran.</p>"}</section>
  <section><h2>Player videos</h2><p>Choose a player to watch their recording.</p>${povs ? `<div class="pov-grid">${povs}</div>` : "<p>No player videos were published.</p>"}</section>
  <section><h2>Run groups</h2>${suite.plannedWaves.length ? `<ol class="wave-list">${suite.plannedWaves.map((wave) => `<li><h3>${escapeHtml(wave.key)}</h3><p>${wave.isolated ? "Runs alone" : "May share a game"}</p><p><strong>Scenarios:</strong> ${wave.profiles.map(escapeHtml).join(", ") || "Unavailable"}</p><p><strong>Identities:</strong> ${wave.identities.map(escapeHtml).join(", ") || "Unavailable"}</p></li>`).join("")}</ol>` : "<p>The run plan is unavailable.</p>"}</section>
  <section><h2>Runs</h2>${children.length ? `<ol class="run-list">${children.map((run) => runSummary(run, "../../")).join("")}</ol>` : "<p>No runs were published.</p>"}</section>
  <section><h2>Infrastructure failures</h2>${suite.failures.length ? `<ul class="failures">${suite.failures.map((failure) => `<li>${escapeHtml(failure)}</li>`).join("")}</ul>` : "<p>No infrastructure failures recorded.</p>"}</section>
  <section><h2>Links</h2>${links(suite.links)}</section>`)
}

const write = (root: string, path: string, contents: string | Uint8Array, written: Set<string>): void => {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  if (written.has(path)) {
    const existing = readFileSync(target)
    const incoming = typeof contents === "string" ? Buffer.from(contents) : Buffer.from(contents)
    if (!existing.equals(incoming)) throw new Error(`${path}: two different files claimed the same generated path`)
    return
  }
  writeFileSync(target, contents)
  written.add(path)
}

const portraitPath = (base: URL | string, filename: string): string | URL => typeof base === "string" ? join(base, filename) : new URL(filename, base)

export const portraitBytesFor = (options: PortraitBytesOptions, run: PublicRunRecord): Uint8Array => {
  const identity = run.identity
  if (!identity) throw new Error(`${run.key}: crew run has no identity snapshot`)
  const candidates: Array<string | URL> = [join(options.stateDir, identity.portraitPath)]
  if (options.portraitSourceDir) {
    candidates.push(join(options.portraitSourceDir, identity.portraitPath))
    candidates.push(join(options.portraitSourceDir, identity.portraitFile))
  }
  candidates.push(portraitPath(options.portraitDir, identity.portraitFile))
  const source = candidates.find((candidate) => existsSync(candidate))
  if (!source) throw new Error(`${run.key}: portrait source ${identity.portraitFile} is missing`)
  const bytes = readFileSync(source)
  if (digest(bytes) !== identity.portraitSha256) throw new Error(`${run.key}: portrait digest does not match ${identity.portraitPath}`)
  return bytes
}

const copyRetainedPortraits = (options: GenerateCrewSiteOptions, written: Set<string>): void => {
  const directory = join(options.stateDir, "assets", "portraits", "by-sha256")
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((one, two) => compareText(one.name, two.name))) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.webp$/.test(entry.name)) throw new Error(`${directory}: invalid retained portrait ${entry.name}`)
    const bytes = readFileSync(join(directory, entry.name))
    if (`${digest(bytes)}.webp` !== entry.name) throw new Error(`${entry.name}: retained portrait digest does not match its filename`)
    write(options.outputDir, `assets/portraits/by-sha256/${entry.name}`, bytes, written)
  }
}

export function generateCrewSite(options: GenerateCrewSiteOptions): string[] {
  if (!Number.isFinite(options.now.getTime())) throw new Error("site generation needs a valid clock")
  const { runs, suites } = readCrewSiteState(options.stateDir)
  const runKeys = new Set(runs.map(({ key }) => key))
  for (const suite of suites) {
    for (const key of suite.observedRunKeys) if (!runKeys.has(key)) throw new Error(`suite ${suite.key}: observed run ${key} is missing`)
  }
  const written = new Set<string>()
  mkdirSync(options.outputDir, { recursive: true })
  for (const directory of ["assets/portraits/current", "assets/portraits/by-sha256", "identities", "runs", "suites", "data/runs", "data/suites"]) {
    mkdirSync(join(options.outputDir, directory), { recursive: true })
  }
  for (const identity of options.catalogue.identities) safeSegment("catalogue identity key", identity.key)

  write(options.outputDir, "index.html", homePage(options.catalogue, runs, suites, options.now), written)
  write(options.outputDir, "assets/site.css", readFileSync(new URL("./site.css", import.meta.url)), written)
  write(options.outputDir, "assets/status.js", readFileSync(new URL("./status.js", import.meta.url)), written)
  write(options.outputDir, ".nojekyll", "", written)
  copyRetainedPortraits(options, written)

  for (const identity of options.catalogue.identities) {
    const bytes = readFileSync(portraitPath(options.portraitDir, identity.portrait))
    const sha = digest(bytes)
    write(options.outputDir, `assets/portraits/current/${identity.portrait}`, bytes, written)
    write(options.outputDir, `assets/portraits/by-sha256/${sha}.webp`, bytes, written)
    write(options.outputDir, `identities/${identity.key}/index.html`, identityPage(identity, runs), written)
  }

  const renderedRuns = runs.map((run) => ({ ...run, recording: recordingAt(run.recording, options.now) }))
  for (const run of renderedRuns) {
    if (run.identity) write(options.outputDir, run.identity.portraitPath, portraitBytesFor(options, run), written)
    write(options.outputDir, `runs/${run.key}/index.html`, runPage(run, renderedRuns, options.catalogue), written)
    write(options.outputDir, `data/runs/${run.key}.json`, `${JSON.stringify(run, null, 2)}\n`, written)
  }
  for (const suite of suites) {
    write(options.outputDir, `suites/${suite.key}/index.html`, suitePage(suite, runs), written)
    write(options.outputDir, `data/suites/${suite.key}.json`, `${JSON.stringify(suite, null, 2)}\n`, written)
  }
  write(options.outputDir, "data/catalogue-version.json", `${JSON.stringify({ version: options.catalogue.version, generatedAt: options.now.toISOString() }, null, 2)}\n`, written)
  return [...written].sort()
}

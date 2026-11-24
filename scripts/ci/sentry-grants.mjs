// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Tells Sentry what a failed grants check found: one error event per name
// whose grants are wrong or could not be read, from the results
// scripts/ci/check-grants.mjs wrote with --results.
//
// A check-in only says ok or error. These events say which name, which
// grants (expected and found, and per product the grants missing and extra),
// or the read error, and link the GitHub run. Each is tied to the cron
// monitor the way Sentry's SDKs tie a job's errors to it: the monitor context
// (contexts.monitor.slug, also the monitor.slug tag), and the run's trace id,
// which is the check-in id sentry-checkin.mjs sends as its trace. Each event
// is fingerprinted by monitor, name and outcome, so one problem on one name
// is one Sentry issue, however many hours it lasts.
//
// A run that compared nothing (a missing variable, a crash, or a step that
// failed before the read and left no results file) sends one event for the
// run instead. So does a check that ended (OUTCOME) but wrote no results.
//
// Nothing here fails the job: an event that cannot be sent, or a results file
// that cannot be turned into events, prints a warning and exits 0, so the
// check-in after it still goes out.
//
// Usage: node scripts/ci/sentry-grants.mjs <monitor slug> <results file>
//   SENTRY_DSN, CHECK_IN_ID and SENTRY_ENVIRONMENT as for sentry-checkin.mjs;
//   OUTCOME is the check's outcome, from its step output (empty when the
//   check never ran);
//   GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT,
//   GITHUB_WORKFLOW, GITHUB_REF_NAME and GITHUB_SHA describe the run.
import { readFileSync } from "node:fs"
import { envelope, newId, sendEnvelope, traceIdFor } from "./sentry-checkin.mjs"

const MAX_MESSAGE = 400

/** The run as the events link it, or null outside GitHub Actions. */
export function githubRun(env) {
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) return null
  const run = { run_url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` }
  if (env.GITHUB_RUN_ATTEMPT) run.attempt = env.GITHUB_RUN_ATTEMPT
  if (env.GITHUB_WORKFLOW) run.workflow = env.GITHUB_WORKFLOW
  if (env.GITHUB_REF_NAME) run.ref = env.GITHUB_REF_NAME
  if (env.GITHUB_SHA) run.commit = env.GITHUB_SHA
  return run
}

const words = (grants) => grants.join(" and ")

/** One product's difference: "missing storage", "extra context", or both. */
export function productLine({ missing, extra }) {
  return [missing.length > 0 && `missing ${words(missing)}`, extra.length > 0 && `extra ${words(extra)}`].filter(Boolean).join(", ")
}

/** What is wrong, in one line: per product, else the check's own detail. */
export function wrongSummary(result) {
  if (result.found === null || !result.products) return result.detail
  const parts = result.products.map((p) => `${p.label} ${productLine(p)}`)
  const floor = result.floor
  if (floor && !floor.lacking.every((g) => result.products.some((p) => p.label === floor.label && p.missing.includes(g)))) {
    parts.push(`${floor.label} lacks ${words(floor.lacking)}, which Jollity needs`)
  }
  return parts.length > 0 ? parts.join("; ") : result.detail
}

const clip = (text) => (text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text)

/** The Sentry error event for one name's result, or for a run that checked nothing (name null). */
export function grantEvent({ result, slug, environment = "production", traceId, run, now = Date.now(), eventId = newId(), spanId = newId().slice(16) }) {
  const { name, outcome } = result
  const grants = { outcome }
  let title
  const contexts = {}
  if (name === null) {
    title = `Could not check the grants: ${result.detail}`
    grants.error = result.detail
  } else if (outcome === "wrong") {
    title = `Grants wrong on ${name}: ${wrongSummary(result)}`
    Object.assign(grants, { name, problem: result.detail })
    grants.expected = JSON.stringify(result.expected)
    grants.found = result.found === null ? "none" : JSON.stringify(result.found)
    if (result.products?.length) contexts["grants by product"] = Object.fromEntries(result.products.map((p) => [p.label, productLine(p)]))
  } else {
    title = `Could not check the grants of ${name}: the manifest could not be read`
    Object.assign(grants, { name, read_error: result.detail })
  }
  const tags = { "monitor.slug": slug, "grants.outcome": outcome }
  if (name !== null) tags["grants.name"] = name
  return {
    event_id: eventId,
    timestamp: now / 1000,
    platform: "node",
    level: "error",
    logger: slug,
    environment,
    message: { formatted: clip(title) },
    fingerprint: [slug, name ?? "(run)", outcome],
    tags,
    contexts: {
      monitor: { slug },
      trace: { trace_id: traceId, span_id: spanId, op: slug },
      grants,
      ...contexts,
      ...(run ? { "github run": run } : {}),
    },
  }
}

/** What a run with no results file tells, by the outcome the check gave, if any. */
export function noResultsDetail(outcome) {
  if (outcome === "wrong") return "the check found wrong grants but wrote no results, so which names is unknown. See the run."
  if (outcome === "unchecked") return "the check could not read every name but wrote no results, so which names is unknown. See the run."
  if (outcome) return `the check ended ${outcome} but wrote no results. See the run.`
  return "the check stopped before it read the names. See the failed step."
}

/** The events for a results file's content, or for a missing one (null), given the check's outcome. */
export function grantEvents(file, { slug, environment, traceId, run, now, outcome }) {
  const base = { slug, environment, traceId, run, now }
  if (file === null) {
    return [grantEvent({ ...base, result: { name: null, outcome: outcome || "unchecked", detail: noResultsDetail(outcome) } })]
  }
  if (file.error) return [grantEvent({ ...base, result: { name: null, outcome: "unchecked", detail: file.error } })]
  return (file.results ?? []).filter((r) => r.outcome === "wrong" || r.outcome === "unchecked").map((result) => grantEvent({ ...base, result }))
}

function readResults(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

async function main() {
  try {
    await sendEvents()
  } catch (error) {
    stopped(error)
  }
}

async function sendEvents() {
  const [slug, path] = process.argv.slice(2)
  const env = process.env
  if (!env.SENTRY_DSN) {
    console.log(`::warning title=No Sentry event::SENTRY_DSN is empty, so ${slug} sent no detail of the grants.`)
    return
  }
  const events = grantEvents(readResults(path), {
    slug,
    environment: env.SENTRY_ENVIRONMENT || undefined,
    traceId: traceIdFor(env.CHECK_IN_ID),
    run: githubRun(env),
    outcome: env.OUTCOME,
  })
  for (const event of events) {
    const what = `${event.tags["grants.name"] ?? "the run"} (${event.tags["grants.outcome"]})`
    try {
      const answer = await sendEnvelope(env.SENTRY_DSN, envelope({ event_id: event.event_id, sent_at: new Date().toISOString() }, [{ type: "event", payload: event }]))
      console.log(`Sentry event sent for ${what} (${answer}), event ${event.event_id}.`)
    } catch (error) {
      console.log(`::warning title=Sentry event not sent::${slug} ${what}: ${error.message}`)
    }
  }
}

/** Anything that stops the events must not stop the check-in after them: a warning, and exit 0. */
function stopped(error) {
  const message = String(error?.message ?? error).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")
  console.log(`::warning title=Sentry events not sent::${process.argv[2]} sent no detail of the grants: ${message}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(stopped)

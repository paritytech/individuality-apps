// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Sends one Sentry cron check-in with nothing but a DSN.
//
// The check-in goes to the DSN's envelope endpoint, as Sentry's SDKs send it:
//   POST https://<ingest host>/api/<project id>/envelope/
// as one check_in item. Sentry creates or updates the monitor from the
// monitor_config sent with the in_progress check-in, so the schedule and its
// margins live here, in the repository. A job sends in_progress when it
// starts, then ok or error with the same check-in id. Sentry raises an issue
// on error, on a check-in that never comes (missed), or on a job that runs
// past max_runtime. Alerting on that issue is a Sentry alert rule, which a
// DSN cannot create.
//
// A check-in holds no free text, so it cannot carry the run's URL. What it
// can carry is a trace id (contexts.trace.trace_id), and every check-in of a
// run carries the same one: the check-in id. The error events
// scripts/ci/sentry-grants.mjs sends for that run carry it too, with the run's
// URL, so Sentry links the run's check-in to the issues it raised.
//
// A check-in that cannot be sent never fails the job: it prints a warning,
// and the job's own result still stands.
//
// Usage: node scripts/ci/sentry-checkin.mjs <monitor slug> <in_progress|ok|error>
//   SENTRY_DSN       the project's DSN; with none, the check-in is skipped
//   CHECK_IN_ID      the same id for the start and the end of one run, 32 hex
//                    digits; it is the run's trace id too
//   CHECK_IN_STARTED the start, in epoch seconds, for the duration
//   SENTRY_ENVIRONMENT  the monitor environment (default production)
//   MONITOR_CONFIG   JSON sent with in_progress (see MONITOR_CONFIG in the workflow)
import { randomUUID } from "node:crypto"

export const STATUSES = ["in_progress", "ok", "error"]

const HEX32 = /^[0-9a-f]{32}$/

/** A fresh 32-hex-digit id, the form Sentry takes for event, check-in and trace ids. */
export const newId = () => randomUUID().replaceAll("-", "")

/** The run's trace id: its check-in id when that has the form of one, else a fresh one. */
export const traceIdFor = (checkInId) => (checkInId && HEX32.test(checkInId.toLowerCase()) ? checkInId.toLowerCase() : newId())

/** The envelope URL and public key for a DSN, or null when the value is not a DSN. Never logged: it holds the key. */
export function envelopeTarget(dsn) {
  let url
  try {
    url = new URL(dsn)
  } catch {
    return null
  }
  const key = url.username
  const parts = url.pathname.split("/").filter(Boolean)
  const project = parts.pop()
  if (!key || !project || !/^\d+$/.test(project)) return null
  const prefix = parts.length ? `/${parts.join("/")}` : ""
  return { url: `${url.protocol}//${url.host}${prefix}/api/${project}/envelope/`, key }
}

/** An envelope: its header, then each item's header and payload, one JSON line each. */
export function envelope(header, items) {
  return [header, ...items.flatMap(({ type, payload }) => [{ type }, payload])].map((line) => JSON.stringify(line)).join("\n") + "\n"
}

/** The check_in item for one check-in. */
export function checkInItem({ slug, status, checkInId, environment = "production", durationSeconds, monitorConfig, traceId }) {
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`)
  const payload = { check_in_id: checkInId || newId(), monitor_slug: slug, status, environment }
  if (durationSeconds !== undefined && status !== "in_progress") payload.duration = durationSeconds
  if (status === "in_progress" && monitorConfig) payload.monitor_config = monitorConfig
  if (traceId) payload.contexts = { trace: { trace_id: traceId } }
  return { type: "check_in", payload }
}

/** Posts one envelope to the DSN's project. Throws when it is not taken. */
export async function sendEnvelope(dsn, body) {
  const target = envelopeTarget(dsn)
  if (target === null) throw new Error("SENTRY_DSN is not a DSN")
  const response = await fetch(target.url, {
    method: "POST",
    headers: {
      "content-type": "application/x-sentry-envelope",
      "x-sentry-auth": `Sentry sentry_version=7, sentry_client=individuality-ci/1.0, sentry_key=${target.key}`,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Sentry answered ${response.status}`)
  return response.status
}

async function main() {
  const [slug, status] = process.argv.slice(2)
  const env = process.env
  if (!env.SENTRY_DSN) {
    console.log(`::warning title=No Sentry check-in::SENTRY_DSN is empty, so ${slug} was not told ${status}.`)
    return
  }
  try {
    const started = Number(env.CHECK_IN_STARTED)
    const checkInId = env.CHECK_IN_ID || newId()
    const item = checkInItem({
      slug,
      status,
      checkInId,
      environment: env.SENTRY_ENVIRONMENT || undefined,
      durationSeconds: started > 0 ? Math.max(0, Math.round(Date.now() / 1000 - started)) : undefined,
      monitorConfig: env.MONITOR_CONFIG ? JSON.parse(env.MONITOR_CONFIG) : undefined,
      traceId: traceIdFor(checkInId),
    })
    const answer = await sendEnvelope(env.SENTRY_DSN, envelope({ sent_at: new Date().toISOString() }, [item]))
    console.log(`Sentry check-in ${status} sent for ${slug} (${answer}), trace ${item.payload.contexts.trace.trace_id}.`)
  } catch (error) {
    console.log(`::warning title=Sentry check-in not sent::${slug} ${status}: ${error.message}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()

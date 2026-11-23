// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Sends one Sentry cron check-in with nothing but a DSN.
//
// Sentry's cron check-in endpoint takes the DSN's public key in the URL:
//   POST https://<ingest host>/api/<project id>/cron/<monitor slug>/<public key>/
// and creates or updates the monitor from the monitor_config sent with the
// in_progress check-in, so the schedule and its margins live here, in the
// repository. A job sends in_progress when it starts, then ok or error with
// the same check-in id. Sentry raises an issue on error, on a check-in that
// never comes (missed), or on a job that runs past max_runtime. Alerting on
// that issue is a Sentry alert rule, which a DSN cannot create.
//
// A check-in that cannot be sent never fails the job: it prints a warning,
// and the job's own result still stands.
//
// Usage: node scripts/ci/sentry-checkin.mjs <monitor slug> <in_progress|ok|error>
//   SENTRY_DSN       the project's DSN; with none, the check-in is skipped
//   CHECK_IN_ID      the same id for the start and the end of one run
//   CHECK_IN_STARTED the start, in epoch seconds, for the duration
//   SENTRY_ENVIRONMENT  the monitor environment (default production)
//   MONITOR_CONFIG   JSON sent with in_progress (see MONITOR_CONFIG in the workflow)

export const STATUSES = ["in_progress", "ok", "error"]

/** The check-in URL for a DSN, or null when the value is not a DSN. Never logged: it holds the key. */
export function cronUrl(dsn, slug) {
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
  return `${url.protocol}//${url.host}${prefix}/api/${project}/cron/${encodeURIComponent(slug)}/${key}/`
}

/** The request for one check-in. */
export function checkInRequest({ dsn, slug, status, checkInId, environment = "production", durationSeconds, monitorConfig }) {
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`)
  const base = cronUrl(dsn, slug)
  if (base === null) throw new Error("SENTRY_DSN is not a DSN")
  const fields = { status, environment }
  if (checkInId) fields.check_in_id = checkInId
  if (durationSeconds !== undefined && status !== "in_progress") fields.duration = durationSeconds
  const body = { ...fields }
  if (status === "in_progress" && monitorConfig) body.monitor_config = monitorConfig
  return { url: `${base}?${new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)]))}`, body }
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
    const request = checkInRequest({
      dsn: env.SENTRY_DSN,
      slug,
      status,
      checkInId: env.CHECK_IN_ID,
      environment: env.SENTRY_ENVIRONMENT || undefined,
      durationSeconds: started > 0 ? Math.max(0, Math.round(Date.now() / 1000 - started)) : undefined,
      monitorConfig: env.MONITOR_CONFIG ? JSON.parse(env.MONITOR_CONFIG) : undefined,
    })
    const response = await fetch(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Sentry answered ${response.status}`)
    console.log(`Sentry check-in ${status} sent for ${slug} (${response.status}).`)
  } catch (error) {
    console.log(`::warning title=Sentry check-in not sent::${slug} ${status}: ${error.message}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()

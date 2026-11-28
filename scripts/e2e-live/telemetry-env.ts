// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The Sentry half of a bot's environment, as a pure decision (vitest pins it).
//
// The bots run `next dev` on localhost, so lib/telemetry/environment.ts files
// their events under environment `local`, never under dim2.paseo. boot.mts
// forwards the DSNs to every slot's `next dev` when one is set, together with
// NEXT_PUBLIC_SENTRY_TAG, which lib/telemetry/init.ts turns into the event tag
// `test.tag`. No DSN means no telemetry (lib/telemetry/boot.ts is a no-op), and
// nothing is added.
//
// TEST TRAFFIC HAS ITS OWN PROJECT. With NEXT_PUBLIC_SENTRY_DSN_TEST set, a
// localhost page (every bot, even one serving a deployed bundle) writes to the
// test project (pickDsn in lib/telemetry/environment.ts), else to production.
//
// The Sentry org and the two projects' numeric ids are configuration, never
// code: DIM2_SENTRY_ORG and DIM2_SENTRY_PROJECT_IDS ({"production": "<id>",
// "test": "<id>"}, repository variables in the workflow). Without them the
// summary names the project and leaves the link out.

/** The tag a bot's events carry unless the caller picks another. */
export const BOT_TAG = "e2e-bot"

export interface BotTelemetry {
  /** NEXT_PUBLIC_SENTRY_* to add to a slot's env: empty when telemetry is off. */
  env: Record<string, string>
  /** one line for the boot log; never contains a DSN */
  describe: string
}

export type SentryProject = "production" | "test"

/** The org and the numeric project ids from the environment; anything malformed reads as unset. */
export function sentryConfig(source: Record<string, string | undefined>): { org: string; ids: Partial<Record<SentryProject, string>> } {
  const org = source.DIM2_SENTRY_ORG?.trim() ?? ""
  let ids: Partial<Record<SentryProject, string>> = {}
  try {
    const parsed: unknown = JSON.parse(source.DIM2_SENTRY_PROJECT_IDS?.trim() || "{}")
    if (parsed && typeof parsed === "object") {
      for (const key of ["production", "test"] as const) {
        const value = (parsed as Record<string, unknown>)[key]
        if (typeof value === "string" && /^[0-9]+$/.test(value)) ids = { ...ids, [key]: value }
      }
    }
  } catch {
    ids = {}
  }
  return { org: /^[a-z0-9-]+$/.test(org) ? org : "", ids }
}

/** The project a bot's events land in: the test project whenever a test DSN is set. */
export function botProject(source: Record<string, string | undefined>): SentryProject {
  return source.NEXT_PUBLIC_SENTRY_DSN_TEST?.trim() ? "test" : "production"
}

export function botTelemetry(source: Record<string, string | undefined>): BotTelemetry {
  const dsn = source.NEXT_PUBLIC_SENTRY_DSN?.trim() ?? ""
  const testDsn = source.NEXT_PUBLIC_SENTRY_DSN_TEST?.trim() ?? ""
  if (!dsn && !testDsn) return { env: {}, describe: "telemetry off (no NEXT_PUBLIC_SENTRY_DSN)" }
  const tag = source.NEXT_PUBLIC_SENTRY_TAG?.trim() || BOT_TAG
  return {
    env: {
      ...(dsn ? { NEXT_PUBLIC_SENTRY_DSN: dsn } : {}),
      ...(testDsn ? { NEXT_PUBLIC_SENTRY_DSN_TEST: testDsn } : {}),
      NEXT_PUBLIC_SENTRY_TAG: tag,
    },
    describe: `telemetry on, tag test.tag=${tag}, project ${botProject(source)} (events land under environment local)`,
  }
}

/** The summary.md line for one game: a Sentry issues search on the game's
 *  events from the bots. `tag` is what the run was started with. */
export function sentrySummaryLine(env: Record<string, string | undefined>, gameIndex: number): string {
  const t = botTelemetry(env)
  if (!t.env.NEXT_PUBLIC_SENTRY_TAG) return "- Sentry: telemetry off for this run (no DSN)"
  const tag = t.env.NEXT_PUBLIC_SENTRY_TAG
  const project = botProject(env)
  const query = encodeURIComponent(`game.index:${gameIndex} test.tag:${tag}`)
  const { org, ids } = sentryConfig(env)
  const id = ids[project]
  const where = org && id
    ? `[game ${gameIndex} events from the bots](https://${org}.sentry.io/issues/?project=${id}&query=${query}&statsPeriod=7d) (org ${org}, `
    : `game ${gameIndex} events from the bots (`
  return (
    `- Sentry: ${where}${project} project, tag test.tag:${tag}, environment local). ` +
    `Bot frame and smoothness metrics come from a CI runner with software rendering: exclude test.tag:${tag} from every real-device dashboard.`
  )
}

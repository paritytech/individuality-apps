// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { BrowserContext, Page } from "@playwright/test"
import type { ScenarioPresentation } from "./crew/catalogue"

export const NARRATION_STATES = ["preparing", "active", "recovered", "not-applied", "verifying", "passed", "failed"] as const
export const NARRATION_SOURCES = ["journey", "network", "role", "outcome"] as const

export type NarrationState = typeof NARRATION_STATES[number]
export type NarrationSource = typeof NARRATION_SOURCES[number]

export interface NarrationTransition {
  at: string
  state: NarrationState
  source: NarrationSource
  action: string | null
  title: string
  text: string
  detail?: string
}

export interface NarrationSink {
  transition(event: Omit<NarrationTransition, "at">): Promise<NarrationTransition>
  transitionRequired(event: Omit<NarrationTransition, "at">): Promise<NarrationTransition>
  attach(page: Page): Promise<void>
  snapshot(): readonly NarrationTransition[]
}

/** A runner-to-page delivery fault is harness evidence, not a persona event.
 * Keep it in the result for diagnosis, but never present it as what the
 * character is doing in a public timeline or derived MP4. */
export const isNarrationTransportFailure = (transition: Pick<NarrationTransition, "source" | "action" | "title">): boolean =>
  transition.source === "outcome" &&
  transition.title === "Recording overlay unavailable" &&
  /^render\.[1-9][0-9]*$/.test(transition.action ?? "")

export interface RequiredNarrationFailure {
  narrator: number
  error: unknown
}

export async function afterRequiredNarration(
  narrators: readonly Pick<NarrationSink, "transitionRequired">[],
  event: Omit<NarrationTransition, "at">,
  afterDelivery: (failures: readonly RequiredNarrationFailure[]) => void | Promise<void>,
): Promise<RequiredNarrationFailure[]> {
  const deliveries = await Promise.allSettled(narrators.map((narrator) => narrator.transitionRequired(event)))
  const failures = deliveries.flatMap((delivery, narrator) => delivery.status === "rejected" ? [{ narrator, error: delivery.reason }] : [])
  await afterDelivery(failures)
  return failures
}

export function scenarioNarration(
  scenario: ScenarioPresentation,
  state: NarrationState,
  source: NarrationTransition["source"],
  action: string | null = null,
  detail?: string,
): Omit<NarrationTransition, "at"> {
  const presentation = action ? scenario.actions[action] : undefined
  const text = state === "preparing"
    ? scenario.phases.preparing
    : state === "active"
      ? (presentation?.active ?? scenario.purpose)
      : state === "recovered"
        ? (presentation?.recovered ?? scenario.phases.verifying)
        : state === "not-applied"
          ? "This network challenge was not applied on this run."
        : state === "verifying"
          ? scenario.phases.verifying
          : state === "passed"
            ? scenario.phases.passed
            : (presentation?.failed ?? scenario.phases.failed)
  return {
    state,
    source,
    action,
    title: scenario.title,
    text,
    ...(detail ? { detail } : {}),
  }
}

export const NARRATION_HOST_ID = "__jollity-e2e-narration"
export const NARRATION_PAGE_UPDATE_TIMEOUT_MS = 2_000
export const REQUIRED_NARRATION_PAGE_UPDATE_TIMEOUT_MS = 5_000

interface HudPayload {
  attribution: string
  revision: number
  transition: NarrationTransition | null
}

interface HudRuntime {
  host: HTMLElement
  attribution: HTMLElement
  title: HTMLElement
  text: HTMLElement
  detail: HTMLElement
}

/** Browser-owned renderer. Keep this function self-contained: Playwright
 * serializes it into the page for both addInitScript and evaluate. */
function renderNarrationHud(payload: HudPayload): void {
  const state = globalThis as typeof globalThis & {
    __jollityNarrationHudV1?: HudRuntime
    __jollityNarrationPayloadV1?: HudPayload
    __jollityNarrationRevisionV1?: number
    __jollityNarrationWaitingV1?: boolean
  }
  if (payload.revision === 0 && payload.transition === null) {
    try {
      const retained = globalThis.sessionStorage?.getItem("__jollity-e2e-narration-payload-v1")
      if (retained) {
        const candidate = JSON.parse(retained) as HudPayload
        if (typeof candidate?.revision === "number" && candidate.revision > payload.revision) payload = candidate
      }
    } catch {
      // Some transient documents have no storage access; explicit first-page
      // and post-relaunch attachment still render the runner's current state.
    }
  }
  const renderedRevision = state.__jollityNarrationRevisionV1 ?? -1
  if (payload.revision < renderedRevision) return
  state.__jollityNarrationRevisionV1 = payload.revision
  state.__jollityNarrationPayloadV1 = payload
  if (payload.revision > 0) {
    try {
      globalThis.sessionStorage?.setItem("__jollity-e2e-narration-payload-v1", JSON.stringify(payload))
    } catch {
      // Rendering remains useful when storage is unavailable.
    }
  }
  const mount = () => {
    state.__jollityNarrationWaitingV1 = false
    if (!document.body) return
    const current = state.__jollityNarrationPayloadV1 ?? payload
    let runtime = state.__jollityNarrationHudV1
    if (!runtime || !document.getElementById("__jollity-e2e-narration")) {
      const host = document.createElement("div")
      host.id = "__jollity-e2e-narration"
      host.setAttribute("aria-hidden", "true")
      host.setAttribute("data-e2e-harness", "narration")
      const root = host.attachShadow({ mode: "closed" })
      const style = document.createElement("style")
      style.textContent = `
      :host {
        all: initial;
        position: fixed;
        inset: 12px auto auto 12px;
        z-index: 2147483647;
        pointer-events: none;
        max-width: min(72vw, 440px);
        color: white;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        text-rendering: geometricPrecision;
      }
      .plate {
        display: block;
        padding: 9px 12px 10px;
        border: 1px solid rgba(255, 255, 255, 0.62);
        border-radius: 10px;
        background: rgba(6, 12, 25, 0.88);
        box-shadow: 0 5px 18px rgba(0, 0, 0, 0.38);
      }
      .attribution { color: #8ee8ff; font-size: 13px; font-weight: 800; letter-spacing: 0.03em; }
      .title { margin-top: 2px; font-size: 18px; font-weight: 800; line-height: 1.12; }
      .text { margin-top: 4px; font-size: 14px; font-weight: 650; line-height: 1.25; }
      .detail { margin-top: 3px; color: #d9e4f7; font-size: 12px; line-height: 1.2; }
      .detail:empty { display: none; }
    `
      const plate = document.createElement("div")
      plate.setAttribute("class", "plate")
      const attribution = document.createElement("div")
      attribution.setAttribute("class", "attribution")
      const title = document.createElement("div")
      title.setAttribute("class", "title")
      const text = document.createElement("div")
      text.setAttribute("class", "text")
      const detail = document.createElement("div")
      detail.setAttribute("class", "detail")
      plate.append(attribution, title, text, detail)
      root.append(style, plate)
      document.body.append(host)
      runtime = { host, attribution, title, text, detail }
      state.__jollityNarrationHudV1 = runtime
    }

    runtime.attribution.textContent = current.attribution
    runtime.title.textContent = current.transition?.title ?? ""
    runtime.text.textContent = current.transition?.text ?? ""
    runtime.detail.textContent = current.transition?.detail ?? ""
  }
  if (!document.body) {
    if (!state.__jollityNarrationWaitingV1) {
      state.__jollityNarrationWaitingV1 = true
      document.addEventListener("DOMContentLoaded", mount, { once: true })
    }
    return
  }
  mount()
}

export async function installNarrationInit(
  context: Pick<BrowserContext, "addInitScript">,
  attribution: string,
): Promise<void> {
  await context.addInitScript(renderNarrationHud, { attribution, revision: 0, transition: null } satisfies HudPayload)
}

const sameEvent = (
  one: Omit<NarrationTransition, "at">,
  two: Omit<NarrationTransition, "at">,
): boolean => one.state === two.state
  && one.source === two.source
  && one.action === two.action
  && one.title === two.title
  && one.text === two.text
  && one.detail === two.detail

const errorDetail = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) || "unknown page update failure"
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export class ScenarioNarrator implements NarrationSink {
  private readonly pages = new Set<Page>()
  private readonly transitions: NarrationTransition[] = []
  private current: NarrationTransition | null = null
  private revision = 0

  constructor(
    private readonly attribution: string,
    private readonly now: () => Date = () => new Date(),
    private readonly options: {
      pageUpdateTimeoutMs?: number
      requiredPageUpdateTimeoutMs?: number
      requiredAttempts?: number
      requiredRetryDelayMs?: number
    } = {},
  ) {}

  async transition(event: Omit<NarrationTransition, "at">): Promise<NarrationTransition> {
    const { transition, revision, created } = this.prepare(event)
    if (!created) return transition

    await Promise.all([...this.pages].map((page) => this.deliver(page, transition, revision)))
    return transition
  }

  async transitionRequired(event: Omit<NarrationTransition, "at">): Promise<NarrationTransition> {
    const { transition, revision } = this.prepare(event)
    const attempts = Math.max(1, this.options.requiredAttempts ?? 3)
    const retryDelayMs = Math.max(0, this.options.requiredRetryDelayMs ?? 250)
    let lastDetail = "no live page"

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const livePages = [...this.pages].filter((page) => {
        if (!page.isClosed()) return true
        this.pages.delete(page)
        return false
      })
      const results = await Promise.all(livePages.map((page) => this.deliverRequired(page, transition, revision)))
      if (results.some(({ acknowledged }) => acknowledged)) return transition
      lastDetail = results.map(({ detail }) => detail).filter(Boolean).join("; ") || "no live page"
      if (attempt < attempts && retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    }

    const error = new Error(`recording overlay did not acknowledge revision ${revision} after ${attempts} attempts: ${lastDetail}`)
    this.recordPageFailure(error, revision)
    throw error
  }

  async attach(page: Page): Promise<void> {
    this.pages.add(page)
    await this.deliver(page, this.current, this.revision)
  }

  private async deliver(page: Page, transition: NarrationTransition | null, revision: number): Promise<void> {
    if (page.isClosed()) {
      this.pages.delete(page)
      return
    }
    const timeoutMs = this.options.pageUpdateTimeoutMs ?? NARRATION_PAGE_UPDATE_TIMEOUT_MS
    try {
      await withTimeout(this.render(page, transition, revision), timeoutMs, "renderer")
    } catch (error) {
      this.recordPageFailure(error, revision)
    } finally {
      if (page.isClosed()) this.pages.delete(page)
    }
  }

  snapshot(): readonly NarrationTransition[] {
    return this.transitions.map((transition) => ({ ...transition }))
  }

  private prepare(event: Omit<NarrationTransition, "at">): { transition: NarrationTransition; revision: number; created: boolean } {
    if (this.current && sameEvent(this.current, event)) return { transition: this.current, revision: this.revision, created: false }
    const transition = { ...event, at: this.now().toISOString() }
    this.transitions.push(transition)
    this.current = transition
    this.revision += 1
    return { transition, revision: this.revision, created: true }
  }

  private async deliverRequired(
    page: Page,
    transition: NarrationTransition,
    revision: number,
  ): Promise<{ acknowledged: boolean; detail: string }> {
    if (page.isClosed()) {
      this.pages.delete(page)
      return { acknowledged: false, detail: "page closed" }
    }
    const timeoutMs = this.options.requiredPageUpdateTimeoutMs
      ?? this.options.pageUpdateTimeoutMs
      ?? REQUIRED_NARRATION_PAGE_UPDATE_TIMEOUT_MS
    try {
      await withTimeout(this.render(page, transition, revision), timeoutMs, "renderer")
      const acknowledged = await withTimeout(this.acknowledged(page, revision), timeoutMs, "acknowledgement")
      return { acknowledged, detail: acknowledged ? "" : `revision ${revision} was not mounted` }
    } catch (error) {
      return { acknowledged: false, detail: errorDetail(error) }
    } finally {
      if (page.isClosed()) this.pages.delete(page)
    }
  }

  private async render(page: Page, transition: NarrationTransition | null, revision: number): Promise<void> {
    await page.evaluate(renderNarrationHud, { attribution: this.attribution, revision, transition } satisfies HudPayload)
  }

  private async acknowledged(page: Page, revision: number): Promise<boolean> {
    return page.evaluate(({ hostId, wantedRevision }) => {
      const state = globalThis as typeof globalThis & { __jollityNarrationRevisionV1?: number }
      return state.__jollityNarrationRevisionV1 === wantedRevision && document.getElementById(hostId) !== null
    }, { hostId: NARRATION_HOST_ID, wantedRevision: revision })
  }

  private recordPageFailure(error: unknown, revision: number): void {
    if (revision < this.revision) return
    const detail = errorDetail(error)
    const previous = this.transitions.at(-1)
    const action = `render.${revision}`
    if (previous?.state === "failed" && previous.title === "Recording overlay unavailable" && previous.action === action && previous.detail === detail) return
    this.transitions.push({
      at: this.now().toISOString(),
      state: "failed",
      source: "outcome",
      action,
      title: "Recording overlay unavailable",
      text: "The test continued, but this page could not show the recording overlay.",
      detail,
    })
  }
}

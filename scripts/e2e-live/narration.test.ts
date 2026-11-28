// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { BrowserContext, Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  afterRequiredNarration,
  installNarrationInit,
  NARRATION_HOST_ID,
  NARRATION_PAGE_UPDATE_TIMEOUT_MS,
  REQUIRED_NARRATION_PAGE_UPDATE_TIMEOUT_MS,
  ScenarioNarrator,
  scenarioNarration,
  type NarrationTransition,
} from "./narration"
import type { ScenarioPresentation } from "./crew/catalogue"

class FakeNode {
  readonly children: FakeNode[] = []
  textContent = ""
  private readonly attributes = new Map<string, string>()

  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes)
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  set innerHTML(_value: string) {
    throw new Error("narration must not use innerHTML")
  }
}

class FakeElement extends FakeNode {
  id = ""
  shadowRoot: FakeShadowRoot | null = null
  closedRoot: FakeShadowRoot | null = null
  shadowMode: "open" | "closed" | null = null

  constructor(readonly tagName: string) {
    super()
  }

  attachShadow({ mode }: { mode: "open" | "closed" }): FakeShadowRoot {
    this.shadowMode = mode
    this.closedRoot = new FakeShadowRoot()
    this.shadowRoot = mode === "open" ? this.closedRoot : null
    return this.closedRoot
  }
}

class FakeShadowRoot extends FakeNode {}

class FakeStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

class FakeDocument {
  body: FakeElement | null = new FakeElement("body")
  private domReady: Array<() => void> = []

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName)
  }

  getElementById(id: string): FakeElement | null {
    return this.body?.children.find((node): node is FakeElement => node instanceof FakeElement && node.id === id) ?? null
  }

  addEventListener(name: string, listener: () => void): void {
    if (name === "DOMContentLoaded") this.domReady.push(listener)
  }

  removeBody(): void {
    this.body = null
  }

  makeReady(): void {
    this.body = new FakeElement("body")
    const listeners = this.domReady.splice(0)
    for (const listener of listeners) listener()
  }
}

const pageStateKeys = ["__jollityNarrationHudV1", "__jollityNarrationPayloadV1", "__jollityNarrationRevisionV1", "__jollityNarrationWaitingV1"] as const

class FakePage {
  document = new FakeDocument()
  private sessionStorage = new FakeStorage()
  private state = new Map<string, unknown>()
  failUpdates = false
  hangUpdates = false
  deferUpdates = false
  updateDelayMs = 0
  closed = false
  evaluateCalls = 0
  private readonly deferredUpdates: Array<() => void> = []

  async evaluate<R, Arg>(run: (arg: Arg) => R, arg: Arg): Promise<R> {
    this.evaluateCalls += 1
    if (this.failUpdates) throw new Error("renderer unavailable")
    if (this.hangUpdates) return new Promise<R>(() => undefined)
    if (this.updateDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.updateDelayMs))
    if (this.deferUpdates) {
      return new Promise<R>((resolve, reject) => {
        this.deferredUpdates.push(() => {
          try {
            resolve(this.inPage(() => run(arg)))
          } catch (error) {
            reject(error)
          }
        })
      })
    }
    return this.inPage(() => run(arg))
  }

  isClosed(): boolean {
    return this.closed
  }

  runInit<Arg>(run: (arg: Arg) => void, arg: Arg): void {
    this.inPage(() => run(arg))
  }

  ready(): void {
    this.inPage(() => this.document.makeReady())
  }

  private inPage<R>(run: () => R): R {
    const previousDocument = (globalThis as { document?: unknown }).document
    const previousSessionStorage = (globalThis as { sessionStorage?: unknown }).sessionStorage
    const previousState = new Map(pageStateKeys.map((key) => [key, (globalThis as Record<string, unknown>)[key]]))
    ;(globalThis as { document?: unknown }).document = this.document
    ;(globalThis as { sessionStorage?: unknown }).sessionStorage = this.sessionStorage
    for (const key of pageStateKeys) {
      const value = this.state.get(key)
      if (value === undefined) delete (globalThis as Record<string, unknown>)[key]
      else (globalThis as Record<string, unknown>)[key] = value
    }
    try {
      return run()
    } finally {
      for (const key of pageStateKeys) {
        const value = (globalThis as Record<string, unknown>)[key]
        if (value === undefined) this.state.delete(key)
        else this.state.set(key, value)
      }
      ;(globalThis as { document?: unknown }).document = previousDocument
      ;(globalThis as { sessionStorage?: unknown }).sessionStorage = previousSessionStorage
      for (const key of pageStateKeys) {
        const value = previousState.get(key)
        if (value === undefined) delete (globalThis as Record<string, unknown>)[key]
        else (globalThis as Record<string, unknown>)[key] = value
      }
    }
  }

  reload(): void {
    this.document = new FakeDocument()
    this.state.clear()
  }

  navigateToFreshOrigin(): void {
    this.reload()
    this.sessionStorage = new FakeStorage()
  }

  flushDeferred(): void {
    for (const update of this.deferredUpdates.splice(0)) update()
  }

  asPage(): Page {
    return this as unknown as Page
  }

  host(): FakeElement {
    const host = this.document.getElementById(NARRATION_HOST_ID)
    if (!host) throw new Error("missing narration host")
    return host
  }

  body(): FakeElement {
    if (!this.document.body) throw new Error("missing document body")
    return this.document.body
  }

  visibleText(): string[] {
    const plate = this.host().closedRoot?.children.find((node) => node instanceof FakeElement && node.tagName === "div")
    return plate?.children.map((node) => node.textContent) ?? []
  }
}

const event = (over: Partial<Omit<NarrationTransition, "at">> = {}): Omit<NarrationTransition, "at"> => ({
  state: "preparing",
  source: "journey",
  action: null,
  title: "Packet Loss Burst",
  text: "Packet Jack is preparing a burst of packet loss.",
  ...over,
})

describe("ScenarioNarrator", () => {
  it("defers init-script mounting until an early document has a body", async () => {
    let init: ((arg: unknown) => void) | null = null
    let payload: unknown
    await installNarrationInit({
      addInitScript: async (run: unknown, arg: unknown) => {
        init = run as (value: unknown) => void
        payload = arg
      },
    } as unknown as Pick<BrowserContext, "addInitScript">, "PreviewNet Boot Harness")
    const page = new FakePage()
    page.document.removeBody()
    page.runInit(init!, payload)
    expect(page.document.getElementById(NARRATION_HOST_ID)).toBeNull()

    page.ready()
    expect(page.host().shadowMode).toBe("closed")
    expect(page.visibleText()[0]).toBe("PreviewNet Boot Harness")
  })

  it("creates one closed pointer-free HUD and writes only text content", async () => {
    const page = new FakePage()
    const narrator = new ScenarioNarrator("Packet Jack", () => new Date("2026-10-18T13:20:00.000Z"))
    await narrator.transition(event())
    await narrator.attach(page.asPage())
    await narrator.attach(page.asPage())

    expect(page.body().children.filter((node) => node instanceof FakeElement && node.id === NARRATION_HOST_ID)).toHaveLength(1)
    expect(page.host().shadowMode).toBe("closed")
    expect(page.host().shadowRoot).toBeNull()
    expect(page.host().getAttribute("aria-hidden")).toBe("true")
    expect(page.host().closedRoot?.children[0].textContent).toContain("pointer-events: none")
    expect(page.host().closedRoot?.children[0].textContent).toContain("z-index: 2147483647")
    expect(page.visibleText()).toEqual([
      "Packet Jack",
      "Packet Loss Burst",
      "Packet Jack is preparing a burst of packet loss.",
      "",
    ])
  })

  it("reapplies the current state to new and reloaded documents", async () => {
    const first = new FakePage()
    const second = new FakePage()
    const narrator = new ScenarioNarrator("NULL Nancy")
    await narrator.transition(event({ title: "Blackout", text: "NULL Nancy has no network." }))
    await narrator.attach(first.asPage())
    await narrator.attach(second.asPage())
    first.reload()
    await narrator.attach(first.asPage())

    expect(first.visibleText()).toEqual(second.visibleText())
    expect(first.visibleText()).toContain("NULL Nancy has no network.")
  })

  it("restores the latest outcome during init before a reloaded page can be reattached", async () => {
    let init: ((arg: unknown) => void) | null = null
    let payload: unknown
    await installNarrationInit({
      addInitScript: async (run: unknown, arg: unknown) => {
        init = run as (value: unknown) => void
        payload = arg
      },
    } as unknown as Pick<BrowserContext, "addInitScript">, "Packet Jack")
    const page = new FakePage()
    const narrator = new ScenarioNarrator("Packet Jack")
    await narrator.attach(page.asPage())
    await narrator.transitionRequired(event({ state: "passed", source: "outcome", text: "Packet Jack passed." }))

    page.reload()
    page.runInit(init!, payload)

    expect(page.visibleText()).toContain("Packet Jack passed.")
  })

  it("restores the latest payload after relaunch navigation loses the blank document", async () => {
    let init: ((arg: unknown) => void) | null = null
    let payload: unknown
    await installNarrationInit({
      addInitScript: async (run: unknown, arg: unknown) => {
        init = run as (value: unknown) => void
        payload = arg
      },
    } as unknown as Pick<BrowserContext, "addInitScript">, "Packet Jack")
    const relaunched = new FakePage()
    const narrator = new ScenarioNarrator("Packet Jack")
    await narrator.transition(event({ state: "passed", source: "outcome", text: "Packet Jack passed." }))

    await narrator.attach(relaunched.asPage())
    expect(relaunched.visibleText()).toContain("Packet Jack passed.")

    relaunched.navigateToFreshOrigin()
    relaunched.runInit(init!, payload)
    expect(relaunched.visibleText()).not.toContain("Packet Jack passed.")

    await narrator.attach(relaunched.asPage())
    expect(relaunched.visibleText()).toContain("Packet Jack passed.")
  })

  it("timestamps each transition once and ignores an exact repeat", async () => {
    const times = [new Date("2026-10-18T13:20:00.000Z"), new Date("2026-10-18T13:20:01.000Z")]
    const narrator = new ScenarioNarrator("Packet Jack", () => times.shift() ?? new Date("2026-10-18T13:20:02.000Z"))
    const first = await narrator.transition(event())
    const repeated = await narrator.transition(event())
    const active = await narrator.transition(event({ state: "active", source: "network", action: "network.1", text: "Packet loss is now in force." }))

    expect(repeated).toBe(first)
    expect(narrator.snapshot()).toEqual([first, active])
    expect(narrator.snapshot().map(({ at }) => at)).toEqual(["2026-10-18T13:20:00.000Z", "2026-10-18T13:20:01.000Z"])
  })

  it("keeps a page update failure as evidence without blocking healthy pages", async () => {
    const healthy = new FakePage()
    const failed = new FakePage()
    const narrator = new ScenarioNarrator("Relay Rita")
    await narrator.attach(healthy.asPage())
    await narrator.attach(failed.asPage())
    failed.failUpdates = true

    const transition = await narrator.transition(event({ state: "active", source: "network", action: "network.1", text: "Relay Rita's relay is offline." }))

    expect(transition.state).toBe("active")
    expect(healthy.visibleText()).toContain("Relay Rita's relay is offline.")
    expect(narrator.snapshot().at(-1)).toMatchObject({
      state: "failed",
      source: "outcome",
      title: "Recording overlay unavailable",
      detail: "renderer unavailable",
    })
  })

  it("bounds a frozen page, updates healthy pages concurrently, and retires closed pages", async () => {
    const healthy = new FakePage()
    const frozen = new FakePage()
    const narrator = new ScenarioNarrator("Packet Jack", () => new Date("2026-10-18T13:20:00.000Z"), { pageUpdateTimeoutMs: 20 })
    await narrator.attach(healthy.asPage())
    await narrator.attach(frozen.asPage())
    frozen.hangUpdates = true

    await narrator.transition(event({ state: "active", source: "network", action: "network.1", text: "Packet loss is now in force." }))
    expect(healthy.visibleText()).toContain("Packet loss is now in force.")
    expect(narrator.snapshot().at(-1)).toMatchObject({
      state: "failed",
      title: "Recording overlay unavailable",
      detail: "renderer timed out after 20 ms",
    })

    frozen.closed = true
    const failures = narrator.snapshot().filter(({ title }) => title === "Recording overlay unavailable").length
    await narrator.transition(event({ state: "verifying", source: "outcome", text: "Checking the result." }))
    expect(narrator.snapshot().filter(({ title }) => title === "Recording overlay unavailable")).toHaveLength(failures)
  })

  it("does not let a timed-out stale render overwrite a newer outcome", async () => {
    const page = new FakePage()
    const narrator = new ScenarioNarrator("Packet Jack", () => new Date("2026-10-18T13:20:00.000Z"), { pageUpdateTimeoutMs: 20 })
    await narrator.attach(page.asPage())
    page.deferUpdates = true

    await narrator.transition(event({ state: "active", source: "network", action: "network.3", text: "Packet Jack is switching back to wifi." }))
    page.deferUpdates = false
    await narrator.transition(event({ state: "passed", source: "outcome", action: null, text: "Packet Jack recorded every required observation." }))
    expect(page.visibleText()).toContain("Packet Jack recorded every required observation.")

    page.flushDeferred()
    expect(page.visibleText()).toContain("Packet Jack recorded every required observation.")
    expect(page.visibleText()).not.toContain("Packet Jack is switching back to wifi.")
  })

  it("retries a required outcome at the same revision until the page acknowledges it", async () => {
    const page = new FakePage()
    const narrator = new ScenarioNarrator("Packet Jack", () => new Date("2026-10-18T13:20:00.000Z"), {
      pageUpdateTimeoutMs: 10,
      requiredAttempts: 2,
      requiredRetryDelayMs: 10,
    })
    await narrator.attach(page.asPage())
    page.deferUpdates = true
    setTimeout(() => { page.deferUpdates = false }, 15)

    await narrator.transitionRequired(event({ state: "passed", source: "outcome", action: null, text: "Packet Jack recorded every required observation." }))
    expect(page.visibleText()).toContain("Packet Jack recorded every required observation.")

    page.flushDeferred()
    expect(page.visibleText()).toContain("Packet Jack recorded every required observation.")
    expect(narrator.snapshot().filter(({ title }) => title === "Recording overlay unavailable")).toHaveLength(0)
  })

  it("gives a required outcome a larger renderer budget than ordinary overlay updates", async () => {
    expect(REQUIRED_NARRATION_PAGE_UPDATE_TIMEOUT_MS).toBeGreaterThan(NARRATION_PAGE_UPDATE_TIMEOUT_MS)

    const page = new FakePage()
    const narrator = new ScenarioNarrator("Packet Jack", () => new Date("2026-10-18T13:20:00.000Z"), {
      pageUpdateTimeoutMs: 10,
      requiredPageUpdateTimeoutMs: 30,
      requiredAttempts: 1,
    })
    await narrator.attach(page.asPage())
    page.updateDelayMs = 20

    await narrator.transitionRequired(event({ state: "passed", source: "outcome", action: null, text: "Packet Jack recorded every required observation." }))
    expect(page.visibleText()).toContain("Packet Jack recorded every required observation.")
    expect(narrator.snapshot().filter(({ title }) => title === "Recording overlay unavailable")).toHaveLength(0)
  })

  it("fails a required outcome explicitly when no live page acknowledges it", async () => {
    const page = new FakePage()
    const narrator = new ScenarioNarrator("Packet Jack", () => new Date("2026-10-18T13:20:00.000Z"), {
      requiredPageUpdateTimeoutMs: 5,
      requiredAttempts: 2,
      requiredRetryDelayMs: 0,
    })
    await narrator.attach(page.asPage())
    page.hangUpdates = true

    await expect(narrator.transitionRequired(event({ state: "passed", source: "outcome", action: null, text: "Packet Jack recorded every required observation." }))).rejects.toThrow(
      "recording overlay did not acknowledge revision 1 after 2 attempts",
    )
    expect(narrator.snapshot().at(-1)).toMatchObject({
      state: "failed",
      action: "render.1",
      title: "Recording overlay unavailable",
    })
  })

  it("keeps stage persistence behind required outcome acknowledgement", async () => {
    let acknowledge!: () => void
    const delivered = new Promise<NarrationTransition>((resolve) => {
      acknowledge = () => resolve({ ...event({ state: "passed", source: "outcome" }), at: "2026-10-18T13:20:00.000Z" })
    })
    let persisted = false
    const pending = afterRequiredNarration(
      [{ transitionRequired: () => delivered }],
      event({ state: "passed", source: "outcome" }),
      () => { persisted = true },
    )

    await Promise.resolve()
    expect(persisted).toBe(false)
    acknowledge()
    await pending
    expect(persisted).toBe(true)
  })

  it("settles every narrator and returns delivery failures without replacing the product verdict", async () => {
    const deliveryError = new Error("Packet Jack's overlay did not render")
    const events: string[] = []
    let releaseSecond!: () => void
    const secondDelivery = new Promise<NarrationTransition>((resolve) => {
      releaseSecond = () => {
        events.push("second-settled")
        resolve({ ...event({ state: "passed", source: "outcome" }), at: "2026-10-18T13:20:00.000Z" })
      }
    })
    const returned = afterRequiredNarration(
      [
        { transitionRequired: async () => { throw deliveryError } },
        { transitionRequired: () => secondDelivery },
      ],
      event({ state: "passed", source: "outcome" }),
      () => { events.push("persisted") },
    ).then((failures) => {
      events.push("returned")
      return failures
    })

    await Promise.resolve()
    releaseSecond()
    expect(await returned).toEqual([{ narrator: 0, error: deliveryError }])
    expect(events).toEqual(["second-settled", "persisted", "returned"])
  })
})

describe("scenarioNarration", () => {
  const scenario: ScenarioPresentation = {
    profile: "relay-outage",
    title: "Relay Outage",
    purpose: "exercise recovery",
    expected: "the relay recovers",
    criteria: ["the relay recovers"],
    parameters: {},
    phases: {
      preparing: "Relay Rita is preparing the relay outage.",
      verifying: "Relay Rita is checking recovery evidence.",
      passed: "Relay Rita recovered.",
      failed: "Relay Rita did not recover.",
    },
    actions: {
      "network.1": {
        active: "Relay Rita's only relay is offline.",
        recovered: "Relay Rita's relay is back; recovery is being checked.",
        failed: "Relay Rita's relay phase could not be proven.",
      },
    },
  }

  it("uses catalogue phase and action copy for truthful lifecycle states", () => {
    expect(scenarioNarration(scenario, "preparing", "journey")).toMatchObject({ title: "Relay Outage", text: scenario.phases.preparing })
    expect(scenarioNarration(scenario, "active", "journey")).toMatchObject({ title: "Relay Outage", text: scenario.purpose })
    expect(scenarioNarration(scenario, "active", "network", "network.1")).toMatchObject({ action: "network.1", text: scenario.actions["network.1"].active })
    expect(scenarioNarration(scenario, "not-applied", "network", "network.1")).toMatchObject({ text: "This network challenge was not applied on this run." })
    expect(scenarioNarration(scenario, "recovered", "network", "network.1")).toMatchObject({ text: scenario.actions["network.1"].recovered })
    expect(scenarioNarration(scenario, "verifying", "outcome")).toMatchObject({ text: scenario.phases.verifying })
    expect(scenarioNarration(scenario, "passed", "outcome")).toMatchObject({ text: scenario.phases.passed })
    expect(scenarioNarration(scenario, "failed", "network", "network.1")).toMatchObject({ text: scenario.actions["network.1"].failed })
  })

  it("falls back to verification copy when a completed action has no custom recovery copy", () => {
    const withoutRecovery = { ...scenario, actions: { "role.confirm-tap": { active: "Confirming.", failed: "Confirm failed." } } }
    expect(scenarioNarration(withoutRecovery, "recovered", "role", "role.confirm-tap")).toMatchObject({ text: scenario.phases.verifying })
  })
})

describe("harness isolation", () => {
  it("keeps the narration module and HUD identifier out of production sources", () => {
    const files = execFileSync("git", ["ls-files", "app", "components", "lib"], { encoding: "utf8" }).trim().split("\n").filter(Boolean)
    const offenders = files.filter((file) => {
      const source = readFileSync(file, "utf8")
      return source.includes("e2e-live/narration") || source.includes(NARRATION_HOST_ID)
    })
    expect(offenders).toEqual([])
  })
})

describe("live journey narration wiring", () => {
  const source = readFileSync("scripts/e2e-live/journey.pw.ts", "utf8")

  it("installs the harness before each document without racing navigation restoration", () => {
    const pageFactory = source.slice(source.indexOf("const newBotPage"), source.indexOf("test.beforeAll"))
    expect(pageFactory.indexOf("installNarrationInit(context, attribution)")).toBeGreaterThan(-1)
    expect(pageFactory.indexOf("installNarrationInit(context, attribution)")).toBeLessThan(pageFactory.indexOf("context.newPage()"))
    expect(pageFactory).toContain("narrators[i].attach(page)")
    expect(source).not.toContain("void narrators[i].attach(page)")
    expect(source).toContain("const fresh = await bounded(newBotPage(context, i)")
    const reopen = source.slice(source.indexOf("async function reopenPage"), source.indexOf("async function relaunch"))
    expect(reopen.indexOf("await bounded(fresh.goto(")).toBeGreaterThan(-1)
    expect(reopen.indexOf("await narrators[i].attach(fresh)")).toBeGreaterThan(reopen.indexOf("await bounded(fresh.goto("))
    expect(reopen.match(/narrators\[i\]\.attach\(fresh\)/g)).toHaveLength(1)
  })

  it("persists the current timeline and maps every required runtime source", () => {
    expect(source).toContain('await narrateAll("active", "journey")')
    expect(source).toContain("r.narration = [...(narrators[i]?.snapshot() ?? [])]")
    expect(source).toContain("onNarration: ({ step, state, role, detail })")
    expect(source).toContain("`network.${step}`")
    expect(source).toContain("const action = `role.${id}`")
    expect(source).toContain("`clock.${k + 1}`")
    expect(source).toContain("`telemetry.${torture.id}`")
  })

  it("derives final overlay phases from the actual Playwright stage outcome", () => {
    expect(source).toContain("const outcomeState: NarrationState | null")
    expect(source).toContain('? "failed"')
    expect(source).toContain('? "verifying"')
    expect(source).toContain('? "passed"')
    expect(source).toContain("await afterRequiredNarration(narrators")
    expect(source.indexOf("await persistStage()")).toBeLessThan(source.indexOf("await afterRequiredNarration(narrators"))
    expect(source).toContain("recording overlay acknowledged the final stage outcome")
    expect(source).toContain("note: \"recording-overlay\"")
  })
})

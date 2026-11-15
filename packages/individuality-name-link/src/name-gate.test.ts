// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Tests the name gate (./name-gate.ts): Register goes only once the name is
 * linked, and the link goes again until it is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createNameGate as createGate,
  NAME_LINK_GRACE_MS,
  NAME_LINK_TIMEOUT_MS,
  NAME_TAP_RETRY_MS,
  NAME_TAP_WAIT_MS,
  NAME_UNOWNED_RECHECK_MS,
  NAME_UNOWNED_RETRY_MS,
  type NameLinkResult,
  type NameLinkTrigger,
} from "./name-gate"

/** the products' ladder (@individuality/sign-up's BIND_RETRY_MS) */
const LADDER = [5_000, 15_000, 45_000, 120_000, 300_000]
const retryDelay = (failures: number) => LADDER[Math.min(Math.max(failures, 1), LADDER.length) - 1]!
const createNameGate = (link: (trigger: NameLinkTrigger, signal: AbortSignal) => Promise<NameLinkResult>) =>
  createGate({ link, retryDelay })

const settled = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe("the name gate works", () => {
  it("lets Register go once the name is linked, and links no second time", async () => {
    // Given
    let answer!: (outcome: NameLinkResult) => void
    const link = vi.fn<(trigger: NameLinkTrigger) => Promise<NameLinkResult>>(() => new Promise((resolve) => (answer = resolve)))
    const gate = createNameGate(link)

    // When
    gate.request()
    await settled()
    const inPlace = gate.inPlace()
    expect(gate.ready()).toBe(false)
    answer("linked")

    // Then
    await expect(inPlace).resolves.toBe("linked")
    gate.request("register")
    await settled()
    expect(link).toHaveBeenCalledTimes(1)
    expect(link).toHaveBeenCalledWith("background", expect.any(AbortSignal))
  })

  it("counts a name the account already carries as linked", async () => {
    // Given
    const gate = createNameGate(async () => "already-linked")

    // When
    const inPlace = await gate.inPlace()

    // Then
    expect(inPlace).toBe("linked")
    expect(gate.ready()).toBe(true)
  })

  it("says the username is unowned until a link finds otherwise", async () => {
    // Given
    const answers: NameLinkResult[] = ["unowned", "linked"]
    const gate = createNameGate(async () => answers.shift() ?? "linked")

    // When
    gate.request()
    await settled()

    // Then
    expect(gate.unowned()).toBe(true)
    await vi.advanceTimersByTimeAsync(NAME_UNOWNED_RETRY_MS)
    expect(gate.unowned()).toBe(false)
  })

  it.each(["failed", "unfunded", "skipped", "not-signed"] as const)(
    "stops saying the username is unowned once a link ends %s, so the notice never names the wrong cause",
    async (next) => {
      // Given
      const answers: NameLinkResult[] = ["unowned", next]
      const gate = createNameGate(async () => answers.shift() ?? next)

      // When
      gate.request()
      await settled()
      expect(gate.unowned()).toBe(true)
      await vi.advanceTimersByTimeAsync(NAME_UNOWNED_RETRY_MS)

      // Then
      expect(answers).toEqual([])
      expect(gate.unowned()).toBe(false)
    },
  )

  it("ends the unowned hold for a player who asks, at most once per NAME_UNOWNED_RECHECK_MS", async () => {
    // Given: the player sets the username up in Humanity a minute later
    const answers: NameLinkResult[] = ["unowned", "unowned", "linked"]
    const link = vi.fn(async () => answers.shift() ?? "linked")
    const gate = createNameGate(link)
    gate.request()
    await settled()

    // When: asked at once, then past the spacing, then again too soon
    gate.recheck()
    await settled()
    expect(link).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(NAME_UNOWNED_RECHECK_MS)
    gate.recheck()
    await settled()
    expect(link).toHaveBeenCalledTimes(2)
    gate.recheck()
    await settled()
    expect(link).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(NAME_UNOWNED_RECHECK_MS)
    gate.recheck()
    await settled()

    // Then: the username landed, and the gate opens long before the hold ran out
    expect(link).toHaveBeenCalledTimes(3)
    expect(link).toHaveBeenLastCalledWith("register", expect.any(AbortSignal))
    expect(gate.ready()).toBe(true)
  })

  it("lets a chat tap past the unowned hold once the spacing has gone by", async () => {
    // Given
    const answers: NameLinkResult[] = ["unowned", "linked"]
    const gate = createNameGate(async () => answers.shift() ?? "linked")
    gate.request()
    await settled()
    await vi.advanceTimersByTimeAsync(NAME_UNOWNED_RECHECK_MS)

    // When
    const tapped = await gate.inPlace()

    // Then
    expect(tapped).toBe("linked")
  })

  it("stops saying the username is unowned when a link that ran out of time ends linked", async () => {
    // Given
    let answer!: (outcome: NameLinkResult) => void
    const answers: Array<NameLinkResult | Promise<NameLinkResult>> = ["unowned", new Promise((resolve) => (answer = resolve))]
    const gate = createNameGate(async () => answers.shift() ?? "linked")
    gate.request()
    await settled()
    await vi.advanceTimersByTimeAsync(NAME_UNOWNED_RETRY_MS + NAME_LINK_TIMEOUT_MS)
    expect(gate.unowned()).toBe(true)

    // When
    answer("linked")
    await settled()

    // Then
    expect(gate.ready()).toBe(true)
    expect(gate.unowned()).toBe(false)
  })

  it("stops saying the username is unowned after a signature that failed for another reason", async () => {
    // Given
    const answers: NameLinkResult[] = ["unowned", "not-signed"]
    const gate = createNameGate(async () => answers.shift() ?? "not-signed")

    // When
    gate.request()
    await settled()
    await vi.advanceTimersByTimeAsync(NAME_UNOWNED_RETRY_MS)

    // Then
    expect(gate.unowned()).toBe(false)
  })

  it("starts no link for a tap, a request or a cleared retry while an unowned username holds it, then checks once (#1115)", async () => {
    // Given
    const link = vi.fn(async (): Promise<NameLinkResult> => "unowned")
    const gate = createNameGate(link)
    gate.request()
    await settled()
    expect(link).toHaveBeenCalledTimes(1)

    // When: every way of asking, for the whole hold
    gate.clearRetry()
    gate.request("register")
    gate.request()
    const tapped = gate.inPlace()
    await settled()

    // Then: the tap answers at once, and no link starts
    await expect(tapped).resolves.toBe("not-linked")
    await vi.advanceTimersByTimeAsync(NAME_UNOWNED_RETRY_MS - 1)
    expect(link).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(link).toHaveBeenCalledTimes(2)
  })

  it("ends a tap's wait at once when the link it waits on finds the username unowned", async () => {
    // Given
    let answer!: (outcome: NameLinkResult) => void
    const link = vi.fn(() => new Promise<NameLinkResult>((resolve) => (answer = resolve)))
    const gate = createNameGate(link)

    // When
    const tapped = gate.inPlace()
    await settled()
    answer("unowned")

    // Then
    await expect(tapped).resolves.toBe("not-linked")
    await vi.advanceTimersByTimeAsync(NAME_TAP_WAIT_MS)
    expect(link).toHaveBeenCalledTimes(1)
  })

  it("keeps the tap's 5 s re-ask for a link that failed for another reason", async () => {
    // Given
    const link = vi.fn(async (): Promise<NameLinkResult> => "failed")
    const gate = createNameGate(link)

    // When
    const tapped = gate.inPlace()
    await vi.advanceTimersByTimeAsync(NAME_TAP_WAIT_MS)

    // Then
    await expect(tapped).resolves.toBe("not-linked")
    expect(link.mock.calls.length).toBeGreaterThan(10)
  })

  it("asks once at a time, however often it is asked", async () => {
    // Given
    const link = vi.fn(() => new Promise<NameLinkResult>(() => {}))
    const gate = createNameGate(link)

    // When
    gate.request()
    gate.request()
    void gate.inPlace()
    await settled()

    // Then
    expect(link).toHaveBeenCalledTimes(1)
  })
})

describe("the name gate fails", () => {
  // `unowned` holds the gate for NAME_UNOWNED_RETRY_MS instead (above)
  it.each(["not-signed", "unfunded", "skipped", "failed"] as const)(
    "never lets Register go after a link that ended %s, and links again on the ladder until it is linked",
    async (outcome) => {
      // Given
      const answers: NameLinkResult[] = [outcome, outcome, "linked"]
      const link = vi.fn<(trigger: NameLinkTrigger) => Promise<NameLinkResult>>(async () => answers.shift() ?? "linked")
      const gate = createNameGate(link)

      // When
      gate.request()
      await settled()
      expect(gate.ready()).toBe(false)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(gate.ready()).toBe(false)
      await vi.advanceTimersByTimeAsync(15_000)

      // Then: tried at once, after 5 s, then after 15 s more
      expect(gate.ready()).toBe(true)
      expect(link.mock.calls.map(([trigger]) => trigger)).toEqual(["background", "background", "background"])
    },
  )

  it("asks again every few seconds while a tap waits, past the ladder, and ends not linked when the wait runs out", async () => {
    // Given
    const link = vi.fn<(trigger: NameLinkTrigger) => Promise<NameLinkResult>>(async () => "skipped")
    const gate = createNameGate(link)
    let result: string | undefined

    // When
    void gate.inPlace().then((value) => (result = value))
    await vi.advanceTimersByTimeAsync(60_000)

    // Then: once at the tap, then about every 5 s
    expect(result).toBeUndefined()
    expect(link.mock.calls.length).toBeGreaterThanOrEqual(10)
    expect(link.mock.calls.every(([trigger]) => trigger === "register")).toBe(true)
    await vi.advanceTimersByTimeAsync(NAME_TAP_WAIT_MS - 60_000)
    expect(result).toBe("not-linked")
    expect(gate.ready()).toBe(false)
  })

  it("gives up on a link that never answers and asks again", async () => {
    // Given
    const link = vi.fn(() => new Promise<NameLinkResult>(() => {}))
    const gate = createNameGate(link)

    // When
    gate.request()
    await vi.advanceTimersByTimeAsync(NAME_LINK_TIMEOUT_MS + 5_000)

    // Then: not over a link that may still be finishing, but once its grace is spent
    expect(gate.pending()).toBe(false)
    expect(link).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(NAME_LINK_GRACE_MS)
    expect(link).toHaveBeenCalledTimes(2)
  })

  it("stops a link that ran out of time, and starts no second one while it finishes", async () => {
    // Given: the first link is still on the root's prompt when its time runs out
    let answer!: (outcome: NameLinkResult) => void
    const signals: AbortSignal[] = []
    const link = vi.fn<(trigger: NameLinkTrigger, signal: AbortSignal) => Promise<NameLinkResult>>((_trigger, signal) => {
      signals.push(signal)
      return signals.length === 1 ? new Promise((resolve) => (answer = resolve)) : Promise.resolve("linked")
    })
    const gate = createNameGate(link)

    // When: a tap waits, asking every few seconds, past the deadline
    gate.request()
    void gate.inPlace()
    await vi.advanceTimersByTimeAsync(NAME_LINK_TIMEOUT_MS + 4 * NAME_TAP_RETRY_MS)

    // Then: the first link was told to stop, and nothing asked over it
    expect(signals[0]!.aborted).toBe(true)
    expect(link).toHaveBeenCalledTimes(1)

    // When: it returns, stopped
    answer("failed")
    await settled()

    // Then: the tap's ask goes now
    expect(link).toHaveBeenCalledTimes(2)
    expect(link.mock.calls[1]![0]).toBe("register")
    expect(signals[1]!.aborted).toBe(false)
    await settled()
    expect(gate.ready()).toBe(true)
  })

  it("counts a link that ran out of time and still ended linked", async () => {
    // Given
    let answer!: (outcome: NameLinkResult) => void
    const link = vi.fn<(trigger: NameLinkTrigger) => Promise<NameLinkResult>>(() => new Promise((resolve) => (answer = resolve)))
    const outcomes: (NameLinkResult | null)[] = []
    const gate = createGate({ link, retryDelay, onOutcome: (outcome) => void outcomes.push(outcome) })
    const heard = vi.fn()
    gate.subscribe(heard)

    // When
    gate.request()
    await vi.advanceTimersByTimeAsync(NAME_LINK_TIMEOUT_MS)
    expect(gate.ready()).toBe(false)
    answer("linked")
    await settled()

    // Then
    expect(gate.ready()).toBe(true)
    expect(outcomes).toEqual([null, "linked"])
    expect(heard).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(LADDER[0]!)
    expect(link).toHaveBeenCalledTimes(1)
  })

  it("goes on when a hook of the product throws", async () => {
    // Given
    const link = vi.fn<(trigger: NameLinkTrigger) => Promise<NameLinkResult>>(async () => "failed")
    const gate = createGate({
      link,
      retryDelay,
      onOutcome: () => {
        throw new Error("telemetry down")
      },
    })
    const after = vi.fn()
    gate.subscribe(() => {
      throw new Error("a listener broke")
    })
    gate.subscribe(after)

    // When
    gate.request()
    await settled()

    // Then: every listener heard, and the ladder still goes
    expect(after).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(LADDER[0]!)
    expect(link).toHaveBeenCalledTimes(2)
  })

  it("takes a link that threw for one that failed", async () => {
    // Given
    const link = vi.fn((): Promise<NameLinkResult> => {
      throw new Error("host gone")
    })
    const gate = createNameGate(link)

    // When
    gate.request()
    await vi.advanceTimersByTimeAsync(5_000)

    // Then
    expect(link).toHaveBeenCalledTimes(2)
    expect(gate.ready()).toBe(false)
  })
})

describe("the name gate lends its caller the ladder", () => {
  it("says a link is under way while it is", async () => {
    let answer!: (outcome: NameLinkResult) => void
    const gate = createNameGate(() => new Promise((resolve) => (answer = resolve)))
    expect(gate.pending()).toBe(false)
    gate.request()
    expect(gate.pending()).toBe(true)
    await settled()
    answer("linked")
    await settled()
    expect(gate.pending()).toBe(false)
  })

  it("adds no background link once a caller running its own retries clears the wait", async () => {
    const link = vi.fn<(trigger: NameLinkTrigger) => Promise<NameLinkResult>>(async () => "unfunded")
    const gate = createNameGate(link)
    gate.request()
    await settled()
    gate.clearRetry()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(link).toHaveBeenCalledTimes(1)
  })
})

describe("the name gate tells its readers", () => {
  it("says how each link ended, with the failures and the wait before the next", async () => {
    // Given
    const answers: NameLinkResult[] = ["unfunded", "linked"]
    const outcomes: [NameLinkResult | null, number, number | null][] = []
    const gate = createGate({
      link: async () => answers.shift() ?? "linked",
      retryDelay,
      onOutcome: (outcome, failures, retryInMs) => outcomes.push([outcome, failures, retryInMs]),
    })
    const woken = vi.fn(() => gate.ready())
    gate.subscribe(woken)

    // When
    gate.request()
    await settled()
    await vi.advanceTimersByTimeAsync(5_000)

    // Then
    expect(outcomes).toEqual([
      ["unfunded", 1, 5_000],
      ["linked", 0, null],
    ])
    // each reader is woken after the state moved
    expect(woken.mock.results.map((result) => result.value)).toEqual([false, true])
  })
})

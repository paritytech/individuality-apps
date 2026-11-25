// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  armChainLostRecheck,
  CHAIN_LOST_RECHECK_CAP_MS,
  CHAIN_LOST_RECHECK_FIRST_MS,
  chainLostRecheckDelayMs,
  collectablesRestartCardCopy,
  restartCardCopy,
  shouldWaitForReconnect,
  type ChainHealthResult,
} from "./chain-health"
import { HEALTHY, LOST, TIMED_OUT } from "./chain-health-fixtures"

describe("the restart card's advice", () => {
  it("reassures a player while a silent host is still inside the reconnecting window", () => {
    expect(restartCardCopy("host-unanswered", 1, " The game starts in 3:17.", true)).toEqual({
      eyebrow: "Reconnecting…",
      heading: "Getting the connection back",
      body: "The Polkadot app lost its chain connection and is reconnecting. This usually takes under a minute. Your place in the game is kept. The game starts in 3:17.",
      escalated: false,
    })
    expect(restartCardCopy("read-unanswered", 1, "", true).eyebrow).toBe("Reconnecting…")
  })

  it("keeps known chain-loss errors and repeated lost opens on immediate restart advice", () => {
    // the window rule decides; the copy follows whatever it decided
    expect(shouldWaitForReconnect("chain-lost", 1)).toBe(false)
    expect(shouldWaitForReconnect("host-unanswered", 2)).toBe(false)
    expect(restartCardCopy("chain-lost", 1, "").eyebrow).toBe("Connection lost")
    expect(restartCardCopy("host-unanswered", 2, "").eyebrow).toBe("Still no answer")
  })

  it("reads Reconnecting for a chain loss the window waits out after a return from the background", () => {
    expect(shouldWaitForReconnect("chain-lost", 1, "card", true)).toBe(true)
    expect(restartCardCopy("chain-lost", 1, "", true).eyebrow).toBe("Reconnecting…")
    expect(restartCardCopy("chain-lost", 2, "", true).escalated).toBe(false)
  })

  it("uses collectables-specific kept wording while its silent host is reconnecting", () => {
    expect(collectablesRestartCardCopy(true)).toEqual({
      eyebrow: "Reconnecting…",
      heading: "Getting the connection back",
      body: "The Polkadot app lost its chain connection and is reconnecting. This usually takes under a minute. Your collectables are kept.",
      escalated: false,
    })
  })

  it("keeps the same restart card for the collectables screen and changes only what is kept", () => {
    expect(collectablesRestartCardCopy()).toEqual({
      eyebrow: "No answer",
      heading: "Restart the Polkadot app",
      body: "Your Polkadot app is not answering. Close it fully (swipe it away) and open it again. Your collectables are kept.",
      escalated: false,
    })
  })

  it("prescribes a restart on the first app open that finds the chain lost", () => {
    const copy = restartCardCopy("chain-lost", 1, " The game starts in 3:17.")
    expect(copy).toEqual({
      eyebrow: "Connection lost",
      heading: "Restart the Polkadot app",
      body: "Your Polkadot app lost its connection to the network. Close it fully (swipe it away) and open it again. Your place in the game is kept. The game starts in 3:17.",
      escalated: false,
    })
  })

  it.each([2, 3, 4])("stops saying restart from the 2nd open in a row (%i)", (streak) => {
    const copy = restartCardCopy("chain-lost", streak, " The game starts in 3:17.")
    expect(copy).toEqual({
      eyebrow: "Still no answer",
      heading: "Switch to mobile data, then reopen",
      body: "The Polkadot app is still not answering. Switch to mobile data, close it fully (swipe it away), then open it again. Your place in the game is kept. The game starts in 3:17.",
      escalated: true,
    })
  })

  it("moves the silent-host variant to mobile data on the second open", () => {
    for (const reason of ["host-unanswered", "read-unanswered"] as const)
      expect(restartCardCopy(reason, 2, "")).toEqual({
        eyebrow: "Still no answer",
        heading: "Switch to mobile data, then reopen",
        body: "The Polkadot app is still not answering. Switch to mobile data, close it fully (swipe it away), then open it again. Your place in the game is kept.",
        escalated: true,
      })
  })
})

describe("the card's re-check schedule", () => {
  it("backs off 5, 10, 20, then 30 s", () => {
    expect([0, 1, 2, 3, 4, 9].map((n) => chainLostRecheckDelayMs(n, false))).toEqual([
      5000, 10_000, 20_000, 30_000, 30_000, 30_000,
    ])
    expect(CHAIN_LOST_RECHECK_FIRST_MS).toBe(5000)
  })

  it("waits the cap after a probe that timed out, its build may still be pending", () => {
    expect(chainLostRecheckDelayMs(0, true)).toBe(CHAIN_LOST_RECHECK_CAP_MS)
  })
})

describe("re-checking while the card is up", () => {
  afterEach(() => vi.useRealTimers())

  function harness(answers: ChainHealthResult[], settleMs = 0) {
    let hidden = false
    let listener: (() => void) | undefined
    const started: number[] = []
    const probe = vi.fn(async () => {
      started.push(Date.now())
      if (settleMs) await new Promise((resolve) => setTimeout(resolve, settleMs))
      return answers.shift()
    })
    const cancel = armChainLostRecheck({
      probe,
      hidden: () => hidden,
      onVisibility: (l) => {
        listener = l
        return () => (listener = undefined)
      },
    })
    return {
      probe,
      started,
      cancel,
      setHidden: (value: boolean) => {
        hidden = value
        listener?.()
      },
    }
  }

  it("re-checks on the backoff, each armed after the last one settles", async () => {
    vi.useFakeTimers({ now: 0 })
    const h = harness([LOST, LOST, HEALTHY], 3000)
    await vi.advanceTimersByTimeAsync(5000) // 1st at 5 s, settles at 8 s
    await vi.advanceTimersByTimeAsync(3000 + 10_000) // 2nd at 18 s, settles at 21 s
    await vi.advanceTimersByTimeAsync(3000 + 20_000) // 3rd at 41 s
    expect(h.started).toEqual([5000, 18_000, 41_000])
    h.cancel()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.probe).toHaveBeenCalledTimes(3)
  })

  it("waits the cap after a timed-out probe", async () => {
    vi.useFakeTimers({ now: 0 })
    const h = harness([TIMED_OUT, HEALTHY])
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(h.probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.probe).toHaveBeenCalledTimes(2)
    h.cancel()
  })

  it("holds a re-check due while the page is hidden, and runs it when it shows", async () => {
    vi.useFakeTimers({ now: 0 })
    const h = harness([LOST])
    h.setHidden(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.probe).not.toHaveBeenCalled()
    h.setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.probe).toHaveBeenCalledTimes(1)
    h.cancel()
  })
})

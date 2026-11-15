// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./debug/log-store", () => ({ devLog: vi.fn() }))

// sessionStorage as the host hands it over, where it does
const store = new Map<string, string>()
vi.stubGlobal("sessionStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
})

const { forgetPostGame, postGameHref, postGameIndex, rememberPostGame } = await import("./post-game")
const { devLog } = await import("./debug/log-store")

beforeEach(() => forgetPostGame())
afterEach(() => {
  vi.useRealTimers()
  vi.mocked(devLog).mockClear()
})

describe("the game the post-game screens are about", () => {
  it("takes the URL's ?game= when it has one", () => {
    rememberPostGame(150)
    expect(postGameIndex("?game=149")).toBe(149)
  })

  it("fills in the game the session remembered when the URL came without one", () => {
    // measured: an iPhone opened the draw screen of game 150 with no ?game=
    rememberPostGame(150)
    expect(postGameIndex("")).toBe(150)
    expect(devLog).toHaveBeenCalledWith("post-game", expect.stringMatching(/without \?game/), { game: 150 })
  })

  it("does not know the game with neither, so the screen falls back to the last attended one", () => {
    expect(postGameIndex("")).toBeUndefined()
  })

  it("brings the remembered game back after a reload, from sessionStorage", () => {
    rememberPostGame(150)
    // a reload: the module starts over, the host's sessionStorage does not
    vi.resetModules()
    return import("./post-game").then(({ postGameIndex: afterReload }) => {
      expect(afterReload("")).toBe(150)
    })
  })

  it("forgets a game remembered hours ago, rather than show yesterday's draw", () => {
    vi.useFakeTimers()
    rememberPostGame(150)
    vi.advanceTimersByTime(4 * 60 * 60 * 1000)
    expect(postGameIndex("")).toBeUndefined()
  })

  it("ignores a ?game= that is not a game index", () => {
    rememberPostGame(150)
    expect(postGameIndex("?game=abc")).toBe(150)
    expect(postGameIndex("?game=")).toBe(150)
  })

  it("carries the game on in the next screen's link", () => {
    vi.stubGlobal("window", { location: { search: "" } })
    rememberPostGame(150)
    expect(postGameHref("/chest")).toBe("/chest?game=150")
    forgetPostGame()
    expect(postGameHref("/chest")).toBe("/chest")
    vi.unstubAllGlobals()
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    })
  })
})
